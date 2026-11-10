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
  /**
   * True when the scope-wide attribution ledger already counts this economic effect for an operation of
   * another Payment: one effect counts once, so here it is unresolved debt, never a return (#1151).
   */
  readonly attributedElsewhere?: boolean | undefined;
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

/** The identity of a source binding in return evidence. NUL cannot occur in PostgreSQL text, so it separates the fields. */
export const returnSourceBindingKey = (source: {
  readonly accountRef: string;
  readonly environment: string;
  readonly sourceKind: string;
  readonly sourceSystem: string;
}): string => [source.sourceKind, source.sourceSystem, source.accountRef, source.environment].join('\u0000');

/**
 * A standing return statement of the same source-scoped economic effect states other money than the
 * candidate. One effect is one amount: the candidate contradicts it and is never counted or folded in
 * (#1151 "conflicting evidence becomes held reconciliation debt").
 */
export const contradictsStandingReturn = (
  evidence: readonly PaymentReturnEvidence[],
  candidate: {
    readonly amount: PaymentMonetaryAmount | undefined;
    readonly economicEffectKey: string | undefined;
    readonly observationId?: string | undefined;
    readonly sourceBindingKey: string;
  },
): boolean => {
  const { amount, economicEffectKey } = candidate;
  return (
    amount !== undefined &&
    economicEffectKey !== undefined &&
    evidence.some(
      (statement) =>
        statement.observationId !== candidate.observationId &&
        statement.economicEffectKey === economicEffectKey &&
        statement.sourceBindingKey === candidate.sourceBindingKey &&
        statement.amount !== undefined &&
        !sameAmount(statement.amount, amount),
    )
  );
};

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

/** One stored correction as the shared reduction rule reads it. */
interface AppliedCorrectionCandidate {
  readonly acceptanceOutcome: string;
  readonly correctsObservationId: string | null;
  readonly economicEffectKey: string | null;
}

/**
 * The accepted corrections that each reduce a statement once. A correction re-issued under the same
 * economic effect key (accepted again as "already corrected") is the same reduction, not another one.
 */
export const appliedCorrectionsOf = <Correction extends AppliedCorrectionCandidate>(
  observationId: string,
  corrections: readonly Correction[],
): readonly Correction[] => {
  const seenKeys = new Set<string>();
  return corrections.filter((correction) => {
    if (correction.acceptanceOutcome !== 'ACCEPTED_OBSERVATION' || correction.correctsObservationId !== observationId) {
      return false;
    }
    const key = correction.economicEffectKey;
    if (key === null) {
      return true;
    }
    if (seenKeys.has(key)) {
      return false;
    }
    seenKeys.add(key);
    return true;
  });
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

/**
 * Groups statements proven to describe one economic effect: the same source binding and the same key.
 * The identity is a pair, kept as nested maps so no separator inside a binding or a key can merge two
 * identities. A keyless statement is its own effect.
 */
const groupByEconomicEffect = (evidence: readonly PaymentReturnEvidence[]): readonly EffectGroup[] => {
  const groups: [PaymentReturnEvidence, ...PaymentReturnEvidence[]][] = [];
  const keyed = new Map<string, Map<string, [PaymentReturnEvidence, ...PaymentReturnEvidence[]]>>();
  for (const statement of evidence) {
    const { economicEffectKey } = statement;
    if (economicEffectKey === undefined) {
      groups.push([statement]);
    } else {
      const binding = statement.sourceBindingKey ?? '';
      const ofBinding = keyed.get(binding) ?? new Map<string, [PaymentReturnEvidence, ...PaymentReturnEvidence[]]>();
      keyed.set(binding, ofBinding);
      const group = ofBinding.get(economicEffectKey);
      if (group === undefined) {
        const created: [PaymentReturnEvidence, ...PaymentReturnEvidence[]] = [statement];
        ofBinding.set(economicEffectKey, created);
        groups.push(created);
      } else {
        group.push(statement);
      }
    }
  }
  return groups;
};

/** Every statement of the group that states money still proves the same amount. */
const statesOneAmount = (group: EffectGroup): boolean => {
  const proven = group.flatMap((statement) => provenAmountOf(statement) ?? []);
  const [first] = proven;
  return first === undefined || proven.every((amount) => sameAmount(amount, first));
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

/** The prior returns of a Payment as every reader counts them (#1150). */
interface PaymentPriorReturns {
  /** True when a proven return cannot be assigned, measured or told apart: new returns are held. */
  readonly ambiguous: boolean;
  /** One confirmed return per proven economic effect that no Payment REFUND already stands for. */
  readonly returns: readonly PaymentFundsOperation[];
}

/**
 * The one reading of prior return evidence against the Payment's operations. A group of statements
 * proven to be one economic effect counts once: nothing when a counted REFUND already stands for it
 * (whichever operation its other statements name), otherwise one confirmed return of the collection
 * it names. The funds snapshot and the correction admission both use exactly this result.
 */
export const priorReturnsOf = (
  fundsOperations: readonly PaymentFundsOperation[],
  evidence: readonly PaymentReturnEvidence[],
): PaymentPriorReturns => {
  const operations = new Map(fundsOperations.map((operation) => [operation.operationId, operation]));
  const returns: PaymentFundsOperation[] = [];
  /** The proven economic effect each counted REFUND already stands for. */
  const refundEffects = new Map<string, string>();
  let ambiguous = false;
  for (const group of groupByEconomicEffect(evidence)) {
    if (group.some((statement) => statement.attributedElsewhere === true)) {
      // The same money already counts for another Payment: it proves no return here and holds new ones.
      ambiguous = true;
      continue;
    }
    const countedRefund = group.find((statement) =>
      describesCountedRefund(
        statement,
        statement.operationId === undefined ? undefined : operations.get(statement.operationId),
      ),
    );
    if (countedRefund !== undefined && !statesOneAmount(group)) {
      // Statements of one economic effect that state different money contradict each other: the REFUND
      // never absorbs the other amount (#1151 "conflicting evidence is held, never folded").
      ambiguous = true;
    }
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
        returns.push(prior);
      }
    }
  }
  return { ambiguous, returns };
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
  const prior = priorReturnsOf(snapshot.operations, evidence);
  return {
    ...snapshot,
    operations: [...snapshot.operations, ...prior.returns],
    unresolvedEvidence: snapshot.unresolvedEvidence || prior.ambiguous,
  };
};
