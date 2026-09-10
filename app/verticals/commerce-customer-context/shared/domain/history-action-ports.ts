import { Effect } from 'effect';
import type { RepeatOrderActionResult } from './history-action-contracts.ts';
import { HistoryActionUnavailable } from './history-action-errors.ts';
import type { RepeatCartCreationOutcome, RepeatCartPublicPort } from './repeat-cart-public-port.ts';
import type { HistoricalRecordRef } from './record-visibility-contracts.ts';

export interface HistoryActionOwnerPorts {
  readonly carts: RepeatCartPublicPort;
}

export { RepeatCartOwner } from './repeat-cart-public-port.ts';
export type { RepeatCartCreationOutcome, RepeatCartPublicPort } from './repeat-cart-public-port.ts';

const unavailable = (ownerModuleId: string) =>
  Effect.fail(
    new HistoryActionUnavailable({
      code: 'history_action_unavailable',
      ownerModuleId,
      reason: `${ownerModuleId} public Action port is not configured`,
    }),
  );

/** Fail-closed external boundary: the Cart owner has not published a live adapter yet. */
export const unavailableHistoryActionOwnerPorts = (): HistoryActionOwnerPorts => ({
  carts: { createFromHistoricalIntent: () => unavailable('commerce.cart') },
});

export const repeatCartResult = (
  sourceOrderRef: HistoricalRecordRef,
  outcome: Exclude<RepeatCartCreationOutcome, { readonly outcome: 'CONFLICT' }>,
): RepeatOrderActionResult => ({
  cartRef: outcome.cartRef,
  lines: outcome.lines,
  outcome: outcome.outcome === 'CREATED' ? 'CART_CREATED' : 'CART_ALREADY_CREATED',
  sourceOrderRef,
});
