import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { and, eq, inArray, like } from 'drizzle-orm';
import {
  Config,
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
} from 'effect';
import { expect, it } from 'effect-rstest';
import type { Scope } from 'effect';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import { makeCommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import type { CommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { portalAuthAuditEvent } from '../../src/portal-auth/audit/audit-tables.ts';
import {
  rateLimit,
  recoveryReconciliation,
  recoveryResetLedger,
  session,
  user,
  verification,
} from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import { makeCommercePortalAuth } from '../../api/portal-auth/provider/auth.ts';
import { UNRESOLVED_PORTAL_AUTH_CLIENT_KEY } from '../../api/portal-auth/http-transport.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { COMMERCE_PORTAL_AUTH_POLICY, parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { makeCommercePortalAuthRecoveryProvider } from '../../api/portal-auth/provider/recovery/provider-service.ts';
import { CommercePortalAuthRecoveryProviderFailure } from '../../api/portal-auth/provider/recovery/provider-failure.ts';
import {
  CommercePortalAuthRecoveryProviderService,
  CommercePortalAuthRecoveryRateLimitService,
  CommercePortalAuthRecoveryReconciliationService,
  CommercePortalAuthRecoveryRejected,
  CommercePortalAuthRecoveryService as CommercePortalAuthRecoveryServiceTag,
  CommercePortalAuthRecoveryStoreService,
  CommercePortalAuthRecoveryUnavailable,
  makeCommercePortalAuthEmailDelivery,
  makeCommercePortalAuthRecoveryReconciliation,
  makeCommercePortalAuthRecoveryRateLimit,
  makeCommercePortalAuthRecoveryService,
  portalAuthRecoveryApiLive,
} from '../../api/portal-auth/provider/recovery/index.ts';
import { makeCommercePortalAuthRecoveryStore } from '../../src/portal-auth/persistence/portal-auth-recovery-store.ts';
import type {
  CommercePortalAuthRecoveryService,
  CommercePortalAuthRecoveryStore,
} from '../../api/portal-auth/provider/recovery/index.ts';
import { CommercePortalAuthRecoveryApi } from '../../shared/portal-auth/recovery-api.ts';
import {
  COMMERCE_PORTAL_AUTH_INTERNAL_BASE_PATH,
  COMMERCE_PORTAL_AUTH_PUBLIC_BASE_PATH,
} from '../../shared/deployment-paths.ts';
import { unauditedCommercePortalAuthRecorder } from '../../src/portal-auth/audit/audit.ts';
import { acquireOutlivingCleanup } from '../support/fixture-pg-client.ts';

const ORIGIN = 'https://portal.example.test';
const EMAIL = 'recovery-integration@example.test';
const ORIGINAL_PASSWORD = 'P'.repeat(24);
const REPLACEMENT_PASSWORD = 'R'.repeat(24);
/** Below the realm's own minimum, so Better Auth refuses it before it reads its token row. */
const SHORT_PASSWORD = 'R'.repeat(4);
const SECRET = 's'.repeat(64);
const DATABASE_URL = Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.Redacted('DATABASE_URL')),
);
const EMAIL_VERIFICATION_IDENTIFIER_PREFIX = 'commerce-email-verification:';
const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const emailVerificationIdentifiers = (digests: readonly string[]): string[] =>
  digests.map((digest) => `${EMAIL_VERIFICATION_IDENTIFIER_PREFIX}${digest}`);
const recoveryCrypto = Crypto.make({
  digest: (algorithm, data) =>
    Effect.sync(() => {
      const nodeAlgorithm = algorithm.toLowerCase().replace('-', '');
      return new Uint8Array(createHash(nodeAlgorithm).update(data).digest());
    }),
  randomBytes: (size) => new Uint8Array(randomBytes(size)),
});
let recoveryFixtureNumber = 200;

/**
 * The durable budget key the transport spends for one recovery subject, recomputed here from the
 * deployment secret exactly as `provider/recovery/http.ts` derives it. The subject half is the
 * invariant: without it the key would be one counter the whole deployment shares, and three
 * requests from anywhere would answer every customer's password reset with 429 for the hour.
 */
const recoveryBudgetKey = (subject: string, route: string): string =>
  `${UNRESOLVED_PORTAL_AUTH_CLIENT_KEY}|${createHmac('sha256', SECRET)
    .update(subject.trim().toLowerCase())
    .digest('base64url')}|${route}`;

/** A second customer of the same deployment, mid-recovery in the same window. */
const bystanderEmail = (email: string): string => `bystander-${email}`;

type ProviderAuth = Parameters<typeof makeCommercePortalAuthRecoveryProvider>[0];
type ProviderDatabase = (typeof CommercePortalAuthDatabase)['Service'];
type RecoveryService = CommercePortalAuthRecoveryService['Service'];
type RecoveryProvider = ReturnType<typeof makeCommercePortalAuthRecoveryProvider>;

interface RecoveryFixture {
  readonly auth: ProviderAuth;
  readonly database: ProviderDatabase;
  readonly email: string;
  readonly ip: string;
  readonly password: string;
  readonly provider: RecoveryProvider;
  readonly recovery: RecoveryService;
  readonly resetTokens: string[];
  readonly resetURLs: string[];
  readonly userId: string;
  readonly verificationToken: Redacted.Redacted;
  readonly verificationTokens: string[];
  readonly verificationURLs: string[];
}

const cleanupRecoveryFixture = (fixture: RecoveryFixture) =>
  Effect.all(
    fixture.verificationTokens.map((token) =>
      recoveryCrypto.digest('SHA-256', new TextEncoder().encode(token)).pipe(Effect.map(bytesToHex)),
    ),
    { concurrency: 1 },
  ).pipe(
    Effect.flatMap((digests) =>
      fixture.database.executor.transaction((transaction) =>
        Effect.gen(function* cleanupRecoveryFixtureEffect() {
          yield* transaction.delete(user).where(eq(user.id, fixture.userId));
          yield* transaction.delete(user).where(eq(user.email, fixture.email));
          yield* transaction.delete(verification).where(eq(verification.identifier, fixture.email));
          if (digests.length > 0) {
            yield* transaction
              .delete(verification)
              .where(inArray(verification.identifier, emailVerificationIdentifiers(digests)));
          }
          yield* transaction.delete(rateLimit).where(like(rateLimit.key, `%${fixture.ip}%`));
          // The budget is keyed on the subject the attempt names, so a fixture owns exactly the
          // rows its own addresses opened and takes them with it.
          yield* transaction
            .delete(rateLimit)
            .where(
              inArray(rateLimit.key, [
                recoveryBudgetKey(fixture.email, '/request-password-reset'),
                recoveryBudgetKey(bystanderEmail(fixture.email), '/request-password-reset'),
              ]),
            );
        }),
      ),
    ),
  );

const makeRecoveryFixture = Effect.fn('CommercePortalAuthRecoveryIntegration.makeFixture')(function* makeFixture(
  caseName: string,
): Effect.fn.Return<RecoveryFixture, unknown, Scope.Scope> {
  const connectionString = yield* DATABASE_URL;
  const configuration = yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(connectionString),
    COMMERCE_PORTAL_AUTH_SECRET: SECRET,
    COMMERCE_PORTAL_AUTH_URL: ORIGIN,
  });
  const database = yield* acquireOutlivingCleanup(makeCommercePortalAuthDatabase(configuration));
  const store = yield* makeCommercePortalAuthRecoveryStore(database.executor).pipe(
    Effect.provideService(Crypto.Crypto, recoveryCrypto),
  );
  const email = `recovery-${caseName}-${randomUUID()}@example.test`;
  const password = `${ORIGINAL_PASSWORD}${caseName}`.slice(0, 64);
  const ip = `198.51.100.${recoveryFixtureNumber}`;
  recoveryFixtureNumber += 1;
  const resetTokens: string[] = [];
  const resetURLs: string[] = [];
  const verificationTokens: string[] = [];
  const verificationURLs: string[] = [];
  const rawEmailDelivery = {
    sendOTP: () => Promise.resolve(),
    sendResetPassword: ({ token, url }: { readonly token: string; readonly url: string }) => {
      resetTokens.push(token);
      resetURLs.push(url);
      return Promise.resolve();
    },
    sendVerificationEmail: ({ token, url }: { readonly token: string; readonly url: string }) => {
      verificationTokens.push(token);
      verificationURLs.push(url);
      return Promise.resolve();
    },
  };
  const emailDelivery = yield* makeCommercePortalAuthEmailDelivery(rawEmailDelivery).pipe(
    Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
  );
  const auth = yield* makeCommercePortalAuth({
    configuration,
    databaseAdapter: database.adapter,
    emailDelivery,
  });
  const signUpHeaders = { origin: ORIGIN, 'x-forwarded-for': ip };
  yield* Effect.tryPromise({
    catch: (cause) => cause,
    try: () =>
      auth.api.signUpEmail({
        body: { email, name: 'Recovery integration fixture', password },
        headers: signUpHeaders,
      }),
  });
  yield* Effect.promise(
    async () => await auth.api.sendVerificationEmail({ body: { email }, headers: signUpHeaders, returnHeaders: true }),
  );
  const verificationToken = verificationTokens.at(-1);
  const verificationURL = verificationURLs.at(-1);
  if (verificationToken === undefined || verificationURL === undefined) {
    return yield* Effect.fail(new Error('Recovery fixture did not receive an email verification callback'));
  }
  if (!verificationURL.startsWith(`${ORIGIN}${COMMERCE_PORTAL_AUTH_PUBLIC_BASE_PATH}/verify-email?`)) {
    return yield* Effect.fail(new Error('Recovery fixture email verification callback used an internal path'));
  }
  const users = yield* database.executor.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  const fixtureUser = users.at(0);
  if (fixtureUser === undefined) {
    return yield* Effect.fail(new Error('Recovery fixture user was not persisted'));
  }
  const provider = makeCommercePortalAuthRecoveryProvider(auth);
  const recovery = yield* makeCommercePortalAuthRecoveryService(unauditedCommercePortalAuthRecorder).pipe(
    Effect.provideService(CommercePortalAuthRecoveryProviderService, provider),
    Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
    Effect.provideServiceEffect(
      CommercePortalAuthRecoveryReconciliationService,
      makeCommercePortalAuthRecoveryReconciliation().pipe(
        Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
      ),
    ),
  );
  const fixture = {
    auth,
    database,
    email,
    ip,
    password,
    provider,
    recovery,
    resetTokens,
    resetURLs,
    userId: fixtureUser.id,
    verificationToken: Redacted.make(verificationToken),
    verificationTokens,
    verificationURLs,
  } satisfies RecoveryFixture;
  yield* Effect.addFinalizer(() => cleanupRecoveryFixture(fixture).pipe(Effect.orDie));
  return fixture;
});

const registerFixtureVerificationToken = (fixture: RecoveryFixture, token = fixture.verificationToken) =>
  fixture.recovery.registerEmailVerificationToken({
    email: fixture.email,
    providerSubjectId: fixture.userId,
    token,
  });

/**
 * The group is mounted on an API carrying the MicroVertical identifier so the recovery routes are
 * driven exactly as the composition root serves them.
 */
const recoveryTransportApi = HttpApi.make('CommerceCustomerContextApi').addHttpApi(CommercePortalAuthRecoveryApi);
const transportContext = Context.makeUnsafe<unknown>(new Map());

/**
 * Builds a complete, independent HttpApi runtime over one recovery store instance — the shape a
 * single replica of the deployment has. Two of these share nothing but the PostgreSQL rows.
 */
const makeRecoveryRuntime = Effect.fn('CommercePortalAuthRecoveryIntegration.makeRuntime')(function* makeRuntime(
  fixture: RecoveryFixture,
  store: CommercePortalAuthRecoveryStore,
): Effect.fn.Return<ReturnType<typeof HttpRouter.toWebHandler>, unknown, Scope.Scope> {
  const configuration = yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(yield* DATABASE_URL),
    COMMERCE_PORTAL_AUTH_SECRET: SECRET,
    COMMERCE_PORTAL_AUTH_URL: ORIGIN,
  });
  const apiLayer = HttpApiBuilder.layer(recoveryTransportApi).pipe(
    Layer.provide(portalAuthRecoveryApiLive),
    Layer.provide(Layer.succeed(CommercePortalAuthRecoveryServiceTag, fixture.recovery)),
    Layer.provide(
      Layer.succeed(CommercePortalAuthRecoveryRateLimitService, makeCommercePortalAuthRecoveryRateLimit(store)),
    ),
    Layer.provide(Layer.succeed(CommercePortalAuthConfig, configuration)),
    Layer.provide(HttpServer.layerServices),
  );
  return yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(apiLayer, { disableLogger: true })),
    (handler) => Effect.promise(handler.dispose.bind(handler)).pipe(Effect.orDie),
  );
});

const customVerificationRows = (fixture: RecoveryFixture) =>
  recoveryCrypto.digest('SHA-256', new TextEncoder().encode(Redacted.value(fixture.verificationToken))).pipe(
    Effect.map(bytesToHex),
    Effect.flatMap((digest) =>
      fixture.database.executor
        .select({ id: verification.id })
        .from(verification)
        .where(eq(verification.identifier, `${EMAIL_VERIFICATION_IDENTIFIER_PREFIX}${digest}`)),
    ),
  );

it.effect('keeps a Better Auth reset token bound to the original provider subject', () => {
  const database = { account: [], session: [], user: [], verification: [] };
  let resetToken: Redacted.Redacted | null = null;
  const auth = betterAuth({
    baseURL: ORIGIN,
    database: memoryAdapter(database),
    emailAndPassword: {
      autoSignIn: false,
      enabled: true,
      requireEmailVerification: false,
      sendResetPassword: ({ token }) => {
        resetToken = Redacted.make(token);
        return Promise.resolve();
      },
    },
    trustedOrigins: [ORIGIN],
  });
  const provider = makeCommercePortalAuthRecoveryProvider(auth);

  return Effect.gen(function* immutableResetLifecycle() {
    yield* Effect.tryPromise({
      catch: (cause) => cause,
      try: auth.api.signUpEmail.bind(auth.api, {
        body: { email: EMAIL, name: 'Original recovery user', password: ORIGINAL_PASSWORD },
      }),
    });
    const requested = yield* provider.requestPasswordReset({ body: { email: EMAIL } });
    expect(requested.status).toBe(true);
    if (resetToken === null) {
      return yield* Effect.fail(new Error('Better Auth did not issue a reset callback token'));
    }

    database.user.splice(0, 1);
    database.account.splice(0, 1);
    yield* Effect.tryPromise({
      catch: (cause) => cause,
      try: auth.api.signUpEmail.bind(auth.api, {
        body: { email: EMAIL, name: 'Replacement recovery user', password: REPLACEMENT_PASSWORD },
      }),
    });

    const reset = yield* Effect.result(
      provider.resetPassword({
        body: {
          newPassword: REPLACEMENT_PASSWORD,
          token: Redacted.value(resetToken),
        },
      }),
    );
    expect(Result.isFailure(reset)).toBe(true);
    return null;
  });
});

it.live('proves PostgreSQL verification consumption is concurrent-safe and replay-resistant', () =>
  Effect.scoped(
    Effect.gen(function* postgresVerificationConcurrency() {
      const fixture = yield* makeRecoveryFixture('concurrency');
      yield* registerFixtureVerificationToken(fixture);

      const attempts = yield* Effect.all(
        [
          fixture.recovery.verifyEmail({ token: fixture.verificationToken }).pipe(Effect.result),
          fixture.recovery.verifyEmail({ token: fixture.verificationToken }).pipe(Effect.result),
        ],
        { concurrency: 2 },
      );
      expect(attempts.filter(Result.isSuccess)).toHaveLength(1);
      expect(attempts.filter(Result.isFailure)).toHaveLength(1);

      const replay = yield* Effect.result(fixture.recovery.verifyEmail({ token: fixture.verificationToken }));
      expect(Result.isFailure(replay)).toBe(true);
      const users = yield* fixture.database.executor
        .select({ emailVerified: user.emailVerified })
        .from(user)
        .where(eq(user.id, fixture.userId))
        .limit(1);
      expect(users.at(0)?.emailVerified).toBe(true);
    }),
  ),
);

it.live('proves PostgreSQL verification expiry consumes an expired row and rejects it', () =>
  Effect.scoped(
    Effect.gen(function* postgresVerificationExpiry() {
      const fixture = yield* makeRecoveryFixture('expiry');
      yield* registerFixtureVerificationToken(fixture);
      const rows = yield* customVerificationRows(fixture);
      const row = yield* Effect.head(Effect.succeed(rows)).pipe(
        Effect.mapError(() => new Error('Recovery fixture verification row was not persisted')),
      );
      const now = yield* DateTime.nowAsDate;
      yield* fixture.database.executor
        .update(verification)
        .set({ expiresAt: DateTime.toDate(DateTime.add(DateTime.makeUnsafe(now), { seconds: -1 })) })
        .where(eq(verification.id, row.id));

      const expired = yield* Effect.result(fixture.recovery.verifyEmail({ token: fixture.verificationToken }));
      expect(Result.isFailure(expired)).toBe(true);
      const remainingRows = yield* customVerificationRows(fixture);
      expect(remainingRows).toHaveLength(0);
    }),
  ),
);

it.live(
  'consumes the PostgreSQL verification ledger and writes the completion row in one transaction on the happy path',
  () =>
    Effect.scoped(
      Effect.gen(function* postgresVerificationHappyPath() {
        const fixture = yield* makeRecoveryFixture('verification-consumed');
        yield* registerFixtureVerificationToken(fixture);
        const tokenDigest = yield* recoveryCrypto
          .digest('SHA-256', new TextEncoder().encode(Redacted.value(fixture.verificationToken)))
          .pipe(Effect.map(bytesToHex));
        yield* Effect.addFinalizer(() =>
          fixture.database.executor
            .delete(portalAuthAuditEvent)
            .where(eq(portalAuthAuditEvent.providerSubjectId, fixture.userId))
            .pipe(Effect.orDie),
        );

        const outcome = yield* fixture.recovery.verifyEmail({ token: fixture.verificationToken });
        expect(outcome).toStrictEqual({ outcome: 'EMAIL_VERIFICATION_COMPLETED_SAME_SUBJECT' });

        // The token is spent by the same transaction that verified the address.
        const remainingRows = yield* customVerificationRows(fixture);
        expect(remainingRows).toHaveLength(0);
        const users = yield* fixture.database.executor
          .select({ emailVerified: user.emailVerified })
          .from(user)
          .where(eq(user.id, fixture.userId))
          .limit(1);
        expect(users.at(0)?.emailVerified).toBe(true);

        // The completion row committed with that same consumption — it is written by the ledger
        // store, not by the (un-audited) recorder this fixture composes the service with.
        const auditRows = yield* fixture.database.executor
          .select()
          .from(portalAuthAuditEvent)
          .where(eq(portalAuthAuditEvent.providerSubjectId, fixture.userId));
        expect(auditRows).toHaveLength(1);
        expect(auditRows[0]?.eventType).toBe('commerce.portal-auth.email-verification-consumed.v1');
        expect(auditRows[0]?.outcome).toBe('success');
        expect(auditRows[0]?.correlationDigest).toBe(tokenDigest);
      }),
    ),
);

it.live('proves PostgreSQL password recovery revokes the original user sessions', () =>
  Effect.scoped(
    Effect.gen(function* postgresPasswordRecovery() {
      const fixture = yield* makeRecoveryFixture('session-revocation');
      yield* registerFixtureVerificationToken(fixture);
      yield* fixture.recovery.verifyEmail({ token: fixture.verificationToken });

      yield* Effect.tryPromise({
        catch: (cause) => cause,
        try: () =>
          fixture.auth.api.signInEmail({
            body: { email: fixture.email, password: fixture.password },
            headers: { origin: ORIGIN, 'x-forwarded-for': fixture.ip },
          }),
      });
      const sessionsBefore = yield* fixture.database.executor
        .select({ id: session.id })
        .from(session)
        .where(eq(session.userId, fixture.userId));
      expect(sessionsBefore.length).toBeGreaterThan(0);

      const requested = yield* fixture.provider.requestPasswordReset({ body: { email: fixture.email } });
      expect(requested.status).toBe(true);
      const resetToken = yield* Effect.head(Effect.succeed(fixture.resetTokens)).pipe(
        Effect.mapError(() => new Error('Recovery fixture did not receive a password reset token')),
      );
      const resetURL = yield* Effect.head(Effect.succeed(fixture.resetURLs)).pipe(
        Effect.mapError(() => new Error('Recovery fixture did not receive a password reset callback')),
      );
      expect(resetURL.startsWith(`${ORIGIN}${COMMERCE_PORTAL_AUTH_PUBLIC_BASE_PATH}/reset-password/`)).toBe(true);
      const reset = yield* fixture.provider.resetPassword({
        body: { newPassword: REPLACEMENT_PASSWORD, token: resetToken },
      });
      expect(reset.status).toBe(true);

      const sessionsAfter = yield* fixture.database.executor
        .select({ id: session.id })
        .from(session)
        .where(eq(session.userId, fixture.userId));
      expect(sessionsAfter).toHaveLength(0);
    }),
  ),
);

it.live(
  'answers reconciliation-required for PostgreSQL verification after the same subject changes email, leaving it unverified',
  () =>
    Effect.scoped(
      Effect.gen(function* postgresVerificationEmailChange() {
        const fixture = yield* makeRecoveryFixture('email-change');
        yield* registerFixtureVerificationToken(fixture);
        const replacementEmail = `changed-${randomUUID()}@example.test`;
        yield* fixture.database.executor
          .update(user)
          .set({ email: replacementEmail })
          .where(eq(user.id, fixture.userId));

        // The reconciliation hook runs before the ledger token is consumed: the account's address
        // no longer matches what the token was issued for, so this is now a surfaced,
        // support-visible outcome rather than a silent INVALID_TOKEN rejection.
        const outcome = yield* fixture.recovery.verifyEmail({ token: fixture.verificationToken });
        expect(outcome).toStrictEqual({
          conflictClass: 'VERIFICATION_LEDGER_SUBJECT_MISMATCH',
          outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED',
        });
        const users = yield* fixture.database.executor
          .select({ email: user.email, emailVerified: user.emailVerified })
          .from(user)
          .where(eq(user.id, fixture.userId))
          .limit(1);
        expect(users.at(0)?.email).toBe(replacementEmail);
        expect(users.at(0)?.emailVerified).toBe(false);
      }),
    ),
);

it.live(
  'answers reconciliation-required for PostgreSQL verification after the original subject is recreated, leaving the replacement unverified',
  () =>
    Effect.scoped(
      Effect.gen(function* postgresVerificationSubjectReuse() {
        const fixture = yield* makeRecoveryFixture('subject-reuse');
        yield* registerFixtureVerificationToken(fixture);
        yield* fixture.database.executor.delete(user).where(eq(user.id, fixture.userId));
        yield* Effect.tryPromise({
          catch: (cause) => cause,
          try: () =>
            fixture.auth.api.signUpEmail({
              body: {
                email: fixture.email,
                name: 'Replacement recovery fixture',
                password: fixture.password,
              },
              headers: { origin: ORIGIN, 'x-forwarded-for': fixture.ip },
            }),
        });
        const replacementUsers = yield* fixture.database.executor
          .select({ emailVerified: user.emailVerified, id: user.id })
          .from(user)
          .where(eq(user.email, fixture.email))
          .limit(1);
        const replacement = yield* Effect.head(Effect.succeed(replacementUsers)).pipe(
          Effect.mapError(() => new Error('Recovery replacement user was not persisted')),
        );
        expect(replacement.id).not.toBe(fixture.userId);

        // The original subject no longer names any account: TOKEN_SUBJECT_STALE takes priority and
        // the hook stops the token before it could verify the unrelated replacement account.
        const outcome = yield* fixture.recovery.verifyEmail({ token: fixture.verificationToken });
        expect(outcome).toStrictEqual({
          conflictClass: 'TOKEN_SUBJECT_STALE',
          outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED',
        });
        const replacementAfter = yield* fixture.database.executor
          .select({ emailVerified: user.emailVerified, id: user.id })
          .from(user)
          .where(eq(user.id, replacement.id))
          .limit(1);
        const replacementState = yield* Effect.head(Effect.succeed(replacementAfter)).pipe(
          Effect.mapError(() => new Error('Recovery replacement user disappeared during verification')),
        );
        expect(replacementState.emailVerified).toBe(false);
      }),
    ),
);

it.live(
  'answers reconciliation-required for a PostgreSQL password reset after the identifier is rebound, leaving the account and password untouched and recording exactly one row',
  () =>
    Effect.scoped(
      Effect.gen(function* postgresResetPasswordIdentifierRebound() {
        const fixture = yield* makeRecoveryFixture('reset-rebind');
        // Sign-in below must succeed on its own merits: the deployment requires a verified email
        // before sign-in, so the account is verified up front rather than left in the fixture's
        // default unverified state.
        yield* registerFixtureVerificationToken(fixture);
        yield* fixture.recovery.verifyEmail({ token: fixture.verificationToken });
        const requested = yield* fixture.provider.requestPasswordReset({ body: { email: fixture.email } });
        expect(requested.status).toBe(true);
        const resetToken = yield* Effect.head(Effect.succeed(fixture.resetTokens)).pipe(
          Effect.mapError(() => new Error('Recovery fixture did not receive a password reset token')),
        );

        const usersBefore = yield* fixture.database.executor
          .select({ email: user.email, id: user.id })
          .from(user)
          .where(eq(user.id, fixture.userId))
          .limit(1);

        // Re-bind the identifier: the original account keeps existing under a different address,
        // and a second account now owns the email the reset token was issued for.
        const supersededEmail = `${fixture.email}.superseded`;
        const rebindingUserId = `recon-reset-rebind-${randomUUID()}`;
        yield* fixture.database.executor
          .update(user)
          .set({ email: supersededEmail })
          .where(eq(user.id, fixture.userId));
        yield* fixture.database.executor
          .insert(user)
          .values({ email: fixture.email, id: rebindingUserId, name: 'Rebound owner' });
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* cleanupRebind() {
            yield* fixture.database.executor.delete(user).where(eq(user.id, rebindingUserId));
            yield* fixture.database.executor
              .delete(recoveryReconciliation)
              .where(eq(recoveryReconciliation.email, fixture.email));
          }).pipe(Effect.orDie),
        );

        // The reconciliation hook runs before the provider's reset ever spends the token: a
        // rebound identifier is terminal, so the original account's password must never change.
        const outcome = yield* fixture.recovery.resetPassword({
          newPassword: Redacted.make(REPLACEMENT_PASSWORD),
          token: Redacted.make(resetToken),
        });
        expect(outcome).toStrictEqual({
          conflictClass: 'IDENTIFIER_REBOUND',
          outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED',
        });

        // The account is untouched: no reset ran, so the address changed above is the only change.
        const usersAfter = yield* fixture.database.executor
          .select({ email: user.email, id: user.id })
          .from(user)
          .where(eq(user.id, fixture.userId))
          .limit(1);
        expect(usersAfter).toStrictEqual(usersBefore.map((row) => ({ ...row, email: supersededEmail })));
        const signIn = yield* Effect.result(
          Effect.tryPromise({
            catch: (cause) => cause,
            try: () =>
              fixture.auth.api.signInEmail({
                body: { email: supersededEmail, password: fixture.password },
                headers: { origin: ORIGIN, 'x-forwarded-for': fixture.ip },
              }),
          }),
        );
        expect(Result.isSuccess(signIn)).toBe(true);

        // Exactly one durable reconciliation row, for a support operator to act on.
        const reconciliationRows = yield* fixture.database.executor
          .select()
          .from(recoveryReconciliation)
          .where(eq(recoveryReconciliation.email, fixture.email));
        expect(reconciliationRows).toHaveLength(1);
        expect(reconciliationRows[0]?.conflictClass).toBe('IDENTIFIER_REBOUND');
        expect(reconciliationRows[0]?.operation).toBe('reset-password');
        expect(reconciliationRows[0]?.providerSubjectId).toBe(fixture.userId);
        expect(reconciliationRows[0]?.currentProviderSubjectId).toBe(rebindingUserId);
      }),
    ),
);

it.live('spends one PostgreSQL recovery budget across two independent HttpApi runtimes', () =>
  Effect.scoped(
    Effect.gen(function* postgresSharedRecoveryBudget() {
      const fixture = yield* makeRecoveryFixture('shared-budget');
      // Two store instances, built independently over the same database, stand in for two replicas.
      const stores = yield* Effect.forEach(
        [0, 1],
        () =>
          makeCommercePortalAuthRecoveryStore(fixture.database.executor).pipe(
            Effect.provideService(Crypto.Crypto, recoveryCrypto),
          ),
        { concurrency: 1 },
      );
      const runtimes = yield* Effect.forEach(stores, (store) => makeRecoveryRuntime(fixture, store), {
        concurrency: 1,
      });
      const budget = COMMERCE_PORTAL_AUTH_POLICY.rateLimit.recovery.max;
      const targetedKey = recoveryBudgetKey(fixture.email, '/request-password-reset');
      const bystanderKey = recoveryBudgetKey(bystanderEmail(fixture.email), '/request-password-reset');
      // A subject-keyed budget already gives this fixture a window of its own, but the row this
      // test proves must *not* exist — the client-only key a deployment-wide counter would use —
      // is shared with anything that ever ran against this database. Start that window from zero
      // so the assertion below reports what this run did, not what some earlier run left behind.
      const globalKey = `${UNRESOLVED_PORTAL_AUTH_CLIENT_KEY}|/request-password-reset`;
      yield* fixture.database.executor
        .delete(rateLimit)
        .where(inArray(rateLimit.key, [globalKey, targetedKey, bystanderKey]));
      const requestReset = (app: (typeof runtimes)[number], email: string, origin: string) =>
        app === undefined
          ? Effect.fail(new Error('Recovery runtime was not constructed'))
          : Effect.promise(() =>
              app.handler(
                new Request(`${ORIGIN}${COMMERCE_PORTAL_AUTH_INTERNAL_BASE_PATH}/request-password-reset`, {
                  body: JSON.stringify({ email }),
                  headers: {
                    'content-type': 'application/json',
                    origin,
                    'x-forwarded-for': fixture.ip,
                  },
                  method: 'POST',
                }),
                transportContext,
              ),
            ).pipe(Effect.map((response) => response.status));

      // A third-party page can drive a visitor's browser into this route, so the origin gate must
      // refuse such a request *before* the durable budget is spent — otherwise the page could burn
      // the named account's whole 3-per-hour budget and collect a 403 only afterwards.
      const forgedOrigin = yield* Effect.forEach(
        Array.from({ length: budget + 1 }, (_unused, attempt) => runtimes[attempt % runtimes.length]),
        (app) => requestReset(app, fixture.email, 'https://attacker.example.test'),
        { concurrency: 1 },
      );
      expect(forgedOrigin).toStrictEqual(Array.from({ length: budget + 1 }, () => 403));
      const afterForgery = yield* fixture.database.executor
        .select({ key: rateLimit.key })
        .from(rateLimit)
        .where(eq(rateLimit.key, targetedKey));
      expect(afterForgery).toHaveLength(0);

      const attempts = Array.from({ length: budget + 1 }, (_unused, attempt) => runtimes[attempt % runtimes.length]);
      const statuses = yield* Effect.forEach(attempts, (app) => requestReset(app, fixture.email, ORIGIN), {
        concurrency: 1,
      });

      expect(statuses).toStrictEqual([...Array.from({ length: budget }, () => 200), 429]);
      // The budget is one durable row, not one counter per runtime — and it is keyed on the
      // resolved client *and the address the attempt names*, never on the `x-forwarded-for` value
      // every one of these requests carried: a caller-chosen hop must not open a budget of its own.
      const counters = yield* fixture.database.executor
        .select({ count: rateLimit.count, key: rateLimit.key })
        .from(rateLimit)
        .where(eq(rateLimit.key, targetedKey));
      expect(counters).toHaveLength(1);
      expect(counters.at(0)?.count).toBe(budget);
      const forgedCounters = yield* fixture.database.executor
        .select({ key: rateLimit.key })
        .from(rateLimit)
        .where(eq(rateLimit.key, `${fixture.ip}|/request-password-reset`));
      expect(forgedCounters).toHaveLength(0);
      // A key without the subject would be one counter for the whole deployment, and the window
      // just exhausted above would have denied password recovery to every other customer.
      const globalCounters = yield* fixture.database.executor
        .select({ key: rateLimit.key })
        .from(rateLimit)
        .where(eq(rateLimit.key, globalKey));
      expect(globalCounters).toHaveLength(0);

      // The same window, a different account: the deployment still recovers its customers.
      expect(yield* requestReset(runtimes[0], bystanderEmail(fixture.email), ORIGIN)).toBe(200);
      const bystanderCounters = yield* fixture.database.executor
        .select({ count: rateLimit.count })
        .from(rateLimit)
        .where(eq(rateLimit.key, bystanderKey));
      expect(bystanderCounters.at(0)?.count).toBe(1);
      // Casing names the same account, so a re-cased address cannot mint itself a fresh budget.
      expect(yield* requestReset(runtimes[0], fixture.email.toUpperCase(), ORIGIN)).toBe(429);
    }),
  ),
);

// -- Claim-before-dispatch: what a lost provider answer leaves behind. --------------------------

/**
 * A recovery service over the fixture's real PostgreSQL store, with one collaborator replaced. The
 * provider double below is what makes a *lost answer* reproducible: the real Better Auth call runs
 * and commits, and only then does the answer fail to come back.
 */
const makeScriptedRecovery = Effect.fn('CommercePortalAuthRecoveryIntegration.makeScriptedRecovery')(
  function* makeScripted(
    provider: RecoveryProvider,
    store: CommercePortalAuthRecoveryStore,
  ): Effect.fn.Return<RecoveryService, unknown> {
    return yield* makeCommercePortalAuthRecoveryService(unauditedCommercePortalAuthRecorder).pipe(
      Effect.provideService(CommercePortalAuthRecoveryProviderService, provider),
      Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
      Effect.provideServiceEffect(
        CommercePortalAuthRecoveryReconciliationService,
        makeCommercePortalAuthRecoveryReconciliation().pipe(
          Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
        ),
      ),
    );
  },
);

/**
 * The provider that commits and then loses its answer: Better Auth really resets the password and
 * really consumes its own token row, and the owner sees a timeout-class failure — no provider code,
 * which is exactly how `provider-service.ts` reports a call that never came back.
 */
const losingAnswerProvider = (provider: RecoveryProvider): RecoveryProvider => ({
  ...provider,
  resetPassword: (input) =>
    provider
      .resetPassword(input)
      .pipe(
        Effect.flatMap(() =>
          Effect.fail(new CommercePortalAuthRecoveryProviderFailure({ operation: 'reset-password' })),
        ),
      ),
});

/** Everything one reset-ledger scenario needs on top of the shared fixture. */
const makeDispatchFixture = Effect.fn('CommercePortalAuthRecoveryIntegration.makeDispatchFixture')(
  function* makeDispatch(caseName: string): Effect.fn.Return<
    {
      readonly fixture: RecoveryFixture;
      readonly resetToken: string;
      readonly store: CommercePortalAuthRecoveryStore;
      readonly tokenDigest: string;
    },
    unknown,
    Scope.Scope
  > {
    const fixture = yield* makeRecoveryFixture(caseName);
    // The deployment requires a verified address before sign-in, and the assertions below prove the
    // password by signing in, so the account is verified up front.
    yield* registerFixtureVerificationToken(fixture);
    yield* fixture.recovery.verifyEmail({ token: fixture.verificationToken });
    const store = yield* makeCommercePortalAuthRecoveryStore(fixture.database.executor).pipe(
      Effect.provideService(Crypto.Crypto, recoveryCrypto),
    );
    const requested = yield* fixture.provider.requestPasswordReset({ body: { email: fixture.email } });
    expect(requested.status).toBe(true);
    const resetToken = yield* Effect.head(Effect.succeed(fixture.resetTokens)).pipe(
      Effect.mapError(() => new Error('Recovery fixture did not receive a password reset token')),
    );
    const tokenDigest = yield* recoveryCrypto
      .digest('SHA-256', new TextEncoder().encode(resetToken))
      .pipe(Effect.map(bytesToHex));
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* cleanupDispatchFixture() {
        yield* fixture.database.executor
          .delete(recoveryResetLedger)
          .where(eq(recoveryResetLedger.tokenDigest, tokenDigest));
        yield* fixture.database.executor
          .delete(recoveryReconciliation)
          .where(eq(recoveryReconciliation.email, fixture.email));
        yield* fixture.database.executor
          .delete(portalAuthAuditEvent)
          .where(eq(portalAuthAuditEvent.providerSubjectId, fixture.userId));
      }).pipe(Effect.orDie),
    );
    return { fixture, resetToken, store, tokenDigest };
  },
);

const resetLedgerRow = (fixture: RecoveryFixture, tokenDigest: string) =>
  fixture.database.executor
    .select()
    .from(recoveryResetLedger)
    .where(eq(recoveryResetLedger.tokenDigest, tokenDigest))
    .limit(1);

const signInWith = (fixture: RecoveryFixture, password: string) =>
  Effect.result(
    Effect.tryPromise({
      catch: (cause) => cause,
      try: () =>
        fixture.auth.api.signInEmail({
          body: { email: fixture.email, password },
          headers: { origin: ORIGIN, 'x-forwarded-for': fixture.ip },
        }),
    }),
  );

it.live(
  'claims the PostgreSQL reset ledger before dispatch, so a provider that commits and loses its answer leaves a dispatched row and an unavailable outcome',
  () =>
    Effect.scoped(
      Effect.gen(function* postgresResetDispatchClaimed() {
        const { fixture, resetToken, store, tokenDigest } = yield* makeDispatchFixture('reset-dispatch');
        const recovery = yield* makeScriptedRecovery(losingAnswerProvider(fixture.provider), store);

        const outcome = yield* Effect.result(
          recovery.resetPassword({
            newPassword: Redacted.make(REPLACEMENT_PASSWORD),
            token: Redacted.make(resetToken),
          }),
        );
        // A network/timeout-class provider failure is reported unavailable — the transport answers
        // 503 — and nothing pretends to know whether the reset happened.
        expect(Result.isFailure(outcome)).toBe(true);
        if (Result.isFailure(outcome)) {
          expect(Schema.is(CommercePortalAuthRecoveryUnavailable)(outcome.failure)).toBe(true);
        }

        // The claim is what survives: the row is `dispatched`, stamped, and still carries the
        // binding a support operator needs.
        const rows = yield* resetLedgerRow(fixture, tokenDigest);
        expect(rows[0]?.state).toBe('dispatched');
        expect(rows[0]?.dispatchedAt).not.toBeNull();
        expect(rows[0]?.providerSubjectId).toBe(fixture.userId);
        expect(rows[0]?.email).toBe(fixture.email);

        // The provider really did commit before the answer was lost: the new password works, which
        // is the fact the `pending` row of the old behaviour would have denied.
        expect(Result.isSuccess(yield* signInWith(fixture, REPLACEMENT_PASSWORD))).toBe(true);
      }),
    ),
);

it.live(
  'answers reconciliation-required rather than INVALID_TOKEN when a PostgreSQL reset is retried after its answer was lost',
  () =>
    Effect.scoped(
      Effect.gen(function* postgresResetRetryAfterLostAnswer() {
        const { fixture, resetToken, store, tokenDigest } = yield* makeDispatchFixture('reset-retry');
        const losing = yield* makeScriptedRecovery(losingAnswerProvider(fixture.provider), store);
        yield* Effect.result(
          losing.resetPassword({
            newPassword: Redacted.make(REPLACEMENT_PASSWORD),
            token: Redacted.make(resetToken),
          }),
        );
        expect((yield* resetLedgerRow(fixture, tokenDigest))[0]?.state).toBe('dispatched');

        // The customer retries the same link. Better Auth already spent its own token row inside
        // the reset above, so asking it again would answer INVALID_TOKEN — indistinguishable from a
        // token that was never valid, which is precisely why the claim decides before the provider
        // is ever reached.
        const retry = yield* makeScriptedRecovery(fixture.provider, store);
        const outcome = yield* retry.resetPassword({
          newPassword: Redacted.make(REPLACEMENT_PASSWORD),
          token: Redacted.make(resetToken),
        });
        expect(outcome).toStrictEqual({
          conflictClass: 'RESET_OUTCOME_INDETERMINATE',
          outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED',
        });

        // Exactly one durable row, naming the account whose reset nobody can confirm.
        const reconciliationRows = yield* fixture.database.executor
          .select()
          .from(recoveryReconciliation)
          .where(eq(recoveryReconciliation.email, fixture.email));
        expect(reconciliationRows).toHaveLength(1);
        expect(reconciliationRows[0]?.conflictClass).toBe('RESET_OUTCOME_INDETERMINATE');
        expect(reconciliationRows[0]?.operation).toBe('reset-password');
        expect(reconciliationRows[0]?.providerSubjectId).toBe(fixture.userId);
        expect(reconciliationRows[0]?.currentProviderSubjectId).toBe(fixture.userId);
        // The claim is not cleared by being reported: the row stays the operator's evidence.
        expect((yield* resetLedgerRow(fixture, tokenDigest))[0]?.state).toBe('dispatched');
      }),
    ),
);

it.live('lets only the PostgreSQL claim winner reach the provider when two submissions race one reset token', () =>
  Effect.scoped(
    Effect.gen(function* postgresConcurrentResetSubmissions() {
      const { fixture, resetToken, store, tokenDigest } = yield* makeDispatchFixture('reset-race');
      let dispatches = 0;
      const counted: RecoveryProvider = {
        ...fixture.provider,
        resetPassword: (input) =>
          Effect.suspend(() => {
            dispatches += 1;
            return fixture.provider.resetPassword(input);
          }),
      };
      const entered = yield* Deferred.make<null>();
      const release = yield* Deferred.make<null>();
      // The claim holder stops inside its provider call, which puts the second submission exactly
      // where two portal tabs put it: after one guarded `UPDATE` won the row and before the reset
      // it authorises has settled anything.
      const gated: RecoveryProvider = {
        ...counted,
        resetPassword: (input) =>
          Deferred.succeed(entered, null).pipe(
            Effect.andThen(() => Deferred.await(release)),
            Effect.andThen(() => counted.resetPassword(input)),
          ),
      };
      const holder = yield* makeScriptedRecovery(gated, store);
      const contender = yield* makeScriptedRecovery(counted, store);
      const submit = (recovery: RecoveryService) =>
        recovery.resetPassword({
          newPassword: Redacted.make(REPLACEMENT_PASSWORD),
          token: Redacted.make(resetToken),
        });

      const holderFiber = yield* Effect.forkScoped(submit(holder));
      yield* Deferred.await(entered);
      const contenderOutcome = yield* Effect.ensuring(
        Effect.result(submit(contender)),
        Deferred.succeed(release, null).pipe(Effect.asVoid),
      );
      // One claim, one dispatch: a zero-row `UPDATE` is a refusal, never permission to ask Better
      // Auth to spend the same token again behind the holder's back.
      expect(dispatches).toBe(1);
      const holderOutcome = yield* Fiber.join(holderFiber);
      expect(holderOutcome).toStrictEqual({ outcome: 'ACCOUNT_RECOVERY_COMPLETED_SAME_SUBJECT' });
      // The loser of the claim cannot know the holder's outcome, so it reports the reconciliation
      // that already describes it rather than spending the token a second time.
      expect(Result.isSuccess(contenderOutcome)).toBe(true);
      if (Result.isSuccess(contenderOutcome)) {
        expect(contenderOutcome.success).toStrictEqual({
          conflictClass: 'RESET_OUTCOME_INDETERMINATE',
          outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED',
        });
      }

      const rows = yield* resetLedgerRow(fixture, tokenDigest);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe('consumed');

      // Exactly the one row the design intends — the holder's unknown outcome, filed once.
      const reconciliationRows = yield* fixture.database.executor
        .select()
        .from(recoveryReconciliation)
        .where(eq(recoveryReconciliation.email, fixture.email));
      expect(reconciliationRows).toHaveLength(1);
      expect(reconciliationRows[0]?.conflictClass).toBe('RESET_OUTCOME_INDETERMINATE');
      expect(reconciliationRows[0]?.providerSubjectId).toBe(fixture.userId);
      expect(Result.isSuccess(yield* signInWith(fixture, REPLACEMENT_PASSWORD))).toBe(true);
    }),
  ),
);

it.live('consumes the PostgreSQL reset ledger and writes the completion row in one transaction on the happy path', () =>
  Effect.scoped(
    Effect.gen(function* postgresResetHappyPath() {
      const { fixture, resetToken, store, tokenDigest } = yield* makeDispatchFixture('reset-consumed');
      const recovery = yield* makeScriptedRecovery(fixture.provider, store);

      const outcome = yield* recovery.resetPassword({
        newPassword: Redacted.make(REPLACEMENT_PASSWORD),
        token: Redacted.make(resetToken),
      });
      expect(outcome).toStrictEqual({ outcome: 'ACCOUNT_RECOVERY_COMPLETED_SAME_SUBJECT' });

      const rows = yield* resetLedgerRow(fixture, tokenDigest);
      expect(rows[0]?.state).toBe('consumed');
      expect(rows[0]?.providerSubjectId).toBeNull();
      expect(rows[0]?.email).toBeNull();

      // The completion row committed with that same transition — it is written by the ledger
      // store, not by the (un-audited) recorder this fixture composes the service with.
      const auditRows = yield* fixture.database.executor
        .select()
        .from(portalAuthAuditEvent)
        .where(
          and(
            eq(portalAuthAuditEvent.providerSubjectId, fixture.userId),
            eq(portalAuthAuditEvent.eventType, 'commerce.portal-auth.recovery-completed.v1'),
          ),
        );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.outcome).toBe('success');
      expect(auditRows[0]?.correlationDigest).toBe(tokenDigest);
      expect(Result.isSuccess(yield* signInWith(fixture, REPLACEMENT_PASSWORD))).toBe(true);
    }),
  ),
);

it.live(
  'answers reconciliation-required when the PostgreSQL completion transaction fails after a real reset, and keeps the token unusable',
  () =>
    Effect.scoped(
      Effect.gen(function* postgresResetCompletionRefused() {
        const { fixture, resetToken, store, tokenDigest } = yield* makeDispatchFixture('reset-completion');
        // The provider succeeds; the one write that cannot be made is the transaction carrying the
        // ledger's terminal state and the completion row together.
        const refusingStore: CommercePortalAuthRecoveryStore = {
          ...store,
          consumePasswordResetLedgerWithAudit: () =>
            Effect.fail(
              new CommercePortalAuthRecoveryUnavailable({
                operation: 'password-reset-ledger-consume-audit',
                reason: 'the completion transaction was refused',
              }),
            ),
        };
        const recovery = yield* makeScriptedRecovery(fixture.provider, refusingStore);

        const outcome = yield* recovery.resetPassword({
          newPassword: Redacted.make(REPLACEMENT_PASSWORD),
          token: Redacted.make(resetToken),
        });
        // Not a bare outage: a customer told only "unavailable" would retry a token the provider
        // has already spent, and nothing would ever record that the password changed.
        expect(outcome).toStrictEqual({
          conflictClass: 'RESET_OUTCOME_INDETERMINATE',
          outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED',
        });
        expect((yield* resetLedgerRow(fixture, tokenDigest))[0]?.state).toBe('dispatched');
        expect(Result.isSuccess(yield* signInWith(fixture, REPLACEMENT_PASSWORD))).toBe(true);

        // The retry re-reads the same claim: Better Auth rejects the spent token, and the owner
        // still answers reconciliation rather than a confident rejection.
        const retry = yield* makeScriptedRecovery(fixture.provider, store);
        expect(
          yield* retry.resetPassword({
            newPassword: Redacted.make(REPLACEMENT_PASSWORD),
            token: Redacted.make(resetToken),
          }),
        ).toStrictEqual({
          conflictClass: 'RESET_OUTCOME_INDETERMINATE',
          outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED',
        });
        const reconciliationRows = yield* fixture.database.executor
          .select()
          .from(recoveryReconciliation)
          .where(eq(recoveryReconciliation.email, fixture.email));
        // The dedupe index keeps a repeated detection of the same conflict on one row.
        expect(reconciliationRows).toHaveLength(1);
        expect(reconciliationRows[0]?.conflictClass).toBe('RESET_OUTCOME_INDETERMINATE');
      }),
    ),
);

/**
 * The one rejection Better Auth judges *before* it consumes its own token row, so the link it
 * refuses is provably still spendable. The realm's published schema enforces the same length bound
 * the provider does, so the short value is introduced here — inside the provider bridge — which is
 * exactly where a provider whose own bound is stricter than the realm's would produce it.
 */
const shortPasswordProvider = (provider: RecoveryProvider): RecoveryProvider => ({
  ...provider,
  resetPassword: (input) =>
    provider.resetPassword(
      input === undefined ? input : { ...input, body: { ...input.body, newPassword: SHORT_PASSWORD } },
    ),
});

/**
 * The account deleted between the claim and the provider's answer. Better Auth loads the account
 * only after it has consumed the token row, so `USER_NOT_FOUND` arrives over a token this call has
 * already spent — from here, indistinguishable from a reset that completed.
 */
const deletingAccountProvider = (fixture: RecoveryFixture): RecoveryProvider => ({
  ...fixture.provider,
  resetPassword: (input) =>
    fixture.database.executor
      .delete(user)
      .where(eq(user.id, fixture.userId))
      .pipe(
        Effect.orDie,
        Effect.andThen(() => fixture.provider.resetPassword(input)),
      ),
});

it.live(
  'releases the PostgreSQL reset claim when the provider refuses the new password, so the corrected retry still resets it',
  () =>
    Effect.scoped(
      Effect.gen(function* postgresResetClaimReleased() {
        const { fixture, resetToken, store, tokenDigest } = yield* makeDispatchFixture('reset-release');
        const refusing = yield* makeScriptedRecovery(shortPasswordProvider(fixture.provider), store);

        const refused = yield* Effect.result(
          refusing.resetPassword({
            newPassword: Redacted.make(REPLACEMENT_PASSWORD),
            token: Redacted.make(resetToken),
          }),
        );
        // The provider's own rejection, not an unknown outcome: the customer is told the password
        // was refused and can correct it.
        expect(Result.isFailure(refused)).toBe(true);
        if (Result.isFailure(refused)) {
          expect(Schema.is(CommercePortalAuthRecoveryRejected)(refused.failure)).toBe(true);
        }

        // Without the release the row stays `dispatched` for the rest of its life: nothing else
        // ever moves it back, so this is the assertion the stranded claim fails.
        const released = yield* resetLedgerRow(fixture, tokenDigest);
        expect(released[0]?.state).toBe('pending');
        expect(released[0]?.dispatchedAt).toBeNull();
        expect(released[0]?.providerSubjectId).toBe(fixture.userId);
        expect(released[0]?.email).toBe(fixture.email);

        // The link really is still good, which is the whole point of giving the claim back: the
        // corrected submission resets the password and retires the token.
        const retry = yield* makeScriptedRecovery(fixture.provider, store);
        expect(
          yield* retry.resetPassword({
            newPassword: Redacted.make(REPLACEMENT_PASSWORD),
            token: Redacted.make(resetToken),
          }),
        ).toStrictEqual({ outcome: 'ACCOUNT_RECOVERY_COMPLETED_SAME_SUBJECT' });
        expect((yield* resetLedgerRow(fixture, tokenDigest))[0]?.state).toBe('consumed');
        expect(Result.isSuccess(yield* signInWith(fixture, REPLACEMENT_PASSWORD))).toBe(true);

        // A refused password is a known outcome from end to end, so no operator is asked to look
        // at this account.
        const reconciliationRows = yield* fixture.database.executor
          .select()
          .from(recoveryReconciliation)
          .where(eq(recoveryReconciliation.email, fixture.email));
        expect(reconciliationRows).toHaveLength(0);
      }),
    ),
);

it.live(
  'answers reconciliation-required when the PostgreSQL account is deleted between the claim and the provider answer',
  () =>
    Effect.scoped(
      Effect.gen(function* postgresResetSubjectDeletedMidFlight() {
        const { fixture, resetToken, store, tokenDigest } = yield* makeDispatchFixture('reset-user-gone');
        const recovery = yield* makeScriptedRecovery(deletingAccountProvider(fixture), store);

        const outcome = yield* recovery.resetPassword({
          newPassword: Redacted.make(REPLACEMENT_PASSWORD),
          token: Redacted.make(resetToken),
        });
        // Better Auth spent the token before it looked the account up, so answering the customer a
        // confident rejection would deny a link whose outcome nobody in this realm can state.
        expect(outcome).toStrictEqual({
          conflictClass: 'RESET_OUTCOME_INDETERMINATE',
          outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED',
        });

        // The claim is evidence now and is deliberately not released: the token really was spent.
        const rows = yield* resetLedgerRow(fixture, tokenDigest);
        expect(rows[0]?.state).toBe('dispatched');
        expect(rows[0]?.providerSubjectId).toBe(fixture.userId);

        const reconciliationRows = yield* fixture.database.executor
          .select()
          .from(recoveryReconciliation)
          .where(eq(recoveryReconciliation.email, fixture.email));
        expect(reconciliationRows).toHaveLength(1);
        expect(reconciliationRows[0]?.conflictClass).toBe('RESET_OUTCOME_INDETERMINATE');
        expect(reconciliationRows[0]?.providerSubjectId).toBe(fixture.userId);
        // Nobody owns the identifier any more, which is the first thing an operator asks.
        expect(reconciliationRows[0]?.currentProviderSubjectId).toBeNull();
      }),
    ),
);

it.live('sweeps an aged PostgreSQL dispatch claim to expired and leaves a fresh one alone', () =>
  Effect.scoped(
    Effect.gen(function* postgresResetLedgerDispatchSweep() {
      const { fixture, resetToken, store, tokenDigest } = yield* makeDispatchFixture('reset-sweep');
      const digestOf = (token: string) =>
        recoveryCrypto.digest('SHA-256', new TextEncoder().encode(token)).pipe(Effect.map(bytesToHex));
      const freshToken = `sweep-fresh-${randomUUID()}`;
      const sweepingToken = `sweep-trigger-${randomUUID()}`;
      const [freshDigest, sweepingDigest] = yield* Effect.all([digestOf(freshToken), digestOf(sweepingToken)], {
        concurrency: 1,
      });
      yield* Effect.addFinalizer(() =>
        fixture.database.executor
          .delete(recoveryResetLedger)
          .where(inArray(recoveryResetLedger.tokenDigest, [freshDigest, sweepingDigest]))
          .pipe(Effect.orDie),
      );
      const now = yield* DateTime.nowAsDate;
      const expiresAt = DateTime.toDate(
        DateTime.add(DateTime.makeUnsafe(now), {
          seconds: COMMERCE_PORTAL_AUTH_POLICY.password.resetTokenExpiresInSeconds,
        }),
      );
      const issue = (token: string) =>
        store.registerPasswordResetToken({
          email: fixture.email,
          expiresAt,
          providerSubjectId: fixture.userId,
          token: Redacted.make(token),
        });

      // The aged claim: still well inside its own `expiresAt`, so only the dispatch window can
      // retire it, and it keeps the address and subject until something does.
      expect(yield* store.dispatchPasswordResetLedger({ token: Redacted.make(resetToken) })).toBe('claimed');
      yield* fixture.database.executor
        .update(recoveryResetLedger)
        .set({
          dispatchedAt: DateTime.toDate(
            DateTime.add(DateTime.makeUnsafe(now), {
              seconds: -(COMMERCE_PORTAL_AUTH_POLICY.password.resetTokenExpiresInSeconds + 60),
            }),
          ),
        })
        .where(eq(recoveryResetLedger.tokenDigest, tokenDigest));

      // Issuance is what pays for the sweep, exactly as the deployment runs it. The second
      // issuance claims its own row, and the third is what sweeps with that claim already fresh.
      yield* issue(freshToken);
      expect(yield* store.dispatchPasswordResetLedger({ token: Redacted.make(freshToken) })).toBe('claimed');
      yield* issue(sweepingToken);

      // Without the dispatch half of the sweep this row keeps its email and subject forever.
      const aged = yield* resetLedgerRow(fixture, tokenDigest);
      expect(aged[0]?.state).toBe('expired');
      expect(aged[0]?.email).toBeNull();
      expect(aged[0]?.providerSubjectId).toBeNull();

      // A claim inside the window is still the answer to a lost dispatch, so it keeps its binding.
      const fresh = yield* resetLedgerRow(fixture, freshDigest);
      expect(fresh[0]?.state).toBe('dispatched');
      expect(fresh[0]?.email).toBe(fixture.email);
      expect(fresh[0]?.providerSubjectId).toBe(fixture.userId);
    }),
  ),
);

it.live(
  'records RESET_OUTCOME_INDETERMINATE reconciliation evidence before a swept PostgreSQL dispatch claim expires',
  () =>
    Effect.scoped(
      Effect.gen(function* postgresResetLedgerDispatchSweepRecordsReconciliation() {
        const { fixture, resetToken, store, tokenDigest } = yield* makeDispatchFixture('reset-sweep-evidence');
        const sweepingToken = `sweep-evidence-trigger-${randomUUID()}`;
        const sweepingDigest = yield* recoveryCrypto
          .digest('SHA-256', new TextEncoder().encode(sweepingToken))
          .pipe(Effect.map(bytesToHex));
        yield* Effect.addFinalizer(() =>
          fixture.database.executor
            .delete(recoveryResetLedger)
            .where(eq(recoveryResetLedger.tokenDigest, sweepingDigest))
            .pipe(Effect.orDie),
        );
        const now = yield* DateTime.nowAsDate;
        const expiresAt = DateTime.toDate(
          DateTime.add(DateTime.makeUnsafe(now), {
            seconds: COMMERCE_PORTAL_AUTH_POLICY.password.resetTokenExpiresInSeconds,
          }),
        );

        // The aged claim: this dispatched row is the only durable evidence a possibly-committed
        // password change ever happened, and the sweep must not destroy that evidence.
        expect(yield* store.dispatchPasswordResetLedger({ token: Redacted.make(resetToken) })).toBe('claimed');
        yield* fixture.database.executor
          .update(recoveryResetLedger)
          .set({
            dispatchedAt: DateTime.toDate(
              DateTime.add(DateTime.makeUnsafe(now), {
                seconds: -(COMMERCE_PORTAL_AUTH_POLICY.password.resetTokenExpiresInSeconds + 60),
              }),
            ),
          })
          .where(eq(recoveryResetLedger.tokenDigest, tokenDigest));

        // Registering a new token is what triggers the sweep in production.
        yield* store.registerPasswordResetToken({
          email: fixture.email,
          expiresAt,
          providerSubjectId: fixture.userId,
          token: Redacted.make(sweepingToken),
        });

        const aged = yield* resetLedgerRow(fixture, tokenDigest);
        expect(aged[0]?.state).toBe('expired');
        expect(aged[0]?.email).toBeNull();
        expect(aged[0]?.providerSubjectId).toBeNull();

        // Without the fix this row never appears, which is exactly what leaves support with no
        // evidence that the password may already have changed.
        const reconciliationRows = yield* fixture.database.executor
          .select()
          .from(recoveryReconciliation)
          .where(eq(recoveryReconciliation.email, fixture.email));
        expect(reconciliationRows).toHaveLength(1);
        expect(reconciliationRows[0]?.conflictClass).toBe('RESET_OUTCOME_INDETERMINATE');
        expect(reconciliationRows[0]?.providerSubjectId).toBe(fixture.userId);
        expect(reconciliationRows[0]?.currentProviderSubjectId).toBe(fixture.userId);
      }),
    ),
);

it.live(
  'refuses email verification when the PostgreSQL completion transaction fails, leaving the address unverified and the ledger row untouched',
  () =>
    Effect.scoped(
      Effect.gen(function* postgresVerificationCompletionRefused() {
        const fixture = yield* makeRecoveryFixture('verification-completion');
        yield* registerFixtureVerificationToken(fixture);
        const store = yield* makeCommercePortalAuthRecoveryStore(fixture.database.executor).pipe(
          Effect.provideService(Crypto.Crypto, recoveryCrypto),
        );
        // The one write that cannot be made is the transaction carrying the ledger's consumption
        // and the completion row together; nothing about the token or the account changes.
        const refusingStore: CommercePortalAuthRecoveryStore = {
          ...store,
          consumeEmailVerificationWithAudit: () =>
            Effect.fail(
              new CommercePortalAuthRecoveryUnavailable({
                operation: 'verification-token-consume-audit',
                reason: 'the completion transaction was refused',
              }),
            ),
        };
        const recovery = yield* makeScriptedRecovery(fixture.provider, refusingStore);

        const outcome = yield* Effect.result(recovery.verifyEmail({ token: fixture.verificationToken }));
        expect(Result.isFailure(outcome)).toBe(true);
        if (Result.isFailure(outcome)) {
          expect(outcome.failure).toBeInstanceOf(CommercePortalAuthRecoveryUnavailable);
        }

        // Without the fix this consumes the token and flips the account verified before the audit
        // write is even attempted, so both assertions below fail on the lenient-emit code path.
        const remainingRows = yield* customVerificationRows(fixture);
        expect(remainingRows).toHaveLength(1);
        const users = yield* fixture.database.executor
          .select({ emailVerified: user.emailVerified })
          .from(user)
          .where(eq(user.id, fixture.userId))
          .limit(1);
        expect(users.at(0)?.emailVerified).toBe(false);
      }),
    ),
);

it.live(
  'leaves the email verification ledger row in place when the account is deleted between reconciliation.detect and the guarded consumption, so a retry still records the conflict',
  () =>
    Effect.scoped(
      Effect.gen(function* postgresVerificationSubjectDeletedMidFlight() {
        const fixture = yield* makeRecoveryFixture('verification-user-gone');
        yield* registerFixtureVerificationToken(fixture);
        const store = yield* makeCommercePortalAuthRecoveryStore(fixture.database.executor).pipe(
          Effect.provideService(Crypto.Crypto, recoveryCrypto),
        );
        const reconciliation = yield* makeCommercePortalAuthRecoveryReconciliation().pipe(
          Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
        );

        // Mirrors what `reconciliation.detect` already read and passed as consistent, then the
        // account is removed before the guarded consumption transaction runs — the exact window
        // Codex flagged: the ledger DELETE ran unconditionally ahead of the guarded `user` UPDATE.
        yield* fixture.database.executor.delete(user).where(eq(user.id, fixture.userId));

        const now = yield* DateTime.nowAsDate;
        const consumed = yield* store.consumeEmailVerificationWithAudit({
          audit: {
            eventType: 'commerce.portal-auth.email-verification-consumed.v1',
            occurredAt: now,
            operation: 'verify-email',
            outcome: 'success',
          },
          now,
          token: fixture.verificationToken,
        });
        expect(Option.isNone(consumed)).toBe(true);

        // The row must survive the miss: without the fix it is already gone, and no later `detect`
        // can ever find the stale binding again.
        const remainingRows = yield* customVerificationRows(fixture);
        expect(remainingRows).toHaveLength(1);

        const conflict = yield* reconciliation.detect({
          operation: 'verify-email',
          token: fixture.verificationToken,
        });
        expect(conflict).toStrictEqual(
          Option.some({
            conflictClass: 'TOKEN_SUBJECT_STALE',
            outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED',
          }),
        );

        const reconciliationRows = yield* fixture.database.executor
          .select()
          .from(recoveryReconciliation)
          .where(eq(recoveryReconciliation.email, fixture.email));
        expect(reconciliationRows).toHaveLength(1);
        expect(reconciliationRows[0]?.conflictClass).toBe('TOKEN_SUBJECT_STALE');
        expect(reconciliationRows[0]?.providerSubjectId).toBe(fixture.userId);
        expect(reconciliationRows[0]?.currentProviderSubjectId).toBeNull();
      }),
    ),
);
