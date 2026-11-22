import { Schema } from 'effect';

/**
 * Expected failure: Privacy did not bind the subject of an issuance whose address is not verified yet, so the message
 * stops as `not-sent` with this distinct reason and nothing is invented in its place:
 * - NO_SUPPORTED_PRIVACY_PATH: this composition has no transport to Privacy's bind Action (open item D1);
 * - PRIVACY_REFUSED: Privacy answered and bound nothing (no current policy, another caller, another scope);
 * - PRIVACY_UNAVAILABLE: Privacy did not answer, or answered outside its published contract.
 */
export class PreVerificationPrivacyBindingUnavailable extends Schema.TaggedError<PreVerificationPrivacyBindingUnavailable>()(
  'PreVerificationPrivacyBindingUnavailable',
  { reason: Schema.Literals(['NO_SUPPORTED_PRIVACY_PATH', 'PRIVACY_REFUSED', 'PRIVACY_UNAVAILABLE']) },
) {}
