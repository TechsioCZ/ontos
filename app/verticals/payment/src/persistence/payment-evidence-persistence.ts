import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import type { PaymentAuthorizationProof } from '../../shared/domain/authorization-proof.ts';
import { paymentEvidenceRejected } from '../../shared/domain/evidence-contract.ts';
import type { PaymentEvidenceRejected } from '../../shared/domain/evidence-contract.ts';
import { PaymentExecutionBindingSchema } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import type { PaymentExecutionProvenance } from '../../shared/domain/payment-provenance.ts';
import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import { UNRESOLVED_PAYMENT_OPERATION_OUTCOMES } from '../../shared/domain/payment-vocabulary.ts';
import type { PaymentSourceBinding } from '../../shared/domain/source-statement.ts';
import type {
  PaymentMethod,
  PaymentObservationAcceptanceOutcome,
  PaymentObservationFactKind,
  PaymentOperationKind,
  PaymentOperationOutcome,
  PaymentOutcomeTransitionCause,
  PaymentReconciliationCaseKind,
  PaymentReconciliationCaseStatus,
  PaymentReconciliationDecisionKind,
  PaymentRecoveryMode,
  PaymentRefundBasisKind,
  PaymentSourceAuthorityStatus,
  PaymentSourceFactFamily,
  PaymentSourceKind,
} from '../../shared/domain/payment-vocabulary.ts';
import type { PaymentAcceptedObservationView, PaymentInterpretedEvidence } from '../domain/evidence-interpretation.ts';
import type { PaymentReconciliationEstablishedEffect } from '../domain/evidence-reconciliation.ts';
import {
  economicEffectAttributions,
  observations,
  operationOutcomeTransitions,
  paymentAuthorizations,
  paymentOperations,
  payments,
  reconciliationCases,
  reconciliationDecisions,
  recoveryRequests,
  sourceAuthorities,
} from '../database/schema.ts';
import { fullyDisprovenTargets } from './payment-full-disproof.ts';
import type { DisproofCorrectionRow, DisproofTargetRow } from './payment-full-disproof.ts';
import type { PaymentAggregatePersistence } from './payment-aggregate-persistence.ts';
import { paymentAuthorizationProofOfRow } from './payment-authorization-persistence.ts';

/**
 * Owner-local persistence of the #1151 evidence lane: accepted-observation lineage for the
 * interpreter, append-only recovery requests, reconciliation cases/decisions and the bounded read
 * projections (unresolved debt, immutable history). Mutations run inside the Action transaction after
 * the Payment row lock (`loadAggregate(..., { lock: true })`); this module never locks the Payment.
 */

/** Hard bound of one history/debt projection collection; larger sets are reported as truncated. */
export const PAYMENT_EVIDENCE_PROJECTION_LIMIT = 500;

const readFailure = (cause: unknown) => paymentUnavailable('Payment evidence could not be read', cause);
/** Corrections recorded from a configured authority; refused (unauthorized/unsupported) statements disprove nothing. */
const QUALIFIED_CORRECTION_OUTCOMES = ['ACCEPTED_OBSERVATION', 'HELD_UNRESOLVED', 'CONFLICT'] as const;
/** Statements recorded from a configured authority (accepted, held or conflicting); refusals state nothing. */
const QUALIFIED_STATEMENT_OUTCOMES = QUALIFIED_CORRECTION_OUTCOMES;
/** Evidence ledgers carry no business uniqueness of their own: a refused write is an outage, never success. */
const writeFailure = (cause: unknown) => paymentUnavailable('Payment evidence could not be written', cause);
const MoneySchema = Schema.Struct({ amountMinor: Schema.Finite, currency: Schema.Literal('CZK') });
const decodeMoney = Schema.decodeUnknownEffect(MoneySchema);

const amountOrUndefined = (amountMinor: number | null, currency: string | null) =>
  amountMinor === null || currency === null
    ? Effect.succeed(Option.none<PaymentMonetaryAmount>())
    : decodeMoney({ amountMinor, currency }).pipe(
        Effect.map(Option.some),
        Effect.mapError((cause) => paymentUnavailable('Stored observation money is unreadable', cause)),
      );

const utc = (value: Date) => DateTime.fromDateUnsafe(value);
const optionalUtc = (value: Date | null) => (value === null ? undefined : utc(value));

const provenanceOf = (row: {
  readonly actionInvocationId: string;
  readonly actorPrincipalId: string;
  readonly compositionRevision: string;
}): PaymentExecutionProvenance => ({
  actionInvocationId: row.actionInvocationId,
  actorPrincipalId: row.actorPrincipalId,
  compositionRevision: row.compositionRevision,
});

export interface PaymentReconciliationCaseRecord {
  readonly caseId: string;
  readonly caseKind: PaymentReconciliationCaseKind;
  readonly closedAt: DateTime.Utc | undefined;
  readonly observationId: string | undefined;
  readonly openedAt: DateTime.Utc;
  readonly operationId: string | undefined;
  readonly paymentId: string | undefined;
  readonly provenance: PaymentExecutionProvenance;
  readonly revision: number;
  readonly status: PaymentReconciliationCaseStatus;
}

export interface PaymentReconciliationDecisionRecord {
  readonly caseId: string;
  readonly decidedAt: DateTime.Utc;
  readonly decisionId: string;
  readonly decisionKind: PaymentReconciliationDecisionKind;
  readonly evidenceRef: string | undefined;
  readonly provenance: PaymentExecutionProvenance;
  readonly reason: string;
  readonly resultingOutcome: PaymentOperationOutcome | undefined;
}

/** One governed ATTACH_EVIDENCE decision of an observation and the operation it concerned. */
export interface PaymentObservationAttachmentRecord {
  readonly decisionId: string;
  readonly observationId: string;
  /** The operation whose outcome the decision changed, else the case's operation; undefined when neither. */
  readonly operationId: string | undefined;
  readonly resultingOutcome: PaymentOperationOutcome | undefined;
}

export interface PaymentObservationRecord {
  readonly acceptanceOutcome: PaymentObservationAcceptanceOutcome;
  readonly accountRef: string;
  readonly amount: PaymentMonetaryAmount | undefined;
  /** Selected-capability sources of a Payment only: qualification proved the selected capability (#1152). */
  readonly capabilityCorrelated: boolean | undefined;
  readonly correctsObservationId: string | undefined;
  readonly economicEffectKey: string | undefined;
  readonly environment: string;
  readonly evidenceRef: string | undefined;
  readonly factFamily: PaymentSourceFactFamily;
  readonly factKind: PaymentObservationFactKind;
  readonly observationId: string;
  readonly operationId: string | undefined;
  readonly paymentId: string | undefined;
  readonly provenance: PaymentExecutionProvenance;
  readonly receivedAt: DateTime.Utc;
  readonly sourceAuthorityId: string | undefined;
  readonly sourceAuthorityRevision: number | undefined;
  readonly sourceKind: PaymentSourceKind;
  readonly sourceOccurredAt: DateTime.Utc | undefined;
  readonly sourceOccurrenceId: string;
  readonly sourceRevision: number;
  readonly sourceSystem: string;
  readonly verifiedAt: DateTime.Utc;
}

export interface PaymentRecoveryRequestRecord {
  readonly binding: PaymentExecutionBinding;
  readonly mode: PaymentRecoveryMode;
  readonly operationId: string;
  readonly paymentId: string;
  readonly provenance: PaymentExecutionProvenance;
  readonly reason: string;
  readonly recoveryId: string;
  readonly requestedAt: DateTime.Utc;
}

export interface PaymentOpenOperationRecord {
  readonly amount: PaymentMonetaryAmount;
  readonly createdAt: DateTime.Utc;
  readonly kind: PaymentOperationKind;
  readonly operationId: string;
  readonly originalProvenance: PaymentExecutionProvenance;
  readonly outcome: PaymentOperationOutcome;
  readonly outcomeRevision: number;
  readonly paymentId: string;
}

export interface PaymentHistoryOperationRecord {
  readonly amount: PaymentMonetaryAmount;
  readonly binding: PaymentExecutionBinding;
  readonly createdAt: DateTime.Utc;
  readonly kind: PaymentOperationKind;
  readonly materialHash: string;
  readonly operationId: string;
  readonly operationKey: string;
  readonly provenance: PaymentExecutionProvenance;
  readonly refundBasisKind: PaymentRefundBasisKind | undefined;
  readonly targetOperationId: string | undefined;
}

export interface PaymentHistoryTransitionRecord {
  readonly causeId: string | undefined;
  readonly causeKind: PaymentOutcomeTransitionCause;
  readonly fromOutcome: PaymentOperationOutcome | undefined;
  readonly operationId: string;
  readonly outcomeRevision: number;
  readonly provenance: PaymentExecutionProvenance;
  readonly recordedAt: DateTime.Utc;
  readonly toOutcome: PaymentOperationOutcome;
}

export interface PaymentHistoryPaymentRecord {
  readonly amount: PaymentMonetaryAmount;
  readonly createdAt: DateTime.Utc;
  readonly executionBinding: PaymentExecutionBinding;
  readonly method: PaymentMethod;
  readonly paymentId: string;
  readonly predecessorPaymentId: string | undefined;
  readonly provenance: PaymentExecutionProvenance;
  readonly purchaseCorrelationId: string;
}

export interface PaymentHistoryRecord {
  /** The original immutable proofs exactly as issued (#1149 historical recovery). */
  readonly authorizations: readonly PaymentAuthorizationProof[];
  readonly cases: readonly PaymentReconciliationCaseRecord[];
  readonly decisions: readonly PaymentReconciliationDecisionRecord[];
  readonly observations: readonly PaymentObservationRecord[];
  readonly operations: readonly PaymentHistoryOperationRecord[];
  readonly payment: PaymentHistoryPaymentRecord;
  readonly recoveries: readonly PaymentRecoveryRequestRecord[];
  readonly transitions: readonly PaymentHistoryTransitionRecord[];
  readonly truncated: boolean;
}

export interface NewRecoveryRequestInput {
  readonly binding: PaymentExecutionBinding;
  readonly mode: PaymentRecoveryMode;
  readonly operationId: string;
  readonly paymentId: string;
  readonly provenance: PaymentExecutionProvenance;
  readonly reason: string;
  readonly requestedAt: DateTime.Utc;
}

export interface OpenReconciliationCaseInput {
  readonly caseKind: PaymentReconciliationCaseKind;
  readonly observationId?: string;
  readonly openedAt: DateTime.Utc;
  readonly operationId?: string;
  readonly paymentId: string;
  readonly provenance: PaymentExecutionProvenance;
}

export interface NewReconciliationDecisionInput {
  readonly caseId: string;
  readonly decidedAt: DateTime.Utc;
  readonly decisionKind: PaymentReconciliationDecisionKind;
  readonly evidenceRef: Option.Option<string>;
  /** The operation the decision counted its evidence toward (ATTACH_EVIDENCE). */
  readonly operationId: Option.Option<string>;
  readonly provenance: PaymentExecutionProvenance;
  readonly reason: string;
  readonly resultingOutcome: Option.Option<PaymentOperationOutcome>;
}

type CaseRow = typeof reconciliationCases.$inferSelect;
type DecisionRow = typeof reconciliationDecisions.$inferSelect;
type ObservationRow = typeof observations.$inferSelect;
type RecoveryRow = typeof recoveryRequests.$inferSelect;

/** One statement as the interpreter reads it, counted toward `operationId`. */
const interpretedViewOf = (row: ObservationRow, operationId: string | undefined) =>
  amountOrUndefined(row.amountMinor, row.currency).pipe(
    Effect.map((amount): PaymentAcceptedObservationView => ({
      amount: Option.getOrUndefined(amount),
      correctsObservationId: row.correctsObservationId ?? undefined,
      economicEffectKey: row.economicEffectKey ?? undefined,
      factKind: row.factKind,
      observationId: row.observationId,
      operationId,
      source: {
        accountRef: row.accountRef,
        environment: row.environment,
        sourceKind: row.sourceKind,
        sourceSystem: row.sourceSystem,
      },
      sourceAuthorityId: row.sourceAuthorityId ?? undefined,
    })),
  );

const caseRecordOf = (row: CaseRow): PaymentReconciliationCaseRecord => ({
  caseId: row.caseId,
  caseKind: row.caseKind,
  closedAt: optionalUtc(row.closedAt),
  observationId: row.observationId ?? undefined,
  openedAt: utc(row.openedAt),
  operationId: row.operationId ?? undefined,
  paymentId: row.paymentId ?? undefined,
  provenance: provenanceOf(row),
  revision: row.revision,
  status: row.status,
});

/** The fully disproven statements among rows that hold both the statements and their corrections. */
const fullyDisprovenIds = (rows: readonly (DisproofCorrectionRow & DisproofTargetRow)[]): ReadonlySet<string> =>
  fullyDisprovenTargets(rows, rows);

/** The immutable source binding a stored statement was issued under. */
const effectSourceOf = (row: Pick<ObservationRow, 'accountRef' | 'environment' | 'sourceKind' | 'sourceSystem'>) => ({
  accountRef: row.accountRef,
  environment: row.environment,
  sourceKind: row.sourceKind,
  sourceSystem: row.sourceSystem,
});

const decisionRecordOf = (row: DecisionRow): PaymentReconciliationDecisionRecord => ({
  caseId: row.caseId,
  decidedAt: utc(row.decidedAt),
  decisionId: row.decisionId,
  decisionKind: row.decisionKind,
  evidenceRef: row.evidenceRef ?? undefined,
  provenance: provenanceOf(row),
  reason: row.reason,
  resultingOutcome: row.resultingOutcome ?? undefined,
});

const observationRecordOf = Effect.fn('PaymentEvidencePersistence.observationRecordOf')(function* observationRecordOf(
  row: ObservationRow,
) {
  const amount = yield* amountOrUndefined(row.amountMinor, row.currency);
  return {
    acceptanceOutcome: row.acceptanceOutcome,
    accountRef: row.accountRef,
    amount: Option.getOrUndefined(amount),
    capabilityCorrelated: row.capabilityCorrelated ?? undefined,
    correctsObservationId: row.correctsObservationId ?? undefined,
    economicEffectKey: row.economicEffectKey ?? undefined,
    environment: row.environment,
    evidenceRef: row.evidenceRef ?? undefined,
    factFamily: row.factFamily,
    factKind: row.factKind,
    observationId: row.observationId,
    operationId: row.operationId ?? undefined,
    paymentId: row.paymentId ?? undefined,
    provenance: provenanceOf(row),
    receivedAt: utc(row.receivedAt),
    sourceAuthorityId: row.sourceAuthorityId ?? undefined,
    sourceAuthorityRevision: row.sourceAuthorityRevision ?? undefined,
    sourceKind: row.sourceKind,
    sourceOccurredAt: optionalUtc(row.sourceOccurredAt),
    sourceOccurrenceId: row.sourceOccurrenceId,
    sourceRevision: row.sourceRevision,
    sourceSystem: row.sourceSystem,
    verifiedAt: utc(row.verifiedAt),
  } satisfies PaymentObservationRecord;
});

const decodeBinding = (value: Schema.Json) =>
  Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentExecutionBindingSchema))(value).pipe(
    Effect.mapError((cause) => paymentUnavailable('A stored execution binding is unreadable', cause)),
  );
const encodeBinding = (value: PaymentExecutionBinding) =>
  Schema.encodeEffect(Schema.toCodecJson(PaymentExecutionBindingSchema))(value).pipe(
    Effect.mapError((cause) => paymentUnavailable('The execution binding could not be encoded', cause)),
  );

const recoveryRecordOf = Effect.fn('PaymentEvidencePersistence.recoveryRecordOf')(function* recoveryRecordOf(
  row: RecoveryRow,
) {
  return {
    binding: yield* decodeBinding(row.bindingSnapshot),
    mode: row.mode,
    operationId: row.operationId,
    paymentId: row.paymentId,
    provenance: provenanceOf(row),
    reason: row.reason,
    recoveryId: row.recoveryId,
    requestedAt: utc(row.requestedAt),
  } satisfies PaymentRecoveryRequestRecord;
});

const money = (amountMinor: number, currency: string) =>
  decodeMoney({ amountMinor, currency }).pipe(
    Effect.mapError((cause) => paymentUnavailable('Stored Payment money is unreadable', cause)),
  );

const truncate = <Row>(rows: readonly Row[]) => ({
  rows: rows.slice(0, PAYMENT_EVIDENCE_PROJECTION_LIMIT),
  truncated: rows.length > PAYMENT_EVIDENCE_PROJECTION_LIMIT,
});

/** One confirmed source economic effect claimed for the operation a statement establishes (#1151). */
export interface PaymentEconomicEffectAttributionInput {
  readonly economicEffectKey: string;
  readonly factKind: PaymentObservationFactKind;
  readonly operationId: string;
  readonly paymentId: string;
  readonly provenance: PaymentExecutionProvenance;
  readonly source: PaymentSourceBinding;
}

/** `ATTRIBUTED_ELSEWHERE`: the effect already established another operation, of this or another Payment. */
export const PaymentEconomicEffectAttributionSchema = Schema.Literals(['ATTRIBUTED', 'ATTRIBUTED_ELSEWHERE']);
export type PaymentEconomicEffectAttribution = typeof PaymentEconomicEffectAttributionSchema.Type;

export interface PaymentEvidencePersistence {
  /**
   * Claims the source economic effect for one operation across every Payment of the trusted scope: the
   * first claim appends the attribution; a later or concurrent claim of the same operation is the same
   * attribution, any other operation is `ATTRIBUTED_ELSEWHERE`. A concurrent first claim waits on the
   * unique key and then reads the committed winner, so exactly one operation is ever attributed.
   */
  readonly attributeEconomicEffect: (
    input: PaymentEconomicEffectAttributionInput,
  ) => Effect.Effect<PaymentEconomicEffectAttribution, PaymentUnavailable>;
  readonly closeCase: (input: {
    readonly caseId: string;
    readonly closedAt: DateTime.Utc;
    readonly expectedRevision: number;
  }) => Effect.Effect<PaymentReconciliationCaseRecord, PaymentUnavailable | PaymentEvidenceRejected>;
  /** Reads one case without a lock (used to find the Payment to lock first). */
  readonly findCase: (
    caseId: string,
  ) => Effect.Effect<Option.Option<PaymentReconciliationCaseRecord>, PaymentUnavailable>;
  readonly findObservation: (
    observationId: string,
  ) => Effect.Effect<Option.Option<PaymentObservationRecord>, PaymentUnavailable>;
  readonly findSourceAuthorityStatus: (
    sourceAuthorityId: string,
  ) => Effect.Effect<Option.Option<PaymentSourceAuthorityStatus>, PaymentUnavailable>;
  /** Whether the case already records a decision of this kind. */
  readonly hasCaseDecision: (
    caseId: string,
    decisionKind: PaymentReconciliationDecisionKind,
  ) => Effect.Effect<boolean, PaymentUnavailable>;
  readonly insertDecision: (
    input: NewReconciliationDecisionInput,
  ) => Effect.Effect<PaymentReconciliationDecisionRecord, PaymentUnavailable>;
  readonly insertRecoveryRequest: (
    input: NewRecoveryRequestInput,
  ) => Effect.Effect<PaymentRecoveryRequestRecord, PaymentUnavailable>;
  /** Whether an uncorrected statement of the same source binding, fact kind and economic effect key already counts toward an operation (see implementation). */
  readonly isEconomicEffectCounted: (input: {
    readonly economicEffectKey: string;
    readonly excludeObservationId: string;
    readonly factKind: PaymentObservationFactKind;
    /** A Payment-bound statement counts only for its own Payment; an unassigned one for any Payment of the scope. */
    readonly paymentId: string | undefined;
    readonly source: PaymentSourceBinding;
  }) => Effect.Effect<boolean, PaymentUnavailable>;
  /** Whether a qualified SOURCE_CORRECTION fully disproves this observation (the shared full-disproof rule). */
  readonly isObservationCorrected: (observationId: string) => Effect.Effect<boolean, PaymentUnavailable>;
  /** Whether an applied full SOURCE_CORRECTION already reopened this observation, so its effect no longer stands. */
  readonly isObservationReopened: (observationId: string) => Effect.Effect<boolean, PaymentUnavailable>;
  /**
   * Uncorrected statements of one Payment whose effect already counts toward an operation: accepted
   * interpretations naming the operation and governed attachments that resolved one.
   */
  readonly listEstablishedEffects: (
    paymentId: string,
  ) => Effect.Effect<readonly PaymentReconciliationEstablishedEffect[], PaymentUnavailable>;
  /** The interpreter's lineage input for one Payment: accepted and governed-attached statements. */
  readonly listInterpretedEvidence: (
    paymentId: string,
  ) => Effect.Effect<PaymentInterpretedEvidence, PaymentUnavailable>;
  /** Governed ATTACH_EVIDENCE decisions of these observations, in any case of this scope. */
  readonly listObservationAttachments: (
    observationIds: readonly string[],
  ) => Effect.Effect<readonly PaymentObservationAttachmentRecord[], PaymentUnavailable>;
  readonly listOpenCases: (
    paymentId: string | undefined,
  ) => Effect.Effect<
    { readonly rows: readonly PaymentReconciliationCaseRecord[]; readonly truncated: boolean },
    PaymentUnavailable
  >;
  readonly listOpenOperations: (
    paymentId: string | undefined,
  ) => Effect.Effect<
    { readonly rows: readonly PaymentOpenOperationRecord[]; readonly truncated: boolean },
    PaymentUnavailable
  >;
  /**
   * Authority-qualified observations of one Payment from the same source binding (under any of its
   * configured authority records) stating the same economic effect.
   */
  readonly listSameEffectObservations: (input: {
    readonly economicEffectKey: string;
    readonly factKind: PaymentObservationFactKind;
    readonly paymentId: string;
    readonly source: PaymentSourceBinding;
  }) => Effect.Effect<readonly PaymentObservationRecord[], PaymentUnavailable>;
  readonly loadHistory: (paymentId: string) => Effect.Effect<Option.Option<PaymentHistoryRecord>, PaymentUnavailable>;
  /** Locks one case of this scope; a foreign or unknown case is not found. */
  readonly lockCase: (
    caseId: string,
  ) => Effect.Effect<PaymentReconciliationCaseRecord, PaymentUnavailable | PaymentEvidenceRejected>;
  /** Opens explicit reconciliation debt once per (operation, kind); an existing open case is reused. */
  readonly openCase: (
    input: OpenReconciliationCaseInput,
  ) => Effect.Effect<
    { readonly created: boolean; readonly record: PaymentReconciliationCaseRecord },
    PaymentUnavailable
  >;
}

/** Construction is private to a Core-owned transaction (Action or Read). */
export const paymentEvidencePersistenceForTransaction = (
  transaction: ScopedTransactionExecutor,
): PaymentEvidencePersistence => {
  const ownerScope = Effect.suspend(() => {
    const { legalEntityId, tenantId } = transaction.scope;
    return legalEntityId === undefined
      ? Effect.fail(paymentUnavailable('A verified Selling Legal Entity scope is required'))
      : Effect.succeed({ legalEntityId, tenantId });
  });

  const findObservation = Effect.fn('PaymentEvidencePersistence.findObservation')(function* findObservation(
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
    return row === undefined ? Option.none() : Option.some(yield* observationRecordOf(row));
  });

  const findSourceAuthorityStatus = Effect.fn('PaymentEvidencePersistence.findSourceAuthorityStatus')(
    function* findSourceAuthorityStatus(sourceAuthorityId: string) {
      const scope = yield* ownerScope;
      const [row] = yield* transaction
        .select({ status: sourceAuthorities.status })
        .from(sourceAuthorities)
        .where(
          and(
            eq(sourceAuthorities.tenantId, scope.tenantId),
            eq(sourceAuthorities.legalEntityId, scope.legalEntityId),
            eq(sourceAuthorities.sourceAuthorityId, sourceAuthorityId),
          ),
        )
        .pipe(Effect.mapError(readFailure));
      return Option.fromNullishOr(row?.status);
    },
  );

  const hasCaseDecision = Effect.fn('PaymentEvidencePersistence.hasCaseDecision')(function* hasCaseDecision(
    caseId: string,
    decisionKind: PaymentReconciliationDecisionKind,
  ) {
    const scope = yield* ownerScope;
    const [row] = yield* transaction
      .select({ decisionId: reconciliationDecisions.decisionId })
      .from(reconciliationDecisions)
      .where(
        and(
          eq(reconciliationDecisions.tenantId, scope.tenantId),
          eq(reconciliationDecisions.legalEntityId, scope.legalEntityId),
          eq(reconciliationDecisions.caseId, caseId),
          eq(reconciliationDecisions.decisionKind, decisionKind),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(readFailure));
    return row !== undefined;
  });

  const listObservationAttachments = Effect.fn('PaymentEvidencePersistence.listObservationAttachments')(
    function* listObservationAttachments(observationIds: readonly string[]) {
      if (observationIds.length === 0) {
        return [];
      }
      const scope = yield* ownerScope;
      // The decision itself records the operation it counted the evidence toward, so an attachment to
      // an already confirmed operation (no transition) of an operationless case keeps its target.
      const decisionRows = yield* transaction
        .select({
          decisionId: reconciliationDecisions.decisionId,
          evidenceRef: reconciliationDecisions.evidenceRef,
          operationId: reconciliationDecisions.operationId,
          resultingOutcome: reconciliationDecisions.resultingOutcome,
        })
        .from(reconciliationDecisions)
        .where(
          and(
            eq(reconciliationDecisions.tenantId, scope.tenantId),
            eq(reconciliationDecisions.legalEntityId, scope.legalEntityId),
            eq(reconciliationDecisions.decisionKind, 'ATTACH_EVIDENCE'),
            inArray(reconciliationDecisions.evidenceRef, [...observationIds]),
          ),
        )
        .orderBy(asc(reconciliationDecisions.decidedAt), asc(reconciliationDecisions.decisionId))
        .pipe(Effect.mapError(readFailure));
      return decisionRows.flatMap((row): PaymentObservationAttachmentRecord[] =>
        row.evidenceRef === null
          ? []
          : [
              {
                decisionId: row.decisionId,
                observationId: row.evidenceRef,
                operationId: row.operationId ?? undefined,
                resultingOutcome: row.resultingOutcome ?? undefined,
              },
            ],
      );
    },
  );

  const listInterpretedEvidence = Effect.fn('PaymentEvidencePersistence.listInterpretedEvidence')(
    function* listInterpretedEvidence(paymentId: string) {
      const scope = yield* ownerScope;
      const rows = yield* transaction
        .select()
        .from(observations)
        .where(
          and(
            eq(observations.tenantId, scope.tenantId),
            eq(observations.legalEntityId, scope.legalEntityId),
            eq(observations.paymentId, paymentId),
            inArray(observations.acceptanceOutcome, [...QUALIFIED_STATEMENT_OUTCOMES]),
          ),
        )
        .orderBy(asc(observations.verifiedAt), asc(observations.observationId))
        .pipe(Effect.mapError(readFailure));
      // Only a full disproof removes an attached statement's effect identity; a partial or unqualified
      // correction leaves it standing (#1151).
      const corrected = fullyDisprovenIds(rows);
      const held = rows.filter(
        (row) =>
          row.acceptanceOutcome !== 'ACCEPTED_OBSERVATION' &&
          row.factKind !== 'SOURCE_CORRECTION' &&
          !corrected.has(row.observationId),
      );
      const attachments = yield* listObservationAttachments(held.map((row) => row.observationId));
      const attachedOperation = new Map(
        attachments.flatMap((attachment) =>
          attachment.operationId === undefined || attachment.resultingOutcome === undefined
            ? []
            : [[attachment.observationId, attachment.operationId] as const],
        ),
      );
      const acceptedObservations = yield* Effect.forEach(
        rows.filter((row) => row.acceptanceOutcome === 'ACCEPTED_OBSERVATION'),
        (row) => interpretedViewOf(row, row.operationId ?? undefined),
        { concurrency: 1 },
      );
      const attachedStatements = yield* Effect.forEach(
        held.flatMap((row) => {
          const operationId = attachedOperation.get(row.observationId);
          return operationId === undefined ? [] : [{ operationId, row }];
        }),
        ({ operationId, row }) => interpretedViewOf(row, operationId),
        { concurrency: 1 },
      );
      return {
        acceptedObservations,
        attachedStatements,
        fullyDisprovenObservationIds: corrected,
      } satisfies PaymentInterpretedEvidence;
    },
  );

  /** The statements among these ids that a correction fully disproves (the shared full-disproof rule). */
  const fullyDisprovenAmong = Effect.fn('PaymentEvidencePersistence.fullyDisprovenAmong')(function* fullyDisprovenAmong(
    observationIds: readonly string[],
  ) {
    if (observationIds.length === 0) {
      return new Set<string>();
    }
    const scope = yield* ownerScope;
    const ofScope = and(eq(observations.tenantId, scope.tenantId), eq(observations.legalEntityId, scope.legalEntityId));
    const [targets, corrections] = yield* Effect.all(
      [
        transaction
          .select({
            amountMinor: observations.amountMinor,
            observationId: observations.observationId,
            paymentId: observations.paymentId,
            sourceAuthorityId: observations.sourceAuthorityId,
          })
          .from(observations)
          .where(and(ofScope, inArray(observations.observationId, [...observationIds])))
          .pipe(Effect.mapError(readFailure)),
        transaction
          .select({
            acceptanceOutcome: observations.acceptanceOutcome,
            amountMinor: observations.amountMinor,
            capabilityCorrelated: observations.capabilityCorrelated,
            correctsObservationId: observations.correctsObservationId,
            factKind: observations.factKind,
            paymentId: observations.paymentId,
            sourceAuthorityId: observations.sourceAuthorityId,
          })
          .from(observations)
          .where(
            and(
              ofScope,
              eq(observations.factKind, 'SOURCE_CORRECTION'),
              inArray(observations.correctsObservationId, [...observationIds]),
            ),
          )
          .pipe(Effect.mapError(readFailure)),
      ],
      { concurrency: 1 },
    );
    return fullyDisprovenTargets(targets, corrections);
  });

  /**
   * Whether an APPLIED full correction already reopened the observation's outcome. Narrower than a full
   * disproof on purpose: a disproof that is still held has not changed Current state, so its case must
   * stay open.
   */
  const isObservationReopened = Effect.fn('PaymentEvidencePersistence.isObservationReopened')(
    function* isObservationReopened(observationId: string) {
      const scope = yield* ownerScope;
      const [row] = yield* transaction
        .select({ observationId: observations.observationId })
        .from(observations)
        .where(
          and(
            eq(observations.tenantId, scope.tenantId),
            eq(observations.legalEntityId, scope.legalEntityId),
            eq(observations.factKind, 'SOURCE_CORRECTION'),
            eq(observations.correctionEffect, 'REOPEN_TO_CONFLICT'),
            eq(observations.correctsObservationId, observationId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(readFailure));
      return row !== undefined;
    },
  );

  const isObservationCorrected = Effect.fn('PaymentEvidencePersistence.isObservationCorrected')(
    function* isObservationCorrected(observationId: string) {
      return (yield* fullyDisprovenAmong([observationId])).has(observationId);
    },
  );

  /**
   * Whether the economic effect of a held statement already counts toward an operation: an uncorrected
   * statement of the same source binding, fact kind and key that an accepted interpretation or a governed
   * attachment resolved for the Payment (any Payment when unassigned). The attribution ledger is not
   * consulted: it outlives a full disproof of the statement that claimed the effect.
   */
  const isEconomicEffectCounted = Effect.fn('PaymentEvidencePersistence.isEconomicEffectCounted')(
    function* isEconomicEffectCounted(input: {
      readonly economicEffectKey: string;
      readonly excludeObservationId: string;
      readonly factKind: PaymentObservationFactKind;
      readonly paymentId: string | undefined;
      readonly source: PaymentSourceBinding;
    }) {
      const scope = yield* ownerScope;
      const rows = yield* transaction
        .select({
          acceptanceOutcome: observations.acceptanceOutcome,
          observationId: observations.observationId,
          operationId: observations.operationId,
        })
        .from(observations)
        .where(
          and(
            eq(observations.tenantId, scope.tenantId),
            eq(observations.legalEntityId, scope.legalEntityId),
            input.paymentId === undefined
              ? isNotNull(observations.paymentId)
              : eq(observations.paymentId, input.paymentId),
            isNotNull(observations.sourceAuthorityId),
            eq(observations.sourceKind, input.source.sourceKind),
            eq(observations.sourceSystem, input.source.sourceSystem),
            eq(observations.accountRef, input.source.accountRef),
            eq(observations.environment, input.source.environment),
            eq(observations.economicEffectKey, input.economicEffectKey),
            eq(observations.factKind, input.factKind),
            inArray(observations.acceptanceOutcome, [...QUALIFIED_STATEMENT_OUTCOMES]),
          ),
        )
        .pipe(Effect.mapError(readFailure));
      const candidates = rows.filter((row) => row.observationId !== input.excludeObservationId);
      const reopened = yield* fullyDisprovenAmong(candidates.map((row) => row.observationId));
      const uncorrected = candidates.filter((row) => !reopened.has(row.observationId));
      if (uncorrected.some((row) => row.acceptanceOutcome === 'ACCEPTED_OBSERVATION' && row.operationId !== null)) {
        return true;
      }
      const attachments = yield* listObservationAttachments(uncorrected.map((row) => row.observationId));
      return attachments.some(
        (attachment) => attachment.operationId !== undefined && attachment.resultingOutcome !== undefined,
      );
    },
  );

  const listEstablishedEffects = Effect.fn('PaymentEvidencePersistence.listEstablishedEffects')(
    function* listEstablishedEffects(paymentId: string) {
      const scope = yield* ownerScope;
      const rows = yield* transaction
        .select({
          acceptanceOutcome: observations.acceptanceOutcome,
          accountRef: observations.accountRef,
          amountMinor: observations.amountMinor,
          capabilityCorrelated: observations.capabilityCorrelated,
          correctsObservationId: observations.correctsObservationId,
          economicEffectKey: observations.economicEffectKey,
          environment: observations.environment,
          factKind: observations.factKind,
          observationId: observations.observationId,
          operationId: observations.operationId,
          paymentId: observations.paymentId,
          sourceAuthorityId: observations.sourceAuthorityId,
          sourceKind: observations.sourceKind,
          sourceSystem: observations.sourceSystem,
        })
        .from(observations)
        .where(
          and(
            eq(observations.tenantId, scope.tenantId),
            eq(observations.legalEntityId, scope.legalEntityId),
            eq(observations.paymentId, paymentId),
            inArray(observations.acceptanceOutcome, [...QUALIFIED_STATEMENT_OUTCOMES]),
          ),
        )
        .orderBy(asc(observations.verifiedAt), asc(observations.observationId))
        .pipe(Effect.mapError(readFailure));
      // Only a full disproof removes a statement's effect identity, whatever the operation's outcome was
      // when it arrived; partial or unqualified corrections keep it (#1151).
      const corrected = fullyDisprovenIds(rows);
      const statements = rows.filter(
        (row) => row.factKind !== 'SOURCE_CORRECTION' && !corrected.has(row.observationId),
      );
      const attachments = yield* listObservationAttachments(statements.map((row) => row.observationId));
      const statementOf = new Map(statements.map((row) => [row.observationId, row]));
      const accepted = statements.flatMap((row): PaymentReconciliationEstablishedEffect[] =>
        row.acceptanceOutcome === 'ACCEPTED_OBSERVATION' && row.operationId !== null
          ? [
              {
                economicEffectKey: row.economicEffectKey ?? undefined,
                factKind: row.factKind,
                observationId: row.observationId,
                operationId: row.operationId,
                source: effectSourceOf(row),
              },
            ]
          : [],
      );
      const attached = attachments.flatMap((attachment): PaymentReconciliationEstablishedEffect[] => {
        const statement = statementOf.get(attachment.observationId);
        return statement === undefined ||
          attachment.operationId === undefined ||
          attachment.resultingOutcome === undefined
          ? []
          : [
              {
                economicEffectKey: statement.economicEffectKey ?? undefined,
                factKind: statement.factKind,
                observationId: statement.observationId,
                operationId: attachment.operationId,
                source: effectSourceOf(statement),
              },
            ];
      });
      return [...accepted, ...attached];
    },
  );

  const listSameEffectObservations = Effect.fn('PaymentEvidencePersistence.listSameEffectObservations')(
    function* listSameEffectObservations(input: {
      readonly economicEffectKey: string;
      readonly factKind: PaymentObservationFactKind;
      readonly paymentId: string;
      readonly source: PaymentSourceBinding;
    }) {
      const scope = yield* ownerScope;
      const rows = yield* transaction
        .select()
        .from(observations)
        .where(
          and(
            eq(observations.tenantId, scope.tenantId),
            eq(observations.legalEntityId, scope.legalEntityId),
            eq(observations.paymentId, input.paymentId),
            eq(observations.sourceKind, input.source.sourceKind),
            eq(observations.sourceSystem, input.source.sourceSystem),
            eq(observations.accountRef, input.source.accountRef),
            eq(observations.environment, input.source.environment),
            isNotNull(observations.sourceAuthorityId),
            eq(observations.economicEffectKey, input.economicEffectKey),
            eq(observations.factKind, input.factKind),
          ),
        )
        .orderBy(asc(observations.verifiedAt), asc(observations.observationId))
        .pipe(Effect.mapError(readFailure));
      return yield* Effect.forEach(rows, observationRecordOf, { concurrency: 1 });
    },
  );

  const attributeEconomicEffect = Effect.fn('PaymentEvidencePersistence.attributeEconomicEffect')(
    function* attributeEconomicEffect(input: PaymentEconomicEffectAttributionInput) {
      const scope = yield* ownerScope;
      const attributedAt = DateTime.toDateUtc(yield* DateTime.now);
      const effect = {
        accountRef: input.source.accountRef,
        economicEffectKey: input.economicEffectKey,
        environment: input.source.environment,
        factKind: input.factKind,
        sourceKind: input.source.sourceKind,
        sourceSystem: input.source.sourceSystem,
      };
      const claimed = yield* transaction
        .insert(economicEffectAttributions)
        .values({
          ...scope,
          ...effect,
          actionInvocationId: input.provenance.actionInvocationId,
          actorPrincipalId: input.provenance.actorPrincipalId,
          attributedAt,
          compositionRevision: input.provenance.compositionRevision,
          operationId: input.operationId,
          paymentId: input.paymentId,
        })
        .onConflictDoNothing({
          target: [
            economicEffectAttributions.tenantId,
            economicEffectAttributions.legalEntityId,
            economicEffectAttributions.sourceKind,
            economicEffectAttributions.sourceSystem,
            economicEffectAttributions.accountRef,
            economicEffectAttributions.environment,
            economicEffectAttributions.factKind,
            economicEffectAttributions.economicEffectKey,
          ],
        })
        .returning({ attributionId: economicEffectAttributions.attributionId })
        .pipe(Effect.mapError(writeFailure));
      if (claimed.length > 0) {
        return 'ATTRIBUTED' satisfies PaymentEconomicEffectAttribution;
      }
      const [existing] = yield* transaction
        .select({
          operationId: economicEffectAttributions.operationId,
          paymentId: economicEffectAttributions.paymentId,
        })
        .from(economicEffectAttributions)
        .where(
          and(
            eq(economicEffectAttributions.tenantId, scope.tenantId),
            eq(economicEffectAttributions.legalEntityId, scope.legalEntityId),
            eq(economicEffectAttributions.sourceKind, effect.sourceKind),
            eq(economicEffectAttributions.sourceSystem, effect.sourceSystem),
            eq(economicEffectAttributions.accountRef, effect.accountRef),
            eq(economicEffectAttributions.environment, effect.environment),
            eq(economicEffectAttributions.factKind, effect.factKind),
            eq(economicEffectAttributions.economicEffectKey, effect.economicEffectKey),
          ),
        )
        .pipe(Effect.mapError(readFailure));
      if (existing === undefined) {
        return yield* paymentUnavailable('The conflicting economic effect attribution is unreadable');
      }
      return (
        existing.paymentId === input.paymentId && existing.operationId === input.operationId
          ? 'ATTRIBUTED'
          : 'ATTRIBUTED_ELSEWHERE'
      ) satisfies PaymentEconomicEffectAttribution;
    },
  );

  const insertRecoveryRequest = Effect.fn('PaymentEvidencePersistence.insertRecoveryRequest')(
    function* insertRecoveryRequest(input: NewRecoveryRequestInput) {
      const scope = yield* ownerScope;
      const bindingSnapshot = yield* encodeBinding(input.binding);
      const [row] = yield* transaction
        .insert(recoveryRequests)
        .values({
          ...scope,
          actionInvocationId: input.provenance.actionInvocationId,
          actorPrincipalId: input.provenance.actorPrincipalId,
          bindingSnapshot,
          compositionRevision: input.provenance.compositionRevision,
          mode: input.mode,
          operationId: input.operationId,
          paymentId: input.paymentId,
          reason: input.reason,
          requestedAt: DateTime.toDateUtc(input.requestedAt),
        })
        .returning()
        .pipe(Effect.mapError(writeFailure));
      if (row === undefined) {
        return yield* paymentUnavailable('The recovery request was not persisted');
      }
      return yield* recoveryRecordOf(row);
    },
  );

  const selectCase = Effect.fn('PaymentEvidencePersistence.selectCase')(function* selectCase(
    caseId: string,
    lock: boolean,
  ) {
    const scope = yield* ownerScope;
    const query = transaction
      .select()
      .from(reconciliationCases)
      .where(
        and(
          eq(reconciliationCases.tenantId, scope.tenantId),
          eq(reconciliationCases.legalEntityId, scope.legalEntityId),
          eq(reconciliationCases.caseId, caseId),
        ),
      );
    const [row] = yield* (lock ? query.for('update') : query).pipe(Effect.mapError(readFailure));
    return Option.map(Option.fromNullishOr(row), caseRecordOf);
  });

  const findCase = (caseId: string) => selectCase(caseId, false);

  const lockCase = Effect.fn('PaymentEvidencePersistence.lockCase')(function* lockCase(caseId: string) {
    const record = yield* selectCase(caseId, true);
    if (Option.isNone(record)) {
      return yield* paymentEvidenceRejected(
        'payment_reconciliation_case_not_found',
        'The reconciliation case does not exist in this scope',
      );
    }
    return record.value;
  });

  const closeCase = Effect.fn('PaymentEvidencePersistence.closeCase')(function* closeCase(input: {
    readonly caseId: string;
    readonly closedAt: DateTime.Utc;
    readonly expectedRevision: number;
  }) {
    const scope = yield* ownerScope;
    const [row] = yield* transaction
      .update(reconciliationCases)
      .set({ closedAt: DateTime.toDateUtc(input.closedAt), revision: input.expectedRevision + 1, status: 'CLOSED' })
      .where(
        and(
          eq(reconciliationCases.tenantId, scope.tenantId),
          eq(reconciliationCases.legalEntityId, scope.legalEntityId),
          eq(reconciliationCases.caseId, input.caseId),
          eq(reconciliationCases.status, 'OPEN'),
          eq(reconciliationCases.revision, input.expectedRevision),
        ),
      )
      .returning()
      .pipe(Effect.mapError(writeFailure));
    if (row === undefined) {
      return yield* paymentEvidenceRejected(
        'payment_reconciliation_case_revision_conflict',
        'The reconciliation case changed concurrently',
      );
    }
    return caseRecordOf(row);
  });

  const openCase = Effect.fn('PaymentEvidencePersistence.openCase')(function* openCase(
    input: OpenReconciliationCaseInput,
  ) {
    const scope = yield* ownerScope;
    const subject = and(
      eq(reconciliationCases.tenantId, scope.tenantId),
      eq(reconciliationCases.legalEntityId, scope.legalEntityId),
      eq(reconciliationCases.paymentId, input.paymentId),
      eq(reconciliationCases.caseKind, input.caseKind),
      eq(reconciliationCases.status, 'OPEN'),
      input.operationId === undefined
        ? isNull(reconciliationCases.operationId)
        : eq(reconciliationCases.operationId, input.operationId),
      input.observationId === undefined
        ? isNull(reconciliationCases.observationId)
        : eq(reconciliationCases.observationId, input.observationId),
    );
    const [existing] = yield* transaction
      .select()
      .from(reconciliationCases)
      .where(subject)
      .orderBy(asc(reconciliationCases.openedAt))
      .limit(1)
      .pipe(Effect.mapError(readFailure));
    if (existing !== undefined) {
      return { created: false, record: caseRecordOf(existing) };
    }
    const [row] = yield* transaction
      .insert(reconciliationCases)
      .values({
        ...scope,
        actionInvocationId: input.provenance.actionInvocationId,
        actorPrincipalId: input.provenance.actorPrincipalId,
        caseKind: input.caseKind,
        compositionRevision: input.provenance.compositionRevision,
        observationId: input.observationId ?? null,
        openedAt: DateTime.toDateUtc(input.openedAt),
        operationId: input.operationId ?? null,
        paymentId: input.paymentId,
        revision: 1,
        status: 'OPEN',
      })
      .returning()
      .pipe(Effect.mapError(writeFailure));
    if (row === undefined) {
      return yield* paymentUnavailable('The reconciliation case was not persisted');
    }
    return { created: true, record: caseRecordOf(row) };
  });

  const insertDecision = Effect.fn('PaymentEvidencePersistence.insertDecision')(function* insertDecision(
    input: NewReconciliationDecisionInput,
  ) {
    const scope = yield* ownerScope;
    const [row] = yield* transaction
      .insert(reconciliationDecisions)
      .values({
        ...scope,
        actionInvocationId: input.provenance.actionInvocationId,
        actorPrincipalId: input.provenance.actorPrincipalId,
        caseId: input.caseId,
        compositionRevision: input.provenance.compositionRevision,
        decidedAt: DateTime.toDateUtc(input.decidedAt),
        decisionKind: input.decisionKind,
        evidenceRef: Option.getOrNull(input.evidenceRef),
        operationId: Option.getOrNull(input.operationId),
        reason: input.reason,
        resultingOutcome: Option.getOrNull(input.resultingOutcome),
      })
      .returning()
      .pipe(Effect.mapError(writeFailure));
    if (row === undefined) {
      return yield* paymentUnavailable('The reconciliation decision was not persisted');
    }
    return decisionRecordOf(row);
  });

  const listOpenCases = Effect.fn('PaymentEvidencePersistence.listOpenCases')(function* listOpenCases(
    paymentId: string | undefined,
  ) {
    const scope = yield* ownerScope;
    const rows = yield* transaction
      .select()
      .from(reconciliationCases)
      .where(
        and(
          eq(reconciliationCases.tenantId, scope.tenantId),
          eq(reconciliationCases.legalEntityId, scope.legalEntityId),
          eq(reconciliationCases.status, 'OPEN'),
          paymentId === undefined ? undefined : eq(reconciliationCases.paymentId, paymentId),
        ),
      )
      .orderBy(asc(reconciliationCases.openedAt), asc(reconciliationCases.caseId))
      .limit(PAYMENT_EVIDENCE_PROJECTION_LIMIT + 1)
      .pipe(Effect.mapError(readFailure));
    const bounded = truncate(rows);
    return { rows: bounded.rows.map(caseRecordOf), truncated: bounded.truncated };
  });

  const listOpenOperations = Effect.fn('PaymentEvidencePersistence.listOpenOperations')(function* listOpenOperations(
    paymentId: string | undefined,
  ) {
    const scope = yield* ownerScope;
    const rows = yield* transaction
      .select()
      .from(paymentOperations)
      .where(
        and(
          eq(paymentOperations.tenantId, scope.tenantId),
          eq(paymentOperations.legalEntityId, scope.legalEntityId),
          inArray(paymentOperations.outcome, [...UNRESOLVED_PAYMENT_OPERATION_OUTCOMES]),
          paymentId === undefined ? undefined : eq(paymentOperations.paymentId, paymentId),
        ),
      )
      .orderBy(asc(paymentOperations.createdAt), asc(paymentOperations.operationId))
      .limit(PAYMENT_EVIDENCE_PROJECTION_LIMIT + 1)
      .pipe(Effect.mapError(readFailure));
    const bounded = truncate(rows);
    const records = yield* Effect.forEach(
      bounded.rows,
      (row) =>
        money(row.amountMinor, row.currency).pipe(
          Effect.map((amount): PaymentOpenOperationRecord => ({
            amount,
            createdAt: utc(row.createdAt),
            kind: row.kind,
            operationId: row.operationId,
            originalProvenance: provenanceOf(row),
            outcome: row.outcome,
            outcomeRevision: row.outcomeRevision,
            paymentId: row.paymentId,
          })),
        ),
      { concurrency: 1 },
    );
    return { rows: records, truncated: bounded.truncated };
  });

  const historyOperations = Effect.fn('PaymentEvidencePersistence.historyOperations')(function* historyOperations(
    scope: { readonly legalEntityId: string; readonly tenantId: string },
    paymentId: string,
  ) {
    const rows = yield* transaction
      .select()
      .from(paymentOperations)
      .where(
        and(
          eq(paymentOperations.tenantId, scope.tenantId),
          eq(paymentOperations.legalEntityId, scope.legalEntityId),
          eq(paymentOperations.paymentId, paymentId),
        ),
      )
      .orderBy(asc(paymentOperations.createdAt), asc(paymentOperations.operationId))
      .limit(PAYMENT_EVIDENCE_PROJECTION_LIMIT + 1)
      .pipe(Effect.mapError(readFailure));
    const bounded = truncate(rows);
    const records = yield* Effect.forEach(
      bounded.rows,
      Effect.fnUntraced(function* historyOperation(row) {
        return {
          amount: yield* money(row.amountMinor, row.currency),
          binding: yield* decodeBinding(row.binding),
          createdAt: utc(row.createdAt),
          kind: row.kind,
          materialHash: row.materialHash,
          operationId: row.operationId,
          operationKey: row.operationKey,
          provenance: provenanceOf(row),
          refundBasisKind: row.refundBasisKind ?? undefined,
          targetOperationId: row.targetOperationId ?? undefined,
        } satisfies PaymentHistoryOperationRecord;
      }),
      { concurrency: 1 },
    );
    return { rows: records, truncated: bounded.truncated };
  });

  const historyTransitions = Effect.fn('PaymentEvidencePersistence.historyTransitions')(function* historyTransitions(
    scope: { readonly legalEntityId: string; readonly tenantId: string },
    paymentId: string,
  ) {
    const rows = yield* transaction
      .select()
      .from(operationOutcomeTransitions)
      .where(
        and(
          eq(operationOutcomeTransitions.tenantId, scope.tenantId),
          eq(operationOutcomeTransitions.legalEntityId, scope.legalEntityId),
          eq(operationOutcomeTransitions.paymentId, paymentId),
        ),
      )
      .orderBy(
        asc(operationOutcomeTransitions.recordedAt),
        asc(operationOutcomeTransitions.operationId),
        asc(operationOutcomeTransitions.outcomeRevision),
      )
      .limit(PAYMENT_EVIDENCE_PROJECTION_LIMIT + 1)
      .pipe(Effect.mapError(readFailure));
    const bounded = truncate(rows);
    return {
      rows: bounded.rows.map((row): PaymentHistoryTransitionRecord => ({
        causeId: row.causeId ?? undefined,
        causeKind: row.causeKind,
        fromOutcome: row.fromOutcome ?? undefined,
        operationId: row.operationId,
        outcomeRevision: row.outcomeRevision,
        provenance: provenanceOf(row),
        recordedAt: utc(row.recordedAt),
        toOutcome: row.toOutcome,
      })),
      truncated: bounded.truncated,
    };
  });

  const historyObservations = Effect.fn('PaymentEvidencePersistence.historyObservations')(function* historyObservations(
    scope: { readonly legalEntityId: string; readonly tenantId: string },
    paymentId: string,
  ) {
    const rows = yield* transaction
      .select()
      .from(observations)
      .where(
        and(
          eq(observations.tenantId, scope.tenantId),
          eq(observations.legalEntityId, scope.legalEntityId),
          eq(observations.paymentId, paymentId),
        ),
      )
      .orderBy(asc(observations.verifiedAt), asc(observations.observationId))
      .limit(PAYMENT_EVIDENCE_PROJECTION_LIMIT + 1)
      .pipe(Effect.mapError(readFailure));
    const bounded = truncate(rows);
    return {
      rows: yield* Effect.forEach(bounded.rows, observationRecordOf, { concurrency: 1 }),
      truncated: bounded.truncated,
    };
  });

  const historyAuthorizations = Effect.fn('PaymentEvidencePersistence.historyAuthorizations')(
    function* historyAuthorizations(
      scope: { readonly legalEntityId: string; readonly tenantId: string },
      paymentId: string,
    ) {
      const rows = yield* transaction
        .select()
        .from(paymentAuthorizations)
        .where(
          and(
            eq(paymentAuthorizations.tenantId, scope.tenantId),
            eq(paymentAuthorizations.legalEntityId, scope.legalEntityId),
            eq(paymentAuthorizations.paymentId, paymentId),
          ),
        )
        .orderBy(asc(paymentAuthorizations.issuedAt), asc(paymentAuthorizations.authorizationId))
        .limit(PAYMENT_EVIDENCE_PROJECTION_LIMIT + 1)
        .pipe(Effect.mapError(readFailure));
      const bounded = truncate(rows);
      const records = yield* Effect.forEach(bounded.rows, paymentAuthorizationProofOfRow, { concurrency: 1 });
      return { rows: records, truncated: bounded.truncated };
    },
  );

  const historyRecoveries = Effect.fn('PaymentEvidencePersistence.historyRecoveries')(function* historyRecoveries(
    scope: { readonly legalEntityId: string; readonly tenantId: string },
    paymentId: string,
  ) {
    const rows = yield* transaction
      .select()
      .from(recoveryRequests)
      .where(
        and(
          eq(recoveryRequests.tenantId, scope.tenantId),
          eq(recoveryRequests.legalEntityId, scope.legalEntityId),
          eq(recoveryRequests.paymentId, paymentId),
        ),
      )
      .orderBy(asc(recoveryRequests.requestedAt), asc(recoveryRequests.recoveryId))
      .limit(PAYMENT_EVIDENCE_PROJECTION_LIMIT + 1)
      .pipe(Effect.mapError(readFailure));
    const bounded = truncate(rows);
    return {
      rows: yield* Effect.forEach(bounded.rows, recoveryRecordOf, { concurrency: 1 }),
      truncated: bounded.truncated,
    };
  });

  const historyCases = Effect.fn('PaymentEvidencePersistence.historyCases')(function* historyCases(
    scope: { readonly legalEntityId: string; readonly tenantId: string },
    paymentId: string,
  ) {
    const caseRows = yield* transaction
      .select()
      .from(reconciliationCases)
      .where(
        and(
          eq(reconciliationCases.tenantId, scope.tenantId),
          eq(reconciliationCases.legalEntityId, scope.legalEntityId),
          eq(reconciliationCases.paymentId, paymentId),
        ),
      )
      .orderBy(asc(reconciliationCases.openedAt), asc(reconciliationCases.caseId))
      .limit(PAYMENT_EVIDENCE_PROJECTION_LIMIT + 1)
      .pipe(Effect.mapError(readFailure));
    const cases = truncate(caseRows);
    const caseIds = cases.rows.map((row) => row.caseId);
    const decisionRows =
      caseIds.length === 0
        ? []
        : yield* transaction
            .select()
            .from(reconciliationDecisions)
            .where(
              and(
                eq(reconciliationDecisions.tenantId, scope.tenantId),
                eq(reconciliationDecisions.legalEntityId, scope.legalEntityId),
                inArray(reconciliationDecisions.caseId, caseIds),
              ),
            )
            .orderBy(asc(reconciliationDecisions.decidedAt), asc(reconciliationDecisions.decisionId))
            .limit(PAYMENT_EVIDENCE_PROJECTION_LIMIT + 1)
            .pipe(Effect.mapError(readFailure));
    const decisions = truncate(decisionRows);
    return {
      cases: cases.rows.map(caseRecordOf),
      decisions: decisions.rows.map(decisionRecordOf),
      truncated: cases.truncated || decisions.truncated,
    };
  });

  const loadHistory = Effect.fn('PaymentEvidencePersistence.loadHistory')(function* loadHistory(paymentId: string) {
    const scope = yield* ownerScope;
    const [paymentRow] = yield* transaction
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, scope.tenantId),
          eq(payments.legalEntityId, scope.legalEntityId),
          eq(payments.paymentId, paymentId),
        ),
      )
      .pipe(Effect.mapError(readFailure));
    if (paymentRow === undefined) {
      return Option.none<PaymentHistoryRecord>();
    }
    const payment = {
      amount: yield* money(paymentRow.amountMinor, paymentRow.currency),
      createdAt: utc(paymentRow.createdAt),
      executionBinding: yield* decodeBinding(paymentRow.executionBinding),
      method: paymentRow.method,
      paymentId: paymentRow.paymentId,
      predecessorPaymentId: paymentRow.predecessorPaymentId ?? undefined,
      provenance: provenanceOf(paymentRow),
      purchaseCorrelationId: paymentRow.purchaseCorrelationId,
    } satisfies PaymentHistoryPaymentRecord;
    // One transaction connection: the projections are read in order, never concurrently.
    const [
      operationHistory,
      transitionHistory,
      observationHistory,
      authorizationHistory,
      recoveryHistory,
      caseHistory,
    ] = yield* Effect.all(
      [
        historyOperations(scope, paymentId),
        historyTransitions(scope, paymentId),
        historyObservations(scope, paymentId),
        historyAuthorizations(scope, paymentId),
        historyRecoveries(scope, paymentId),
        historyCases(scope, paymentId),
      ],
      { concurrency: 1 },
    );
    return Option.some({
      authorizations: authorizationHistory.rows,
      cases: caseHistory.cases,
      decisions: caseHistory.decisions,
      observations: observationHistory.rows,
      operations: operationHistory.rows,
      payment,
      recoveries: recoveryHistory.rows,
      transitions: transitionHistory.rows,
      truncated:
        operationHistory.truncated ||
        transitionHistory.truncated ||
        observationHistory.truncated ||
        authorizationHistory.truncated ||
        recoveryHistory.truncated ||
        caseHistory.truncated,
    } satisfies PaymentHistoryRecord);
  });

  return Object.freeze({
    attributeEconomicEffect,
    closeCase,
    findCase,
    findObservation,
    findSourceAuthorityStatus,
    hasCaseDecision,
    insertDecision,
    insertRecoveryRequest,
    isEconomicEffectCounted,
    isObservationCorrected,
    isObservationReopened,
    listEstablishedEffects,
    listInterpretedEvidence,
    listObservationAttachments,
    listOpenCases,
    listOpenOperations,
    listSameEffectObservations,
    loadHistory,
    lockCase,
    openCase,
  });
};

/** Services of the #1151 Actions: the shared aggregate primitives plus the evidence ledgers. */
export interface PaymentEvidenceActionServices {
  readonly aggregate: PaymentAggregatePersistence;
  readonly evidence: PaymentEvidencePersistence;
}
