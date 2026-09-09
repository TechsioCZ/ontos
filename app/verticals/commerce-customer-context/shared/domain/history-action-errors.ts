import { Schema } from 'effect';
import { GuestOrderClaimRejected } from './guest-order-claim-rejected.ts';
import { GuestOrderClaimConflict } from './guest-order-claim-conflict.ts';
import { GuestOrderClaimRateLimited } from './guest-order-claim-rate-limited.ts';
import { HistoryActionUnavailable } from './history-action-unavailable.ts';
import { RepeatOrderConflict } from './repeat-order-conflict.ts';
import { RepeatOrderNoRepeatableLines } from './repeat-order-no-repeatable-lines.ts';

export { GuestOrderClaimRejected } from './guest-order-claim-rejected.ts';
export { GuestOrderClaimConflict } from './guest-order-claim-conflict.ts';
export { GuestOrderClaimRateLimited } from './guest-order-claim-rate-limited.ts';
export { HistoryActionUnavailable } from './history-action-unavailable.ts';
export { RepeatOrderConflict } from './repeat-order-conflict.ts';
export { RepeatOrderNoRepeatableLines } from './repeat-order-no-repeatable-lines.ts';

export const RepeatOrderActionErrorSchema = Schema.Union([
  HistoryActionUnavailable,
  RepeatOrderConflict,
  RepeatOrderNoRepeatableLines,
]);

export const ClaimGuestOrderActionErrorSchema = Schema.Union([
  GuestOrderClaimConflict,
  GuestOrderClaimRateLimited,
  GuestOrderClaimRejected,
  HistoryActionUnavailable,
]);
