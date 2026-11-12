import { GATEWAY_LAUNCH_CAPABILITIES } from '../psp/capability-matrix.ts';
import type { GatewayCapabilityRow } from '../psp/capability-matrix.ts';
import { GatewayProviderUnsupported } from '../psp/psp-errors.ts';
import type { GatewayProviderUnsupportedError } from '../psp/psp-errors.ts';

/**
 * GoPay Launch capabilities (#1154, #1156, plan N8). GoPay documents no cancel for an unpaid
 * standard payment (only `void-authorization` for preauthorized payments, which OntOS never
 * creates); an unpaid payment ends only by expiry (TIMEOUTED) or decline (CANCELED). CANCEL_OR_VOID
 * is therefore UNSUPPORTED and never falls back to a void, a refund or another provider.
 */

export const GOPAY_CAPABILITIES: GatewayCapabilityRow = GATEWAY_LAUNCH_CAPABILITIES.GOPAY;

/** Reason carried by the typed failure and by the local CANCEL_NOT_EFFECTED evidence. */
export const GOPAY_CANCEL_UNSUPPORTED_REASON = 'provider_cancel_unsupported';

/** The typed failure of every GoPay cancel or void request. */
export const gopayCancelUnsupported = (): GatewayProviderUnsupportedError =>
  new GatewayProviderUnsupported({
    capability: 'CANCEL_OR_VOID',
    code: 'gateway_provider_unsupported',
    family: 'GOPAY',
    reason: GOPAY_CANCEL_UNSUPPORTED_REASON,
  });
