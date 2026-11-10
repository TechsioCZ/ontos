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
import type {
  PaymentEffectIdentity,
  PaymentEvidenceOperationView,
  PaymentEvidenceOutcomeChange,
} from './evidence-interpretation.ts';
import {
  completesCancellationContradiction,
  paymentFactMeaning,
  restatesEstablishedEffect,
} from './evidence-interpretation.ts';
import { sameAmount } from './money.ts';
import { isAllowedOutcomeTransition, isDefinitiveOutcome } from './operation-lifecycle.ts';
import { PAYMENT_SELECTED_CAPABILITY_SOURCES } from './source-qualification.ts';

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
export interface PaymentReconciliationEstablishedEffect extends PaymentEffectIdentity {
  readonly factKind: PaymentObservationFactKind;
  readonly observationId: string;
  readonly operationId: string;
}

/** What the Action established about the observation an ATTACH_EVIDENCE decision names. */
export interface PaymentReconciliationEvidenceFacts {
  readonly acceptanceOutcome: PaymentObservationAcceptanceOutcome;
  readonly amount: PaymentMonetaryAmount | undefined;
  /**
   * Selected-capability sources only: source qualification proved the statement names the selected
   * Delivery Offer / pickup capability of its Payment (recorded with the observation).
   */
  readonly capabilityCorrelated: boolean | undefined;
  /** A qualified SOURCE_CORRECTION (accepted, held or conflicting) disproved this statement. */
  readonly corrected: boolean;
  /**
   * Return statements only: the money its accepted partial corrections took away, as the funds reader
   * measures it. Such a statement proves less than it states (#1150).
   */
  readonly correctedAmount?: PaymentMonetaryAmount | undefined;
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
  /**
   * Held SOURCE_CORRECTION only: Current state still rests on the statement it names (the statement
   * stands and its operation has the outcome it states), so the unapplied correction is still owed.
   */
  readonly correctionTargetRelied?: boolean;
  /**
   * EFFECT_CONFIRMED statements only: the same economic effect (source binding, fact kind, key) already
   * counts toward an operation of this Payment (any Payment when unassigned), or a held REFUND_CONFIRMED is a
   * prior return of a COLLECT of this Payment that the funds reader already counts (#1150). Either way the
   * held copy is accounted for.
   */
  readonly economicEffectCounted?: boolean;
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
 * A REFUND keeps the executor it was requested through: any other executor binding (another source kind,
 * system, account or environment) never evidences it, whichever entry path the evidence took (#1150/#1152).
 */
const bypassesRefundRoute = (
  source: PaymentReconciliationEvidenceSource,
  operation: PaymentReconciliationOperationView,
): boolean => {
  const route = operation.refundExecutionRoute;
  return (
    route !== undefined &&
    (route.sourceKind !== source.sourceKind ||
      route.sourceSystem !== source.sourceSystem ||
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
 * A COD carrier or local POS statement speaks for a Payment only through its exact selected capability
 * (#1152). Source qualification records whether it proved that capability; a statement held as
 * CAPABILITY_NOT_CORRELATED keeps no capability reference, so governance cannot establish its effect.
 * A statement that did prove it (e.g. held only because its operation is in CONFLICT) can be attached.
 */
const selectedCapabilityUnproven = (facts: PaymentReconciliationEvidenceFacts): boolean =>
  PAYMENT_SELECTED_CAPABILITY_SOURCES.has(facts.source.sourceKind) && facts.capabilityCorrelated !== true;

/**
 * The attached statement and another uncorrected statement confirming this operation's effect carry
 * different economic effect keys: two proven monetary effects (e.g. two returns), not one
 * (#1151 "Several observations proven to describe the same economic effect count once").
 */
const statesDistinctEffect = (
  facts: PaymentReconciliationEvidenceFacts,
  operation: PaymentReconciliationOperationView,
  outcome: PaymentOperationOutcome,
): boolean =>
  outcome === 'EFFECT_CONFIRMED' &&
  !restatesEstablishedEffect(
    facts,
    facts.establishedEffects.filter(
      (established) =>
        established.operationId === operation.operationId &&
        established.observationId !== facts.observationId &&
        paymentFactMeaning(established.factKind)?.outcome === outcome,
    ),
  );

/**
 * An uncorrected statement of this operation already establishes the opposite definitive outcome. A governed
 * attachment of the other outcome would overturn it without a full qualified disproof (#1151).
 */
const contradictsEstablishedOutcome = (
  facts: PaymentReconciliationEvidenceFacts,
  operation: PaymentReconciliationOperationView,
  outcome: PaymentOperationOutcome,
): boolean =>
  facts.establishedEffects.some((established) => {
    const establishedOutcome = paymentFactMeaning(established.factKind)?.outcome;
    return (
      established.operationId === operation.operationId &&
      established.observationId !== facts.observationId &&
      establishedOutcome !== undefined &&
      isDefinitiveOutcome(establishedOutcome) &&
      establishedOutcome !== outcome
    );
  });

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
  if (contradictsEstablishedOutcome(facts, operation, meaning.outcome)) {
    return reject(
      'payment_reconciliation_evidence_not_qualified',
      'An uncorrected statement already establishes the opposite outcome of this operation; only a full qualified disproof removes it',
    );
  }
  if (facts.amount !== undefined && !sameAmount(facts.amount, operation.amount)) {
    return reject('payment_reconciliation_evidence_not_qualified', 'The evidence amount differs from the operation');
  }
  if (facts.correctedAmount !== undefined) {
    // A refund has no reduction ledger: a partially retracted receipt cannot confirm the whole REFUND.
    return reject(
      'payment_reconciliation_evidence_not_qualified',
      'Accepted corrections reduced the evidence; it no longer proves the full amount of the operation',
    );
  }
  if (
    operation.outcome !== meaning.outcome &&
    completesCancellationContradiction(input.operations, operation, meaning.outcome)
  ) {
    // A confirmed cancellation and a confirmed collection of one COLLECT contradict each other: never complete the pair.
    return reject(
      'payment_reconciliation_decision_not_applicable',
      'The evidence would complete a confirmed cancellation and collection of the same COLLECT; it stays held',
    );
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
    if (evidence.correctionTargetEstablished && !evidence.conflictClassified) {
      return 'The held correction disproves evidence the Current interpretation still relies on; classify the conflict first';
    }
    // A classified conflict that was resolved with the corrected statement itself left the correction unapplied.
    return evidence.correctionTargetRelied === true
      ? 'The held correction is not applied and Current funds still rest on the statement it corrects'
      : undefined;
  }
  if (evidence.factKind === 'SETTLEMENT_OBSERVED') {
    return evidence.attachedOutcomes.length === 0
      ? 'The held settlement is not assigned to an operation of a Payment'
      : undefined;
  }
  const meaning = paymentFactMeaning(evidence.factKind);
  return meaning?.outcome === 'EFFECT_CONFIRMED' &&
    !evidence.attachedOutcomes.includes(meaning.outcome) &&
    evidence.economicEffectCounted !== true
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
