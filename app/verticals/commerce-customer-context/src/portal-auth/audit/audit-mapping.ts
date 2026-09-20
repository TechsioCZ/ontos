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
  correlationDigest: event.correlationDigest,
  eventType: event.eventType,
  operation: event.operation,
  outcome: event.outcome,
  providerSubjectId: event.providerSubjectId,
  schemaVersion: COMMERCE_PORTAL_AUTH_AUDIT_SCHEMA_VERSION,
  sessionRef: event.sessionRef,
  subjectDigest: event.subjectDigest,
});

/** The exact column values one audit row carries; an absent optional is a NULL, never a guess. */
export interface CommercePortalAuthAuditRow {
  readonly correlationDigest: string | null;
  readonly eventType: CommercePortalAuthAuditEventType;
  readonly occurredAt: Date;
  readonly operation: string | null;
  readonly outcome: CommercePortalAuthAuditOutcome;
  readonly providerSubjectId: string | null;
  readonly schemaVersion: number;
  readonly sessionRef: string | null;
  readonly subjectDigest: string | null;
}

/**
 * One event becomes exactly one row, projected through the published record shape first, so a field
 * that is not part of that shape cannot reach a column even if a caller attaches it to the event.
 * The projection is kept here rather than beside the insert because two writers share it: the
 * lenient recorder that records a decision, and the session store that writes the same row inside
 * the transaction that changes state (`../persistence/portal-auth-session-store.ts`).
 */
export const commercePortalAuthAuditRow = (event: CommercePortalAuthAuditEvent): CommercePortalAuthAuditRow => {
  const record = commercePortalAuthAuditRecord(event);
  return {
    correlationDigest: record.correlationDigest ?? null,
    eventType: record.eventType,
    occurredAt: event.occurredAt,
    operation: record.operation ?? null,
    outcome: record.outcome,
    providerSubjectId: record.providerSubjectId ?? null,
    schemaVersion: record.schemaVersion,
    sessionRef: record.sessionRef ?? null,
    subjectDigest: record.subjectDigest ?? null,
  };
};
