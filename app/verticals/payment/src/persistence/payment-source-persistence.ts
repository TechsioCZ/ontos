import { isPostgresUniqueViolation, OperationContextUnavailable } from '@app/core-runtime';
import type { ActionServiceFactory, ScopedTransactionExecutor } from '@app/core-runtime';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import { PaymentCurrencySchema } from '../../shared/domain/payment-money.ts';
import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import type { PaymentExecutionProvenance } from '../../shared/domain/payment-provenance.ts';
import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type {
  PaymentCorrectionEffectKind,
  PaymentMethod,
  PaymentObservationAcceptanceOutcome,
  PaymentObservationFactKind,
  PaymentReconciliationCaseKind,
  PaymentSourceAuthorityStatus,
  PaymentSourceFactFamily,
} from '../../shared/domain/payment-vocabulary.ts';
import { paymentSourceRejected } from '../../shared/domain/source-statement.ts';
import type { PaymentSourceBinding, PaymentSourceRejected } from '../../shared/domain/source-statement.ts';
import { observations, reconciliationCases, sourceAuthorities, sourceAuthorityRevisions } from '../database/schema.ts';
import { paymentAggregatePersistenceForTransaction } from './payment-aggregate-persistence.ts';
import type { PaymentAggregatePersistence } from './payment-aggregate-persistence.ts';
import type { PaymentAcceptedObservationView } from '../domain/evidence-interpretation.ts';
import type { PaymentRecordedObservationView, PaymentSourceAuthorityView } from '../domain/source-qualification.ts';

/**
 * Owner-local persistence of the external/offline source boundary (#1152): configured source
 * authorities (current row + append-only revision history) and the append-only observation ledger.
 * Every statement first locks the authority rows of its exact source binding and fact family
 * (`SELECT ... FOR UPDATE`), so redeliveries of one source occurrence serialize and resolve to
 * DUPLICATE; the Payment row lock (aggregate persistence) is always taken after it.
 */

export interface PaymentSourceAuthorityIdentity {
  readonly factFamily: PaymentSourceFactFamily;
  readonly method: PaymentMethod | undefined;
  readonly source: PaymentSourceBinding;
}

export interface ConfigurePaymentSourceAuthorityInput extends PaymentSourceAuthorityIdentity {
  readonly expectedRevision: number | undefined;
  readonly provenance: PaymentExecutionProvenance;
  readonly reason: string;
  readonly refundRoute: boolean;
  readonly status: PaymentSourceAuthorityStatus;
}

export interface NewPaymentObservationInput {
  readonly acceptanceOutcome: Exclude<PaymentObservationAcceptanceOutcome, 'DUPLICATE' | 'UNAUTHORIZED_SOURCE'>;
  readonly amount: PaymentMonetaryAmount | undefined;
  readonly authority: PaymentSourceAuthorityView;
  /** Exactly for an accepted SOURCE_CORRECTION: what it did to the Current interpretation. */
  readonly correctionEffect?: PaymentCorrectionEffectKind | undefined;
  readonly correctsObservationId: string | undefined;
  readonly economicEffectKey: string | undefined;
  readonly evidenceRef: string | undefined;
  readonly factFamily: PaymentSourceFactFamily;
  readonly factKind: PaymentObservationFactKind;
  readonly operationId: string | undefined;
  readonly paymentId: string | undefined;
  readonly provenance: PaymentExecutionProvenance;
  readonly receivedAt: DateTime.Utc;
  readonly source: PaymentSourceBinding;
  readonly sourceOccurredAt: DateTime.Utc | undefined;
  readonly sourceOccurrenceId: string;
  readonly sourceRevision: number;
  readonly verifiedAt: DateTime.Utc;
}

export interface OpenReconciliationCaseInput {
  readonly caseKind: PaymentReconciliationCaseKind;
  readonly observationId: string;
  readonly operationId: string | undefined;
  readonly paymentId: string | undefined;
  readonly provenance: PaymentExecutionProvenance;
}

export interface PaymentSourceConfigurationWrite {
  readonly authority: PaymentSourceAuthorityView;
  readonly written: boolean;
}

export type PaymentSourceFailure = PaymentSourceRejected | PaymentUnavailable;

export interface PaymentSourcePersistence {
  readonly configureAuthority: (
    input: ConfigurePaymentSourceAuthorityInput,
  ) => Effect.Effect<PaymentSourceConfigurationWrite, PaymentSourceFailure>;
  readonly findObservation: (
    observationId: string,
  ) => Effect.Effect<Option.Option<PaymentRecordedObservationView>, PaymentUnavailable>;
  readonly findOccurrence: (input: {
    readonly source: PaymentSourceBinding;
    readonly sourceOccurrenceId: string;
    readonly sourceRevision: number;
  }) => Effect.Effect<Option.Option<PaymentRecordedObservationView>, PaymentUnavailable>;
  readonly insertObservation: (input: NewPaymentObservationInput) => Effect.Effect<string, PaymentSourceFailure>;
  readonly listAcceptedObservations: (
    paymentId: string,
  ) => Effect.Effect<readonly PaymentAcceptedObservationView[], PaymentUnavailable>;
  readonly lockAuthorities: (input: {
    readonly factFamily: PaymentSourceFactFamily;
    readonly source: PaymentSourceBinding;
  }) => Effect.Effect<readonly PaymentSourceAuthorityView[], PaymentUnavailable>;
  readonly openReconciliationCase: (input: OpenReconciliationCaseInput) => Effect.Effect<string, PaymentUnavailable>;
}

const readFailure = (cause: unknown) => paymentUnavailable('Payment source state could not be read', cause);
const writeFailure = (cause: unknown) => paymentUnavailable('Payment source state could not be written', cause);

const isLaunchCurrency = Schema.is(PaymentCurrencySchema);

type AuthorityRow = typeof sourceAuthorities.$inferSelect;
type ObservationRow = typeof observations.$inferSelect;

const authorityViewOf = (row: AuthorityRow): PaymentSourceAuthorityView => ({
  accountRef: row.accountRef,
  environment: row.environment,
  factFamily: row.factFamily,
  method: row.method ?? undefined,
  refundRoute: row.refundRoute,
  revision: row.revision,
  sourceAuthorityId: row.sourceAuthorityId,
  sourceKind: row.sourceKind,
  sourceSystem: row.sourceSystem,
  status: row.status,
});

const recordedAmountOf = (row: {
  readonly amountMinor: number | null;
  readonly currency: string | null;
}): Effect.Effect<Option.Option<PaymentMonetaryAmount>, PaymentUnavailable> => {
  const { amountMinor, currency } = row;
  if (amountMinor === null || currency === null) {
    return Effect.succeedNone;
  }
  return isLaunchCurrency(currency)
    ? Effect.succeedSome({ amountMinor, currency })
    : Effect.fail(paymentUnavailable('Stored observation money is unreadable'));
};

const recordedViewOf = (row: ObservationRow) =>
  recordedAmountOf(row).pipe(
    Effect.map((amount): PaymentRecordedObservationView => ({
      acceptanceOutcome: row.acceptanceOutcome,
      amount: Option.getOrUndefined(amount),
      correctsObservationId: row.correctsObservationId ?? undefined,
      economicEffectKey: row.economicEffectKey ?? undefined,
      evidenceRef: row.evidenceRef ?? undefined,
      factFamily: row.factFamily,
      factKind: row.factKind,
      observationId: row.observationId,
      operationId: row.operationId ?? undefined,
      paymentId: row.paymentId ?? undefined,
      sourceAuthorityId: row.sourceAuthorityId ?? undefined,
      sourceOccurredAt: row.sourceOccurredAt === null ? undefined : DateTime.fromDateUnsafe(row.sourceOccurredAt),
    })),
  );

const AUTHORITY_IDENTITY_CONSTRAINTS = new Set(['payment_source_authorities_identity_uk']);
const OCCURRENCE_CONSTRAINTS = new Set(['payment_observations_occurrence_uk']);

const bindingWhere = (
  scope: { readonly legalEntityId: string; readonly tenantId: string },
  source: PaymentSourceBinding,
) =>
  and(
    eq(sourceAuthorities.tenantId, scope.tenantId),
    eq(sourceAuthorities.legalEntityId, scope.legalEntityId),
    eq(sourceAuthorities.sourceKind, source.sourceKind),
    eq(sourceAuthorities.sourceSystem, source.sourceSystem),
    eq(sourceAuthorities.accountRef, source.accountRef),
    eq(sourceAuthorities.environment, source.environment),
  );

const authorityWriteFailure = (cause: unknown) =>
  isPostgresUniqueViolation(cause, AUTHORITY_IDENTITY_CONSTRAINTS)
    ? paymentSourceRejected(
        'payment_source_authority_revision_conflict',
        'A concurrent configuration of the same source authority won this write',
      )
    : writeFailure(cause);

const observationWriteFailure = (cause: unknown) =>
  isPostgresUniqueViolation(cause, OCCURRENCE_CONSTRAINTS)
    ? paymentSourceRejected(
        'payment_source_occurrence_conflict',
        'The same source occurrence and revision was recorded concurrently',
      )
    : writeFailure(cause);

/** Construction is private to a Core-owned transaction; handlers receive only these closed methods. */
export const paymentSourcePersistenceForTransaction = (
  transaction: ScopedTransactionExecutor,
): PaymentSourcePersistence => {
  const ownerScope = Effect.suspend(() => {
    const { legalEntityId, tenantId } = transaction.scope;
    return legalEntityId === undefined
      ? Effect.fail(paymentUnavailable('A verified Selling Legal Entity scope is required'))
      : Effect.succeed({ legalEntityId, tenantId });
  });
  const now = DateTime.now.pipe(Effect.map(DateTime.toDateUtc));

  const lockAuthorities = Effect.fn('PaymentSourcePersistence.lockAuthorities')(function* lockAuthorities(input: {
    readonly factFamily: PaymentSourceFactFamily;
    readonly source: PaymentSourceBinding;
  }) {
    const scope = yield* ownerScope;
    const rows = yield* transaction
      .select()
      .from(sourceAuthorities)
      .where(and(bindingWhere(scope, input.source), eq(sourceAuthorities.factFamily, input.factFamily)))
      .orderBy(asc(sourceAuthorities.sourceAuthorityId))
      .for('update')
      .pipe(Effect.mapError(readFailure));
    return rows.map(authorityViewOf);
  });

  const appendAuthorityRevision = Effect.fn('PaymentSourcePersistence.appendAuthorityRevision')(
    function* appendAuthorityRevision(row: AuthorityRow, recordedAt: Date) {
      yield* transaction
        .insert(sourceAuthorityRevisions)
        .values({
          actionInvocationId: row.actionInvocationId,
          actorPrincipalId: row.actorPrincipalId,
          compositionRevision: row.compositionRevision,
          legalEntityId: row.legalEntityId,
          reason: row.reason,
          recordedAt,
          refundRoute: row.refundRoute,
          revision: row.revision,
          sourceAuthorityId: row.sourceAuthorityId,
          status: row.status,
          tenantId: row.tenantId,
        })
        .pipe(Effect.mapError(writeFailure));
    },
  );

  const configureAuthority = Effect.fn('PaymentSourcePersistence.configureAuthority')(function* configureAuthority(
    input: ConfigurePaymentSourceAuthorityInput,
  ) {
    const scope = yield* ownerScope;
    const [existing] = yield* transaction
      .select()
      .from(sourceAuthorities)
      .where(
        and(
          bindingWhere(scope, input.source),
          eq(sourceAuthorities.factFamily, input.factFamily),
          input.method === undefined ? isNull(sourceAuthorities.method) : eq(sourceAuthorities.method, input.method),
        ),
      )
      .for('update')
      .pipe(Effect.mapError(readFailure));
    if (input.expectedRevision !== undefined && existing?.revision !== input.expectedRevision) {
      return yield* paymentSourceRejected(
        'payment_source_authority_revision_conflict',
        'The source authority revision differs from the expected revision',
      );
    }
    const configuredAt = yield* now;
    const provenance = {
      actionInvocationId: input.provenance.actionInvocationId,
      actorPrincipalId: input.provenance.actorPrincipalId,
      compositionRevision: input.provenance.compositionRevision,
    };
    if (existing === undefined) {
      const [created] = yield* transaction
        .insert(sourceAuthorities)
        .values({
          ...scope,
          ...provenance,
          accountRef: input.source.accountRef,
          configuredAt,
          environment: input.source.environment,
          factFamily: input.factFamily,
          method: input.method ?? null,
          reason: input.reason,
          refundRoute: input.refundRoute,
          revision: 1,
          sourceKind: input.source.sourceKind,
          sourceSystem: input.source.sourceSystem,
          status: input.status,
        })
        .returning()
        .pipe(Effect.mapError(authorityWriteFailure));
      if (created === undefined) {
        return yield* paymentUnavailable('The source authority was not persisted');
      }
      yield* appendAuthorityRevision(created, configuredAt);
      return { authority: authorityViewOf(created), written: true } satisfies PaymentSourceConfigurationWrite;
    }
    if (existing.status === input.status && existing.refundRoute === input.refundRoute) {
      return { authority: authorityViewOf(existing), written: false } satisfies PaymentSourceConfigurationWrite;
    }
    const [updated] = yield* transaction
      .update(sourceAuthorities)
      .set({
        ...provenance,
        configuredAt,
        reason: input.reason,
        refundRoute: input.refundRoute,
        revision: existing.revision + 1,
        status: input.status,
      })
      .where(
        and(
          eq(sourceAuthorities.tenantId, scope.tenantId),
          eq(sourceAuthorities.legalEntityId, scope.legalEntityId),
          eq(sourceAuthorities.sourceAuthorityId, existing.sourceAuthorityId),
          eq(sourceAuthorities.revision, existing.revision),
        ),
      )
      .returning()
      .pipe(Effect.mapError(authorityWriteFailure));
    if (updated === undefined) {
      return yield* paymentSourceRejected(
        'payment_source_authority_revision_conflict',
        'The source authority changed concurrently',
      );
    }
    yield* appendAuthorityRevision(updated, configuredAt);
    return { authority: authorityViewOf(updated), written: true } satisfies PaymentSourceConfigurationWrite;
  });

  const findOccurrence = Effect.fn('PaymentSourcePersistence.findOccurrence')(function* findOccurrence(input: {
    readonly source: PaymentSourceBinding;
    readonly sourceOccurrenceId: string;
    readonly sourceRevision: number;
  }) {
    const scope = yield* ownerScope;
    const [row] = yield* transaction
      .select()
      .from(observations)
      .where(
        and(
          eq(observations.tenantId, scope.tenantId),
          eq(observations.legalEntityId, scope.legalEntityId),
          eq(observations.sourceKind, input.source.sourceKind),
          eq(observations.sourceSystem, input.source.sourceSystem),
          eq(observations.accountRef, input.source.accountRef),
          eq(observations.environment, input.source.environment),
          eq(observations.sourceOccurrenceId, input.sourceOccurrenceId),
          eq(observations.sourceRevision, input.sourceRevision),
        ),
      )
      .pipe(Effect.mapError(readFailure));
    return row === undefined ? Option.none() : Option.some(yield* recordedViewOf(row));
  });

  const findObservation = Effect.fn('PaymentSourcePersistence.findObservation')(function* findObservation(
    observationId: string,
  ) {
    const scope = yield* ownerScope;
    const [row] = yield* transaction
      .select()
      .from(observations)
      .where(
        and(
          eq(observations.tenantId, scope.tenantId),
          eq(observations.legalEntityId, scope.legalEntityId),
          eq(observations.observationId, observationId),
        ),
      )
      .pipe(Effect.mapError(readFailure));
    return row === undefined ? Option.none() : Option.some(yield* recordedViewOf(row));
  });

  const listAcceptedObservations = Effect.fn('PaymentSourcePersistence.listAcceptedObservations')(
    function* listAcceptedObservations(paymentId: string) {
      const scope = yield* ownerScope;
      const rows = yield* transaction
        .select()
        .from(observations)
        .where(
          and(
            eq(observations.tenantId, scope.tenantId),
            eq(observations.legalEntityId, scope.legalEntityId),
            eq(observations.paymentId, paymentId),
            eq(observations.acceptanceOutcome, 'ACCEPTED_OBSERVATION'),
          ),
        )
        .orderBy(asc(observations.verifiedAt), asc(observations.observationId))
        .pipe(Effect.mapError(readFailure));
      return yield* Effect.forEach(
        rows,
        (row) =>
          recordedAmountOf(row).pipe(
            Effect.map((amount): PaymentAcceptedObservationView => ({
              amount: Option.getOrUndefined(amount),
              correctsObservationId: row.correctsObservationId ?? undefined,
              economicEffectKey: row.economicEffectKey ?? undefined,
              factKind: row.factKind,
              observationId: row.observationId,
              operationId: row.operationId ?? undefined,
            })),
          ),
        { concurrency: 1 },
      );
    },
  );

  const insertObservation = Effect.fn('PaymentSourcePersistence.insertObservation')(function* insertObservation(
    input: NewPaymentObservationInput,
  ) {
    const scope = yield* ownerScope;
    const [row] = yield* transaction
      .insert(observations)
      .values({
        ...scope,
        acceptanceOutcome: input.acceptanceOutcome,
        accountRef: input.source.accountRef,
        actionInvocationId: input.provenance.actionInvocationId,
        actorPrincipalId: input.provenance.actorPrincipalId,
        amountMinor: input.amount?.amountMinor ?? null,
        compositionRevision: input.provenance.compositionRevision,
        correctionEffect: input.correctionEffect ?? null,
        correctsObservationId: input.correctsObservationId ?? null,
        currency: input.amount?.currency ?? null,
        economicEffectKey: input.economicEffectKey ?? null,
        environment: input.source.environment,
        evidenceRef: input.evidenceRef ?? null,
        factFamily: input.factFamily,
        factKind: input.factKind,
        operationId: input.operationId ?? null,
        paymentId: input.paymentId ?? null,
        receivedAt: DateTime.toDateUtc(input.receivedAt),
        sourceAuthorityId: input.authority.sourceAuthorityId,
        sourceAuthorityRevision: input.authority.revision,
        sourceKind: input.source.sourceKind,
        sourceOccurredAt: input.sourceOccurredAt === undefined ? null : DateTime.toDateUtc(input.sourceOccurredAt),
        sourceOccurrenceId: input.sourceOccurrenceId,
        sourceRevision: input.sourceRevision,
        sourceSystem: input.source.sourceSystem,
        verifiedAt: DateTime.toDateUtc(input.verifiedAt),
      })
      .returning({ observationId: observations.observationId })
      .pipe(Effect.mapError(observationWriteFailure));
    if (row === undefined) {
      return yield* paymentUnavailable('The Payment Observation was not persisted');
    }
    return row.observationId;
  });

  const openReconciliationCase = Effect.fn('PaymentSourcePersistence.openReconciliationCase')(
    function* openReconciliationCase(input: OpenReconciliationCaseInput) {
      const scope = yield* ownerScope;
      const openedAt = yield* now;
      const [row] = yield* transaction
        .insert(reconciliationCases)
        .values({
          ...scope,
          actionInvocationId: input.provenance.actionInvocationId,
          actorPrincipalId: input.provenance.actorPrincipalId,
          caseKind: input.caseKind,
          closedAt: null,
          compositionRevision: input.provenance.compositionRevision,
          observationId: input.observationId,
          openedAt,
          operationId: input.operationId ?? null,
          paymentId: input.paymentId ?? null,
          revision: 1,
          status: 'OPEN',
        })
        .returning({ caseId: reconciliationCases.caseId })
        .pipe(Effect.mapError(writeFailure));
      if (row === undefined) {
        return yield* paymentUnavailable('The reconciliation case was not persisted');
      }
      return row.caseId;
    },
  );

  return Object.freeze({
    configureAuthority,
    findObservation,
    findOccurrence,
    insertObservation,
    listAcceptedObservations,
    lockAuthorities,
    openReconciliationCase,
  });
};

/** The owner services of the source Actions, built over the Core-installed scoped transaction. */
export interface PaymentSourceServices {
  readonly aggregate: PaymentAggregatePersistence;
  readonly source: PaymentSourcePersistence;
}

/**
 * Action service factory: both persistences share the one Core-owned transaction and its trusted
 * Tenant / Selling Legal Entity scope; a scope without a legal entity has no source authority.
 */
export const paymentSourceServicesForTransaction: ActionServiceFactory<PaymentSourceServices> = (transaction, scope) =>
  scope.legalEntityId === undefined
    ? Effect.fail(
        new OperationContextUnavailable({
          code: 'operation_context_unavailable',
          reason: 'Payment source operations require a trusted Selling Legal Entity',
        }),
      )
    : Effect.succeed(
        Object.freeze({
          aggregate: paymentAggregatePersistenceForTransaction(transaction),
          source: paymentSourcePersistenceForTransaction(transaction),
        }),
      );
