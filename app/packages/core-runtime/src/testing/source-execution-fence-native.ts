import { and, eq, exists, isNotNull, isNull } from 'drizzle-orm';
import { Effect, Option, Redacted, Schema } from 'effect';

import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../access/ids.ts';
import { ActionInvocationIdSchema } from '../auth/external-identity-contracts.ts';
import { makeCoreDatabase } from '../db/client.ts';
import { actionInvocations, principals, sourceExecutionFences } from '../db/schema.ts';
import { requireOwnedNativeDatabaseFixture } from './isolated-native-database.ts';
import type { OwnedNativeDatabaseFixture } from './isolated-native-database.ts';

const fixturePurpose = 'implementation-1096-registered-workload-gateway';

const SyncAdmissionFenceFaultSchema = Schema.Struct({
  admissionId: ActionInvocationIdSchema,
  expectedLegalEntityId: Schema.OptionFromNullOr(LegalEntityIdSchema),
  expectedOriginalIntegrationPrincipalId: PrincipalIdSchema,
  purpose: Schema.Literal(fixturePurpose),
  tenantId: TenantIdSchema,
});

export interface OwnedSyncAdmissionFenceFaultInput {
  readonly admissionId: string;
  readonly expectedLegalEntityId: string | null;
  readonly expectedOriginalIntegrationPrincipalId: string;
  readonly ownedDatabase: OwnedNativeDatabaseFixture;
  readonly purpose: typeof fixturePurpose;
  readonly tenantId: string;
}

export class SourceExecutionFenceNativeFaultError extends Schema.TaggedError<SourceExecutionFenceNativeFaultError>()(
  'SourceExecutionFenceNativeFaultError',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}

const unavailable = (reason: string, cause?: unknown) =>
  new SourceExecutionFenceNativeFaultError({ cause: Redacted.make(cause), reason });

/**
 * TEST FAULT ONLY. Cancels an existing committed Sync admission in this live disposable clone.
 * This is neither governed Privacy execution nor an admitted Action, and supplies no authority.
 */
export const cancelOwnedSyncAdmissionFenceNative = Effect.fn('SourceExecutionFenceNative.cancelOwnedSyncAdmission')(
  function* cancelOwnedSyncAdmissionFenceNative(input: OwnedSyncAdmissionFenceFaultInput) {
    const pins = yield* Schema.decodeUnknownEffect(SyncAdmissionFenceFaultSchema)(input).pipe(
      Effect.mapError((cause) => unavailable('Invalid owned Sync admission fault input', cause)),
    );
    const { connections } = input.ownedDatabase;
    const expected = {
      adminConnectionString: Redacted.make(connections.admin.connectionString),
      purpose: pins.purpose,
      runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
    };
    const requireOwnership = requireOwnedNativeDatabaseFixture(input.ownedDatabase, expected).pipe(
      Effect.mapError((cause) => unavailable('The Sync fault requires this exact live owned clone', cause)),
    );
    yield* requireOwnership;
    return yield* Effect.scoped(
      Effect.gen(function* cancelOwnedFence() {
        const database = yield* makeCoreDatabase(connections.admin).pipe(
          Effect.mapError((cause) => unavailable('Unable to open the owned Sync fault database', cause)),
        );
        yield* database.executor
          .transaction(
            Effect.fn('SourceExecutionFenceNative.cancelExactCommittedAdmission')(
              function* cancelExactCommittedAdmission(transaction) {
                yield* requireOwnership;
                const committedAdmission = transaction
                  .select({ admissionId: actionInvocations.actionInvocationId })
                  .from(actionInvocations)
                  .innerJoin(
                    principals,
                    and(
                      eq(principals.tenantId, actionInvocations.tenantId),
                      eq(principals.principalId, actionInvocations.principalId),
                    ),
                  )
                  .where(
                    and(
                      eq(actionInvocations.actionInvocationId, pins.admissionId),
                      eq(actionInvocations.tenantId, pins.tenantId),
                      eq(actionInvocations.principalId, pins.expectedOriginalIntegrationPrincipalId),
                      eq(actionInvocations.actionKey, 'integration.symmy.admit-symmy-sync'),
                      eq(actionInvocations.status, 'succeeded'),
                      isNotNull(actionInvocations.completedAt),
                      Option.match(pins.expectedLegalEntityId, {
                        onNone: () => isNull(actionInvocations.legalEntityId),
                        onSome: (legalEntityId) => eq(actionInvocations.legalEntityId, legalEntityId),
                      }),
                      eq(principals.kind, 'integration'),
                    ),
                  );
                // A native UPDATE takes the exclusive row lock and waits for real owner SHARE locks.
                const cancelled = yield* transaction
                  .update(sourceExecutionFences)
                  .set({ state: 'cancelled' })
                  .where(
                    and(
                      eq(sourceExecutionFences.tenantId, pins.tenantId),
                      eq(sourceExecutionFences.admissionInvocationId, pins.admissionId),
                      eq(sourceExecutionFences.state, 'open'),
                      exists(committedAdmission),
                    ),
                  )
                  .returning({ admissionId: sourceExecutionFences.admissionInvocationId });
                if (cancelled.length !== 1) {
                  return yield* unavailable('The exact succeeded Integration Sync admission has no open fence');
                }
                yield* requireOwnership;
                return yield* Effect.void;
              },
            ),
          )
          .pipe(
            Effect.mapError((cause) => unavailable('Unable to inject the exact owned Sync cancellation fault', cause)),
          );
      }),
    );
  },
);
