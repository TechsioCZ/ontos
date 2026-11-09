import { DateTime, Effect, Option } from 'effect';

import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import type { PaymentExecutionProvenance } from '../../shared/domain/payment-provenance.ts';
import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type {
  PaymentOperationKind,
  PaymentOperationOutcome,
  PaymentReconciliationCaseKind,
} from '../../shared/domain/payment-vocabulary.ts';
import { paymentSourceRejected } from '../../shared/domain/source-statement.ts';
import type { PaymentSourceEntry, PaymentSourceStatementResult } from '../../shared/domain/source-statement.ts';
import type { OutboxPayload as OperationOutcomeChangedPayload } from '../../shared/outbox/payment-core-operation-outcome-changed-v1.ts';
import type { PaymentAggregateRecord } from '../persistence/payment-aggregate-persistence.ts';
import type { NewPaymentObservationInput, PaymentSourceServices } from '../persistence/payment-source-persistence.ts';
import type { PaymentEvidenceDecisionCase, PaymentEvidenceOutcomeChange } from './evidence-interpretation.ts';
import {
  interpretPaymentObservation,
  PaymentCorrectionEffect,
  PaymentEvidenceDecision,
  paymentFactMeaning,
} from './evidence-interpretation.ts';
import { PaymentSourceQualification, qualifyPaymentSourceStatement } from './source-qualification.ts';
import type {
  PaymentRecordedObservationView,
  PaymentSourceAuthorityView,
  PaymentSourceQualificationCase,
  PaymentSourceStatement,
} from './source-qualification.ts';

/**
 * Governed acceptance of one source statement inside the owning Action transaction (#1152, ingress
 * half of #1151). Order: authority rows lock -> Payment row lock -> qualification -> evidence
 * interpretation -> append-only observation -> outcome transition / correction / reconciliation case.
 * A refused statement fails the Action, so nothing is committed and no acceptance is acknowledged.
 * Every recorded row carries the NEW invocation and Composition revision; the original operation
 * lineage is referenced, never rewritten (late R2 acceptance).
 */

export interface PaymentSourceStatementInput {
  readonly entry: PaymentSourceEntry;
  readonly provenance: PaymentExecutionProvenance;
  /** Durable transport receipt time when the ingress supplies it; otherwise the verification time. */
  readonly receivedAt: Option.Option<DateTime.Utc>;
  readonly statement: PaymentSourceStatement;
}

/** One applied operation outcome change, ready for the `operation-outcome-changed` Domain Event. */
export interface PaymentSourceOutcomeChange {
  readonly coverageRevision: number;
  readonly fromOutcome: PaymentOperationOutcome;
  readonly observationId: string;
  readonly operationId: string;
  readonly operationKind: PaymentOperationKind;
  readonly originalProvenance: PaymentExecutionProvenance;
  readonly outcomeRevision: number;
  readonly paymentId: string;
  readonly toOutcome: PaymentOperationOutcome;
}

export interface PaymentSourceStatementAcceptance {
  readonly outcomeChanges: readonly PaymentSourceOutcomeChange[];
  readonly result: PaymentSourceStatementResult;
}

/** Everything one statement execution has established before recording. */
interface StatementRun {
  readonly input: PaymentSourceStatementInput;
  readonly receivedAt: DateTime.Utc;
  readonly services: PaymentSourceServices;
  readonly target: Option.Option<PaymentAggregateRecord>;
  readonly verifiedAt: DateTime.Utc;
}

type QualifiedStatement = Extract<PaymentSourceQualificationCase, { readonly _tag: 'Qualified' }>;
type HeldStatement = Extract<PaymentSourceQualificationCase, { readonly _tag: 'Held' }>;
type DecisionOf<Tag extends PaymentEvidenceDecisionCase['_tag']> = Extract<
  PaymentEvidenceDecisionCase,
  { readonly _tag: Tag }
>;

interface RecordedRow {
  readonly acceptanceOutcome: NewPaymentObservationInput['acceptanceOutcome'];
  readonly amount?: PaymentMonetaryAmount | undefined;
  readonly authority: PaymentSourceAuthorityView;
  readonly correctionEffect?: NewPaymentObservationInput['correctionEffect'];
  readonly operationId?: string | undefined;
  readonly paymentId?: string | undefined;
}

interface ResultFields {
  readonly acceptanceOutcome: PaymentSourceStatementResult['acceptanceOutcome'];
  readonly change?: PaymentSourceOutcomeChange | undefined;
  readonly interpretation: PaymentSourceStatementResult['interpretation'];
  readonly observationId: string;
  readonly operationId?: string | undefined;
  readonly paymentId?: string | undefined;
  readonly reconciliationCaseId?: string | undefined;
  readonly sourceAuthorityId: string;
}

const acceptanceOf = (fields: ResultFields): PaymentSourceStatementAcceptance => ({
  outcomeChanges: fields.change === undefined ? [] : [fields.change],
  result: {
    acceptanceOutcome: fields.acceptanceOutcome,
    interpretation: fields.interpretation,
    observationId: fields.observationId,
    operationId: fields.operationId,
    outcomeChange:
      fields.change === undefined
        ? undefined
        : { from: fields.change.fromOutcome, operationId: fields.change.operationId, to: fields.change.toOutcome },
    paymentId: fields.paymentId,
    reconciliationCaseId: fields.reconciliationCaseId,
    sourceAuthorityId: fields.sourceAuthorityId,
  },
});

/** Only an operation of the correlated Payment can be referenced by the recorded evidence. */
const operationInTarget = (run: StatementRun, operationId: string | undefined): string | undefined =>
  Option.exists(run.target, (aggregate) =>
    aggregate.operations.some((operation) => operation.operationId === operationId),
  )
    ? operationId
    : undefined;

const claimedAmountOf = (statement: PaymentSourceStatement): PaymentMonetaryAmount | undefined =>
  statement.amount === undefined ? undefined : { amountMinor: statement.amount.amountMinor, currency: 'CZK' };

const recordObservation = (run: StatementRun, row: RecordedRow) => {
  const { provenance, statement } = run.input;
  return run.services.source.insertObservation({
    acceptanceOutcome: row.acceptanceOutcome,
    amount: row.amount,
    authority: row.authority,
    correctionEffect: row.correctionEffect,
    correctsObservationId: statement.correctsObservationId,
    economicEffectKey: statement.economicEffectKey,
    evidenceRef: statement.evidenceRef,
    factFamily: statement.factFamily,
    factKind: statement.factKind,
    operationId: row.operationId,
    paymentId: row.paymentId,
    provenance,
    receivedAt: run.receivedAt,
    source: statement.source,
    sourceOccurredAt: statement.sourceOccurredAt,
    sourceOccurrenceId: statement.sourceOccurrenceId,
    sourceRevision: statement.sourceRevision,
    verifiedAt: run.verifiedAt,
  });
};

const openCase = (
  run: StatementRun,
  caseKind: PaymentReconciliationCaseKind,
  subject: {
    readonly observationId: string;
    readonly operationId?: string | undefined;
    readonly paymentId?: string | undefined;
  },
) =>
  run.services.source.openReconciliationCase({
    caseKind,
    observationId: subject.observationId,
    operationId: subject.operationId,
    paymentId: subject.paymentId,
    provenance: run.input.provenance,
  });

/** Applies one legal outcome change caused by the recorded observation and reports it for the event. */
const applyOutcomeChange = Effect.fn('PaymentSource.applyOutcomeChange')(function* applyOutcomeChange(
  run: StatementRun,
  paymentId: string,
  change: PaymentEvidenceOutcomeChange,
  observationId: string,
) {
  const applied = yield* run.services.aggregate.transitionOperationOutcome({
    causedBy: { kind: 'OBSERVATION', sourceId: observationId },
    expectedOutcomeRevision: change.expectedOutcomeRevision,
    operationId: change.operationId,
    paymentId,
    provenance: run.input.provenance,
    to: change.to,
  });
  const payment = yield* run.services.aggregate.lockPayment(paymentId);
  return {
    coverageRevision: payment.coverageRevision,
    fromOutcome: change.from,
    observationId,
    operationId: applied.record.operationId,
    operationKind: applied.record.kind,
    originalProvenance: applied.record.provenance,
    outcomeRevision: applied.record.outcomeRevision,
    paymentId,
    toOutcome: applied.record.outcome,
  } satisfies PaymentSourceOutcomeChange;
});

const recordHeld = Effect.fn('PaymentSource.recordHeld')(function* recordHeld(run: StatementRun, held: HeldStatement) {
  const operationId = operationInTarget(run, Option.getOrUndefined(held.operationId));
  const observationId = yield* recordObservation(run, {
    acceptanceOutcome: 'HELD_UNRESOLVED',
    amount: claimedAmountOf(run.input.statement),
    authority: held.authority,
    operationId,
    paymentId: held.paymentId,
  });
  const reconciliationCaseId = yield* openCase(run, 'HELD_OBSERVATION', {
    observationId,
    operationId,
    paymentId: held.paymentId,
  });
  return acceptanceOf({
    acceptanceOutcome: 'HELD_UNRESOLVED',
    interpretation: 'NOT_INTERPRETED',
    observationId,
    operationId,
    paymentId: held.paymentId,
    reconciliationCaseId,
    sourceAuthorityId: held.authority.sourceAuthorityId,
  });
});

/** Evidence without an exact Payment in this scope stays unassigned debt; no Payment is touched. */
const recordUnassigned = Effect.fn('PaymentSource.recordUnassigned')(function* recordUnassigned(
  run: StatementRun,
  authority: PaymentSourceAuthorityView,
) {
  const observationId = yield* recordObservation(run, {
    acceptanceOutcome: 'HELD_UNRESOLVED',
    amount: claimedAmountOf(run.input.statement),
    authority,
  });
  const reconciliationCaseId = yield* openCase(run, 'HELD_OBSERVATION', { observationId });
  return acceptanceOf({
    acceptanceOutcome: 'HELD_UNRESOLVED',
    interpretation: 'NOT_INTERPRETED',
    observationId,
    reconciliationCaseId,
    sourceAuthorityId: authority.sourceAuthorityId,
  });
});

/**
 * One live or proven collection lineage per Payment (#1148): a not-effected COLLECT cannot leave
 * NOT_EFFECTED_CONFIRMED while a permitted retry COLLECT stands. Evidence contradicting it stays
 * OPERATION_CONFLICT debt (coverage held) without reopening the operation.
 */
const reopensBehindRetriedCollect = (run: StatementRun, change: PaymentEvidenceOutcomeChange): boolean =>
  change.from === 'NOT_EFFECTED_CONFIRMED' &&
  Option.exists(
    run.target,
    ({ operations }) =>
      operations.some((operation) => operation.operationId === change.operationId && operation.kind === 'COLLECT') &&
      operations.some((operation) => operation.kind === 'COLLECT' && operation.outcome !== 'NOT_EFFECTED_CONFIRMED'),
  );

const applyConflict = Effect.fn('PaymentSource.applyConflict')(function* applyConflict(
  run: StatementRun,
  qualified: QualifiedStatement,
  decision: DecisionOf<'CONFLICT'>,
) {
  const operationId = operationInTarget(run, decision.operationId);
  const observationId = yield* recordObservation(run, {
    acceptanceOutcome: 'CONFLICT',
    amount: claimedAmountOf(run.input.statement),
    authority: qualified.authority,
    operationId,
    paymentId: qualified.paymentId,
  });
  const change =
    Option.isSome(decision.change) && !reopensBehindRetriedCollect(run, decision.change.value)
      ? yield* applyOutcomeChange(run, qualified.paymentId, decision.change.value, observationId)
      : undefined;
  const reconciliationCaseId = yield* openCase(run, 'OPERATION_CONFLICT', {
    observationId,
    operationId,
    paymentId: qualified.paymentId,
  });
  yield* Effect.annotateCurrentSpan('payment.evidence.conflict', decision.reason);
  return acceptanceOf({
    acceptanceOutcome: 'CONFLICT',
    change,
    interpretation: 'CONFLICT',
    observationId,
    operationId,
    paymentId: qualified.paymentId,
    reconciliationCaseId,
    sourceAuthorityId: qualified.authority.sourceAuthorityId,
  });
});

const applyCorrection = Effect.fn('PaymentSource.applyCorrection')(function* applyCorrection(
  run: StatementRun,
  qualified: QualifiedStatement,
  decision: DecisionOf<'CORRECTION'>,
) {
  const { effect } = decision;
  if (PaymentCorrectionEffect.$is('REOPEN_TO_CONFLICT')(effect) && reopensBehindRetriedCollect(run, effect.change)) {
    // The disproof cannot reopen the attempt behind a standing retry: it is recorded as conflict debt.
    return yield* applyConflict(
      run,
      qualified,
      PaymentEvidenceDecision.CONFLICT({
        change: Option.none(),
        operationId: decision.affectedOperationId,
        reason: 'CONTRADICTS_DEFINITIVE_OUTCOME',
      }),
    );
  }
  const operationId = operationInTarget(run, decision.affectedOperationId);
  // Every correction keeps its exact claimed amount as evidence (#1152). Only a partial disproof of
  // proven collection (`correction_effect`) carries money into Current coverage, so the funds guard
  // never deducts the same money twice.
  const reduction = PaymentCorrectionEffect.$is('REDUCE_ESTABLISHED_COLLECTION')(effect) ? effect.amount : undefined;
  const observationId = yield* recordObservation(run, {
    acceptanceOutcome: 'ACCEPTED_OBSERVATION',
    amount: claimedAmountOf(run.input.statement),
    authority: qualified.authority,
    correctionEffect: effect._tag,
    operationId,
    paymentId: qualified.paymentId,
  });
  const fields = {
    acceptanceOutcome: 'ACCEPTED_OBSERVATION',
    interpretation: 'CORRECTION',
    observationId,
    operationId,
    paymentId: qualified.paymentId,
    sourceAuthorityId: qualified.authority.sourceAuthorityId,
  } as const;
  if (reduction !== undefined) {
    yield* run.services.aggregate.bumpCoverageRevision(qualified.paymentId);
    return acceptanceOf(fields);
  }
  if (PaymentCorrectionEffect.$is('REOPEN_TO_CONFLICT')(effect)) {
    // The reopened operation and its reconciliation debt are written together, in this order.
    const [change, reconciliationCaseId] = yield* Effect.all(
      [
        applyOutcomeChange(run, qualified.paymentId, effect.change, observationId),
        openCase(run, 'OPERATION_CONFLICT', { observationId, operationId, paymentId: qualified.paymentId }),
      ],
      { concurrency: 1 },
    );
    return acceptanceOf({ ...fields, change, reconciliationCaseId });
  }
  return acceptanceOf(fields);
});

const applyHold = Effect.fn('PaymentSource.applyHold')(function* applyHold(
  run: StatementRun,
  qualified: QualifiedStatement,
  decision: DecisionOf<'HOLD'>,
) {
  const operationId = operationInTarget(run, decision.operationId);
  const observationId = yield* recordObservation(run, {
    acceptanceOutcome: 'HELD_UNRESOLVED',
    amount: claimedAmountOf(run.input.statement),
    authority: qualified.authority,
    operationId,
    paymentId: qualified.paymentId,
  });
  const reconciliationCaseId = yield* openCase(run, 'HELD_OBSERVATION', {
    observationId,
    operationId,
    paymentId: qualified.paymentId,
  });
  yield* Effect.annotateCurrentSpan('payment.evidence.hold', decision.reason);
  return acceptanceOf({
    acceptanceOutcome: 'HELD_UNRESOLVED',
    interpretation: 'HOLD',
    observationId,
    operationId,
    paymentId: qualified.paymentId,
    reconciliationCaseId,
    sourceAuthorityId: qualified.authority.sourceAuthorityId,
  });
});

/**
 * One economic effect counts once across every Payment of the trusted scope (#1151): a confirmed
 * statement claims its source economic effect for the operation it establishes or corroborates before
 * anything is recorded. When the effect already established another operation (of this or another
 * Payment, including one concurrently committing first), the statement must not count again.
 */
const effectAttributedElsewhere = Effect.fn('PaymentSource.effectAttributedElsewhere')(
  function* effectAttributedElsewhere(run: StatementRun, paymentId: string, operationId: string) {
    const { provenance, statement } = run.input;
    const { economicEffectKey, factKind, source } = statement;
    if (economicEffectKey === undefined || paymentFactMeaning(factKind)?.outcome !== 'EFFECT_CONFIRMED') {
      return false;
    }
    const attribution = yield* run.services.source.attributeEconomicEffect({
      economicEffectKey,
      factKind,
      operationId,
      paymentId,
      provenance,
      source,
    });
    return attribution === 'ATTRIBUTED_ELSEWHERE';
  },
);

/** The confirmed effect already counts toward another operation: held debt, no outcome change. */
const holdEffectCountedElsewhere = (run: StatementRun, qualified: QualifiedStatement, operationId: string) =>
  applyHold(
    run,
    qualified,
    PaymentEvidenceDecision.HOLD({ operationId, reason: 'ECONOMIC_EFFECT_ESTABLISHED_ANOTHER_OPERATION' }),
  );

const applyNoChange = Effect.fn('PaymentSource.applyNoChange')(function* applyNoChange(
  run: StatementRun,
  qualified: QualifiedStatement,
  decision: DecisionOf<'NO_CHANGE'>,
) {
  const operationId = operationInTarget(run, decision.operationId);
  if (operationId !== undefined && (yield* effectAttributedElsewhere(run, qualified.paymentId, operationId))) {
    return yield* holdEffectCountedElsewhere(run, qualified, operationId);
  }
  const observationId = yield* recordObservation(run, {
    acceptanceOutcome: 'ACCEPTED_OBSERVATION',
    amount: claimedAmountOf(run.input.statement),
    authority: qualified.authority,
    operationId,
    paymentId: qualified.paymentId,
  });
  return acceptanceOf({
    acceptanceOutcome: 'ACCEPTED_OBSERVATION',
    interpretation: 'NO_CHANGE',
    observationId,
    operationId,
    paymentId: qualified.paymentId,
    sourceAuthorityId: qualified.authority.sourceAuthorityId,
  });
});

const applyTransition = Effect.fn('PaymentSource.applyTransition')(function* applyTransition(
  run: StatementRun,
  qualified: QualifiedStatement,
  decision: DecisionOf<'TRANSITION'>,
) {
  if (yield* effectAttributedElsewhere(run, qualified.paymentId, decision.operationId)) {
    return yield* holdEffectCountedElsewhere(run, qualified, decision.operationId);
  }
  const observationId = yield* recordObservation(run, {
    acceptanceOutcome: 'ACCEPTED_OBSERVATION',
    amount: claimedAmountOf(run.input.statement),
    authority: qualified.authority,
    operationId: decision.operationId,
    paymentId: qualified.paymentId,
  });
  const change = yield* applyOutcomeChange(run, qualified.paymentId, decision, observationId);
  return acceptanceOf({
    acceptanceOutcome: 'ACCEPTED_OBSERVATION',
    change,
    interpretation: 'TRANSITION',
    observationId,
    operationId: decision.operationId,
    paymentId: qualified.paymentId,
    sourceAuthorityId: qualified.authority.sourceAuthorityId,
  });
});

/** Interprets qualified evidence against the locked Current aggregate (lane L6 interpreter). */
const applyQualified = Effect.fn('PaymentSource.applyQualified')(function* applyQualified(
  run: StatementRun,
  qualified: QualifiedStatement,
) {
  if (Option.isNone(run.target)) {
    return yield* paymentUnavailable('The qualified Payment is no longer loaded');
  }
  const lineage = yield* run.services.source.listInterpretedEvidence(qualified.paymentId);
  const decision = interpretPaymentObservation(
    { ...lineage, operations: run.target.value.operations },
    qualified.observation,
  );
  return yield* PaymentEvidenceDecision.$match(decision, {
    CONFLICT: (conflict) => applyConflict(run, qualified, conflict),
    CORRECTION: (correction) => applyCorrection(run, qualified, correction),
    HOLD: (hold) => applyHold(run, qualified, hold),
    NO_CHANGE: (unchanged) => applyNoChange(run, qualified, unchanged),
    TRANSITION: (transition) => applyTransition(run, qualified, transition),
  });
});

/** A redelivered exact occurrence: the original decision, counted once, nothing recorded or emitted. */
const duplicateOf = (
  original: PaymentRecordedObservationView,
): Effect.Effect<PaymentSourceStatementAcceptance, PaymentUnavailable> =>
  original.sourceAuthorityId === undefined
    ? Effect.fail(paymentUnavailable('The recorded duplicate occurrence has no source authority'))
    : Effect.succeed({
        outcomeChanges: [],
        result: {
          acceptanceOutcome: 'DUPLICATE',
          duplicateOfOutcome: original.acceptanceOutcome,
          interpretation: 'NOT_INTERPRETED',
          observationId: original.observationId,
          operationId: original.operationId,
          paymentId: original.paymentId,
          sourceAuthorityId: original.sourceAuthorityId,
        },
      });

const loadTarget = (services: PaymentSourceServices, paymentId: string | undefined) =>
  paymentId === undefined
    ? Effect.succeedNone
    : services.aggregate.loadAggregate(paymentId, { lock: true }).pipe(
        Effect.map(Option.some),
        // A Payment outside the trusted scope is indistinguishable from an absent one: unresolved.
        Effect.catchTag('PaymentRejected', (failure) =>
          failure.code === 'payment_not_found' ? Effect.succeedNone : Effect.fail(failure),
        ),
      );

/** Records one source statement and applies its Current interpretation. */
export const acceptPaymentSourceStatement = Effect.fn('PaymentSource.acceptStatement')(function* acceptStatement(
  services: PaymentSourceServices,
  input: PaymentSourceStatementInput,
) {
  const { statement } = input;
  const verifiedAt = yield* DateTime.now;
  const receivedAt = Option.getOrElse(input.receivedAt, () => verifiedAt);
  if (DateTime.isGreaterThan(receivedAt, verifiedAt)) {
    return yield* paymentSourceRejected(
      'payment_source_received_time_invalid',
      'The transport receipt time must not lie after the verification time',
    );
  }
  // One transaction connection, in lock order: the source authority rows, then the Payment row.
  const [authorities, target, existingOccurrence, correctedObservation] = yield* Effect.all(
    [
      services.source.lockAuthorities({ factFamily: statement.factFamily, source: statement.source }),
      loadTarget(services, statement.paymentId),
      services.source.findOccurrence({
        source: statement.source,
        sourceOccurrenceId: statement.sourceOccurrenceId,
        sourceRevision: statement.sourceRevision,
      }),
      statement.correctsObservationId === undefined
        ? Effect.succeedNone
        : services.source.findObservation(statement.correctsObservationId),
    ],
    { concurrency: 1 },
  );
  const run: StatementRun = { input, receivedAt, services, target, verifiedAt };
  const qualification = qualifyPaymentSourceStatement({
    authorities,
    correctedObservation: Option.getOrUndefined(correctedObservation),
    entry: input.entry,
    existingOccurrence: Option.getOrUndefined(existingOccurrence),
    statement,
    target: Option.getOrUndefined(target),
  });
  return yield* PaymentSourceQualification.$match(qualification, {
    CurrencyMismatch: ({ claimed, required }) =>
      Effect.fail(
        paymentSourceRejected(
          'payment_source_currency_mismatch',
          `The statement currency ${claimed} differs from the Payment currency ${required}`,
        ),
      ),
    Duplicate: ({ original }) => duplicateOf(original),
    Held: (held) => recordHeld(run, held),
    HeldUnassigned: ({ authority }) => recordUnassigned(run, authority),
    OccurrenceConflict: () =>
      Effect.fail(
        paymentSourceRejected(
          'payment_source_occurrence_conflict',
          'The same source occurrence and revision was already recorded with different content',
        ),
      ),
    Qualified: (qualified) => applyQualified(run, qualified),
    Unauthorized: ({ reason }) => Effect.fail(paymentSourceRejected('payment_source_authority_forbidden', reason)),
    Unsupported: ({ reason }) => Effect.fail(paymentSourceRejected('payment_source_fact_unsupported', reason)),
  });
});

/**
 * The `payment.core.operation-outcome-changed.v1` payload of one applied change: the applying (new)
 * invocation provenance plus the operation's original admitted lineage, never relabelled.
 */
export const paymentSourceOutcomeChangedPayload = (
  change: PaymentSourceOutcomeChange,
  provenance: PaymentExecutionProvenance,
): OperationOutcomeChangedPayload => ({
  cause: { _tag: 'OBSERVATION', observationId: change.observationId },
  coverageRevision: change.coverageRevision,
  fromOutcome: change.fromOutcome,
  operationId: change.operationId,
  operationKind: change.operationKind,
  originalActionInvocationId: change.originalProvenance.actionInvocationId,
  originalCompositionRevision: change.originalProvenance.compositionRevision,
  outcomeRevision: change.outcomeRevision,
  paymentId: change.paymentId,
  provenance,
  toOutcome: change.toOutcome,
});
