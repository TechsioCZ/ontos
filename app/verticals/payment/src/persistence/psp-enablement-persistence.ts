import { OperationContextUnavailable } from '@app/core-runtime';
import type { ActionServiceFactory, ScopedTransactionExecutor } from '@app/core-runtime';
import { and, asc, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import { gatewayEnablementRejected } from '../../shared/actions/configure-gateway-enablement.ts';
import type { GatewayEnablementRejected } from '../../shared/actions/configure-gateway-enablement.ts';
import type { PaymentExecutionProvenance } from '../../shared/domain/payment-provenance.ts';
import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type {
  PaymentGatewayProviderFamilySchema,
  PaymentSourceFactFamily,
} from '../../shared/domain/payment-vocabulary.ts';
import {
  GatewayMerchantIdentitySchema,
  GatewayProviderAccountBindingIdSchema,
  GatewayProviderAccountRefSchema,
} from '../../shared/domain/psp-configuration.ts';
import type {
  GatewayMerchantIdentity,
  GatewayProviderAccountBindingId,
  GatewayProviderAccountRef,
} from '../../shared/domain/psp-configuration.ts';
import type { GatewayBindingStatus, GatewayEnvironment } from '../../shared/domain/psp-vocabulary.ts';
import { PaymentSourceBindingSchema } from '../../shared/domain/source-statement.ts';
import {
  pspGatewayEnablementRevisions,
  pspGatewayEnablements,
  pspProviderAccountBindings,
} from '../database/schema.ts';
import type { PaymentSourceAuthorityView } from '../domain/source-qualification.ts';
import { paymentEvidencePersistenceForTransaction } from './payment-evidence-persistence.ts';
import { paymentSourcePersistenceForTransaction } from './payment-source-persistence.ts';

type PaymentGatewayProviderFamily = typeof PaymentGatewayProviderFamilySchema.Type;

/**
 * Owner-local Gateway Enablement (#1155) per Customer Configuration, Selling Legal Entity and provider
 * family, over the Core-installed `ScopedTransactionExecutor`. The Current row changes only under its
 * row lock with one appended immutable revision; the named binding is read under a share lock, so a
 * concurrent retirement of that binding serializes against enabling it. RLS, the composite binding
 * foreign key (family and environment equal the binding's) and the revision trigger are the database
 * backstop. Nothing here reads a credential or a secret reference.
 */

/** A Provider Account Binding as Gateway Enablement names it. No secret or secret reference. */
export interface PspEnablementBinding {
  readonly bindingId: GatewayProviderAccountBindingId;
  readonly environment: GatewayEnvironment;
  readonly providerAccountRef: GatewayProviderAccountRef;
  readonly providerFamily: PaymentGatewayProviderFamily;
  readonly status: GatewayBindingStatus;
}

/** A binding as the configuration Read shows it. */
export interface PspConfiguredBinding extends PspEnablementBinding {
  readonly configuredAt: DateTime.Utc;
  readonly currentCredentialRevision: number;
  readonly merchantIdentity: GatewayMerchantIdentity;
  readonly notificationUrl: string;
  readonly revision: number;
}

export interface PspGatewayEnablementRecord {
  readonly binding: PspEnablementBinding;
  readonly configuredAt: DateTime.Utc;
  readonly customerConfigurationId: string;
  readonly enabled: boolean;
  readonly provenance: PaymentExecutionProvenance;
  readonly reason: string;
  readonly returnUrl: string;
  readonly revision: number;
}

export interface ConfigureGatewayEnablementInput {
  /** The binding read under its share lock in this transaction. */
  readonly binding: PspEnablementBinding;
  readonly customerConfigurationId: string;
  readonly enabled: boolean;
  /** Stale-write guard: `None` only for the first configuration of this family. */
  readonly expectedRevision: Option.Option<number>;
  readonly provenance: PaymentExecutionProvenance;
  readonly reason: string;
  readonly returnUrl: string;
}

/** `changed` is false when the requested state already is Current: no revision is appended. */
export interface ConfigureGatewayEnablementOutcome {
  readonly changed: boolean;
  readonly record: PspGatewayEnablementRecord;
}

export interface PspEnablementPersistence {
  readonly configureEnablement: (
    input: ConfigureGatewayEnablementInput,
  ) => Effect.Effect<ConfigureGatewayEnablementOutcome, GatewayEnablementRejected | PaymentUnavailable>;
  /** Every binding of the scope, Current and retired, oldest first, at most `limit`. */
  readonly listBindings: (limit: number) => Effect.Effect<readonly PspConfiguredBinding[], PaymentUnavailable>;
  /** Current enablement rows (enabled or not) with their bindings, family order, at most `limit`. */
  readonly listEnablements: (input: {
    readonly customerConfigurationId: Option.Option<string>;
    readonly limit: number;
    readonly providerFamily: Option.Option<PaymentGatewayProviderFamily>;
  }) => Effect.Effect<readonly PspGatewayEnablementRecord[], PaymentUnavailable>;
  /** The exact binding of this ref and environment, read under a share lock. */
  readonly lockBinding: (input: {
    readonly environment: GatewayEnvironment;
    readonly providerAccountRef: GatewayProviderAccountRef;
  }) => Effect.Effect<Option.Option<PspEnablementBinding>, PaymentUnavailable>;
}

type EnablementRow = typeof pspGatewayEnablements.$inferSelect;
type BindingRow = typeof pspProviderAccountBindings.$inferSelect;

const readFailure = (cause: unknown) => paymentUnavailable('Gateway Enablement could not be read', cause);
const writeFailure = (cause: unknown) => paymentUnavailable('Gateway Enablement could not be written', cause);

const decodeBindingId = Schema.decodeUnknownEffect(GatewayProviderAccountBindingIdSchema);
const decodeAccountRef = Schema.decodeUnknownEffect(GatewayProviderAccountRefSchema);
const decodeMerchantIdentity = Schema.decodeUnknownEffect(GatewayMerchantIdentitySchema);
const decodeSourceBinding = Schema.decodeUnknownEffect(PaymentSourceBindingSchema);

/** Stored identifiers are CHECK-constrained; an undecodable one is unreadable state, never absence. */
const bindingOf = (
  row: Pick<BindingRow, 'bindingId' | 'environment' | 'providerAccountRef' | 'providerFamily' | 'status'>,
) =>
  Effect.all([decodeBindingId(row.bindingId), decodeAccountRef(row.providerAccountRef)], { concurrency: 1 }).pipe(
    Effect.map(([bindingId, providerAccountRef]): PspEnablementBinding => ({
      bindingId,
      environment: row.environment,
      providerAccountRef,
      providerFamily: row.providerFamily,
      status: row.status,
    })),
    Effect.mapError(readFailure),
  );

const configuredBindingOf = (row: BindingRow) =>
  Effect.all([bindingOf(row), decodeMerchantIdentity(row.merchantIdentity).pipe(Effect.mapError(readFailure))], {
    concurrency: 1,
  }).pipe(
    Effect.map(([binding, merchantIdentity]): PspConfiguredBinding => ({
      ...binding,
      configuredAt: DateTime.fromDateUnsafe(row.configuredAt),
      currentCredentialRevision: row.currentCredentialRevision,
      merchantIdentity,
      notificationUrl: row.notificationUrl,
      revision: row.revision,
    })),
  );

const recordOf = (row: EnablementRow, binding: PspEnablementBinding): PspGatewayEnablementRecord => ({
  binding,
  configuredAt: DateTime.fromDateUnsafe(row.configuredAt),
  customerConfigurationId: row.customerConfigurationId,
  enabled: row.enabled,
  provenance: {
    actionInvocationId: row.actionInvocationId,
    actorPrincipalId: row.actorPrincipalId,
    compositionRevision: row.compositionRevision,
  },
  reason: row.reason,
  returnUrl: row.returnUrl,
  revision: row.revision,
});

const sameState = (row: EnablementRow, input: ConfigureGatewayEnablementInput) =>
  row.bindingId === input.binding.bindingId &&
  row.environment === input.binding.environment &&
  row.enabled === input.enabled &&
  row.returnUrl === input.returnUrl;

/** Construction is private to a Core-owned transaction; handlers receive only these closed methods. */
export const pspEnablementPersistenceForTransaction = (
  transaction: ScopedTransactionExecutor,
): PspEnablementPersistence => {
  const ownerScope = Effect.suspend(() => {
    const { legalEntityId, tenantId } = transaction.scope;
    return legalEntityId === undefined
      ? Effect.fail(paymentUnavailable('A verified Selling Legal Entity scope is required'))
      : Effect.succeed({ legalEntityId, tenantId });
  });

  const lockBinding = Effect.fn('PspEnablementPersistence.lockBinding')(function* lockBinding(input: {
    readonly environment: GatewayEnvironment;
    readonly providerAccountRef: GatewayProviderAccountRef;
  }) {
    const scope = yield* ownerScope;
    const [row] = yield* transaction
      .select({
        bindingId: pspProviderAccountBindings.bindingId,
        environment: pspProviderAccountBindings.environment,
        providerAccountRef: pspProviderAccountBindings.providerAccountRef,
        providerFamily: pspProviderAccountBindings.providerFamily,
        status: pspProviderAccountBindings.status,
      })
      .from(pspProviderAccountBindings)
      .where(
        and(
          eq(pspProviderAccountBindings.tenantId, scope.tenantId),
          eq(pspProviderAccountBindings.legalEntityId, scope.legalEntityId),
          eq(pspProviderAccountBindings.providerAccountRef, input.providerAccountRef),
          eq(pspProviderAccountBindings.environment, input.environment),
        ),
      )
      .for('share')
      .pipe(Effect.mapError(readFailure));
    return row === undefined ? Option.none() : Option.some(yield* bindingOf(row));
  });

  const bindingById = Effect.fn('PspEnablementPersistence.bindingById')(function* bindingById(bindingId: string) {
    const scope = yield* ownerScope;
    const [row] = yield* transaction
      .select()
      .from(pspProviderAccountBindings)
      .where(
        and(
          eq(pspProviderAccountBindings.tenantId, scope.tenantId),
          eq(pspProviderAccountBindings.legalEntityId, scope.legalEntityId),
          eq(pspProviderAccountBindings.bindingId, bindingId),
        ),
      )
      .pipe(Effect.mapError(readFailure));
    return row === undefined
      ? yield* paymentUnavailable('The Gateway Enablement names a binding that is not visible')
      : yield* bindingOf(row);
  });

  const lockCurrent = Effect.fn('PspEnablementPersistence.lockCurrent')(function* lockCurrent(
    customerConfigurationId: string,
    providerFamily: PaymentGatewayProviderFamily,
  ) {
    const scope = yield* ownerScope;
    const [row] = yield* transaction
      .select()
      .from(pspGatewayEnablements)
      .where(
        and(
          eq(pspGatewayEnablements.tenantId, scope.tenantId),
          eq(pspGatewayEnablements.legalEntityId, scope.legalEntityId),
          eq(pspGatewayEnablements.customerConfigurationId, customerConfigurationId),
          eq(pspGatewayEnablements.providerFamily, providerFamily),
        ),
      )
      .for('update')
      .pipe(Effect.mapError(readFailure));
    return Option.fromNullishOr(row);
  });

  const appendRevision = Effect.fn('PspEnablementPersistence.appendRevision')(function* appendRevision(
    row: EnablementRow,
  ) {
    yield* transaction
      .insert(pspGatewayEnablementRevisions)
      .values({
        actionInvocationId: row.actionInvocationId,
        actorPrincipalId: row.actorPrincipalId,
        bindingId: row.bindingId,
        compositionRevision: row.compositionRevision,
        customerConfigurationId: row.customerConfigurationId,
        enabled: row.enabled,
        enablementId: row.enablementId,
        environment: row.environment,
        legalEntityId: row.legalEntityId,
        providerFamily: row.providerFamily,
        reason: row.reason,
        recordedAt: row.configuredAt,
        returnUrl: row.returnUrl,
        revision: row.revision,
        tenantId: row.tenantId,
      })
      .pipe(Effect.mapError(writeFailure));
  });

  /**
   * First configuration. A concurrent first configuration of the same family waits on the unique key,
   * then inserts nothing; the caller re-reads the winner under its lock and decides again.
   */
  const insertFirst = Effect.fn('PspEnablementPersistence.insertFirst')(function* insertFirst(
    input: ConfigureGatewayEnablementInput,
  ) {
    const scope = yield* ownerScope;
    const configuredAt = DateTime.toDateUtc(yield* DateTime.now);
    const [row] = yield* transaction
      .insert(pspGatewayEnablements)
      .values({
        actionInvocationId: input.provenance.actionInvocationId,
        actorPrincipalId: input.provenance.actorPrincipalId,
        bindingId: input.binding.bindingId,
        compositionRevision: input.provenance.compositionRevision,
        configuredAt,
        customerConfigurationId: input.customerConfigurationId,
        enabled: input.enabled,
        environment: input.binding.environment,
        legalEntityId: scope.legalEntityId,
        providerFamily: input.binding.providerFamily,
        reason: input.reason,
        returnUrl: input.returnUrl,
        revision: 1,
        tenantId: scope.tenantId,
      })
      .onConflictDoNothing({
        target: [
          pspGatewayEnablements.tenantId,
          pspGatewayEnablements.legalEntityId,
          pspGatewayEnablements.customerConfigurationId,
          pspGatewayEnablements.providerFamily,
        ],
      })
      .returning()
      .pipe(Effect.mapError(writeFailure));
    if (row !== undefined) {
      yield* appendRevision(row);
    }
    return Option.fromNullishOr(row);
  });

  const reviseLocked = Effect.fn('PspEnablementPersistence.reviseLocked')(function* reviseLocked(
    current: EnablementRow,
    input: ConfigureGatewayEnablementInput,
  ) {
    const decidedAgainst = Option.getOrElse(input.expectedRevision, () => 0);
    if (decidedAgainst !== current.revision) {
      return yield* gatewayEnablementRejected(
        'gateway_enablement_revision_conflict',
        Option.isNone(input.expectedRevision)
          ? `The gateway family is already configured at revision ${current.revision}`
          : `The Gateway Enablement is at revision ${current.revision}, not ${decidedAgainst}`,
      );
    }
    if (sameState(current, input)) {
      return {
        changed: false,
        record: recordOf(current, yield* bindingById(current.bindingId)),
      } satisfies ConfigureGatewayEnablementOutcome;
    }
    const configuredAt = DateTime.toDateUtc(yield* DateTime.now);
    const [updated] = yield* transaction
      .update(pspGatewayEnablements)
      .set({
        actionInvocationId: input.provenance.actionInvocationId,
        actorPrincipalId: input.provenance.actorPrincipalId,
        bindingId: input.binding.bindingId,
        compositionRevision: input.provenance.compositionRevision,
        configuredAt,
        enabled: input.enabled,
        environment: input.binding.environment,
        reason: input.reason,
        returnUrl: input.returnUrl,
        revision: current.revision + 1,
      })
      .where(
        and(
          eq(pspGatewayEnablements.tenantId, current.tenantId),
          eq(pspGatewayEnablements.legalEntityId, current.legalEntityId),
          eq(pspGatewayEnablements.enablementId, current.enablementId),
          eq(pspGatewayEnablements.revision, current.revision),
        ),
      )
      .returning()
      .pipe(Effect.mapError(writeFailure));
    if (updated === undefined) {
      return yield* paymentUnavailable('The locked Gateway Enablement row was not updated');
    }
    yield* appendRevision(updated);
    return { changed: true, record: recordOf(updated, input.binding) } satisfies ConfigureGatewayEnablementOutcome;
  });

  const configureEnablement = Effect.fn('PspEnablementPersistence.configureEnablement')(function* configureEnablement(
    input: ConfigureGatewayEnablementInput,
  ) {
    const { providerFamily } = input.binding;
    const existing = yield* lockCurrent(input.customerConfigurationId, providerFamily);
    if (Option.isSome(existing)) {
      return yield* reviseLocked(existing.value, input);
    }
    if (Option.isSome(input.expectedRevision)) {
      return yield* gatewayEnablementRejected(
        'gateway_enablement_revision_conflict',
        `The gateway family is not configured yet; expected revision ${input.expectedRevision.value} does not exist`,
      );
    }
    const inserted = yield* insertFirst(input);
    if (Option.isSome(inserted)) {
      return {
        changed: true,
        record: recordOf(inserted.value, input.binding),
      } satisfies ConfigureGatewayEnablementOutcome;
    }
    // A concurrent first configuration committed meanwhile: decide against it under its lock.
    const winner = yield* lockCurrent(input.customerConfigurationId, providerFamily);
    if (Option.isNone(winner)) {
      return yield* paymentUnavailable('The concurrently configured Gateway Enablement is not visible');
    }
    return yield* reviseLocked(winner.value, input);
  });

  const listEnablements = Effect.fn('PspEnablementPersistence.listEnablements')(function* listEnablements(input: {
    readonly customerConfigurationId: Option.Option<string>;
    readonly limit: number;
    readonly providerFamily: Option.Option<PaymentGatewayProviderFamily>;
  }) {
    const scope = yield* ownerScope;
    const rows = yield* transaction
      .select({ binding: pspProviderAccountBindings, enablement: pspGatewayEnablements })
      .from(pspGatewayEnablements)
      .innerJoin(
        pspProviderAccountBindings,
        and(
          eq(pspProviderAccountBindings.tenantId, pspGatewayEnablements.tenantId),
          eq(pspProviderAccountBindings.legalEntityId, pspGatewayEnablements.legalEntityId),
          eq(pspProviderAccountBindings.bindingId, pspGatewayEnablements.bindingId),
        ),
      )
      .where(
        and(
          eq(pspGatewayEnablements.tenantId, scope.tenantId),
          eq(pspGatewayEnablements.legalEntityId, scope.legalEntityId),
          ...Option.match(input.customerConfigurationId, {
            onNone: () => [],
            onSome: (customerConfigurationId) => [
              eq(pspGatewayEnablements.customerConfigurationId, customerConfigurationId),
            ],
          }),
          ...Option.match(input.providerFamily, {
            onNone: () => [],
            onSome: (providerFamily) => [eq(pspGatewayEnablements.providerFamily, providerFamily)],
          }),
        ),
      )
      .orderBy(asc(pspGatewayEnablements.customerConfigurationId), asc(pspGatewayEnablements.providerFamily))
      .limit(input.limit)
      .pipe(Effect.mapError(readFailure));
    return yield* Effect.forEach(
      rows,
      ({ binding, enablement }) => bindingOf(binding).pipe(Effect.map((view) => recordOf(enablement, view))),
      { concurrency: 1 },
    );
  });

  const listBindings = Effect.fn('PspEnablementPersistence.listBindings')(function* listBindings(limit: number) {
    const scope = yield* ownerScope;
    const rows = yield* transaction
      .select()
      .from(pspProviderAccountBindings)
      .where(
        and(
          eq(pspProviderAccountBindings.tenantId, scope.tenantId),
          eq(pspProviderAccountBindings.legalEntityId, scope.legalEntityId),
        ),
      )
      .orderBy(asc(pspProviderAccountBindings.configuredAt), asc(pspProviderAccountBindings.bindingId))
      .limit(limit)
      .pipe(Effect.mapError(readFailure));
    return yield* Effect.forEach(rows, configuredBindingOf, { concurrency: 1 });
  });

  return Object.freeze({ configureEnablement, listBindings, listEnablements, lockBinding });
};

/** The fact families a gateway's own evidence needs before its binding may be offered (D11). */
const REQUIRED_GATEWAY_AUTHORITIES = [
  'GATEWAY_OUTCOME',
  'REFUND_EXECUTION',
] as const satisfies readonly PaymentSourceFactFamily[];

/** The C16 source authorities of one exact gateway binding, read under the C16 authority row locks. */
export interface PspGatewaySourceAuthorities {
  readonly lockGatewayAuthorities: (
    binding: PspEnablementBinding,
  ) => Effect.Effect<readonly PaymentSourceAuthorityView[], PaymentUnavailable>;
}

export interface PspEnablementServices {
  readonly enablement: PspEnablementPersistence;
  readonly sourceAuthorities: PspGatewaySourceAuthorities;
}

/**
 * Action service factory: both share the one Core-owned transaction and its trusted Tenant / Selling
 * Legal Entity scope. Source authorities are read only through the C16 source persistence, whose
 * `PAYMENT_GATEWAY` binding is (family, account ref, environment) exactly as A8 qualifies evidence.
 */
export const pspEnablementServicesForTransaction: ActionServiceFactory<PspEnablementServices> = (
  transaction,
  scope,
) => {
  if (scope.legalEntityId === undefined) {
    return Effect.fail(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Gateway Enablement requires a trusted Selling Legal Entity',
      }),
    );
  }
  const source = paymentSourcePersistenceForTransaction(
    transaction,
    { principalId: scope.principalId },
    paymentEvidencePersistenceForTransaction(transaction),
  );
  const lockGatewayAuthorities = Effect.fn('PspEnablementServices.lockGatewayAuthorities')(
    function* lockGatewayAuthorities(binding: PspEnablementBinding) {
      const gatewaySource = yield* decodeSourceBinding({
        accountRef: binding.providerAccountRef,
        environment: binding.environment,
        sourceKind: 'PAYMENT_GATEWAY',
        sourceSystem: binding.providerFamily,
      }).pipe(Effect.mapError(readFailure));
      const families = yield* Effect.forEach(
        REQUIRED_GATEWAY_AUTHORITIES,
        (factFamily) => source.lockAuthorities({ factFamily, source: gatewaySource }),
        { concurrency: 1 },
      );
      return families.flat();
    },
  );
  return Effect.succeed(
    Object.freeze({
      enablement: pspEnablementPersistenceForTransaction(transaction),
      sourceAuthorities: Object.freeze({ lockGatewayAuthorities }),
    }),
  );
};
