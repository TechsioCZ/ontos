import { Schema } from 'effect';

import type { RetailPortalPermissionCode } from '../domain/profile-contracts.ts';
import { UpdateCustomerOwnConsentSchema } from './consent-api.ts';
import { UpdateCustomerOwnProfileSchema } from './profile-api.ts';

/*
 * The storefront customer's own profile, consents and password, as governed reads and Actions of the registered
 * storefront client (`commerce.storefront-client`). The portal routes admit the customer's session from its cookie
 * and hand the read or Action exactly that session's own account; the owner overlay then re-proves, inside the
 * operation's own transaction, that this account is bound to this Party in this company. "The session itself is the
 * owner rule": nothing names a Party but the admitted session.
 */

/** The storefront workload key every portal self-service carrier admits (O73). */
export const STOREFRONT_CLIENT_WORKLOAD = 'commerce.storefront-client';

const Uuid = Schema.String.check(Schema.isUUID());
export const PortalAuthBindingIdSchema = Uuid.pipe(Schema.brand('PortalAuthBindingId'));
export const PortalCustomerPrincipalIdSchema = Uuid.pipe(Schema.brand('PortalCustomerPrincipalId'));
export const PortalPartyIdSchema = Uuid.pipe(Schema.brand('PortalPartyId'));
/** SHA-256 (hex) of the admitted session's published reference: it names the session, never its token. */
export const PortalSessionRefDigestSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)).pipe(
  Schema.brand('PortalSessionRefDigest'),
);
export const PortalProviderSubjectIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).pipe(
  Schema.brand('PortalProviderSubjectId'),
);

/**
 * The admitted portal session's own account, as the portal route admitted it: its external-identity binding, its own
 * customer principal, the Party that account is bound to and its provider subject. It is set by the route from the
 * session cookie it verified, never by the storefront or the browser.
 */
export const CustomerPortalOwnSessionSchema = Schema.Struct({
  authBindingId: PortalAuthBindingIdSchema,
  customerPrincipalId: PortalCustomerPrincipalIdSchema,
  partyId: PortalPartyIdSchema,
  providerSubjectId: PortalProviderSubjectIdSchema,
  sessionRefDigest: PortalSessionRefDigestSchema,
});
export type CustomerPortalOwnSession = typeof CustomerPortalOwnSessionSchema.Type;

/** The two governed reads take nothing but the admitted session: there is no Party parameter to name another. */
export const CustomerOwnPortalReadInputSchema = Schema.Struct({ session: CustomerPortalOwnSessionSchema });
export type CustomerOwnPortalReadInput = typeof CustomerOwnPortalReadInputSchema.Type;

export const UpdateOwnCustomerProfilePayloadSchema = Schema.Struct({
  session: CustomerPortalOwnSessionSchema,
  update: UpdateCustomerOwnProfileSchema,
});
export type UpdateOwnCustomerProfilePayload = typeof UpdateOwnCustomerProfilePayloadSchema.Type;

export const UpdateOwnCustomerConsentPayloadSchema = Schema.Struct({
  session: CustomerPortalOwnSessionSchema,
  update: UpdateCustomerOwnConsentSchema,
});
export type UpdateOwnCustomerConsentPayload = typeof UpdateOwnCustomerConsentPayloadSchema.Type;

/**
 * The password change carries the session and NOTHING else. The current and new passwords are never part of an Action
 * payload: Core hashes the payload into the invocation's request hash and keeps the invocation row, so a password in
 * it would be stored as an unsalted digest. They reach the owner routine only through the route's own request.
 */
export const ChangeOwnCustomerPasswordPayloadSchema = Schema.Struct({ session: CustomerPortalOwnSessionSchema });
export type ChangeOwnCustomerPasswordPayload = typeof ChangeOwnCustomerPasswordPayloadSchema.Type;

/**
 * What a portal write commits: that this session's own write was authorized and evidenced. The owner routine runs once
 * the commit holds, so a recorded result never claims the change itself, and a same-key retry never re-runs it.
 */
export const CustomerOwnWriteAuthorizedSchema = Schema.Struct({ authorized: Schema.Literal(true) });
export type CustomerOwnWriteAuthorized = typeof CustomerOwnWriteAuthorizedSchema.Type;

/** The owner facts of a portal session (O70): the overlay reads the account binding they name, never trusts them. */
export const PORTAL_SESSION_FACT = {
  authBindingId: 'portalAuthBindingId',
  customerPrincipalId: 'portalCustomerPrincipalId',
  partyId: 'portalPartyId',
  providerSubjectId: 'portalProviderSubjectId',
  sessionRefDigest: 'portalSessionRefDigest',
} as const;

export const portalSessionOwnerFacts = (session: CustomerPortalOwnSession) =>
  ({
    [PORTAL_SESSION_FACT.authBindingId]: session.authBindingId,
    [PORTAL_SESSION_FACT.customerPrincipalId]: session.customerPrincipalId,
    [PORTAL_SESSION_FACT.partyId]: session.partyId,
    [PORTAL_SESSION_FACT.providerSubjectId]: session.providerSubjectId,
    [PORTAL_SESSION_FACT.sessionRefDigest]: session.sessionRefDigest,
  }) satisfies Readonly<Record<string, string>>;

/** The operation keys of the five portal self-service carriers, and the retail right each needs of the session. */
export const PORTAL_OWN_OPERATION = {
  credentialChange: 'commerce.customer-context.change-own-customer-password',
  readConsent: 'commerce.customer-context.api.customer-consent-read-own',
  readProfile: 'commerce.customer-context.api.customer-profile-read-own',
  updateConsent: 'commerce.customer-context.update-own-customer-consent',
  updateProfile: 'commerce.customer-context.update-own-customer-profile',
} as const;

/**
 * The retail portal right the session's own account must hold for each operation: the same right the portal session
 * admission asks today (consent asks `retail.consent.manage`, everything else `retail.profile.read`). The overlay picks
 * it by operation, never from the request.
 */
const PROFILE_READ: RetailPortalPermissionCode = 'retail.profile.read';
const CONSENT_MANAGE: RetailPortalPermissionCode = 'retail.consent.manage';
export const portalOwnPermissionByOperation: ReadonlyMap<string, RetailPortalPermissionCode> = new Map([
  [PORTAL_OWN_OPERATION.credentialChange, PROFILE_READ],
  [PORTAL_OWN_OPERATION.readConsent, CONSENT_MANAGE],
  [PORTAL_OWN_OPERATION.readProfile, PROFILE_READ],
  [PORTAL_OWN_OPERATION.updateConsent, CONSENT_MANAGE],
  [PORTAL_OWN_OPERATION.updateProfile, PROFILE_READ],
]);
