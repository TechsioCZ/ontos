import { Config, Crypto, DateTime, Effect, Option, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';
import type { Scope } from 'effect';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { makeCommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import type { CommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { makeCommercePortalAuthRecoveryStore } from '../../src/portal-auth/persistence/portal-auth-recovery-store.ts';
import {
  recoveryReconciliation,
  recoveryResetLedger,
  session,
  user,
} from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import {
  CommercePortalAuthRecoveryStoreService,
  makeCommercePortalAuthRecoveryReconciliation,
} from '../../api/portal-auth/provider/recovery/index.ts';
import type { CommercePortalAuthRecoveryStore } from '../../api/portal-auth/provider/recovery/index.ts';

const ORIGIN = 'https://portal.example.test';
const SECRET = 's'.repeat(64);
const DATABASE_URL = Config.redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.redacted('DATABASE_URL')),
);
const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const recoveryCrypto = Crypto.make({
  digest: (algorithm, data) =>
    Effect.sync(() => {
      const nodeAlgorithm = algorithm.toLowerCase().replace('-', '');
      return new Uint8Array(createHash(nodeAlgorithm).update(data).digest());
    }),
  randomBytes: (size) => new Uint8Array(randomBytes(size)),
});

const identifierDigestFor = (email: string) =>
  recoveryCrypto.digest('SHA-256', new TextEncoder().encode(email)).pipe(Effect.map(bytesToHex));

/** A store instance plus the raw database, for tests that exercise the password-reset ledger directly. */
const makeResetLedgerHarness = Effect.fn('CommercePortalAuthRecoveryIntegration.makeResetLedgerHarness')(
  function* makeHarness(): Effect.fn.Return<
    { readonly database: ProviderDatabase; readonly store: CommercePortalAuthRecoveryStore },
    unknown,
    Scope.Scope
  > {
    const connectionString = yield* DATABASE_URL;
    const configuration = yield* parseCommercePortalAuthConfig({
      COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(connectionString),
      COMMERCE_PORTAL_AUTH_SECRET: SECRET,
      COMMERCE_PORTAL_AUTH_URL: ORIGIN,
    });
    const database = yield* makeCommercePortalAuthDatabase(configuration);
    const store = yield* makeCommercePortalAuthRecoveryStore(database.executor).pipe(
      Effect.provideService(Crypto.Crypto, recoveryCrypto),
    );
    return { database, store };
  },
);

type ProviderDatabase = (typeof CommercePortalAuthDatabase)['Service'];

interface ReconciliationFixture {
  readonly database: ProviderDatabase;
  readonly originalEmail: string;
  readonly originalUserId: string;
  readonly rebindingUserId: string;
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly token: Redacted.Redacted;
}

/**
 * Builds one deleted/recreated-owner scenario directly against PostgreSQL: a password-reset token
 * is issued to `originalUserId` for `originalEmail`, the identifier is then re-bound to a second,
 * unrelated account, and an active session for the original account is left in place so the test
 * can prove detection never touches it.
 */
const makeReconciliationFixture = Effect.fn('CommercePortalAuthRecoveryReconciliationIntegration.makeFixture')(
  function* makeFixture(caseName: string): Effect.fn.Return<ReconciliationFixture, unknown, Scope.Scope> {
    const connectionString = yield* DATABASE_URL;
    const configuration = yield* parseCommercePortalAuthConfig({
      COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(connectionString),
      COMMERCE_PORTAL_AUTH_SECRET: SECRET,
      COMMERCE_PORTAL_AUTH_URL: ORIGIN,
    });
    const database = yield* makeCommercePortalAuthDatabase(configuration);
    const now = yield* DateTime.nowAsDate;
    const originalUserId = `recon-${caseName}-original-${randomUUID()}`;
    const rebindingUserId = `recon-${caseName}-rebinding-${randomUUID()}`;
    const originalEmail = `recon-${caseName}-${randomUUID()}@example.test`;
    const supersededEmail = `${originalEmail}.superseded`;
    const sessionId = `recon-${caseName}-session-${randomUUID()}`;
    const sessionToken = `recon-${caseName}-session-token-${randomUUID()}`;

    yield* database.executor.insert(user).values({
      email: originalEmail,
      id: originalUserId,
      name: 'Reconciliation original owner',
    });
    yield* database.executor.insert(session).values({
      expiresAt: DateTime.toDate(DateTime.add(DateTime.makeUnsafe(now), { seconds: 3600 })),
      id: sessionId,
      token: sessionToken,
      updatedAt: now,
      userId: originalUserId,
    });

    const store = yield* makeCommercePortalAuthRecoveryStore(database.executor).pipe(
      Effect.provideService(Crypto.Crypto, recoveryCrypto),
    );
    const token = Redacted.make(`recon-${caseName}-token-${randomUUID()}`);
    const registered = yield* (
      store.registerPasswordResetToken?.({
        email: originalEmail,
        expiresAt: DateTime.toDate(DateTime.add(DateTime.makeUnsafe(now), { seconds: 3600 })),
        providerSubjectId: originalUserId,
        token,
      }) ?? Effect.fail(new Error('registerPasswordResetToken is not implemented'))
    );
    if (!registered) {
      return yield* Effect.fail(new Error('Reconciliation fixture could not register the password-reset ledger'));
    }

    // Re-bind the identifier: the original account keeps existing, under a different address, and
    // a second account now owns the email the ledger token was issued for.
    yield* database.executor.update(user).set({ email: supersededEmail }).where(eq(user.id, originalUserId));
    yield* database.executor.insert(user).values({ email: originalEmail, id: rebindingUserId, name: 'Rebound owner' });

    const fixture: ReconciliationFixture = {
      database,
      originalEmail,
      originalUserId,
      rebindingUserId,
      sessionId,
      sessionToken,
      token,
    };
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* cleanup() {
        const identifierDigest = yield* recoveryCrypto
          .digest('SHA-256', new TextEncoder().encode(originalEmail))
          .pipe(Effect.map(bytesToHex));
        yield* database.executor
          .delete(recoveryResetLedger)
          .where(eq(recoveryResetLedger.identifierDigest, identifierDigest));
        yield* database.executor.delete(recoveryReconciliation).where(eq(recoveryReconciliation.email, originalEmail));
        yield* database.executor.delete(session).where(eq(session.id, sessionId));
        yield* database.executor.delete(user).where(eq(user.id, originalUserId));
        yield* database.executor.delete(user).where(eq(user.id, rebindingUserId));
      }).pipe(Effect.orDie),
    );
    return fixture;
  },
);

it.live('proves a conflicting reset leaves the account untouched, sessions unchanged, and records one row', () =>
  Effect.scoped(
    Effect.gen(function* postgresRebindDetection() {
      const fixture = yield* makeReconciliationFixture('rebind');
      const store = yield* makeCommercePortalAuthRecoveryStore(fixture.database.executor).pipe(
        Effect.provideService(Crypto.Crypto, recoveryCrypto),
      );
      const reconciliation = yield* makeCommercePortalAuthRecoveryReconciliation().pipe(
        Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
      );

      const usersBefore = yield* fixture.database.executor
        .select()
        .from(user)
        .where(eq(user.id, fixture.originalUserId));
      const sessionsBefore = yield* fixture.database.executor
        .select()
        .from(session)
        .where(eq(session.id, fixture.sessionId));

      const outcome = yield* reconciliation.detect({
        operation: 'reset-password',
        token: fixture.token,
      });
      expect(Option.isSome(outcome)).toBe(true);
      if (Option.isSome(outcome)) {
        expect(outcome.value).toStrictEqual({
          conflictClass: 'IDENTIFIER_REBOUND',
          outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED',
        });
      }

      // Detecting twice must not grow the audit past one row: the store's dedupe index, not the
      // service, is what makes a repeated detection idempotent.
      yield* reconciliation.detect({ operation: 'reset-password', token: fixture.token });

      const usersAfter = yield* fixture.database.executor
        .select()
        .from(user)
        .where(eq(user.id, fixture.originalUserId));
      const sessionsAfter = yield* fixture.database.executor
        .select()
        .from(session)
        .where(eq(session.id, fixture.sessionId));
      const reconciliationRows = yield* fixture.database.executor
        .select()
        .from(recoveryReconciliation)
        .where(eq(recoveryReconciliation.email, fixture.originalEmail));

      // The account is untouched: no password reset, no field on the original row changed.
      expect(usersAfter).toStrictEqual(usersBefore);
      // Sessions are unchanged: detection never revokes or updates them.
      expect(sessionsAfter).toStrictEqual(sessionsBefore);
      // Exactly one durable reconciliation row, for a support operator to act on.
      expect(reconciliationRows).toHaveLength(1);
      expect(reconciliationRows[0]?.conflictClass).toBe('IDENTIFIER_REBOUND');
      expect(reconciliationRows[0]?.providerSubjectId).toBe(fixture.originalUserId);
      expect(reconciliationRows[0]?.currentProviderSubjectId).toBe(fixture.rebindingUserId);
      expect(reconciliationRows[0]?.operation).toBe('reset-password');
    }),
  ),
);

it.live('proves a stale ledger subject is detected without touching any account and records one row', () =>
  Effect.scoped(
    Effect.gen(function* postgresStaleSubjectDetection() {
      const fixture = yield* makeReconciliationFixture('stale');
      const store = yield* makeCommercePortalAuthRecoveryStore(fixture.database.executor).pipe(
        Effect.provideService(Crypto.Crypto, recoveryCrypto),
      );
      const reconciliation = yield* makeCommercePortalAuthRecoveryReconciliation().pipe(
        Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
      );

      // Delete the original account outright: the ledger's subject now names no account at all.
      yield* fixture.database.executor.delete(session).where(eq(session.id, fixture.sessionId));
      yield* fixture.database.executor.delete(user).where(eq(user.id, fixture.originalUserId));

      const outcome = yield* reconciliation.detect({
        operation: 'reset-password',
        token: fixture.token,
      });
      expect(Option.isSome(outcome)).toBe(true);
      if (Option.isSome(outcome)) {
        expect(outcome.value).toStrictEqual({
          conflictClass: 'TOKEN_SUBJECT_STALE',
          outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED',
        });
      }

      const reconciliationRows = yield* fixture.database.executor
        .select()
        .from(recoveryReconciliation)
        .where(eq(recoveryReconciliation.email, fixture.originalEmail));
      expect(reconciliationRows).toHaveLength(1);
      expect(reconciliationRows[0]?.conflictClass).toBe('TOKEN_SUBJECT_STALE');
      // The ledger subject is gone, but the email has a current owner: the row names it for the operator.
      expect(reconciliationRows[0]?.currentProviderSubjectId).toBe(fixture.rebindingUserId);

      const rebindingUsers = yield* fixture.database.executor
        .select()
        .from(user)
        .where(eq(user.id, fixture.rebindingUserId));
      // The unrelated second account is untouched by detection too.
      expect(rebindingUsers).toHaveLength(1);
    }),
  ),
);

it.live(
  'proves a repeated PostgreSQL password-reset registration for the same identifier replaces the pending ledger row instead of duplicating it',
  () =>
    Effect.scoped(
      Effect.gen(function* postgresResetLedgerIdempotency() {
        const { database, store } = yield* makeResetLedgerHarness();
        const now = yield* DateTime.nowAsDate;
        const email = `recon-idempotent-${randomUUID()}@example.test`;
        const providerSubjectId = `recon-idempotent-subject-${randomUUID()}`;
        const expiresAt = DateTime.toDate(DateTime.add(DateTime.makeUnsafe(now), { seconds: 3600 }));
        const firstToken = Redacted.make(`recon-idempotent-token-a-${randomUUID()}`);
        const secondToken = Redacted.make(`recon-idempotent-token-b-${randomUUID()}`);
        const identifierDigest = yield* identifierDigestFor(email);
        yield* Effect.addFinalizer(() =>
          database.executor
            .delete(recoveryResetLedger)
            .where(eq(recoveryResetLedger.identifierDigest, identifierDigest))
            .pipe(Effect.orDie),
        );

        const registerToken = store.registerPasswordResetToken;
        const peekLedger = store.peekPasswordResetLedger;
        if (registerToken === undefined || peekLedger === undefined) {
          return yield* Effect.fail(new Error('Reset-ledger idempotency fixture requires the optional store methods'));
        }

        // Two requests for the same identifier within the window: the first opens the pending row,
        // the second must reuse it deterministically rather than inserting a second pending row.
        const firstRegistered = yield* registerToken({ email, expiresAt, providerSubjectId, token: firstToken });
        expect(firstRegistered).toBe(true);
        const secondRegistered = yield* registerToken({ email, expiresAt, providerSubjectId, token: secondToken });
        expect(secondRegistered).toBe(true);

        const rows = yield* database.executor
          .select()
          .from(recoveryResetLedger)
          .where(eq(recoveryResetLedger.identifierDigest, identifierDigest));
        expect(rows).toHaveLength(1);

        // The response the caller sees for each request never distinguishes "first" from "repeat":
        // the superseded token no longer resolves, and only the latest one does.
        const firstPeek = yield* peekLedger({ token: firstToken });
        expect(Option.isNone(firstPeek)).toBe(true);
        const secondPeek = yield* peekLedger({ token: secondToken });
        expect(Option.isSome(secondPeek)).toBe(true);
        if (Option.isSome(secondPeek)) {
          expect(secondPeek.value).toStrictEqual({ email, providerSubjectId });
        }
        return null;
      }),
    ),
);

it.live(
  'proves an expired PostgreSQL password-reset ledger row is excluded from lookups and, once swept, retains neither the subject nor the email',
  () =>
    Effect.scoped(
      Effect.gen(function* postgresResetLedgerExpirySweep() {
        const { database, store } = yield* makeResetLedgerHarness();
        const now = yield* DateTime.nowAsDate;
        const email = `recon-expiring-${randomUUID()}@example.test`;
        const providerSubjectId = `recon-expiring-subject-${randomUUID()}`;
        const token = Redacted.make(`recon-expiring-token-${randomUUID()}`);
        const alreadyExpired = DateTime.toDate(DateTime.add(DateTime.makeUnsafe(now), { seconds: -5 }));
        const identifierDigest = yield* identifierDigestFor(email);
        yield* Effect.addFinalizer(() =>
          database.executor
            .delete(recoveryResetLedger)
            .where(eq(recoveryResetLedger.identifierDigest, identifierDigest))
            .pipe(Effect.orDie),
        );

        const registerToken = store.registerPasswordResetToken;
        const peekLedger = store.peekPasswordResetLedger;
        if (registerToken === undefined || peekLedger === undefined) {
          return yield* Effect.fail(new Error('Reset-ledger expiry fixture requires the optional store methods'));
        }

        const registered = yield* registerToken({ email, expiresAt: alreadyExpired, providerSubjectId, token });
        expect(registered).toBe(true);

        // #8: an expired row is excluded from lookups immediately, whether or not a sweep has run
        // yet — `peekPasswordResetLedger` filters on expiry itself rather than trusting `state`.
        const peekedBeforeSweep = yield* peekLedger({ token });
        expect(Option.isNone(peekedBeforeSweep)).toBe(true);
        const rowsBeforeSweep = yield* database.executor
          .select()
          .from(recoveryResetLedger)
          .where(eq(recoveryResetLedger.identifierDigest, identifierDigest));
        expect(rowsBeforeSweep[0]?.state).toBe('pending');

        // Trigger the bounded, opportunistic sweep the same way production does: another
        // registration for an unrelated identifier.
        const sweepTriggerEmail = `recon-sweep-trigger-${randomUUID()}@example.test`;
        const sweepTriggerSubject = `recon-sweep-trigger-subject-${randomUUID()}`;
        const sweepTriggerToken = Redacted.make(`recon-sweep-trigger-token-${randomUUID()}`);
        const sweepTriggerExpiresAt = DateTime.toDate(DateTime.add(DateTime.makeUnsafe(now), { seconds: 3600 }));
        const sweepTriggerDigest = yield* identifierDigestFor(sweepTriggerEmail);
        yield* Effect.addFinalizer(() =>
          database.executor
            .delete(recoveryResetLedger)
            .where(eq(recoveryResetLedger.identifierDigest, sweepTriggerDigest))
            .pipe(Effect.orDie),
        );
        yield* registerToken({
          email: sweepTriggerEmail,
          expiresAt: sweepTriggerExpiresAt,
          providerSubjectId: sweepTriggerSubject,
          token: sweepTriggerToken,
        });

        const rowsAfterSweep = yield* database.executor
          .select()
          .from(recoveryResetLedger)
          .where(eq(recoveryResetLedger.identifierDigest, identifierDigest));
        const [swept] = rowsAfterSweep;
        expect(swept?.state).toBe('expired');
        // #6: a terminal row retains only what reconciliation needs to know it existed — never the
        // account subject or the email it named.
        expect(swept?.providerSubjectId).toBeNull();
        expect(swept?.email).toBeNull();
        return null;
      }),
    ),
);
