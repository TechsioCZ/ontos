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
  session,
  user,
  verification,
} from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import {
  CommercePortalAuthRecoveryStoreService,
  makeCommercePortalAuthRecoveryReconciliation,
} from '../../api/portal-auth/provider/recovery/index.ts';

const ORIGIN = 'https://portal.example.test';
const SECRET = 's'.repeat(64);
const RESET_IDENTIFIER_PREFIX = 'commerce-password-reset:';
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
        const digest = yield* recoveryCrypto
          .digest('SHA-256', new TextEncoder().encode(Redacted.value(token)))
          .pipe(Effect.map(bytesToHex));
        yield* database.executor
          .delete(verification)
          .where(eq(verification.identifier, `${RESET_IDENTIFIER_PREFIX}${digest}`));
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
        email: fixture.originalEmail,
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
      yield* reconciliation.detect({ email: fixture.originalEmail, operation: 'reset-password', token: fixture.token });

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
        email: fixture.originalEmail,
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
      expect(reconciliationRows[0]?.currentProviderSubjectId).toBeNull();

      const rebindingUsers = yield* fixture.database.executor
        .select()
        .from(user)
        .where(eq(user.id, fixture.rebindingUserId));
      // The unrelated second account is untouched by detection too.
      expect(rebindingUsers).toHaveLength(1);
    }),
  ),
);
