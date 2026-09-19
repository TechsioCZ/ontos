import { Match } from 'effect';

import { COMMERCE_PORTAL_AUTH_AUDIT_SCHEMA_VERSION } from './audit-contracts.ts';
import type {
  CommercePortalAuthAuditEvent,
  CommercePortalAuthAuditEventType,
  CommercePortalAuthAuditOutcome,
  CommercePortalAuthAuditRecord,
} from './audit-contracts.ts';

/**
 * The sign-in outcome names the owner's session lifecycle publishes. They are listed here rather
 * than imported as a type so the mapping stays exhaustive evidence in its own right: adding an
 * outcome to the lifecycle without an audit class fails the mapping test, not a live request.
 */
export const COMMERCE_PORTAL_AUTH_SESSION_OUTCOMES = [
  'ACCOUNT_DISABLED',
  'AUTHENTICATION_FAILED',
  'MFA_REQUIRED',
  'RATE_LIMITED',
  'SESSION_CREATED',
  'SESSION_EXPIRED',
  'SESSION_IDENTIFIER_ROTATED',
  'SESSION_LIMIT_REACHED',
  'SESSION_REFRESHED',
  'SESSION_REVOKED',
  'VERIFICATION_REQUIRED',
] as const;
export type CommercePortalAuthSessionOutcomeName = (typeof COMMERCE_PORTAL_AUTH_SESSION_OUTCOMES)[number];

/** Maps one lifecycle outcome name onto exactly one audit outcome class. */
export const commercePortalAuthSessionOutcomeClass = (
  outcome: CommercePortalAuthSessionOutcomeName,
): CommercePortalAuthAuditOutcome =>
  Match.value(outcome).pipe(
    Match.when('ACCOUNT_DISABLED', () => 'account_disabled' as const),
    Match.when('AUTHENTICATION_FAILED', () => 'authentication_failed' as const),
    Match.when('MFA_REQUIRED', () => 'mfa_required' as const),
    Match.when('RATE_LIMITED', () => 'rate_limited' as const),
    Match.when('SESSION_CREATED', () => 'success' as const),
    Match.when('SESSION_EXPIRED', () => 'session_expired' as const),
    Match.when('SESSION_IDENTIFIER_ROTATED', () => 'success' as const),
    Match.when('SESSION_LIMIT_REACHED', () => 'session_limit_reached' as const),
    Match.when('SESSION_REFRESHED', () => 'success' as const),
    Match.when('SESSION_REVOKED', () => 'session_revoked' as const),
    Match.when('VERIFICATION_REQUIRED', () => 'verification_required' as const),
    Match.exhaustive,
  );

/** A completed sign-in and a refused one are distinct facts, not one fact with a status field. */
export const commercePortalAuthSignInEventType = (
  outcome: CommercePortalAuthAuditOutcome,
): CommercePortalAuthAuditEventType =>
  outcome === 'success'
    ? 'commerce.portal-auth.session-signed-in.v1'
    : 'commerce.portal-auth.session-sign-in-failed.v1';

export interface CommercePortalAuthSignInAuditInput {
  readonly occurredAt: Date;
  readonly outcome: CommercePortalAuthSessionOutcomeName;
  readonly providerSubjectId?: string | undefined;
  readonly sessionRef?: string | undefined;
  readonly subjectDigest?: string | undefined;
}

export const commercePortalAuthSignInAuditEvent = (
  input: CommercePortalAuthSignInAuditInput,
): CommercePortalAuthAuditEvent => ({
  eventType: commercePortalAuthSignInEventType(commercePortalAuthSessionOutcomeClass(input.outcome)),
  occurredAt: input.occurredAt,
  operation: 'sign-in',
  outcome: commercePortalAuthSessionOutcomeClass(input.outcome),
  providerSubjectId: input.providerSubjectId,
  sessionRef: input.sessionRef,
  subjectDigest: input.subjectDigest,
});

/**
 * The persisted projection. Only these keys ever reach the audit table; the transport values that
 * carried the decision — tokens, cookies, passwords, MFA seeds, raw addresses — have no field here.
 */
export const commercePortalAuthAuditRecord = (event: CommercePortalAuthAuditEvent): CommercePortalAuthAuditRecord => ({
  eventType: event.eventType,
  operation: event.operation,
  outcome: event.outcome,
  providerSubjectId: event.providerSubjectId,
  schemaVersion: COMMERCE_PORTAL_AUTH_AUDIT_SCHEMA_VERSION,
  sessionRef: event.sessionRef,
  subjectDigest: event.subjectDigest,
});
