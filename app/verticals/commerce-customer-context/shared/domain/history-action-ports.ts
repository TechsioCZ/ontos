import { Effect } from 'effect';
import type { RepeatOrderActionResult } from './history-action-contracts.ts';
import { HistoryActionUnavailable } from './history-action-errors.ts';
import type { GuestOrderClaimPublicPort } from './guest-order-claim-public-port.ts';
import type { RepeatCartCreationOutcome, RepeatCartPublicPort } from './repeat-cart-public-port.ts';
import type { HistoricalRecordRef } from './record-visibility-contracts.ts';

export interface HistoryActionOwnerPorts {
  readonly carts: RepeatCartPublicPort;
  readonly guestOrders: GuestOrderClaimPublicPort;
}

export { GuestOrderClaimOwner } from './guest-order-claim-public-port.ts';
export type {
  GuestOrderClaimPublicPort,
  GuestOrderOwnerClaimOutcome,
} from './guest-order-claim-public-port.ts';
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

/** Fail-closed external boundary: Cart and Order owners have not published live adapters yet. */
export const unavailableHistoryActionOwnerPorts = (): HistoryActionOwnerPorts => ({
  carts: { createFromHistoricalIntent: () => unavailable('commerce.cart') },
  guestOrders: { claim: () => unavailable('commerce.order') },
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
