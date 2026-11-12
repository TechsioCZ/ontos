import { GATEWAY_LAUNCH_CAPABILITIES } from '../psp/capability-matrix.ts';
import type { GatewayCapabilityRow } from '../psp/capability-matrix.ts';
import { GatewayProviderUnavailable } from '../psp/psp-errors.ts';
import type { GatewayProviderUnavailableError } from '../psp/psp-errors.ts';

/**
 * GoPay Launch capabilities on Payments API v4 (#1154, #1156, #1159; plan D-P1). CANCEL_OR_VOID is
 * `DELETE /payments/{payment_id}` (https://api-docs.gopay.com/llms-full.txt "Canceling a payment": only a
 * payment in CREATED can be canceled, 204, any other state 409), always decided by a lookup of the payment.
 * It never falls back to a void, a refund or another provider.
 */

export const GOPAY_CAPABILITIES: GatewayCapabilityRow = GATEWAY_LAUNCH_CAPABILITIES.GOPAY;

/** Reason of a CANCEL_NOT_EFFECTED: GoPay refuses a cancel outside CREATED, and the lookup shows that state. */
export const GOPAY_CANCEL_REJECTED_STATE_REASON = 'provider_cancel_rejected_state';

/** Reason of a collect that cannot be prepared: v4 requires `customer.email` (at most 128 characters). */
const GOPAY_PAYER_CONTACT_UNAVAILABLE_REASON = 'payer_contact_unavailable';

/** The typed prepare-time failure of a collect without a usable payer email; nothing is sent. */
export const gopayPayerContactUnavailable = (): GatewayProviderUnavailableError =>
  new GatewayProviderUnavailable({
    code: 'gateway_provider_unavailable',
    family: 'GOPAY',
    reason: GOPAY_PAYER_CONTACT_UNAVAILABLE_REASON,
  });
