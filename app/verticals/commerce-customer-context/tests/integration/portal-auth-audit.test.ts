import { Config, DateTime, Effect, Redacted, Result } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { makeCommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import type { CommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { makeCommercePortalAuthSessionStore } from '../../src/portal-auth/persistence/portal-auth-session-store.ts';
import { session, user } from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import type { CommercePortalAuthSessionStore } from '../../api/portal-auth/session/store-service.ts';
import { portalAuthAuditEvent } from '../../src/portal-auth/audit/audit-tables.ts';
import { COMMERCE_PORTAL_AUTH_AUDIT_SCHEMA_VERSION } from '../../src/portal-auth/audit/audit-contracts.ts';
import { commercePortalAuthSignInAuditEvent } from '../../src/portal-auth/audit/audit-mapping.ts';
import {
  commercePortalAuthSubjectDigest,
  makeCommercePortalAuthAuditRecorder,
} from '../../src/portal-auth/audit/audit.ts';
import type { CommercePortalAuthAuditRecorder } from '../../src/portal-auth/audit/audit.ts';
import type { CommercePortalAuthAuditEvent } from '../../src/portal-auth/audit/audit-contracts.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';

const ORIGIN = 'https://portal.example.test';
const SECRET = 's'.repeat(64);
const DATABASE_URL = Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.Redacted('DATABASE_URL')),
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

/**
 * The strict path: a state change and its evidence share one transaction. The fixture below writes
 * the owner's own provider rows so the revocation is a real deletion, then asks the store to record
 * an audit row PostgreSQL must refuse.
 */
interface SessionAuditFixture {
  readonly auditRows: () => Effect.Effect<readonly { readonly eventType: string; readonly operation: string | null }[]>;
  readonly providerSubjectId: string;
  readonly sessionId: string;
  readonly sessionRows: () => Effect.Effect<readonly { readonly id: string }[]>;
  readonly store: CommercePortalAuthSessionStore;
}

/**
 * A NUL byte is not representable in a PostgreSQL text value, so the server refuses this row at
 * execution — a real database refusal of the audit insert, raised from inside the transaction the
 * revocation is running in, rather than a fault injected into the store's own code.
 */
const REFUSED_BY_POSTGRES = 'audit-write-refused\u0000';

/** A deterministic fixture instant: these audit rows only need a stable, orderable timestamp. */
const REVOCATION_EVENT_OCCURRED_AT = DateTime.toDate(DateTime.makeUnsafe(1_700_000_000_000));

const revocationEvent = (
  fixture: Pick<SessionAuditFixture, 'providerSubjectId'>,
  subjectDigest?: string,
): CommercePortalAuthAuditEvent => {
  const event: CommercePortalAuthAuditEvent = {
    eventType: 'commerce.portal-auth.session-revoked.v1',
    occurredAt: REVOCATION_EVENT_OCCURRED_AT,
    operation: 'revoke',
    outcome: 'success',
    providerSubjectId: fixture.providerSubjectId,
  };
  return subjectDigest === undefined ? event : { ...event, subjectDigest };
};

const makeSessionAuditFixture = Effect.fn('CommercePortalAuthAuditIntegration.makeSessionFixture')(
  function* makeSessionAuditFixtureEffect(): Effect.fn.Return<SessionAuditFixture, unknown, Scope.Scope> {
    const connectionString = yield* DATABASE_URL;
    const configuration = yield* parseCommercePortalAuthConfig({
      COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(connectionString),
      COMMERCE_PORTAL_AUTH_SECRET: SECRET,
      COMMERCE_PORTAL_AUTH_URL: ORIGIN,
    });
    const database = yield* makeCommercePortalAuthDatabase(configuration);
    const providerSubjectId = `audit-revoke-${randomUUID()}`;
    const sessionId = `${providerSubjectId}-session`;
    const now = yield* DateTime.nowAsDate;
    yield* Effect.addFinalizer(() =>
      database.executor
        .transaction((transaction) =>
          Effect.gen(function* cleanupSessionAuditFixture() {
            yield* transaction
              .delete(portalAuthAuditEvent)
              .where(eq(portalAuthAuditEvent.providerSubjectId, providerSubjectId));
            yield* transaction.delete(user).where(eq(user.id, providerSubjectId));
          }),
        )
        .pipe(Effect.orDie),
    );
    yield* database.executor.insert(user).values({
      createdAt: now,
      email: `${providerSubjectId}@example.test`,
      emailVerified: true,
      id: providerSubjectId,
      name: 'Audit revocation fixture',
      updatedAt: now,
    });
    yield* database.executor.insert(session).values({
      createdAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
      id: sessionId,
      token: `${providerSubjectId}-token`,
      updatedAt: now,
      userId: providerSubjectId,
    });
    return {
      auditRows: () =>
        database.executor
          .select({ eventType: portalAuthAuditEvent.eventType, operation: portalAuthAuditEvent.operation })
          .from(portalAuthAuditEvent)
          .where(eq(portalAuthAuditEvent.providerSubjectId, providerSubjectId))
          .pipe(Effect.orDie),
      providerSubjectId,
      sessionId,
      sessionRows: () =>
        database.executor.select({ id: session.id }).from(session).where(eq(session.id, sessionId)).pipe(Effect.orDie),
      store: makeCommercePortalAuthSessionStore(database.executor),
    };
  },
);

it.live('rolls a revocation back when PostgreSQL refuses its audit row', () =>
  Effect.scoped(
    Effect.gen(function* revocationRollsBackWithoutEvidence() {
      const fixture = yield* makeSessionAuditFixture();

      const refused = yield* Effect.result(
        fixture.store.revokeWithAudit({
          audit: revocationEvent(fixture, REFUSED_BY_POSTGRES),
          providerSubjectId: fixture.providerSubjectId,
          sessionId: fixture.sessionId,
        }),
      );
      if (!Result.isFailure(refused)) {
        throw new Error('A revocation whose audit row was refused must not report success');
      }
      expect(refused.failure.operation).toBe('session-revoke-audit');
      // Nothing committed: the session is still revocable and no evidence was left behind.
      expect(yield* fixture.sessionRows()).toStrictEqual([{ id: fixture.sessionId }]);
      expect(yield* fixture.auditRows()).toStrictEqual([]);
    }),
  ),
);

it.live('commits a revocation and exactly one audit row together', () =>
  Effect.scoped(
    Effect.gen(function* revocationCommitsWithEvidence() {
      const fixture = yield* makeSessionAuditFixture();

      const revoked = yield* fixture.store.revokeWithAudit({
        audit: revocationEvent(fixture),
        providerSubjectId: fixture.providerSubjectId,
        sessionId: fixture.sessionId,
      });
      expect(revoked).toBe(true);
      expect(yield* fixture.sessionRows()).toStrictEqual([]);
      expect(yield* fixture.auditRows()).toStrictEqual([
        { eventType: 'commerce.portal-auth.session-revoked.v1', operation: 'revoke' },
      ]);
    }),
  ),
);
