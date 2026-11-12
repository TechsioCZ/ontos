import { and, eq, isNull, sql } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Exit, Redacted, Ref, Schema } from 'effect';
import type { Scope } from 'effect';

import { PrincipalIdSchema, TenantIdSchema } from '../access/ids.ts';
import { makeAccessWorkloadBindingDrizzleStore } from '../access/workloads/binding-store.ts';
import { AccessWorkloadBindingIdSchema } from '../access/workloads/store.ts';
import { makePrincipalResolver, ProviderSubjectSchema } from '../auth/principal-resolver.ts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '../auth/staff-authentication-namespace.ts';
import { WorkloadKeySchema } from '../authorization/access-declaration.ts';
import { makeCoreDatabase } from '../db/client.ts';
import { accessWorkloadBindings, principals } from '../db/schema.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import { defineDatabaseIdentityEnrollment } from '../db/database-identity-manifest.ts';
import type { CoreTransaction } from '../db/types.ts';
import { stageScopeOf } from '../install/stage-context-bootstrap.ts';
import { makeOperationalScopeRepository } from '../operations/context.ts';
import type { OperationalScope } from '../operations/context.ts';
import { requireOwnedNativeDatabaseFixture } from './isolated-native-database.ts';
import type { OwnedNativeDatabaseFixture } from './isolated-native-database.ts';

const fixturePurpose = 'implementation-1096-registered-workload-gateway';
const writerWorkloads = ['commerce.customer-context.source-write', 'commerce.inventory.source-write'] as const;
const priceGroupReaderWorkload = 'pricing.price-group-catalog.source-read';

const WorkloadOperatorFields = {
  operatorPrincipalId: PrincipalIdSchema,
  operatorProviderUserId: ProviderSubjectSchema.fields.providerSubjectId,
  purpose: Schema.Literal(fixturePurpose),
  targetPrincipalId: PrincipalIdSchema,
  tenantId: TenantIdSchema,
};
const WorkloadControlInputSchema = Schema.Union([
  Schema.Struct({
    ...WorkloadOperatorFields,
    principalKind: Schema.Literal('system'),
    workloadKey: Schema.Literals(writerWorkloads),
  }),
  Schema.Struct({
    ...WorkloadOperatorFields,
    principalKind: Schema.Literal('integration'),
    workloadKey: Schema.Literal(priceGroupReaderWorkload),
  }),
]);

interface OwnedWorkloadOperatorInput {
  readonly operatorPrincipalId: string;
  readonly operatorProviderUserId: string;
  readonly ownedDatabase: OwnedNativeDatabaseFixture;
  readonly purpose: typeof fixturePurpose;
  readonly tenantId: string;
}

export interface OwnedSystemWriterWorkloadControlInput extends OwnedWorkloadOperatorInput {
  readonly systemPrincipalId: string;
  readonly workloadKey: (typeof writerWorkloads)[number];
}

export interface OwnedIntegrationPriceGroupReaderWorkloadControlInput extends OwnedWorkloadOperatorInput {
  readonly integrationPrincipalId: string;
}

type OwnedNativeWorkloadControlInput = OwnedWorkloadOperatorInput & {
  readonly targetPrincipalId: string;
} & (
    | { readonly principalKind: 'system'; readonly workloadKey: (typeof writerWorkloads)[number] }
    | { readonly principalKind: 'integration'; readonly workloadKey: typeof priceGroupReaderWorkload }
  );

export interface NativeWorkloadBindingReference {
  readonly bindingId: string;
  readonly incarnation: string;
}

export class NativeWorkloadBindingControlError extends Schema.TaggedError<NativeWorkloadBindingControlError>()(
  'NativeWorkloadBindingControlError',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}

export interface OwnedNativeWorkloadBindingControl {
  readonly originalBinding: NativeWorkloadBindingReference;
  readonly rebind: () => Effect.Effect<NativeWorkloadBindingReference, NativeWorkloadBindingControlError>;
  readonly revoke: () => Effect.Effect<void, NativeWorkloadBindingControlError>;
}

export type OwnedSystemWriterWorkloadControl = OwnedNativeWorkloadBindingControl;
export type OwnedIntegrationPriceGroupReaderWorkloadControl = OwnedNativeWorkloadBindingControl;

const unavailable = (reason: string, cause?: unknown) =>
  new NativeWorkloadBindingControlError({ cause: Redacted.make(cause), reason });

/**
 * TEST infrastructure only: controls one exact allowed enrollment in an authentic live clone.
 * It grants no permissions and preserves revoked history and every other enrollment.
 */
const makeOwnedWorkloadBindingControlNative = Effect.fn('NativeWorkloadBindingControl.make')(
  function* makeOwnedWorkloadBindingControlNative(
    input: OwnedNativeWorkloadControlInput,
  ): Effect.fn.Return<
    OwnedNativeWorkloadBindingControl,
    NativeWorkloadBindingControlError,
    Crypto.Crypto | Scope.Scope
  > {
    const crypto = yield* Crypto.Crypto;
    const pins = yield* Schema.decodeUnknownEffect(WorkloadControlInputSchema)(input).pipe(
      Effect.mapError((cause) => unavailable('Invalid owned enrollment control input', cause)),
    );
    const { connections } = input.ownedDatabase;
    const requireOwnership = requireOwnedNativeDatabaseFixture(input.ownedDatabase, {
      adminConnectionString: Redacted.make(connections.admin.connectionString),
      purpose: pins.purpose,
      runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
    }).pipe(Effect.mapError((cause) => unavailable('An authentic live owned clone is required', cause)));
    yield* requireOwnership;
    const database = yield* makeCoreDatabase(connections.runtime).pipe(
      Effect.mapError((cause) => unavailable('Unable to open the owned enrollment control runtime', cause)),
    );
    const enrollment = defineDatabaseIdentityEnrollment([]);
    const writer = makeAccessWorkloadBindingDrizzleStore({ enrollment, executor: database.executor });
    const scope = yield* stageScopeOf({ principalId: pins.operatorPrincipalId, tenantId: pins.tenantId }).pipe(
      Effect.mapError((cause) => unavailable('Unable to resolve the native operator scope', cause)),
    );
    const workloadKey = WorkloadKeySchema.make(pins.workloadKey);

    const runVerified = Effect.fn('NativeWorkloadBindingControl.runVerified')(
      function* runOwnedWriterControl<Value, Failure>(
        body: (transaction: CoreTransaction, operatorScope: OperationalScope) => Effect.Effect<Value, Failure>,
      ) {
        yield* requireOwnership;
        return yield* database.executor.transaction(
          Effect.fn('NativeWorkloadBindingControl.verifyAndRun')(function* verifyAndRun(transaction) {
            const [runtime] = yield* transaction.execute<{ readonly valid: boolean }>(
              sql`select current_database()=${connections.runtime.database}
                  and current_user=${connections.runtime.user} and session_user=${connections.runtime.user}
                  and not rolsuper and not rolbypassrls as valid from pg_roles where rolname=current_user`,
              'objects',
            );
            if (runtime?.valid !== true) {
              return yield* unavailable('The owned enrollment control requires its exact non-privileged runtime role');
            }
            yield* installOperationalScope(transaction, scope, enrollment);
            const targetRows = transaction
              .select({ principalId: principals.principalId })
              .from(principals)
              .where(
                and(
                  eq(principals.tenantId, pins.tenantId),
                  eq(principals.principalId, pins.targetPrincipalId),
                  eq(principals.kind, pins.principalKind),
                  eq(principals.status, 'active'),
                ),
              )
              .limit(1);
            // These reads share one native SQL transaction; preserve their failure and connection order.
            const { operator, persisted, targets } = yield* Effect.all(
              {
                operator: makePrincipalResolver(database, {
                  authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
                }).resolveBetterAuthUserForTenant(pins.operatorProviderUserId, pins.tenantId),
                persisted: makeOperationalScopeRepository({ executor: transaction }, enrollment).load(scope),
                targets: targetRows,
              },
              { concurrency: 1 },
            );
            const [target] = targets;
            if (
              operator.principalId !== pins.operatorPrincipalId ||
              operator.principalKind !== 'human' ||
              operator.tenantId !== pins.tenantId ||
              persisted.tenantStatus !== 'active' ||
              persisted.principalStatus !== 'active' ||
              persisted.principalTenantId !== pins.tenantId ||
              target === undefined
            ) {
              return yield* unavailable(
                'The actual active human operator, Tenant and target Principal kind do not match',
              );
            }
            // The native store uses this same client's active transaction context, including its savepoint.
            const result = yield* body(transaction, scope);
            yield* requireOwnership;
            return result;
          }),
        );
      },
      Effect.mapError((cause) => unavailable('The owned enrollment control could not be verified', cause)),
    );

    const activeBindings = (transaction: CoreTransaction) =>
      transaction
        .select({ bindingId: accessWorkloadBindings.bindingId, incarnation: accessWorkloadBindings.incarnation })
        .from(accessWorkloadBindings)
        .where(
          and(
            eq(accessWorkloadBindings.tenantId, pins.tenantId),
            eq(accessWorkloadBindings.principalId, pins.targetPrincipalId),
            eq(accessWorkloadBindings.workloadKey, workloadKey),
            eq(accessWorkloadBindings.status, 'active'),
            isNull(accessWorkloadBindings.revokedAt),
          ),
        )
        .limit(2)
        .for('update');
    const originalBinding = yield* runVerified(
      Effect.fn('NativeWorkloadBindingControl.selectOriginal')(function* selectOriginal(transaction) {
        const rows = yield* activeBindings(transaction);
        const [original] = rows;
        if (rows.length !== 1 || original === undefined) {
          return yield* unavailable('Exactly one current target workload enrollment is required');
        }
        return Object.freeze(original);
      }),
    );
    const state = yield* Ref.make<'active' | 'revoking' | 'revoked' | 'rebinding' | 'rebound' | 'failed'>('active');
    yield* Effect.addFinalizer(() => Ref.set(state, 'failed'));
    const runTransition = Effect.fn('NativeWorkloadBindingControl.transition')(function* transitionWriterEnrollment<
      Value,
    >(
      from: 'active' | 'revoked',
      pending: 'revoking' | 'rebinding',
      to: 'revoked' | 'rebound',
      operation: Effect.Effect<Value, NativeWorkloadBindingControlError>,
    ) {
      const claimed = yield* Ref.modify(state, (current) => (current === from ? [true, pending] : [false, current]));
      if (!claimed) {
        return yield* unavailable('This exact enrollment transition is stale or already consumed');
      }
      return yield* operation.pipe(
        Effect.tap(() => Ref.set(state, to)),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Ref.set(state, 'failed') : Effect.void)),
      );
    });

    const revoke = runVerified(
      Effect.fn('NativeWorkloadBindingControl.revokeOriginal')(function* revokeOriginal(transaction, operatorScope) {
        const rows = yield* activeBindings(transaction);
        const [current] = rows;
        if (
          rows.length !== 1 ||
          current?.bindingId !== originalBinding.bindingId ||
          current.incarnation !== originalBinding.incarnation
        ) {
          return yield* unavailable('The exact original workload enrollment is no longer current');
        }
        yield* writer.revokeBinding(operatorScope, {
          bindingId: AccessWorkloadBindingIdSchema.make(originalBinding.bindingId),
          revokedAt: DateTime.toDateUtc(yield* DateTime.now),
        });
        return yield* Effect.void;
      }),
    );
    const rebind = runVerified(
      Effect.fn('NativeWorkloadBindingControl.rebindFresh')(function* rebindFresh(transaction, operatorScope) {
        if ((yield* activeBindings(transaction)).length !== 0) {
          return yield* unavailable('A later enrollment already occupies this exact workload');
        }
        const [ended] = yield* transaction
          .select({ status: accessWorkloadBindings.status })
          .from(accessWorkloadBindings)
          .where(
            and(
              eq(accessWorkloadBindings.tenantId, pins.tenantId),
              eq(accessWorkloadBindings.principalId, pins.targetPrincipalId),
              eq(accessWorkloadBindings.workloadKey, workloadKey),
              eq(accessWorkloadBindings.bindingId, originalBinding.bindingId),
              eq(accessWorkloadBindings.incarnation, originalBinding.incarnation),
              eq(accessWorkloadBindings.status, 'revoked'),
            ),
          )
          .for('update');
        if (ended === undefined) {
          return yield* unavailable('The original ended workload enrollment is missing');
        }
        const bindingId = AccessWorkloadBindingIdSchema.make(yield* crypto.randomUUIDv4());
        const incarnation = AccessWorkloadBindingIdSchema.make(yield* crypto.randomUUIDv4());
        if (
          bindingId === originalBinding.bindingId ||
          bindingId === originalBinding.incarnation ||
          incarnation === originalBinding.bindingId ||
          incarnation === originalBinding.incarnation ||
          bindingId === incarnation
        ) {
          return yield* unavailable('A rebind requires genuinely new binding and incarnation identities');
        }
        yield* writer.registerBindings(operatorScope, {
          bindings: [
            {
              bindingId,
              createdAt: DateTime.toDateUtc(yield* DateTime.now),
              incarnation,
              principalId: pins.targetPrincipalId,
              tenantId: pins.tenantId,
              workloadKey,
            },
          ],
        });
        const current = yield* activeBindings(transaction);
        if (current.length !== 1 || current[0]?.bindingId !== bindingId || current[0].incarnation !== incarnation) {
          return yield* unavailable('The native writer did not establish the exact fresh enrollment');
        }
        return Object.freeze({ bindingId, incarnation });
      }),
    );
    return Object.freeze({
      originalBinding,
      rebind: () => runTransition('revoked', 'rebinding', 'rebound', rebind),
      revoke: () => runTransition('active', 'revoking', 'revoked', revoke),
    });
  },
);

/** TEST-only control for the existing finite System writer enrollments. */
export const makeOwnedSystemWriterWorkloadControlNative = Effect.fn('NativeWorkloadBindingControl.makeSystemWriter')(
  (input: OwnedSystemWriterWorkloadControlInput) =>
    makeOwnedWorkloadBindingControlNative({
      operatorPrincipalId: input.operatorPrincipalId,
      operatorProviderUserId: input.operatorProviderUserId,
      ownedDatabase: input.ownedDatabase,
      principalKind: 'system',
      purpose: input.purpose,
      targetPrincipalId: input.systemPrincipalId,
      tenantId: input.tenantId,
      workloadKey: input.workloadKey,
    }),
);

/** TEST-only Integration reader control. No caller-selected workload or Principal kind is accepted. */
export const makeOwnedIntegrationPriceGroupReaderWorkloadControlNative = Effect.fn(
  'NativeWorkloadBindingControl.makeIntegrationPriceGroupReader',
)((input: OwnedIntegrationPriceGroupReaderWorkloadControlInput) =>
  makeOwnedWorkloadBindingControlNative({
    operatorPrincipalId: input.operatorPrincipalId,
    operatorProviderUserId: input.operatorProviderUserId,
    ownedDatabase: input.ownedDatabase,
    principalKind: 'integration',
    purpose: input.purpose,
    targetPrincipalId: input.integrationPrincipalId,
    tenantId: input.tenantId,
    workloadKey: priceGroupReaderWorkload,
  }),
);
