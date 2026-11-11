import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { and, asc, eq } from 'drizzle-orm';
import { DateTime, Effect, Option } from 'effect';

import type { PaymentMethodEnablementState } from '../../shared/domain/applicability-contract.ts';
import { paymentMethodEnablementConflict } from '../../shared/domain/applicability-errors.ts';
import type { PaymentMethodEnablementConflict } from '../../shared/domain/applicability-errors.ts';
import type { PaymentExecutionProvenance } from '../../shared/domain/payment-provenance.ts';
import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentMethod } from '../../shared/domain/payment-vocabulary.ts';
import { methodEnablementRevisions, methodEnablements } from '../database/schema.ts';

/**
 * Owner-local merchant method enablement (#1147) in Customer Configuration + Selling Legal Entity
 * scope, over the Core-installed `ScopedTransactionExecutor`. The Current row is changed only under
 * its row lock (`SELECT ... FOR UPDATE`); every change appends one immutable revision row in the same
 * transaction. RLS and the revision trigger are the database backstop.
 */

export interface PaymentMethodEnablementRecord {
  readonly configuredAt: DateTime.Utc;
  readonly customerConfigurationId: string;
  readonly enabled: boolean;
  readonly method: PaymentMethod;
  readonly provenance: PaymentExecutionProvenance;
  readonly reason: string;
  readonly revision: number;
}

export interface ConfigurePaymentMethodEnablementInput {
  readonly customerConfigurationId: string;
  readonly enabled: boolean;
  /** Stale-write guard: `None` only for the first configuration of this method. */
  readonly expectedRevision: Option.Option<number>;
  readonly method: PaymentMethod;
  readonly provenance: PaymentExecutionProvenance;
  readonly reason: string;
}

/** `changed` is false when the requested state already is Current: no revision is appended. */
export interface ConfigurePaymentMethodEnablementOutcome {
  readonly changed: boolean;
  readonly record: PaymentMethodEnablementRecord;
}

export type PaymentApplicabilityPersistenceFailure = PaymentMethodEnablementConflict | PaymentUnavailable;

export interface PaymentApplicabilityPersistence {
  readonly configureEnablement: (
    input: ConfigurePaymentMethodEnablementInput,
  ) => Effect.Effect<ConfigurePaymentMethodEnablementOutcome, PaymentApplicabilityPersistenceFailure>;
  /** Current enablement rows of one Customer Configuration in the trusted Selling Legal Entity. */
  readonly loadCurrentEnablements: (
    customerConfigurationId: string,
  ) => Effect.Effect<readonly PaymentMethodEnablementState[], PaymentUnavailable>;
}

type EnablementRow = typeof methodEnablements.$inferSelect;

const readFailure = (cause: unknown) => paymentUnavailable('Payment method enablement could not be read', cause);
const writeFailure = (cause: unknown) => paymentUnavailable('Payment method enablement could not be written', cause);

const recordOf = (row: EnablementRow): PaymentMethodEnablementRecord => ({
  configuredAt: DateTime.fromDateUnsafe(row.configuredAt),
  customerConfigurationId: row.customerConfigurationId,
  enabled: row.enabled,
  method: row.method,
  provenance: {
    actionInvocationId: row.actionInvocationId,
    actorPrincipalId: row.actorPrincipalId,
    compositionRevision: row.compositionRevision,
  },
  reason: row.reason,
  revision: row.revision,
});

/** Construction is private to a Core-owned transaction; handlers receive only these closed methods. */
export const paymentApplicabilityPersistenceForTransaction = (
  transaction: ScopedTransactionExecutor,
): PaymentApplicabilityPersistence => {
  const ownerScope = Effect.suspend(() => {
    const { legalEntityId, tenantId } = transaction.scope;
    return legalEntityId === undefined
      ? Effect.fail(paymentUnavailable('A verified Selling Legal Entity scope is required'))
      : Effect.succeed({ legalEntityId, tenantId });
  });

  const loadCurrentEnablements = Effect.fn('PaymentApplicabilityPersistence.loadCurrentEnablements')(
    function* loadCurrentEnablements(customerConfigurationId: string) {
      const scope = yield* ownerScope;
      const rows = yield* transaction
        .select({
          enabled: methodEnablements.enabled,
          method: methodEnablements.method,
          revision: methodEnablements.revision,
        })
        .from(methodEnablements)
        .where(
          and(
            eq(methodEnablements.tenantId, scope.tenantId),
            eq(methodEnablements.legalEntityId, scope.legalEntityId),
            eq(methodEnablements.customerConfigurationId, customerConfigurationId),
          ),
        )
        .orderBy(asc(methodEnablements.method))
        .pipe(Effect.mapError(readFailure));
      return rows satisfies readonly PaymentMethodEnablementState[];
    },
  );

  const lockCurrent = Effect.fn('PaymentApplicabilityPersistence.lockCurrent')(function* lockCurrent(
    customerConfigurationId: string,
    method: PaymentMethod,
  ) {
    const scope = yield* ownerScope;
    const [row] = yield* transaction
      .select()
      .from(methodEnablements)
      .where(
        and(
          eq(methodEnablements.tenantId, scope.tenantId),
          eq(methodEnablements.legalEntityId, scope.legalEntityId),
          eq(methodEnablements.customerConfigurationId, customerConfigurationId),
          eq(methodEnablements.method, method),
        ),
      )
      .for('update')
      .pipe(Effect.mapError(readFailure));
    return Option.fromNullishOr(row);
  });

  const appendRevision = Effect.fn('PaymentApplicabilityPersistence.appendRevision')(function* appendRevision(
    row: EnablementRow,
  ) {
    yield* transaction
      .insert(methodEnablementRevisions)
      .values({
        actionInvocationId: row.actionInvocationId,
        actorPrincipalId: row.actorPrincipalId,
        compositionRevision: row.compositionRevision,
        customerConfigurationId: row.customerConfigurationId,
        enabled: row.enabled,
        legalEntityId: row.legalEntityId,
        method: row.method,
        methodEnablementId: row.methodEnablementId,
        reason: row.reason,
        recordedAt: row.configuredAt,
        revision: row.revision,
        tenantId: row.tenantId,
      })
      .pipe(Effect.mapError(writeFailure));
  });

  /**
   * First configuration. A concurrent first configuration of the same method waits on the unique
   * key, then inserts nothing; the caller re-reads the winner under its lock and decides again.
   */
  const insertFirst = Effect.fn('PaymentApplicabilityPersistence.insertFirst')(function* insertFirst(
    input: ConfigurePaymentMethodEnablementInput,
  ) {
    const scope = yield* ownerScope;
    const configuredAt = DateTime.toDateUtc(yield* DateTime.now);
    const [row] = yield* transaction
      .insert(methodEnablements)
      .values({
        actionInvocationId: input.provenance.actionInvocationId,
        actorPrincipalId: input.provenance.actorPrincipalId,
        compositionRevision: input.provenance.compositionRevision,
        configuredAt,
        customerConfigurationId: input.customerConfigurationId,
        enabled: input.enabled,
        legalEntityId: scope.legalEntityId,
        method: input.method,
        reason: input.reason,
        revision: 1,
        tenantId: scope.tenantId,
      })
      .onConflictDoNothing({
        target: [
          methodEnablements.tenantId,
          methodEnablements.legalEntityId,
          methodEnablements.customerConfigurationId,
          methodEnablements.method,
        ],
      })
      .returning()
      .pipe(Effect.mapError(writeFailure));
    if (row !== undefined) {
      yield* appendRevision(row);
    }
    return Option.fromNullishOr(row);
  });

  const reviseLocked = Effect.fn('PaymentApplicabilityPersistence.reviseLocked')(function* reviseLocked(
    current: EnablementRow,
    input: ConfigurePaymentMethodEnablementInput,
  ) {
    const decidedAgainst = Option.getOrElse(input.expectedRevision, () => 0);
    if (decidedAgainst !== current.revision) {
      return yield* paymentMethodEnablementConflict(
        Option.isNone(input.expectedRevision)
          ? `The method is already configured at revision ${current.revision}`
          : `The method enablement is at revision ${current.revision}, not ${decidedAgainst}`,
      );
    }
    if (current.enabled === input.enabled) {
      return { changed: false, record: recordOf(current) } satisfies ConfigurePaymentMethodEnablementOutcome;
    }
    const configuredAt = DateTime.toDateUtc(yield* DateTime.now);
    const [updated] = yield* transaction
      .update(methodEnablements)
      .set({
        actionInvocationId: input.provenance.actionInvocationId,
        actorPrincipalId: input.provenance.actorPrincipalId,
        compositionRevision: input.provenance.compositionRevision,
        configuredAt,
        enabled: input.enabled,
        reason: input.reason,
        revision: current.revision + 1,
      })
      .where(
        and(
          eq(methodEnablements.tenantId, current.tenantId),
          eq(methodEnablements.legalEntityId, current.legalEntityId),
          eq(methodEnablements.methodEnablementId, current.methodEnablementId),
          eq(methodEnablements.revision, current.revision),
        ),
      )
      .returning()
      .pipe(Effect.mapError(writeFailure));
    if (updated === undefined) {
      return yield* paymentUnavailable('The locked method enablement row was not updated');
    }
    yield* appendRevision(updated);
    return { changed: true, record: recordOf(updated) } satisfies ConfigurePaymentMethodEnablementOutcome;
  });

  const configureEnablement = Effect.fn('PaymentApplicabilityPersistence.configureEnablement')(
    function* configureEnablement(input: ConfigurePaymentMethodEnablementInput) {
      const existing = yield* lockCurrent(input.customerConfigurationId, input.method);
      if (Option.isSome(existing)) {
        return yield* reviseLocked(existing.value, input);
      }
      if (Option.isSome(input.expectedRevision)) {
        return yield* paymentMethodEnablementConflict(
          `The method is not configured yet; expected revision ${input.expectedRevision.value} does not exist`,
        );
      }
      const inserted = yield* insertFirst(input);
      if (Option.isSome(inserted)) {
        return { changed: true, record: recordOf(inserted.value) } satisfies ConfigurePaymentMethodEnablementOutcome;
      }
      // A concurrent first configuration committed meanwhile: decide against it under its lock.
      const winner = yield* lockCurrent(input.customerConfigurationId, input.method);
      if (Option.isNone(winner)) {
        return yield* paymentUnavailable('The concurrently configured method enablement is not visible');
      }
      return yield* reviseLocked(winner.value, input);
    },
  );

  return Object.freeze({ configureEnablement, loadCurrentEnablements });
};
