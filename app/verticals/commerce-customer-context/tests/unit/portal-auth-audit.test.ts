import { Array as EffectArray, Effect, Order, Redacted, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { COMMERCE_PORTAL_AUTH_AUDIT_SCHEMA_VERSION } from '../../src/portal-auth/audit/audit-contracts.ts';
import type { CommercePortalAuthAuditOutcome } from '../../src/portal-auth/audit/audit-contracts.ts';
import {
  COMMERCE_PORTAL_AUTH_SESSION_OUTCOMES,
  commercePortalAuthAuditRecord,
  commercePortalAuthAuditRow,
  commercePortalAuthSessionOutcomeClass,
  commercePortalAuthSignInAuditEvent,
  commercePortalAuthSignInEventType,
} from '../../src/portal-auth/audit/audit-mapping.ts';
import type { CommercePortalAuthSessionOutcomeName } from '../../src/portal-auth/audit/audit-mapping.ts';
import {
  commercePortalAuthSubjectDigest,
  recordCommercePortalAuthAudit,
} from '../../src/portal-auth/audit/audit-service.ts';
import type { CommercePortalAuthAuditRecorder } from '../../src/portal-auth/audit/audit-service.ts';
import { CommercePortalAuthAuditUnavailable } from '../../src/portal-auth/audit/audit-unavailable.ts';

const occurredAt = new Date('2026-01-01T00:00:00.000Z');
const SECRET = Redacted.make('s'.repeat(64));
const EMAIL = 'Customer@Example.test';
const AUDIT_RECORD_KEYS = [
  'eventType',
  'operation',
  'outcome',
  'providerSubjectId',
  'schemaVersion',
  'sessionRef',
  'subjectDigest',
];

/**
 * The sign-in outcome classes #340 requires durable evidence for, each bound to the exact lifecycle
 * outcome that produces it. A renamed or dropped outcome fails this table, not a live request.
 */
const SIGN_IN_OUTCOME_BY_CLASS = {
  account_disabled: 'ACCOUNT_DISABLED',
  authentication_failed: 'AUTHENTICATION_FAILED',
  rate_limited: 'RATE_LIMITED',
  session_limit_reached: 'SESSION_LIMIT_REACHED',
  success: 'SESSION_CREATED',
  verification_required: 'VERIFICATION_REQUIRED',
} as const satisfies Readonly<Record<string, CommercePortalAuthSessionOutcomeName>>;

const signInOutcomeClasses: readonly CommercePortalAuthAuditOutcome[] = Object.values(SIGN_IN_OUTCOME_BY_CLASS).map(
  (outcomeName) => commercePortalAuthSessionOutcomeClass(outcomeName),
);

it('maps every lifecycle outcome name onto exactly one audit outcome class', () => {
  const classes = COMMERCE_PORTAL_AUTH_SESSION_OUTCOMES.map((outcome) =>
    commercePortalAuthSessionOutcomeClass(outcome),
  );
  expect(classes).toHaveLength(COMMERCE_PORTAL_AUTH_SESSION_OUTCOMES.length);
  expect(new Set(COMMERCE_PORTAL_AUTH_SESSION_OUTCOMES).size).toBe(COMMERCE_PORTAL_AUTH_SESSION_OUTCOMES.length);
  for (const outcomeClass of signInOutcomeClasses) {
    expect(classes).toContain(outcomeClass);
  }
});

it('publishes an admitted sign-in and a refused sign-in as distinct schema-versioned facts', () => {
  expect(commercePortalAuthSignInEventType('success')).toBe('commerce.portal-auth.session-signed-in.v1');
  for (const outcomeClass of signInOutcomeClasses.filter((value) => value !== 'success')) {
    expect(commercePortalAuthSignInEventType(outcomeClass)).toBe('commerce.portal-auth.session-sign-in-failed.v1');
  }
});

it('produces exactly one record per sign-in outcome class, carrying only safe fields', () => {
  const digest = commercePortalAuthSubjectDigest(EMAIL, SECRET);
  for (const [outcomeClass, outcomeName] of Object.entries(SIGN_IN_OUTCOME_BY_CLASS)) {
    const event = commercePortalAuthSignInAuditEvent({
      occurredAt,
      outcome: outcomeName,
      subjectDigest: digest,
    });
    expect(event.outcome).toBe(outcomeClass);
    expect(event.operation).toBe('sign-in');
    expect(event.occurredAt).toStrictEqual(occurredAt);
    const record = commercePortalAuthAuditRecord(event);
    expect(record.schemaVersion).toBe(COMMERCE_PORTAL_AUTH_AUDIT_SCHEMA_VERSION);
    expect(EffectArray.sort(Object.keys(record), Order.String)).toStrictEqual(AUDIT_RECORD_KEYS);
    expect(record.providerSubjectId).toBeUndefined();
    expect(record.sessionRef).toBeUndefined();
  }
});

it('never carries the attempted address, a secret, a token or a cookie into a record', () => {
  const digest = commercePortalAuthSubjectDigest(EMAIL, SECRET);
  const record = commercePortalAuthAuditRecord(
    commercePortalAuthSignInAuditEvent({
      occurredAt,
      outcome: 'AUTHENTICATION_FAILED',
      subjectDigest: digest,
    }),
  );
  const serialized = JSON.stringify(record);
  expect(serialized).not.toContain('Customer@Example.test');
  expect(serialized).not.toContain('customer@example.test');
  expect(serialized).not.toContain(Redacted.value(SECRET));
  expect(record.subjectDigest).toBe(digest);
});

it('keys the subject digest under the deployment secret and normalizes the address first', () => {
  expect(commercePortalAuthSubjectDigest(' customer@example.test ', SECRET)).toBe(
    commercePortalAuthSubjectDigest(EMAIL, SECRET),
  );
  expect(commercePortalAuthSubjectDigest(EMAIL, Redacted.make('d'.repeat(64)))).not.toBe(
    commercePortalAuthSubjectDigest(EMAIL, SECRET),
  );
});

it('leaves an unknown optional field absent rather than inventing a value for it', () => {
  const record = commercePortalAuthAuditRecord({
    eventType: 'commerce.portal-auth.session-revoked.v1',
    occurredAt,
    outcome: 'success',
  });
  expect(EffectArray.sort(Object.keys(record), Order.String)).toStrictEqual(AUDIT_RECORD_KEYS);
  expect(record.operation).toBeUndefined();
  expect(record.providerSubjectId).toBeUndefined();
  expect(record.sessionRef).toBeUndefined();
  expect(record.subjectDigest).toBeUndefined();
});

it('carries the opaque session reference and provider subject when the caller knows them', () => {
  const record = commercePortalAuthAuditRecord({
    eventType: 'commerce.portal-auth.step-up-issued.v1',
    occurredAt,
    operation: 'step-up-issue',
    outcome: 'success',
    providerSubjectId: 'subject-1',
    sessionRef: 'commerce-session-ref',
  });
  expect(record.eventType).toBe('commerce.portal-auth.step-up-issued.v1');
  expect(record.operation).toBe('step-up-issue');
  expect(record.outcome).toBe('success');
  expect(record.providerSubjectId).toBe('subject-1');
  expect(record.schemaVersion).toBe(COMMERCE_PORTAL_AUTH_AUDIT_SCHEMA_VERSION);
  expect(record.sessionRef).toBe('commerce-session-ref');
  expect(record.subjectDigest).toBeUndefined();
});

it.effect('does not turn an audit store outage into an authentication failure', () =>
  Effect.gen(function* auditOutageProof() {
    const failing: CommercePortalAuthAuditRecorder = {
      record: () =>
        Effect.fail(
          new CommercePortalAuthAuditUnavailable({
            operation: 'audit-record',
            reason: 'store is down',
          }),
        ),
    };
    const outcome = yield* Effect.result(
      recordCommercePortalAuthAudit(failing, {
        eventType: 'commerce.portal-auth.session-signed-out.v1',
        occurredAt,
        outcome: 'success',
      }),
    );
    expect(Result.isSuccess(outcome)).toBe(true);
  }),
);

it('projects one event onto one row, with a NULL for every field the caller did not know', () => {
  const sparse = commercePortalAuthAuditRow({
    eventType: 'commerce.portal-auth.session-revoked.v1',
    occurredAt,
    outcome: 'success',
  });
  expect(sparse).toStrictEqual({
    eventType: 'commerce.portal-auth.session-revoked.v1',
    occurredAt,
    operation: null,
    outcome: 'success',
    providerSubjectId: null,
    schemaVersion: COMMERCE_PORTAL_AUTH_AUDIT_SCHEMA_VERSION,
    sessionRef: null,
    subjectDigest: null,
  });

  // The row is the same projection the lenient recorder writes, so the strict, transaction-scoped
  // writer in the session store cannot drift into a different column set.
  const complete = commercePortalAuthAuditRow({
    eventType: 'commerce.portal-auth.session-signed-out.v1',
    occurredAt,
    operation: 'sign-out',
    outcome: 'success',
    providerSubjectId: 'subject-1',
    sessionRef: 'commerce-session-ref',
    subjectDigest: commercePortalAuthSubjectDigest(EMAIL, SECRET),
  });
  expect(EffectArray.sort(Object.keys(complete), Order.String)).toStrictEqual(
    EffectArray.sort([...AUDIT_RECORD_KEYS, 'occurredAt'], Order.String),
  );
  expect(complete.sessionRef).toBe('commerce-session-ref');
  expect(JSON.stringify(complete)).not.toContain(Redacted.value(SECRET));
});
