import { Result } from 'effect';

import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import type { PaymentFundsOperation, PaymentFundsSnapshot } from './coverage.ts';
import { compareAmounts, sameAmount, subtractAmounts, sumAmounts } from './money.ts';

/**
 * Prior return evidence in the refund funds guard (#1150 "Prior return evidence reduces the remaining
 * budget"). A qualified REFUND_CONFIRMED statement proves money of this Payment already went back to
 * the customer. When it describes a Payment REFUND that the shared calculator already counts
 * (confirmed or reserved), it adds nothing; a second, distinct proven effect stated against that same
 * REFUND cannot be told apart from it and holds new returns. Otherwise it is a confirmed return of the collection it
 * names, counted once per proven economic effect, whether or not its reconciliation case is closed.
 * A statement that cannot be assigned or measured holds new returns instead of inventing funds.
 */

/** One qualified, not fully corrected REFUND_CONFIRMED observation of this Payment, read under the row lock. */
export interface PaymentReturnEvidence {
  /** The money the statement states; undefined when the source stated none. Identifies a counted REFUND. */
  readonly amount: PaymentMonetaryAmount | undefined;
  /** Money accepted corrections took away from the statement; what remains is what it still proves (#1150). */
  readonly correctedAmount?: PaymentMonetaryAmount | undefined;
  /** Observations proven to describe the same economic effect share this key and count once. */
  readonly economicEffectKey: string | undefined;
  readonly observationId: string;
  readonly operationId: string | undefined;
  /**
   * The identity of the source binding that issued the statement. Effect keys are source-scoped: the same
   * opaque key from two bindings is two returns (#1151).
   */
  readonly sourceBindingKey?: string | undefined;
}

/** How the accepted corrections of one return statement reach it (#1150). */
export interface CorrectionReach {
  /** The money a partial correction took away; absent when no measured correction reduces the statement. */
  readonly correctedAmount?: PaymentMonetaryAmount;
  /** True when the corrections cover all of the stated money: the statement no longer counts. */
  readonly covered: boolean;
}

const NOT_REDUCED: CorrectionReach = { covered: false };
const COVERED: CorrectionReach = { covered: true };

/**
 * What the accepted corrections of one return statement do to it (#1150). A correction that states no
 * amount retracts the whole statement. Otherwise only corrections stating money in the statement's
 * currency reduce it, and only all of them together: one in another currency cannot be measured and
 * reduces nothing. The statement is removed when the corrections cover all of its stated money; a
 * partial correction keeps the remainder.
 */
export const correctionReachOf = (
  stated: PaymentMonetaryAmount | undefined,
  corrections: readonly (PaymentMonetaryAmount | undefined)[],
): CorrectionReach => {
  if (corrections.length === 0) {
    return NOT_REDUCED;
  }
  // A correction that states no amount retracts the whole statement, as the interpreter reads it.
  if (corrections.some((correction) => correction === undefined)) {
    return COVERED;
  }
  if (stated === undefined) {
    return NOT_REDUCED;
  }
  const measured = corrections.flatMap((correction) =>
    correction === undefined || correction.currency !== stated.currency ? [] : [correction],
  );
  if (measured.length !== corrections.length) {
    return NOT_REDUCED;
  }
  const total = sumAmounts(measured, stated.currency);
  if (Result.isFailure(total)) {
    return NOT_REDUCED;
  }
  const order = compareAmounts(total.success, stated);
  if (Result.isFailure(order)) {
    return NOT_REDUCED;
  }
  return order.success >= 0 ? COVERED : { correctedAmount: total.success, covered: false };
};

/** What a statement still proves: its stated money less the accepted partial corrections. */
const provenAmountOf = (statement: PaymentReturnEvidence): PaymentMonetaryAmount | undefined => {
  if (statement.amount === undefined) {
    return undefined;
  }
  if (statement.correctedAmount === undefined) {
    return statement.amount;
  }
  const remaining = subtractAmounts(statement.amount, statement.correctedAmount);
  return Result.getOrUndefined(remaining);
};

type EffectGroup = readonly [PaymentReturnEvidence, ...PaymentReturnEvidence[]];

/** A REFUND the calculator already counts: confirmed, or still reserving its funds. */
const describesCountedRefund = (
  evidence: PaymentReturnEvidence,
  operation: PaymentFundsOperation | undefined,
): boolean =>
  operation !== undefined &&
  operation.kind === 'REFUND' &&
  operation.outcome !== 'NOT_EFFECTED_CONFIRMED' &&
  (evidence.amount === undefined || sameAmount(evidence.amount, operation.amount));

const groupByEconomicEffect = (evidence: readonly PaymentReturnEvidence[]): readonly EffectGroup[] => {
  const groups = new Map<string, [PaymentReturnEvidence, ...PaymentReturnEvidence[]]>();
  for (const statement of evidence) {
    const key =
      statement.economicEffectKey === undefined
        ? `observation:${statement.observationId}`
        : `effect:${statement.sourceBindingKey ?? ''}:${statement.economicEffectKey}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [statement]);
    } else {
      group.push(statement);
    }
  }
  return [...groups.values()];
};

/** The single return of one effect group against a COLLECT of this Payment, or undefined when ambiguous. */
const collectionReturnOf = (
  group: EffectGroup,
  operations: ReadonlyMap<string, PaymentFundsOperation>,
): PaymentFundsOperation | undefined => {
  const [first] = group;
  const { observationId, operationId } = first;
  const amount = provenAmountOf(first);
  const collect = operationId === undefined ? undefined : operations.get(operationId);
  const consistent = group.every((statement) => {
    const proven = provenAmountOf(statement);
    return (
      statement.operationId === operationId &&
      proven !== undefined &&
      amount !== undefined &&
      sameAmount(proven, amount)
    );
  });
  if (collect?.kind !== 'COLLECT' || amount === undefined || !consistent) {
    return undefined;
  }
  return {
    amount,
    kind: 'REFUND',
    operationId: `observation:${observationId}`,
    outcome: 'EFFECT_CONFIRMED',
    targetOperationId: collect.operationId,
  };
};

/**
 * The funds snapshot with prior return evidence applied: each uncounted proven return becomes one
 * confirmed return of its collection; any unassignable, unmeasured or inconsistent return marks the
 * snapshot as unresolved so the shared guard holds new returns for reconciliation.
 */
export const fundsSnapshotWithPriorReturns = (
  snapshot: PaymentFundsSnapshot,
  evidence: readonly PaymentReturnEvidence[],
): PaymentFundsSnapshot => {
  const operations = new Map(snapshot.operations.map((operation) => [operation.operationId, operation]));
  const priorReturns: PaymentFundsOperation[] = [];
  /** The proven economic effect each counted REFUND already stands for. */
  const refundEffects = new Map<string, string>();
  let ambiguous = false;
  for (const group of groupByEconomicEffect(evidence)) {
    const countedRefund = group.find((statement) =>
      describesCountedRefund(
        statement,
        statement.operationId === undefined ? undefined : operations.get(statement.operationId),
      ),
    );
    if (countedRefund?.operationId !== undefined && countedRefund.economicEffectKey !== undefined) {
      // A second proven return stated against the same REFUND is not that REFUND: hold, never fold it in.
      const prior = refundEffects.get(countedRefund.operationId);
      ambiguous ||= prior !== undefined && prior !== countedRefund.economicEffectKey;
      refundEffects.set(countedRefund.operationId, prior ?? countedRefund.economicEffectKey);
    }
    if (countedRefund === undefined) {
      const prior = collectionReturnOf(group, operations);
      if (prior === undefined) {
        ambiguous = true;
      } else {
        priorReturns.push(prior);
      }
    }
  }
  return {
    ...snapshot,
    operations: [...snapshot.operations, ...priorReturns],
    unresolvedEvidence: snapshot.unresolvedEvidence || ambiguous,
  };
};
