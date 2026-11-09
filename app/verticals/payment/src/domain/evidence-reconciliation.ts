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
} from '../../shared/domain/payment-vocabulary.ts';
import type { PaymentEvidenceOperationView, PaymentEvidenceOutcomeChange } from './evidence-interpretation.ts';
import { paymentFactMeaning } from './evidence-interpretation.ts';
import { sameAmount } from './money.ts';
import { isAllowedOutcomeTransition, isDefinitiveOutcome } from './operation-lifecycle.ts';

/**
 * Governed reconciliation decisions (#1151 "Operator reconciliation cannot fabricate money"). Pure:
 * the Action supplies the locked case, the locked Payment's operations and the qualification facts of
 * the attached observation. No branch creates an operation, an amount or a refund; an effect is
 * confirmed only by a qualified observation that states exactly that effect; a case closes only when
 * its operation is definitive.
 */

export interface PaymentReconciliationCaseSubject {
  readonly operationId: string | undefined;
  readonly paymentId: string | undefined;
  readonly status: PaymentReconciliationCaseStatus;
}

/** What the Action established about the observation an ATTACH_EVIDENCE decision names. */
export interface PaymentReconciliationEvidenceFacts {
  readonly acceptanceOutcome: PaymentObservationAcceptanceOutcome;
  readonly amount: PaymentMonetaryAmount | undefined;
  /** A later accepted SOURCE_CORRECTION disproved this statement. */
  readonly corrected: boolean;
  readonly factKind: PaymentObservationFactKind;
  readonly observationId: string;
  readonly operationId: string | undefined;
  readonly paymentId: string | undefined;
  /** The observation came from a configured source authority that is ACTIVE now. */
  readonly sourceAuthorityActive: boolean;
}

export interface PaymentReconciliationDecisionInput {
  readonly body: PaymentReconciliationDecisionBody;
  readonly evidence: Option.Option<PaymentReconciliationEvidenceFacts>;
  readonly operations: readonly PaymentEvidenceOperationView[];
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
): Result.Result<PaymentEvidenceOperationView, PaymentReconciliationStepCase> => {
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

const qualificationRefusal = (
  facts: PaymentReconciliationEvidenceFacts,
  subject: PaymentReconciliationCaseSubject,
  operation: PaymentEvidenceOperationView,
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
  return undefined;
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
