import { Schema } from 'effect';

/**
 * Published, schema-only vocabulary of the Portal Auth side of the Communications contract (#1406). Portal Auth is the
 * SOLE source owner of three security e-mails: the verification link, the password reset link and the second-factor
 * one-time code. This file names what Auth tells Communications about an issuance; it carries references and closed
 * keys only. No token, link, one-time code, password or address can be represented in it, so nothing here can leak by
 * construction.
 *
 * The strings below must equal the approved catalog entries of Communications (`approved-registry.ts`); the end-to-end
 * suites assert it. The message type, purpose and state names are PROPOSED names that Auth owner review confirms.
 */

export const PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE = 'commerce.customer-context';

export const PortalAuthEmailFlowSchema = Schema.Literals(['verify-email', 'reset-password', 'otp']);
export type PortalAuthEmailFlow = typeof PortalAuthEmailFlowSchema.Type;
export const PORTAL_AUTH_EMAIL_FLOWS = PortalAuthEmailFlowSchema.literals;

/** The reason Auth asks for a communication; the same key the approved Message Type of the flow carries. */
export const portalAuthCommunicationPurposeOf = (flow: PortalAuthEmailFlow): string =>
  `commerce.customer-context.portal-auth.${flow}`;

/** Auth's own role vocabulary for the one recipient of each message: the holder of the account the issuance was made for. */
export const PORTAL_AUTH_RECIPIENT_ROLE = 'account-holder';

/**
 * The secret-bearing placeholder each approved Template Revision declares as `owner-rendered`. The generic Communications
 * renderer leaves it untouched and refuses any value for it, so the owner completes it under its own authority (ADR-0022).
 */
const OWNER_RENDERED_SLOTS: readonly (readonly [PortalAuthEmailFlow, string])[] = [
  ['verify-email', 'verification_link'],
  ['reset-password', 'reset_link'],
  ['otp', 'otp_code'],
];
export const portalAuthOwnerRenderedSlotOf = (flow: PortalAuthEmailFlow): string =>
  OWNER_RENDERED_SLOTS.find(([candidate]) => candidate === flow)?.[1] ?? flow;

/** Resource types of the references Auth names in a request. None of them is a copy of the resource. */
export const PORTAL_AUTH_RESOURCE_TYPE = {
  account: 'commerce.customer-context.portal-auth-account',
  endpoint: 'commerce.customer-context.portal-auth-endpoint',
  issuance: 'commerce.customer-context.portal-auth-issuance',
} as const;

/** The one safe reference an Auth request names: the issuance the message belongs to. */
export const PORTAL_AUTH_ISSUANCE_REFERENCE_KEY = 'portal-auth.issuance';

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

/** Source-owned replay identity: one issuance always carries the same key; a token, link, code or address never does. */
export const portalAuthIdempotencyKey = (flow: PortalAuthEmailFlow, issuanceRef: PortalAuthIssuanceRef): string =>
  `portal-auth.${flow}.${issuanceRef}`;
