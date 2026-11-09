import { describe, expect, it } from 'effect-rstest';
import { Option } from 'effect';

import type { PaymentReconciliationDecisionBody } from '../../shared/domain/evidence-contract.ts';
import type { PaymentOperationOutcome } from '../../shared/domain/payment-vocabulary.ts';
import type { PaymentEvidenceOperationView } from '../../src/domain/evidence-interpretation.ts';
import { decidePaymentReconciliation, PaymentReconciliationStep } from '../../src/domain/evidence-reconciliation.ts';
import type {
  PaymentReconciliationCaseSubject,
  PaymentReconciliationEvidenceFacts,
} from '../../src/domain/evidence-reconciliation.ts';

const PAYMENT_ID = 'payment-1';
const COLLECT_ID = 'collect-1';
const czk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });

const collect = (outcome: PaymentOperationOutcome, targetOperationId?: string): PaymentEvidenceOperationView => ({
  amount: czk(100_000),
  kind: 'COLLECT',
  operationId: COLLECT_ID,
  outcome,
  outcomeRevision: 3,
  targetOperationId,
});
const absent = Option.getOrUndefined(Option.none<string>());

const openCase: PaymentReconciliationCaseSubject = { operationId: COLLECT_ID, paymentId: PAYMENT_ID, status: 'OPEN' };

const facts = (overrides: Partial<PaymentReconciliationEvidenceFacts> = {}): PaymentReconciliationEvidenceFacts => ({
  acceptanceOutcome: 'HELD_UNRESOLVED',
  amount: czk(100_000),
  corrected: false,
  factKind: 'COLLECTION_CONFIRMED',
  observationId: 'obs-1',
  operationId: COLLECT_ID,
  paymentId: PAYMENT_ID,
  sourceAuthorityActive: true,
  ...overrides,
});

const attach: PaymentReconciliationDecisionBody = { _tag: 'ATTACH_EVIDENCE', observationId: 'obs-1' };
const classify: PaymentReconciliationDecisionBody = { _tag: 'CLASSIFY_CONFLICT' };
const close: PaymentReconciliationDecisionBody = { _tag: 'CLOSE_CASE', evidenceRef: 'erp-statement-7' };

const decide = (
  body: PaymentReconciliationDecisionBody,
  outcome: PaymentOperationOutcome,
  evidence: Option.Option<PaymentReconciliationEvidenceFacts> = Option.none(),
  subject: PaymentReconciliationCaseSubject = openCase,
) => decidePaymentReconciliation({ body, evidence, operations: [collect(outcome)], subject });

const rejectionCode = (step: ReturnType<typeof decide>) =>
  PaymentReconciliationStep.$match(step, { Apply: () => 'applied', Reject: ({ code }) => code });

describe('#1151 governed reconciliation decisions', () => {
  it('#1151 attaching qualified configured evidence resolves a conflicting operation to the proven outcome', () => {
    expect(decide(attach, 'CONFLICT', Option.some(facts()))).toEqual(
      PaymentReconciliationStep.Apply({
        change: Option.some({
          expectedOutcomeRevision: 3,
          from: 'CONFLICT',
          operationId: COLLECT_ID,
          to: 'EFFECT_CONFIRMED',
        }),
        closeCase: false,
        decisionKind: 'ATTACH_EVIDENCE',
        evidenceRef: Option.some('obs-1'),
        resultingOutcome: Option.some('EFFECT_CONFIRMED'),
      }),
    );
  });

  it('#1151 reconciliation never confirms an effect without qualified evidence', () => {
    expect(rejectionCode(decide(attach, 'CONFLICT'))).toBe('payment_reconciliation_evidence_not_found');
    expect(rejectionCode(decide(attach, 'CONFLICT', Option.some(facts({ sourceAuthorityActive: false }))))).toBe(
      'payment_reconciliation_evidence_not_qualified',
    );
    expect(
      rejectionCode(decide(attach, 'CONFLICT', Option.some(facts({ acceptanceOutcome: 'UNAUTHORIZED_SOURCE' })))),
    ).toBe('payment_reconciliation_evidence_not_qualified');
    expect(rejectionCode(decide(attach, 'CONFLICT', Option.some(facts({ corrected: true }))))).toBe(
      'payment_reconciliation_evidence_not_qualified',
    );
    expect(rejectionCode(decide(attach, 'CONFLICT', Option.some(facts({ paymentId: 'payment-2' }))))).toBe(
      'payment_reconciliation_evidence_not_qualified',
    );
    expect(rejectionCode(decide(attach, 'CONFLICT', Option.some(facts({ amount: czk(99_999) }))))).toBe(
      'payment_reconciliation_evidence_not_qualified',
    );
  });

  it('#1151 non-outcome evidence is attached as evidence only and fabricates no outcome', () => {
    expect(decide(attach, 'INDETERMINATE', Option.some(facts({ factKind: 'SETTLEMENT_OBSERVED' })))).toEqual(
      PaymentReconciliationStep.Apply({
        change: Option.none(),
        closeCase: false,
        decisionKind: 'ATTACH_EVIDENCE',
        evidenceRef: Option.some('obs-1'),
        resultingOutcome: Option.none(),
      }),
    );
  });

  it('#1151 evidence contradicting a definitive outcome must be classified as a conflict first', () => {
    expect(
      rejectionCode(decide(attach, 'NOT_EFFECTED_CONFIRMED', Option.some(facts({ factKind: 'COLLECTION_CONFIRMED' })))),
    ).toBe('payment_reconciliation_decision_not_applicable');
    expect(decide(classify, 'NOT_EFFECTED_CONFIRMED')).toMatchObject({
      change: Option.some({ from: 'NOT_EFFECTED_CONFIRMED', to: 'CONFLICT' }),
      decisionKind: 'CLASSIFY_CONFLICT',
    });
  });

  it('#1151 classifying an already conflicting operation changes nothing but is audited', () => {
    expect(decide(classify, 'CONFLICT')).toMatchObject({ change: Option.none(), decisionKind: 'CLASSIFY_CONFLICT' });
  });

  it('#1151 closing an administrative case never discards an unresolved monetary obligation', () => {
    for (const outcome of ['PENDING', 'INDETERMINATE', 'CONFLICT'] as const) {
      expect(rejectionCode(decide(close, outcome))).toBe('payment_reconciliation_obligation_unresolved');
    }
    expect(decide(close, 'EFFECT_CONFIRMED')).toEqual(
      PaymentReconciliationStep.Apply({
        change: Option.none(),
        closeCase: true,
        decisionKind: 'CLOSE_CASE',
        evidenceRef: Option.some('erp-statement-7'),
        resultingOutcome: Option.none(),
      }),
    );
  });

  it('#1151 a closed case accepts no further decision', () => {
    expect(rejectionCode(decide(close, 'EFFECT_CONFIRMED', Option.none(), { ...openCase, status: 'CLOSED' }))).toBe(
      'payment_reconciliation_case_already_closed',
    );
  });

  it('#1151 a held observation case may be assigned only to an operation of its own Payment', () => {
    const heldCase: PaymentReconciliationCaseSubject = {
      operationId: absent,
      paymentId: PAYMENT_ID,
      status: 'OPEN',
    };
    const assigned: PaymentReconciliationDecisionBody = {
      _tag: 'ATTACH_EVIDENCE',
      observationId: 'obs-1',
      operationId: COLLECT_ID,
    };
    expect(decide(assigned, 'PENDING', Option.some(facts({ operationId: absent })), heldCase)).toMatchObject({
      change: Option.some({ to: 'EFFECT_CONFIRMED' }),
    });
    expect(rejectionCode(decide(attach, 'PENDING', Option.some(facts({ operationId: absent })), heldCase))).toBe(
      'payment_reconciliation_decision_not_applicable',
    );
    expect(rejectionCode(decide(classify, 'PENDING', Option.none(), heldCase))).toBe(
      'payment_reconciliation_decision_not_applicable',
    );
  });
});
