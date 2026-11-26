import type { PortalAuthIssuanceRef } from '@app/portal-auth-contracts/portal-auth-issuance';
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

// The published issuance vocabulary lives with the schema-only Portal Auth contracts, so Communications reaches it without
// taking an edge to this module's package.
export {
  PORTAL_AUTH_ISSUANCE_REVISION,
  PORTAL_AUTH_ISSUANCE_STATE,
  PortalAuthIssuanceRefSchema,
} from '@app/portal-auth-contracts/portal-auth-issuance';
export type { PortalAuthIssuanceRef, PortalAuthIssuanceState } from '@app/portal-auth-contracts/portal-auth-issuance';

/** Source-owned replay identity: one issuance always carries the same key; a token, link, code or address never does. */
export const portalAuthIdempotencyKey = (flow: PortalAuthEmailFlow, issuanceRef: PortalAuthIssuanceRef): string =>
  `portal-auth.${flow}.${issuanceRef}`;
