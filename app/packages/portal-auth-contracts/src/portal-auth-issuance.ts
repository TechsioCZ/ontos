import { Schema } from 'effect';

/**
 * Published, schema-only vocabulary of ONE Portal Auth issuance as Auth's `portal-auth-issuance-source` Read states it (#1406).
 * It carries a reference and closed keys only: no token, link, one-time code, password or address can be represented in it.
 */

/**
 * What Auth says about its issuance NOW, as the source state of the occurrence. Only `current` lets an approved type
 * proceed; every other state stops the message with the closed reason of Communications. The state names Auth's own
 * lifecycle and never changes it: language and template revision cannot extend, shorten or reissue an issuance.
 */
export const PORTAL_AUTH_ISSUANCE_STATE = {
  consumed: 'commerce.customer-context.portal-auth.issuance-consumed',
  current: 'commerce.customer-context.portal-auth.issuance-current',
  expired: 'commerce.customer-context.portal-auth.issuance-expired',
  notResumable: 'commerce.customer-context.portal-auth.issuance-not-resumable',
  revoked: 'commerce.customer-context.portal-auth.issuance-revoked',
  superseded: 'commerce.customer-context.portal-auth.issuance-superseded',
} as const;
/** An issuance is stated once and never revised, so its occurrence revision is always this one. */
export const PORTAL_AUTH_ISSUANCE_REVISION = 1;

export type PortalAuthIssuanceState = (typeof PORTAL_AUTH_ISSUANCE_STATE)[keyof typeof PORTAL_AUTH_ISSUANCE_STATE];

/**
 * Opaque identity of ONE Auth issuance (one verification link, one reset link or one one-time code). It is neither the
 * enrollment `ownerInvocationId` (which names the enrollment operation) nor the Communications request or Message
 * Intent, and it is never derived from a token, link, code or address.
 */
export const PortalAuthIssuanceRefSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(120),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
).pipe(Schema.brand('PortalAuthIssuanceRef'));
export type PortalAuthIssuanceRef = typeof PortalAuthIssuanceRefSchema.Type;
