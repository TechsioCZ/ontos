import { Config, DateTime, Effect, Redacted } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { makeCommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import type { CommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { portalAuthAuditEvent } from '../../src/portal-auth/audit/audit-tables.ts';
import { COMMERCE_PORTAL_AUTH_AUDIT_SCHEMA_VERSION } from '../../src/portal-auth/audit/audit-contracts.ts';
import { commercePortalAuthSignInAuditEvent } from '../../src/portal-auth/audit/audit-mapping.ts';
import { commercePortalAuthSubjectDigest } from '../../src/portal-auth/audit/audit-service.ts';
import type { CommercePortalAuthAuditRecorder } from '../../src/portal-auth/audit/audit-service.ts';
import { makeCommercePortalAuthAuditRecorder } from '../../src/portal-auth/audit/audit-store.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';

const ORIGIN = 'https://portal.example.test';
const SECRET = 's'.repeat(64);
const DATABASE_URL = Config.redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.redacted('DATABASE_URL')),
);

type ProviderDatabase = (typeof CommercePortalAuthDatabase)['Service'];

interface AuditFixture {
  readonly database: ProviderDatabase;
  readonly now: Date;
  readonly providerSubjectId: string;
  readonly recorder: CommercePortalAuthAuditRecorder;
  readonly subjectDigest: string;
}

const cleanupAuditRows = (fixture: AuditFixture) =>
  fixture.database.executor.transaction((transaction) =>
    Effect.gen(function* cleanupAuditRowsEffect() {
      yield* transaction
        .delete(portalAuthAuditEvent)
        .where(eq(portalAuthAuditEvent.subjectDigest, fixture.subjectDigest));
      yield* transaction
        .delete(portalAuthAuditEvent)
        .where(eq(portalAuthAuditEvent.providerSubjectId, fixture.providerSubjectId));
    }),
  );

const makeFixture = Effect.fn('CommercePortalAuthAuditIntegration.makeFixture')(function* makeFixtureEffect(
  caseName: string,
): Effect.fn.Return<AuditFixture, unknown, Scope.Scope> {
  const connectionString = yield* DATABASE_URL;
  const configuration = yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(connectionString),
    COMMERCE_PORTAL_AUTH_SECRET: SECRET,
    COMMERCE_PORTAL_AUTH_URL: ORIGIN,
  });
  const database = yield* makeCommercePortalAuthDatabase(configuration);
  const now = yield* DateTime.nowAsDate;
  const fixture: AuditFixture = {
    database,
    now,
    providerSubjectId: `audit-${caseName}-subject-${randomUUID()}`,
    recorder: makeCommercePortalAuthAuditRecorder(database.executor),
    subjectDigest: commercePortalAuthSubjectDigest(
      `audit-${caseName}-${randomUUID()}@example.test`,
      configuration.secret,
    ),
  };
  yield* Effect.addFinalizer(() => cleanupAuditRows(fixture).pipe(Effect.orDie));
  return fixture;
});

const rowsForSubjectDigest = (fixture: AuditFixture) =>
  fixture.database.executor
    .select({
      eventType: portalAuthAuditEvent.eventType,
      operation: portalAuthAuditEvent.operation,
      outcome: portalAuthAuditEvent.outcome,
      providerSubjectId: portalAuthAuditEvent.providerSubjectId,
      schemaVersion: portalAuthAuditEvent.schemaVersion,
      sessionRef: portalAuthAuditEvent.sessionRef,
      subjectDigest: portalAuthAuditEvent.subjectDigest,
    })
    .from(portalAuthAuditEvent)
    .where(eq(portalAuthAuditEvent.subjectDigest, fixture.subjectDigest));

const rowsForProviderSubject = (fixture: AuditFixture) =>
  fixture.database.executor
    .select({
      eventType: portalAuthAuditEvent.eventType,
      operation: portalAuthAuditEvent.operation,
      outcome: portalAuthAuditEvent.outcome,
      providerSubjectId: portalAuthAuditEvent.providerSubjectId,
      schemaVersion: portalAuthAuditEvent.schemaVersion,
      subjectDigest: portalAuthAuditEvent.subjectDigest,
    })
    .from(portalAuthAuditEvent)
    .where(eq(portalAuthAuditEvent.providerSubjectId, fixture.providerSubjectId));

it.live('leaves exactly one durable row for a refused sign-in, without the attempted address', () =>
  Effect.scoped(
    Effect.gen(function* signInFailureProof() {
      const fixture = yield* makeFixture('sign-in');
      yield* fixture.recorder.record(
        commercePortalAuthSignInAuditEvent({
          occurredAt: fixture.now,
          outcome: 'AUTHENTICATION_FAILED',
          subjectDigest: fixture.subjectDigest,
        }),
      );

      const rows = yield* rowsForSubjectDigest(fixture);
      expect(rows).toStrictEqual([
        {
          eventType: 'commerce.portal-auth.session-sign-in-failed.v1',
          operation: 'sign-in',
          outcome: 'authentication_failed',
          providerSubjectId: null,
          schemaVersion: COMMERCE_PORTAL_AUTH_AUDIT_SCHEMA_VERSION,
          sessionRef: null,
          subjectDigest: fixture.subjectDigest,
        },
      ]);
    }),
  ),
);

it.live('leaves exactly one durable row for a completed recovery, keyed by the provider subject', () =>
  Effect.scoped(
    Effect.gen(function* recoveryCompletionProof() {
      const fixture = yield* makeFixture('recovery');
      yield* fixture.recorder.record({
        eventType: 'commerce.portal-auth.recovery-completed.v1',
        occurredAt: fixture.now,
        operation: 'reset-password',
        outcome: 'success',
        providerSubjectId: fixture.providerSubjectId,
      });

      const rows = yield* rowsForProviderSubject(fixture);
      expect(rows).toStrictEqual([
        {
          eventType: 'commerce.portal-auth.recovery-completed.v1',
          operation: 'reset-password',
          outcome: 'success',
          providerSubjectId: fixture.providerSubjectId,
          schemaVersion: COMMERCE_PORTAL_AUTH_AUDIT_SCHEMA_VERSION,
          subjectDigest: null,
        },
      ]);
    }),
  ),
);
