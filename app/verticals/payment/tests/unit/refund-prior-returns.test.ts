import { Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { PaymentOperationKind, PaymentOperationOutcome } from '../../shared/domain/payment-vocabulary.ts';
import { computePaymentFunds, PaymentFundsLedger } from '../../src/domain/coverage.ts';
import type { PaymentFundsOperation, PaymentFundsSnapshot } from '../../src/domain/coverage.ts';
import { correctionReachOf, fundsSnapshotWithPriorReturns } from '../../src/domain/refund-prior-returns.ts';
import type { PaymentReturnEvidence } from '../../src/domain/refund-prior-returns.ts';

/** #1150 "Prior return evidence reduces the remaining budget": the pure prior-return rule. */

const czk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });

const operation = (
  kind: PaymentOperationKind,
  operationId: string,
  outcome: PaymentOperationOutcome,
  amountMinor: number,
  targetOperationId?: string,
): PaymentFundsOperation => ({ amount: czk(amountMinor), kind, operationId, outcome, targetOperationId });
const collect = operation('COLLECT', 'collect-1', 'EFFECT_CONFIRMED', 100_000);
const refund = (outcome: PaymentOperationOutcome) => operation('REFUND', 'refund-1', outcome, 30_000, 'collect-1');
const snapshotOf = (operations: readonly PaymentFundsOperation[]): PaymentFundsSnapshot => ({
  collectionCorrections: [],
  operations,
  required: czk(100_000),
  unresolvedEvidence: false,
});
interface StatementInput {
  readonly amountMinor?: number;
  readonly economicEffectKey?: string;
  readonly observationId?: string;
  readonly operationId?: string;
  /** The source could not assign the return to an operation. */
  readonly unassigned?: boolean;
  /** The source stated the return without its money. */
  readonly unmeasured?: boolean;
}
const statement = (input: StatementInput): PaymentReturnEvidence => ({
  amount: input.unmeasured === true ? undefined : czk(input.amountMinor ?? 40_000),
  economicEffectKey: input.economicEffectKey ?? 'gopay:refund:1',
  observationId: input.observationId ?? 'observation-1',
  operationId: input.unassigned === true ? undefined : (input.operationId ?? 'collect-1'),
});
const ledgerOf = (snapshot: PaymentFundsSnapshot, evidence: readonly PaymentReturnEvidence[]) =>
  computePaymentFunds(fundsSnapshotWithPriorReturns(snapshot, evidence));
const remainingOf = (snapshot: PaymentFundsSnapshot, evidence: readonly PaymentReturnEvidence[]) => {
  const ledger = ledgerOf(snapshot, evidence);
  return PaymentFundsLedger.$is('Established')(ledger) ? ledger.remaining.amountMinor : undefined;
};
const heldReasonOf = (snapshot: PaymentFundsSnapshot, evidence: readonly PaymentReturnEvidence[]) => {
  const ledger = ledgerOf(snapshot, evidence);
  return PaymentFundsLedger.$is('Held')(ledger) ? ledger.reason : undefined;
};

describe('#1150 Prior return evidence reduces the remaining budget', () => {
  it('a proven return of the collection outside any Payment REFUND is a confirmed return', () => {
    expect(remainingOf(snapshotOf([collect]), [statement({})])).toBe(60_000);
  });

  it('several statements of the same economic effect count once', () => {
    const evidence = [statement({}), statement({ observationId: 'observation-2' })];
    expect(remainingOf(snapshotOf([collect]), evidence)).toBe(60_000);
  });

  it('the same opaque effect key from two source bindings is two returns, each counted', () => {
    const fromBankA = { ...statement({}), sourceBindingKey: 'BANK_ACCOUNTING|erp|bank-a|production' };
    const fromBankB = {
      ...statement({ observationId: 'observation-2' }),
      sourceBindingKey: 'BANK_ACCOUNTING|erp|bank-b|production',
    };
    expect(remainingOf(snapshotOf([collect]), [fromBankA, fromBankB])).toBe(20_000);
    // The same binding re-exporting its own key still counts once.
    expect(remainingOf(snapshotOf([collect]), [fromBankA, { ...fromBankA, observationId: 'observation-3' }])).toBe(
      60_000,
    );
  });

  it('evidence of a confirmed or reserved Payment REFUND is not deducted twice', () => {
    const evidence = [statement({ amountMinor: 30_000, operationId: 'refund-1' })];
    expect(remainingOf(snapshotOf([collect, refund('EFFECT_CONFIRMED')]), evidence)).toBe(70_000);
    expect(remainingOf(snapshotOf([collect, refund('PENDING')]), evidence)).toBe(70_000);
  });

  it('a second distinct return stated against an already counted REFUND is held, not folded into it', () => {
    const evidence = [
      statement({ amountMinor: 30_000, operationId: 'refund-1' }),
      statement({
        amountMinor: 30_000,
        economicEffectKey: 'gopay:refund:2',
        observationId: 'observation-2',
        operationId: 'refund-1',
      }),
    ];
    expect(heldReasonOf(snapshotOf([collect, refund('EFFECT_CONFIRMED')]), evidence)).toBe('UNRESOLVED_EVIDENCE');
    // Re-exports of the one return still count once.
    expect(
      remainingOf(snapshotOf([collect, refund('EFFECT_CONFIRMED')]), [
        statement({ amountMinor: 30_000, operationId: 'refund-1' }),
        statement({ amountMinor: 30_000, observationId: 'observation-2', operationId: 'refund-1' }),
      ]),
    ).toBe(70_000);
  });

  it('unassignable, unmeasured or inconsistent return evidence is held', () => {
    const snapshot = snapshotOf([collect, refund('NOT_EFFECTED_CONFIRMED')]);
    expect(heldReasonOf(snapshot, [statement({ unassigned: true })])).toBe('UNRESOLVED_EVIDENCE');
    expect(heldReasonOf(snapshot, [statement({ unmeasured: true })])).toBe('UNRESOLVED_EVIDENCE');
    expect(heldReasonOf(snapshot, [statement({ amountMinor: 30_000, operationId: 'refund-1' })])).toBe(
      'UNRESOLVED_EVIDENCE',
    );
    expect(
      heldReasonOf(snapshot, [statement({}), statement({ amountMinor: 50_000, observationId: 'observation-2' })]),
    ).toBe('UNRESOLVED_EVIDENCE');
  });

  it('no evidence leaves the funds snapshot unchanged', () => {
    const snapshot = snapshotOf([collect]);
    expect(fundsSnapshotWithPriorReturns(snapshot, [])).toEqual(snapshot);
  });
});

const czkOf = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });
/** A correction that states no money. */
const noAmount = Option.getOrUndefined(Option.none<ReturnType<typeof czkOf>>());

describe('#1150 What corrections do to a prior return statement', () => {
  it('an amountless correction retracts the whole statement, as the interpreter reads it', () => {
    expect(correctionReachOf(czkOf(40_000), [noAmount])).toEqual({ covered: true });
    expect(correctionReachOf(czkOf(40_000), [czkOf(10_000), noAmount])).toEqual({ covered: true });
  });

  it('measured corrections reduce the statement and remove it only when they cover it', () => {
    expect(correctionReachOf(czkOf(40_000), [czkOf(10_000)])).toEqual({
      correctedAmount: czkOf(10_000),
      covered: false,
    });
    expect(correctionReachOf(czkOf(40_000), [czkOf(10_000), czkOf(30_000)])).toEqual({ covered: true });
    expect(correctionReachOf(czkOf(40_000), [])).toEqual({ covered: false });
  });
});
