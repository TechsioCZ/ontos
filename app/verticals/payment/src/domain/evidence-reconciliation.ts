import { Data, Match, Option, Result } from 'effect';

import type {
  PaymentEvidenceRejectionCode,
  PaymentReconciliationDecisionBody,
} from '../../shared/domain/evidence-contract.ts';
import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import type {
  PaymentObservationAcceptanceOutcome,
  PaymentObservationFactKind,
  PaymentOperationOutcome,
  PaymentReconciliationCaseStatus,
  PaymentReconciliationDecisionKind,
  PaymentSourceFactFamily,
  PaymentSourceKind,
} from '../../shared/domain/payment-vocabulary.ts';
import type { PaymentEvidenceOperationView, PaymentEvidenceOutcomeChange } from './evidence-interpretation.ts';
import { paymentFactMeaning } from './evidence-interpretation.ts';
import { sameAmount } from './money.ts';
import { isAllowedOutcomeTransition, isDefinitiveOutcome } from './operation-lifecycle.ts';

/**
 * Governed reconciliation decisions (#1151 "Operator reconciliation cannot fabricate money"). Pure:
 * the Action supplies the locked case, the locked Payment's operations and the qualification facts of
 * the attached observation. No branch creates an operation, an amount or a refund; an effect is
 * confirmed only by a qualified observation that states exactly that effect, from the executor the
 * operation was requested through, and one economic effect counts toward one operation only. A case
 * closes only when its operation is definitive and the monetary statement it holds is accounted for
 * by Current state: an operator note is audit, never authoritative evidence by itself.
 */

export interface PaymentReconciliationCaseSubject {
  readonly operationId: string | undefined;
  readonly paymentId: string | undefined;
  readonly status: PaymentReconciliationCaseStatus;
}

/** The exact source binding an observation was recorded under. */
export interface PaymentReconciliationEvidenceSource {
  readonly accountRef: string;
  readonly environment: string;
  readonly factFamily: PaymentSourceFactFamily;
  readonly sourceKind: PaymentSourceKind;
  readonly sourceSystem: string;
}

/**
 * One uncorrected statement whose effect already counts toward an operation: its own accepted
 * interpretation, or a governed attachment that resolved the operation.
 */
export interface PaymentReconciliationEstablishedEffect {
  readonly economicEffectKey: string | undefined;
  readonly factKind: PaymentObservationFactKind;
  readonly observationId: string;
  readonly operationId: string;
}

/** What the Action established about the observation an ATTACH_EVIDENCE decision names. */
export interface PaymentReconciliationEvidenceFacts {
  readonly acceptanceOutcome: PaymentObservationAcceptanceOutcome;
  readonly amount: PaymentMonetaryAmount | undefined;
  /** A qualified SOURCE_CORRECTION (accepted, held or conflicting) disproved this statement. */
  readonly corrected: boolean;
  /**
   * Operations this observation's economic effect already counts toward: its own accepted
   * interpretation, governed attachments of it, and those of other observations of the same source
   * and economic effect. `undefined` stands for an attachment whose operation is not identifiable.
   */
  readonly countedToward: readonly (string | undefined)[];
  readonly economicEffectKey: string | undefined;
  /** Uncorrected statements that already establish an operation of this Payment (accepted or attached). */
  readonly establishedEffects: readonly PaymentReconciliationEstablishedEffect[];
  readonly factKind: PaymentObservationFactKind;
  readonly observationId: string;
  readonly operationId: string | undefined;
  readonly paymentId: string | undefined;
  readonly source: PaymentReconciliationEvidenceSource;
  /** The observation came from a configured source authority that is ACTIVE now. */
  readonly sourceAuthorityActive: boolean;
}

/**
 * What the Action established about the observation a case holds, for CLOSE_CASE (#1151 "Closing an
 * administrative case must not falsely confirm an effect or discard an unresolved monetary obligation").
 */
export interface PaymentReconciliationCaseEvidence {
  readonly acceptanceOutcome: PaymentObservationAcceptanceOutcome;
  /** Resulting outcomes of the governed ATTACH_EVIDENCE decisions of this observation; `undefined` = evidence only. */
  readonly attachedOutcomes: readonly (PaymentOperationOutcome | undefined)[];
  /** A CLASSIFY_CONFLICT decision of this case applied the held evidence through governance. */
  readonly conflictClassified: boolean;
  /** A qualified SOURCE_CORRECTION (accepted, held or conflicting) disproved this statement. */
  readonly corrected: boolean;
  /** SOURCE_CORRECTION only: the disproven statement was accepted or resolved an operation by attachment. */
  readonly correctionTargetEstablished: boolean;
  readonly factKind: PaymentObservationFactKind;
}

/** The refund executor binding a REFUND was requested through (#1150), as stored on the operation. */
export interface PaymentReconciliationRefundRoute {
  readonly accountRef: string;
  readonly environment: string;
  readonly sourceKind: PaymentSourceKind;
  readonly sourceSystem: string;
}

/** One operation as reconciliation needs it (structurally satisfied by `PaymentOperationRecord`). */
export interface PaymentReconciliationOperationView extends PaymentEvidenceOperationView {
  readonly refundExecutionRoute?: PaymentReconciliationRefundRoute | undefined;
}

export interface PaymentReconciliationDecisionInput {
  readonly body: PaymentReconciliationDecisionBody;
  /** CLOSE_CASE only: the observation the case holds; none when the case holds no observation. */
  readonly caseEvidence: Option.Option<PaymentReconciliationCaseEvidence>;
  readonly evidence: Option.Option<PaymentReconciliationEvidenceFacts>;
  readonly operations: readonly PaymentReconciliationOperationView[];
  readonly subject: PaymentReconciliationCaseSubject;
}

export type PaymentReconciliationStepCase = Data.TaggedEnum<{
  Apply: {
    readonly change: Option.Option<PaymentEvidenceOutcomeChange>;
    readonly closeCase: boolean;
    readonly decisionKind: PaymentReconciliationDecisionKind;
    readonly evidenceRef: Option.Option<string>;
    readonly resultingOutcome: Option.Option<PaymentOperationOutcome>;
  };
  Reject: { readonly code: PaymentEvidenceRejectionCode; readonly reason: string };
}>;
export const PaymentReconciliationStep = Data.taggedEnum<PaymentReconciliationStepCase>();

const reject = (code: PaymentEvidenceRejectionCode, reason: string) =>
  PaymentReconciliationStep.Reject({ code, reason });

const QUALIFYING_ACCEPTANCE: ReadonlySet<PaymentObservationAcceptanceOutcome> = new Set([
  'ACCEPTED_OBSERVATION',
  'HELD_UNRESOLVED',
  'CONFLICT',
] as const);

const changeTo = (
  operation: PaymentEvidenceOperationView,
  to: PaymentOperationOutcome,
): Option.Option<PaymentEvidenceOutcomeChange> =>
  operation.outcome === to
    ? Option.none()
    : Option.some({
        expectedOutcomeRevision: operation.outcomeRevision,
        from: operation.outcome,
        operationId: operation.operationId,
        to,
      });

const targetOperation = (
  input: PaymentReconciliationDecisionInput,
  requestedOperationId: string | undefined,
): Result.Result<PaymentReconciliationOperationView, PaymentReconciliationStepCase> => {
  const { operationId } = input.subject;
  if (operationId !== undefined && requestedOperationId !== undefined && operationId !== requestedOperationId) {
    return Result.fail(
      reject('payment_reconciliation_decision_not_applicable', 'The case concerns a different operation'),
    );
  }
  const target = operationId ?? requestedOperationId;
  const operation = input.operations.find((candidate) => candidate.operationId === target);
  return operation === undefined
    ? Result.fail(reject('payment_reconciliation_decision_not_applicable', 'No operation of this Payment is named'))
    : Result.succeed(operation);
};

/**
 * A REFUND keeps the executor it was requested through: another system or account of the same
 * executor kind never evidences it, whichever entry path the evidence took (#1150/#1152).
 */
const bypassesRefundRoute = (
  source: PaymentReconciliationEvidenceSource,
  operation: PaymentReconciliationOperationView,
): boolean => {
  const route = operation.refundExecutionRoute;
  return (
    route !== undefined &&
    route.sourceKind === source.sourceKind &&
    (route.sourceSystem !== source.sourceSystem ||
      route.accountRef !== source.accountRef ||
      route.environment !== source.environment)
  );
};

const qualificationRefusal = (
  facts: PaymentReconciliationEvidenceFacts,
  subject: PaymentReconciliationCaseSubject,
  operation: PaymentReconciliationOperationView,
): string | undefined => {
  if (facts.paymentId === undefined || facts.paymentId !== subject.paymentId) {
    return 'The evidence does not belong to the Payment of this case';
  }
  if (!QUALIFYING_ACCEPTANCE.has(facts.acceptanceOutcome)) {
    return 'Only authorized, recorded evidence can be attached';
  }
  if (!facts.sourceAuthorityActive) {
    return 'The evidence source is not a configured ACTIVE authority';
  }
  if (facts.corrected) {
    return 'A qualified source correction disproved this evidence';
  }
  if (facts.operationId !== undefined && facts.operationId !== operation.operationId) {
    return 'The evidence is correlated to another operation';
  }
  if (bypassesRefundRoute(facts.source, operation)) {
    return 'The evidence does not come from the refund execution route the REFUND was requested through';
  }
  return undefined;
};

/**
 * Sources that speak for a Payment only through its exact selected capability (#1152): the COD carrier
 * must name the selected Delivery Offer, the local POS operator the selected pickup capability.
 */
const SELECTED_CAPABILITY_SOURCES: ReadonlySet<PaymentSourceKind> = new Set(['CARRIER', 'LOCAL_POS_OPERATOR'] as const);

/**
 * Source qualification holds a statement of such a source that does not prove the selected capability
 * (CAPABILITY_NOT_CORRELATED) and keeps no capability reference, so a held statement of these sources
 * never proves that correlation: governance cannot establish its effect, only a source statement naming
 * the capability can.
 */
const selectedCapabilityUnproven = (facts: PaymentReconciliationEvidenceFacts): boolean =>
  facts.acceptanceOutcome === 'HELD_UNRESOLVED' && SELECTED_CAPABILITY_SOURCES.has(facts.source.sourceKind);

/**
 * The attached statement and another uncorrected statement confirming this operation's effect carry
 * different economic effect keys: two proven monetary effects (e.g. two returns), not one
 * (#1151 "Several observations proven to describe the same economic effect count once").
 */
const statesDistinctEffect = (
  facts: PaymentReconciliationEvidenceFacts,
  operation: PaymentReconciliationOperationView,
  outcome: PaymentOperationOutcome,
): boolean => {
  const key = facts.economicEffectKey;
  return (
    outcome === 'EFFECT_CONFIRMED' &&
    key !== undefined &&
    facts.establishedEffects.some(
      (established) =>
        established.operationId === operation.operationId &&
        established.observationId !== facts.observationId &&
        established.economicEffectKey !== undefined &&
        established.economicEffectKey !== key &&
        paymentFactMeaning(established.factKind)?.outcome === outcome,
    )
  );
};

const decideAttach = (
  input: PaymentReconciliationDecisionInput,
  requestedOperationId: string | undefined,
): PaymentReconciliationStepCase => {
  if (Option.isNone(input.evidence)) {
    return reject('payment_reconciliation_evidence_not_found', 'The evidence does not exist in this scope');
  }
  const facts = input.evidence.value;
  const target = targetOperation(input, requestedOperationId);
  if (Result.isFailure(target)) {
    return target.failure;
  }
  const operation = target.success;
  const refusal = qualificationRefusal(facts, input.subject, operation);
  if (refusal !== undefined) {
    return reject('payment_reconciliation_evidence_not_qualified', refusal);
  }
  const meaning = paymentFactMeaning(facts.factKind);
  const resolves = meaning !== undefined && meaning.kind === operation.kind && isDefinitiveOutcome(meaning.outcome);
  const evidenceOnly = PaymentReconciliationStep.Apply({
    change: Option.none(),
    closeCase: false,
    decisionKind: 'ATTACH_EVIDENCE',
    evidenceRef: Option.some(facts.observationId),
    resultingOutcome: Option.none(),
  });
  if (!resolves) {
    return evidenceOnly;
  }
  if (selectedCapabilityUnproven(facts)) {
    return reject(
      'payment_reconciliation_evidence_not_qualified',
      'The held evidence does not prove the selected Delivery Offer or pickup capability of this Payment',
    );
  }
  if (facts.countedToward.some((counted) => counted !== operation.operationId)) {
    // One economic effect counts once: it never confirms a second operation.
    return reject(
      'payment_reconciliation_evidence_not_qualified',
      'The evidence already counts toward another operation of this Payment',
    );
  }
  if (statesDistinctEffect(facts, operation, meaning.outcome)) {
    // One operation is one monetary effect: a second proven effect is never folded into it.
    return reject(
      'payment_reconciliation_evidence_not_qualified',
      'The evidence proves an economic effect distinct from the one that already established this operation',
    );
  }
  if (facts.amount !== undefined && !sameAmount(facts.amount, operation.amount)) {
    return reject('payment_reconciliation_evidence_not_qualified', 'The evidence amount differs from the operation');
  }
  if (operation.outcome !== meaning.outcome && !isAllowedOutcomeTransition(operation.outcome, meaning.outcome)) {
    return reject(
      'payment_reconciliation_decision_not_applicable',
      `The evidence contradicts the ${operation.outcome} outcome; classify the conflict first`,
    );
  }
  return PaymentReconciliationStep.Apply({
    change: changeTo(operation, meaning.outcome),
    closeCase: false,
    decisionKind: 'ATTACH_EVIDENCE',
    evidenceRef: Option.some(facts.observationId),
    resultingOutcome: Option.some(meaning.outcome),
  });
};

const decideClassify = (input: PaymentReconciliationDecisionInput): PaymentReconciliationStepCase => {
  if (input.subject.operationId === undefined) {
    return reject('payment_reconciliation_decision_not_applicable', 'Only an operation case can hold a conflict');
  }
  return Result.match(targetOperation(input, input.subject.operationId), {
    onFailure: (refusal) => refusal,
    onSuccess: (operation) =>
      PaymentReconciliationStep.Apply({
        change: changeTo(operation, 'CONFLICT'),
        closeCase: false,
        decisionKind: 'CLASSIFY_CONFLICT',
        evidenceRef: Option.none(),
        resultingOutcome: Option.some('CONFLICT'),
      }),
  });
};

/**
 * Why the observation a case holds is still an unresolved monetary obligation, or `undefined` when
 * Current state accounts for it. Pending, not-effected and unrecognized statements claim no money.
 */
const unresolvedObligation = (evidence: PaymentReconciliationCaseEvidence): string | undefined => {
  if (evidence.acceptanceOutcome === 'ACCEPTED_OBSERVATION' || evidence.corrected) {
    // Applied to Current by its own interpretation, or disproven by its qualified source.
    return undefined;
  }
  if (evidence.factKind === 'SOURCE_CORRECTION') {
    return evidence.correctionTargetEstablished && !evidence.conflictClassified
      ? 'The held correction disproves evidence the Current interpretation still relies on; classify the conflict first'
      : undefined;
  }
  if (evidence.factKind === 'SETTLEMENT_OBSERVED') {
    return evidence.attachedOutcomes.length === 0
      ? 'The held settlement is not assigned to an operation of a Payment'
      : undefined;
  }
  const meaning = paymentFactMeaning(evidence.factKind);
  return meaning?.outcome === 'EFFECT_CONFIRMED' && !evidence.attachedOutcomes.includes(meaning.outcome)
    ? 'The held evidence states a monetary effect that no operation accounts for'
    : undefined;
};

const decideClose = (input: PaymentReconciliationDecisionInput, evidenceRef: string): PaymentReconciliationStepCase => {
  const { operationId } = input.subject;
  if (operationId !== undefined) {
    const operation = input.operations.find((candidate) => candidate.operationId === operationId);
    if (operation === undefined || !isDefinitiveOutcome(operation.outcome)) {
      return reject(
        'payment_reconciliation_obligation_unresolved',
        'The operation of this case is still unresolved; closing would discard a monetary obligation',
      );
    }
  }
  const obligation = input.caseEvidence.pipe(
    Option.flatMap((evidence) => Option.fromUndefinedOr(unresolvedObligation(evidence))),
  );
  if (Option.isSome(obligation)) {
    return reject('payment_reconciliation_obligation_unresolved', obligation.value);
  }
  return PaymentReconciliationStep.Apply({
    change: Option.none(),
    closeCase: true,
    decisionKind: 'CLOSE_CASE',
    evidenceRef: Option.some(evidenceRef),
    resultingOutcome: Option.none(),
  });
};

/** Decides one reconciliation decision against the locked case and Payment. */
export const decidePaymentReconciliation = (
  input: PaymentReconciliationDecisionInput,
): PaymentReconciliationStepCase => {
  if (input.subject.status === 'CLOSED') {
    return reject('payment_reconciliation_case_already_closed', 'The reconciliation case is already closed');
  }
  return Match.valueTags(input.body, {
    ATTACH_EVIDENCE: (body) => decideAttach(input, body.operationId),
    CLASSIFY_CONFLICT: () => decideClassify(input),
    CLOSE_CASE: ({ evidenceRef }) => decideClose(input, evidenceRef),
  });
};
