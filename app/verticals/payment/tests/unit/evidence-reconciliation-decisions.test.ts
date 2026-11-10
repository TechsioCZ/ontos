import { describe, expect, it } from 'effect-rstest';
import { Option } from 'effect';

import type { PaymentReconciliationDecisionBody } from '../../shared/domain/evidence-contract.ts';
import type { PaymentOperationOutcome } from '../../shared/domain/payment-vocabulary.ts';
import type { PaymentEvidenceOperationView } from '../../src/domain/evidence-interpretation.ts';
import { decidePaymentReconciliation, PaymentReconciliationStep } from '../../src/domain/evidence-reconciliation.ts';
import type {
  PaymentReconciliationCaseEvidence,
  PaymentReconciliationCaseSubject,
  PaymentReconciliationEstablishedEffect,
  PaymentReconciliationEvidenceFacts,
  PaymentReconciliationOperationView,
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
  capabilityCorrelated: Option.getOrUndefined(Option.none<boolean>()),
  corrected: false,
  countedToward: [],
  economicEffectKey: absent,
  establishedEffects: [],
  factKind: 'COLLECTION_CONFIRMED',
  observationId: 'obs-1',
  operationId: COLLECT_ID,
  paymentId: PAYMENT_ID,
  source: {
    accountRef: 'gopay-account-1',
    environment: 'production',
    factFamily: 'GATEWAY_OUTCOME',
    sourceKind: 'PAYMENT_GATEWAY',
    sourceSystem: 'GOPAY',
  },
  sourceAuthorityActive: true,
  ...overrides,
});

const caseEvidence = (
  overrides: Partial<PaymentReconciliationCaseEvidence> = {},
): Option.Option<PaymentReconciliationCaseEvidence> =>
  Option.some({
    acceptanceOutcome: 'HELD_UNRESOLVED',
    attachedOutcomes: [],
    conflictClassified: false,
    corrected: false,
    correctionTargetEstablished: false,
    factKind: 'COLLECTION_CONFIRMED',
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
  held: Option.Option<PaymentReconciliationCaseEvidence> = Option.none(),
) => decidePaymentReconciliation({ body, caseEvidence: held, evidence, operations: [collect(outcome)], subject });

const rejectionCode = (step: ReturnType<typeof decide>) =>
  PaymentReconciliationStep.$match(step, { Apply: () => 'applied', Reject: ({ code }) => code });

/** Closes a case of a definitive operation that holds the given observation. */
const closeHeld = (held: Option.Option<PaymentReconciliationCaseEvidence>) =>
  rejectionCode(decide(close, 'EFFECT_CONFIRMED', Option.none(), openCase, held));
const closeHeldCorrection = (overrides: Partial<PaymentReconciliationCaseEvidence>) =>
  closeHeld(caseEvidence({ factKind: 'SOURCE_CORRECTION', ...overrides }));

/** A statement that already confirmed the collection, recorded under `economicEffectKey`. */
const established = (
  economicEffectKey: string | undefined,
  observationId = 'obs-0',
): PaymentReconciliationEstablishedEffect => ({
  economicEffectKey,
  factKind: 'COLLECTION_CONFIRMED',
  observationId,
  operationId: COLLECT_ID,
  source: facts().source,
});
/** Attaches a held collection statement of `economicEffectKey` to the collection of the open case. */
const attachWith = (
  economicEffectKey: string | undefined,
  establishedEffects: readonly PaymentReconciliationEstablishedEffect[],
  outcome: PaymentOperationOutcome = 'EFFECT_CONFIRMED',
) => rejectionCode(decide(attach, outcome, Option.some(facts({ economicEffectKey, establishedEffects }))));

const carrier = {
  accountRef: 'dpd-merchant-12',
  environment: 'production',
  factFamily: 'COD_CUSTOMER_COLLECTION',
  sourceKind: 'CARRIER',
  sourceSystem: 'dpd',
} as const;
const pos = {
  accountRef: 'pos-drawer-1',
  environment: 'production',
  factFamily: 'LOCAL_POS_COLLECTION',
  sourceKind: 'LOCAL_POS_OPERATOR',
  sourceSystem: 'store-pos',
} as const;
/**
 * Attaches a collection statement of `source` recorded with `acceptanceOutcome` and the capability
 * correlation its qualification proved to the pending collection.
 */
const attachHeldCapability = (
  source: PaymentReconciliationEvidenceFacts['source'],
  acceptanceOutcome: PaymentReconciliationEvidenceFacts['acceptanceOutcome'],
  capabilityCorrelated: boolean,
) => rejectionCode(decide(attach, 'PENDING', Option.some(facts({ acceptanceOutcome, capabilityCorrelated, source }))));

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

  it('#1152 a COD carrier or POS statement proves its effect through attachment only when it proved the selected capability', () => {
    expect([
      attachHeldCapability(carrier, 'HELD_UNRESOLVED', false),
      attachHeldCapability(pos, 'HELD_UNRESOLVED', false),
      rejectionCode(decide(attach, 'PENDING', Option.some(facts({ source: carrier })))),
      attachHeldCapability(carrier, 'HELD_UNRESOLVED', true),
      attachHeldCapability(pos, 'HELD_UNRESOLVED', true),
      attachHeldCapability(carrier, 'CONFLICT', true),
      attachHeldCapability(pos, 'CONFLICT', true),
    ]).toEqual([
      'payment_reconciliation_evidence_not_qualified',
      'payment_reconciliation_evidence_not_qualified',
      'payment_reconciliation_evidence_not_qualified',
      'applied',
      'applied',
      'applied',
      'applied',
    ]);
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
    // A return whose effect another standing statement states with other money is assigned to nothing.
    expect(rejectionCode(decide(attach, 'CONFLICT', Option.some(facts({ contradictsStandingReturn: true }))))).toBe(
      'payment_reconciliation_evidence_not_qualified',
    );
    // An assignment that changes no outcome is refused too when the statement already counts elsewhere.
    expect(
      rejectionCode(
        decide(
          attach,
          'EFFECT_CONFIRMED',
          Option.some(facts({ countedToward: ['refund-1'], factKind: 'REFUND_CONFIRMED' })),
        ),
      ),
    ).toBe('payment_reconciliation_evidence_not_qualified');
    // A partially retracted statement proves less than it states: it cannot confirm the whole operation.
    expect(rejectionCode(decide(attach, 'CONFLICT', Option.some(facts({ correctedAmount: czk(10_000) }))))).toBe(
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

  it('#1151 closing a case never discards a held monetary statement that no operation accounts for', () => {
    // A qualified return reported against the collection, an orphan receipt, an unassigned settlement.
    expect(closeHeld(caseEvidence({ factKind: 'REFUND_CONFIRMED' }))).toBe(
      'payment_reconciliation_obligation_unresolved',
    );
    expect(closeHeld(caseEvidence())).toBe('payment_reconciliation_obligation_unresolved');
    expect(closeHeld(caseEvidence({ factKind: 'SETTLEMENT_OBSERVED' }))).toBe(
      'payment_reconciliation_obligation_unresolved',
    );
    const orphanCase: PaymentReconciliationCaseSubject = { operationId: absent, paymentId: absent, status: 'OPEN' };
    expect(rejectionCode(decide(close, 'PENDING', Option.none(), orphanCase, caseEvidence()))).toBe(
      'payment_reconciliation_obligation_unresolved',
    );
    // Accounted for: resolved by a governed attachment, applied by acceptance, or disproven by its source.
    expect(closeHeld(caseEvidence({ attachedOutcomes: ['EFFECT_CONFIRMED'] }))).toBe('applied');
    expect(closeHeld(caseEvidence({ attachedOutcomes: [undefined], factKind: 'SETTLEMENT_OBSERVED' }))).toBe('applied');
    expect(closeHeld(caseEvidence({ acceptanceOutcome: 'ACCEPTED_OBSERVATION' }))).toBe('applied');
    expect(closeHeld(caseEvidence({ corrected: true, factKind: 'REFUND_CONFIRMED' }))).toBe('applied');
    // An evidence-only attachment or a different resulting outcome does not account for the money.
    expect(closeHeld(caseEvidence({ attachedOutcomes: [undefined, 'CONFLICT'] }))).toBe(
      'payment_reconciliation_obligation_unresolved',
    );
    // Statements that claim no money keep the administrative close.
    for (const factKind of ['COLLECTION_PENDING', 'REFUND_NOT_EFFECTED', 'UNRECOGNIZED'] as const) {
      expect(closeHeld(caseEvidence({ factKind }))).toBe('applied');
    }
  });

  it('#1151 a held correction of evidence Current relies on closes only after governance applied it', () => {
    expect(closeHeldCorrection({ correctionTargetEstablished: true })).toBe(
      'payment_reconciliation_obligation_unresolved',
    );
    expect(closeHeldCorrection({ conflictClassified: true, correctionTargetEstablished: true })).toBe('applied');
    // A classified conflict resolved with the corrected statement itself leaves the correction unapplied.
    expect(
      closeHeldCorrection({
        conflictClassified: true,
        correctionTargetEstablished: true,
        correctionTargetRelied: true,
      }),
    ).toBe('payment_reconciliation_obligation_unresolved');
    expect(closeHeldCorrection({ correctionTargetEstablished: false })).toBe('applied');
  });

  it('#1151 one economic effect confirms at most one operation through governed attachment', () => {
    const heldCase: PaymentReconciliationCaseSubject = { operationId: absent, paymentId: PAYMENT_ID, status: 'OPEN' };
    const assigned: PaymentReconciliationDecisionBody = {
      _tag: 'ATTACH_EVIDENCE',
      observationId: 'obs-1',
      operationId: COLLECT_ID,
    };
    const attachCounted = (countedToward: readonly (string | undefined)[]) =>
      rejectionCode(decide(assigned, 'PENDING', Option.some(facts({ countedToward, operationId: absent })), heldCase));
    expect(attachCounted(['collect-2'])).toBe('payment_reconciliation_evidence_not_qualified');
    expect(attachCounted([undefined])).toBe('payment_reconciliation_evidence_not_qualified');
    expect(attachCounted([COLLECT_ID])).toBe('applied');
    expect(attachCounted([])).toBe('applied');
  });

  it('#1151 a statement of a distinct economic effect never confirms an operation another effect established', () => {
    // A second proven receipt (or return) is a separate monetary effect: it is not folded into this one.
    expect(attachWith('gopay:payment:2', [established('gopay:payment:1')])).toBe(
      'payment_reconciliation_evidence_not_qualified',
    );
    expect(attachWith('gopay:payment:2', [established('gopay:payment:1')], 'CONFLICT')).toBe(
      'payment_reconciliation_evidence_not_qualified',
    );
    // A keyed statement beside a keyless one is never proven the same money, whichever came first,
    // and the same opaque key from another source binding is another receipt.
    expect(attachWith(absent, [established('gopay:payment:1')])).toBe('payment_reconciliation_evidence_not_qualified');
    expect(attachWith('gopay:payment:2', [established(absent)])).toBe('payment_reconciliation_evidence_not_qualified');
    expect(
      attachWith('gopay:payment:1', [
        { ...established('gopay:payment:1'), source: { ...facts().source, accountRef: 'gopay-account-2' } },
      ]),
    ).toBe('payment_reconciliation_evidence_not_qualified');
    // The same effect, two keyless statements, its own earlier attachment or another operation's effect still attach.
    expect(attachWith('gopay:payment:1', [established('gopay:payment:1')])).toBe('applied');
    expect(attachWith(absent, [established(absent)])).toBe('applied');
    expect(attachWith('gopay:payment:2', [established('gopay:payment:1', 'obs-1')])).toBe('applied');
    expect(attachWith('gopay:payment:2', [{ ...established('gopay:payment:1'), operationId: 'collect-2' }])).toBe(
      'applied',
    );
    // Statements that claim no money are not effects to count.
    expect(attachWith('gopay:payment:2', [{ ...established('gopay:payment:1'), factKind: 'COLLECTION_PENDING' }])).toBe(
      'applied',
    );
  });

  it('#1150/#1152 refund evidence attaches only from the refund route the REFUND was requested through', () => {
    const refund: PaymentReconciliationOperationView = {
      amount: czk(50_000),
      kind: 'REFUND',
      operationId: 'refund-1',
      outcome: 'PENDING',
      outcomeRevision: 1,
      refundExecutionRoute: {
        accountRef: 'refund-account-a',
        environment: 'production',
        sourceKind: 'BANK_ACCOUNTING',
        sourceSystem: 'erp-primary',
      },
      targetOperationId: COLLECT_ID,
    };
    const heldCase: PaymentReconciliationCaseSubject = { operationId: absent, paymentId: PAYMENT_ID, status: 'OPEN' };
    const attachFrom = (sourceSystem: string, accountRef: string) =>
      rejectionCode(
        decidePaymentReconciliation({
          body: { _tag: 'ATTACH_EVIDENCE', observationId: 'obs-1', operationId: 'refund-1' },
          caseEvidence: Option.none(),
          evidence: Option.some(
            facts({
              amount: czk(50_000),
              factKind: 'REFUND_CONFIRMED',
              operationId: absent,
              source: {
                accountRef,
                environment: 'production',
                factFamily: 'REFUND_EXECUTION',
                sourceKind: 'BANK_ACCOUNTING',
                sourceSystem,
              },
            }),
          ),
          operations: [collect('EFFECT_CONFIRMED'), refund],
          subject: heldCase,
        }),
      );
    expect(attachFrom('erp-secondary', 'refund-account-b')).toBe('payment_reconciliation_evidence_not_qualified');
    expect(attachFrom('erp-primary', 'refund-account-b')).toBe('payment_reconciliation_evidence_not_qualified');
    expect(attachFrom('erp-primary', 'refund-account-a')).toBe('applied');
  });

  it('#1150/#1152 refund evidence from another executor kind never attaches to the REFUND', () => {
    const refund: PaymentReconciliationOperationView = {
      amount: czk(50_000),
      kind: 'REFUND',
      operationId: 'refund-1',
      outcome: 'PENDING',
      outcomeRevision: 1,
      refundExecutionRoute: {
        accountRef: 'refund-account-a',
        environment: 'production',
        sourceKind: 'BANK_ACCOUNTING',
        sourceSystem: 'erp-primary',
      },
      targetOperationId: COLLECT_ID,
    };
    const crossKind = decidePaymentReconciliation({
      body: { _tag: 'ATTACH_EVIDENCE', observationId: 'obs-1', operationId: 'refund-1' },
      caseEvidence: Option.none(),
      evidence: Option.some(
        facts({
          amount: czk(50_000),
          capabilityCorrelated: true,
          factKind: 'REFUND_CONFIRMED',
          operationId: absent,
          source: {
            accountRef: 'refund-account-a',
            environment: 'production',
            factFamily: 'REFUND_EXECUTION',
            sourceKind: 'LOCAL_POS_OPERATOR',
            sourceSystem: 'erp-primary',
          },
        }),
      ),
      operations: [collect('EFFECT_CONFIRMED'), refund],
      subject: { operationId: absent, paymentId: PAYMENT_ID, status: 'OPEN' },
    });
    expect(rejectionCode(crossKind)).toBe('payment_reconciliation_evidence_not_qualified');
  });

  it('#1151 a held confirmation whose economic effect already counts for its Payment may close', () => {
    expect(closeHeld(caseEvidence({ economicEffectCounted: true }))).toBe('applied');
    expect(closeHeld(caseEvidence({ economicEffectCounted: false }))).toBe(
      'payment_reconciliation_obligation_unresolved',
    );
    // The same fact kind and key already counts toward an operation: a refund held copy is accounted for too.
    expect(closeHeld(caseEvidence({ economicEffectCounted: true, factKind: 'REFUND_CONFIRMED' }))).toBe('applied');
  });
});
