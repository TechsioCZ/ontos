import { Schema } from 'effect';

/**
 * Closed reasons an Auth issuance cannot lead to a completed owner-rendered slot. They name an Auth lifecycle fact and
 * never carry a value: no token, link, code, address or provider text can travel in one.
 * - EXPIRED / CONSUMED / REVOKED / SUPERSEDED: the issuance is no longer usable (Auth's own state; SUPERSEDED = a newer one replaced it);
 * - NOT_RESUMABLE: this runtime no longer holds the protected handoff of the issuance (a restart, another instance). The
 *   secret is never reproduced; only Auth itself can issue a new one;
 * - SLOT_NOT_DECLARED: the template asked Auth for a slot the flow does not own.
 */
export const OwnerSlotStopReasonSchema = Schema.Literals([
  'CONSUMED',
  'EXPIRED',
  'NOT_RESUMABLE',
  'REVOKED',
  'SLOT_NOT_DECLARED',
  'SUPERSEDED',
]);

/** Expected failure: Auth will not complete an owner-rendered slot. Nothing is reproduced and nothing is reissued. */
export class OwnerSlotStop extends Schema.TaggedError<OwnerSlotStop>()('OwnerSlotStop', {
  reason: OwnerSlotStopReasonSchema,
}) {}
