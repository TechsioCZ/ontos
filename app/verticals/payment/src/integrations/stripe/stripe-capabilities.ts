import { GATEWAY_LAUNCH_CAPABILITIES } from '../psp/capability-matrix.ts';
import type { GatewayCapabilityRow } from '../psp/capability-matrix.ts';

/**
 * Stripe Launch capabilities (#1154, #1159): collect through a hosted Checkout Session, retrieve
 * (session, PaymentIntent, refund, PaymentIntent search), cancel by expiring an open session, refund
 * a PaymentIntent, and signed webhooks. All supported; the row is the frozen matrix entry.
 */
export const STRIPE_CAPABILITIES: GatewayCapabilityRow = GATEWAY_LAUNCH_CAPABILITIES.STRIPE;

/**
 * Stripe keeps an idempotent request result for at least 24 hours
 * (https://docs.stripe.com/api/idempotent_requests), so an exact replay is allowed inside that window only.
 */
export const STRIPE_REPLAY_WINDOW_MS = 86_400_000;

/** A Checkout Session expires at most 24 hours after creation (https://docs.stripe.com/api/checkout/sessions/create). */
export const STRIPE_CHECKOUT_SESSION_LIFETIME_SECONDS = 86_400;

/** Webhook signature tolerance (https://docs.stripe.com/webhooks#verify-manually). */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;
