import { GATEWAY_LAUNCH_CAPABILITIES } from '../psp/capability-matrix.ts';
import type { GatewayCapabilityRow } from '../psp/capability-matrix.ts';
import { GatewayProviderUnavailable, GatewayProviderUnsupported } from '../psp/psp-errors.ts';
import type { GatewayProviderUnavailableError, GatewayProviderUnsupportedError } from '../psp/psp-errors.ts';
import type { GatewayCapability } from '../../../shared/domain/psp-vocabulary.ts';

/**
 * Comgate Launch capabilities (#1154, #1159). Collect, status, cancel of a PENDING payment, refund and
 * push are all documented. Comgate is built but not enableable at Launch (plan D11, N9): collect needs
 * a payer contact Payment has no owner for, and refund completion is unprovable (N10). Comgate has no
 * idempotency key, no replay and no lookup by `refId`; those requests fail with typed errors, never a
 * finding or a fallback.
 */

export const COMGATE_CAPABILITIES: GatewayCapabilityRow = GATEWAY_LAUNCH_CAPABILITIES.COMGATE;

/** Typed reasons used by the Comgate adapter. */
export const COMGATE_UNSUPPORTED_REASONS = {
  amountOutOfRange: 'comgate_amount_out_of_range',
  foreignProviderRef: 'comgate_foreign_provider_ref',
  orderReferenceLookup: 'comgate_order_reference_lookup_unsupported',
  replay: 'comgate_replay_unsupported',
} as const;

export const COMGATE_PAYER_CONTACT_UNAVAILABLE_REASON = 'payer_contact_unavailable';

export const comgateUnsupported = (
  capability: GatewayCapability,
  reason: (typeof COMGATE_UNSUPPORTED_REASONS)[keyof typeof COMGATE_UNSUPPORTED_REASONS],
): GatewayProviderUnsupportedError =>
  new GatewayProviderUnsupported({
    capability,
    code: 'gateway_provider_unsupported',
    family: 'COMGATE',
    reason,
  });

/** Comgate requires `fullName` and `email` or `phone`; without them nothing is prepared or sent (plan §4, N9). */
export const comgatePayerContactUnavailable = (): GatewayProviderUnavailableError =>
  new GatewayProviderUnavailable({
    code: 'gateway_provider_unavailable',
    family: 'COMGATE',
    reason: COMGATE_PAYER_CONTACT_UNAVAILABLE_REASON,
  });
