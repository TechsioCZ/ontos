import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import type { PaymentFundsOperation, PaymentFundsSnapshot } from './coverage.ts';
import { sameAmount } from './money.ts';

/**
 * Prior return evidence in the refund funds guard (#1150 "Prior return evidence reduces the remaining
 * budget"). A qualified REFUND_CONFIRMED statement proves money of this Payment already went back to
 * the customer. When it describes a Payment REFUND that the shared calculator already counts
 * (confirmed or reserved), it adds nothing. Otherwise it is a confirmed return of the collection it
 * names, counted once per proven economic effect, whether or not its reconciliation case is closed.
 * A statement that cannot be assigned or measured holds new returns instead of inventing funds.
 */

/** One qualified, uncorrected REFUND_CONFIRMED observation of this Payment, read under the row lock. */
export interface PaymentReturnEvidence {
  readonly amount: PaymentMonetaryAmount | undefined;
  /** Observations proven to describe the same economic effect share this key and count once. */
  readonly economicEffectKey: string | undefined;
  readonly observationId: string;
  readonly operationId: string | undefined;
}

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
    const key = statement.economicEffectKey ?? `observation:${statement.observationId}`;
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
  const { amount, observationId, operationId } = first;
  const collect = operationId === undefined ? undefined : operations.get(operationId);
  const consistent = group.every(
    (statement) =>
      statement.operationId === operationId &&
      statement.amount !== undefined &&
      amount !== undefined &&
      sameAmount(statement.amount, amount),
  );
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
  let ambiguous = false;
  for (const group of groupByEconomicEffect(evidence)) {
    const counted = group.some((statement) =>
      describesCountedRefund(
        statement,
        statement.operationId === undefined ? undefined : operations.get(statement.operationId),
      ),
    );
    if (!counted) {
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
