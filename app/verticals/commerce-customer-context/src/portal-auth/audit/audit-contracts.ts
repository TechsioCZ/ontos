import { Schema } from 'effect';

/**
 * Commerce portal authentication audit evidence. Every event name is schema-versioned so a later
 * relay can publish it under the same key without re-interpreting older rows.
 */
export const COMMERCE_PORTAL_AUTH_AUDIT_SCHEMA_VERSION = 1;

const CommercePortalAuthAuditEventTypeSchema = Schema.Literals([
  'commerce.portal-auth.account-disabled.v1',
  'commerce.portal-auth.email-verification-consumed.v1',
  'commerce.portal-auth.email-verification-requested.v1',
  'commerce.portal-auth.mfa-verified.v1',
  'commerce.portal-auth.recovery-completed.v1',
  'commerce.portal-auth.recovery-reset-requested.v1',
  'commerce.portal-auth.recovery-started.v1',
  'commerce.portal-auth.session-refreshed.v1',
  'commerce.portal-auth.session-revoked.v1',
  'commerce.portal-auth.session-sign-in-failed.v1',
  'commerce.portal-auth.session-sign-in-requested.v1',
  'commerce.portal-auth.session-signed-in.v1',
  'commerce.portal-auth.session-signed-out.v1',
  'commerce.portal-auth.step-up-expired.v1',
  'commerce.portal-auth.step-up-issued.v1',
  'commerce.portal-auth.step-up-verified.v1',
]);
export type CommercePortalAuthAuditEventType = Schema.Schema.Type<typeof CommercePortalAuthAuditEventTypeSchema>;

/**
 * The outcome classes that require evidence. `mfa_required` is a live challenge rather than a
 * refusal, so it is recorded as its own class instead of being folded into a failure. `requested`
 * is the pre-mutation intent class: the row states that the owner is about to ask the provider to
 * change state, and it is written strictly, before the call, so no completed mutation can exist
 * without at least this row.
 */
const CommercePortalAuthAuditOutcomeSchema = Schema.Literals([
  'account_disabled',
  'authentication_failed',
  'mfa_required',
  'provider_unavailable',
  'rate_limited',
  'requested',
  'session_expired',
  'session_limit_reached',
  'session_revoked',
  'success',
  'unavailable',
  'verification_required',
]);
export type CommercePortalAuthAuditOutcome = Schema.Schema.Type<typeof CommercePortalAuthAuditOutcomeSchema>;

/** The in-process event handed to the audit port; `occurredAt` is supplied by the caller's clock. */
export interface CommercePortalAuthAuditEvent {
  /**
   * Ties a pre-mutation intent row to the completion row for the same attempt: the recovery
   * ledger's token digest, or the keyed digest of the sign-in attempt's client key. It is always a
   * digest — never a token, an address, or a value an address can be recovered from.
   */
  readonly correlationDigest?: string | undefined;
  readonly eventType: CommercePortalAuthAuditEventType;
  readonly occurredAt: Date;
  /** The owner-local operation name, never a provider endpoint or a request path with identifiers. */
  readonly operation?: string | undefined;
  readonly outcome: CommercePortalAuthAuditOutcome;
  /** The provider's opaque subject, never an address, a display name or a credential. */
  readonly providerSubjectId?: string | undefined;
  /** The published opaque session reference, which is already the caller-visible identifier. */
  readonly sessionRef?: string | undefined;
  /** HMAC digest of an attempted address under the deployment secret; never the address. */
  readonly subjectDigest?: string | undefined;
}

/**
 * The complete set of fields an audit row may carry. Secrets, tokens, cookies, passwords, MFA seeds
 * and raw email addresses are absent by construction: the shape has no field they could occupy, and
 * the audit table has no column for them.
 */
export interface CommercePortalAuthAuditRecord {
  readonly correlationDigest: string | undefined;
  readonly eventType: CommercePortalAuthAuditEventType;
  readonly operation: string | undefined;
  readonly outcome: CommercePortalAuthAuditOutcome;
  readonly providerSubjectId: string | undefined;
  readonly schemaVersion: number;
  readonly sessionRef: string | undefined;
  readonly subjectDigest: string | undefined;
}
