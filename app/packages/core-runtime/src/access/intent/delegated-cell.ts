import { Option, Result } from 'effect';

import { lifecycleRefusal } from '../lifecycle/errors.ts';
import type { AccessLifecycleError } from '../lifecycle/errors.ts';
import type { AmountCeiling, Cell, DelegatedLimits, Delegation, Holder } from '../model.ts';
import { principalIdOf } from './persistence.ts';

/*
 * D10b: a delegated cell is bounded by the envelope it came from, not only by its own ceiling. The
 * write path proves an assignment fits its delegation once, with `delegationCellIssue`; the read path
 * has to answer with the same bound every time it hands a cell to a decision, because a decision that
 * sees only the cell's own limit would spend money the delegation never granted.
 *
 * `delegationCellIssue` states the same envelope for the writer, and this read cannot call it: it
 * refuses an uncapped money cell outright where a read has to bound one. The refusal codes below are
 * its codes, so both paths still name the same rule when they disagree.
 *
 * Only a capability that moves money is limited by an amount ceiling, on both paths: the reader is told
 * whether the cell's catalog entry declares an `amountInput`, the test `delegationCellIssue` applies,
 * and a delegation's ceiling never reaches a cell that no request will ever supply an amount for.
 *
 * The two paths differ in one thing on purpose. A writer refuses the whole command when a cell does not
 * fit, while a reader cannot refuse a tenant's authority because one row disagrees with its envelope:
 * it drops that cell, so the decision is smaller and never larger. Only for an uncapped money cell does
 * the read keep the cell and take the envelope's ceiling — a reader must bound what it was given rather
 * than answer with unlimited authority, which is exactly what a missing ceiling would mean.
 */

export interface DelegatedCellRequest {
  /** Whether the cell's catalog entry declares an `amountInput`, so an amount ceiling can apply to it. */
  readonly amountGoverned: boolean;
  /** The cell the role revision grants, exactly as the row stores it. */
  readonly cell: Cell;
  /** The delegation the assignment names, live at the instant the read answers for. */
  readonly delegation: Delegation;
  /** The envelope the assignment froze from its delegation, kept after the delegation ends (D21). */
  readonly frozen: DelegatedLimits;
  readonly holder: Holder;
  /** The role the assignment holds, exactly as the row stores it; membership in the envelope is equality. */
  readonly roleId: string;
}

const narrowest = (ceilings: readonly AmountCeiling[]): Option.Option<AmountCeiling> => {
  const [first] = ceilings;
  if (first === undefined) {
    return Option.none();
  }
  let narrow = first;
  for (const ceiling of ceilings) {
    // One envelope spanning two currencies bounds nothing, so that cell leaves intent (fail closed).
    if (ceiling.currency !== first.currency) {
      return Option.none();
    }
    if (ceiling.limitMinor < narrow.limitMinor) {
      narrow = ceiling;
    }
  }
  return Option.some(narrow);
};

/**
 * The ceiling a delegated cell may actually spend, or the rule that keeps the cell out of the read.
 *
 * The holder is the person the envelope names and never its own manager (D10); the capability has to
 * appear in both the delegation and the envelope frozen from it, and the role has to be one the
 * delegation manages. A money cell's ceiling is then the narrowest of the cell's own, the frozen
 * envelope's and the delegation's, and a currency any one of them disagrees on removes the cell rather
 * than widening it — a limit expressed in another currency cannot bound this one. A cell that governs
 * no amount keeps only its own ceiling: the envelope's money limit does not apply to it.
 */
export const delegatedCellCeiling = (
  request: DelegatedCellRequest,
): Result.Result<Option.Option<AmountCeiling>, AccessLifecycleError> => {
  const { amountGoverned, cell, delegation, frozen, holder, roleId } = request;
  const person = Option.getOrUndefined(principalIdOf(holder));
  if (person === undefined || person === delegation.managerId || !new Set(delegation.people).has(person)) {
    return Result.fail(
      lifecycleRefusal(
        'delegation_holder_outside_envelope',
        `holder ${Option.getOrElse(principalIdOf(holder), () => delegation.managerId)} is outside delegation ${delegation.id}`,
      ),
    );
  }
  if (
    !new Set(delegation.capabilityKeys).has(cell.capabilityKey) ||
    !new Set(frozen.capabilityKeys).has(cell.capabilityKey)
  ) {
    return Result.fail(
      lifecycleRefusal(
        'delegation_cell_outside_envelope',
        `capability ${cell.capabilityKey} is outside delegation ${delegation.id}`,
      ),
    );
  }
  if (!new Set<string>(delegation.roleIds).has(roleId)) {
    return Result.fail(
      lifecycleRefusal('delegation_role_outside_envelope', `role ${roleId} is outside delegation ${delegation.id}`),
    );
  }
  const bounds = amountGoverned
    ? [cell.amountCeiling, frozen.amountCeiling, delegation.amountCeiling]
    : [cell.amountCeiling];
  const ceilings = bounds.filter((ceiling): ceiling is AmountCeiling => ceiling !== undefined);
  if (ceilings.length === 0) {
    return Result.succeed(Option.none());
  }
  const ceiling = narrowest(ceilings);
  return Option.isSome(ceiling)
    ? Result.succeed(ceiling)
    : Result.fail(
        lifecycleRefusal(
          'delegation_amount_outside_envelope',
          `the cell, the envelope and delegation ${delegation.id} do not share one currency`,
        ),
      );
};
