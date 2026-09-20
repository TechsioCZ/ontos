import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { eq, inArray, like } from 'drizzle-orm';
import { Config, Context, Crypto, DateTime, Effect, Layer, Redacted, Result } from 'effect';
import { expect, it } from 'effect-rstest';
import type { Scope } from 'effect';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import { makeCommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { makeCommercePortalAuthAccountCreationCorrelation } from '../../src/portal-auth/persistence/portal-auth-account-correlation.ts';
import type { CommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import {
  rateLimit,
  recoveryReconciliation,
  session,
  user,
  verification,
} from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import { makeCommercePortalAuth } from '../../api/portal-auth/provider/auth.ts';
import { UNRESOLVED_PORTAL_AUTH_CLIENT_KEY } from '../../api/portal-auth/http-transport.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { COMMERCE_PORTAL_AUTH_POLICY, parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { makeCommercePortalAuthRecoveryProvider } from '../../api/portal-auth/provider/recovery/provider-service.ts';
import {
  CommercePortalAuthRecoveryProviderService,
  CommercePortalAuthRecoveryRateLimitService,
  CommercePortalAuthRecoveryReconciliationService,
  CommercePortalAuthRecoveryService as CommercePortalAuthRecoveryServiceTag,
  CommercePortalAuthRecoveryStoreService,
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

const ORIGIN = 'https://portal.example.test';
const EMAIL = 'recovery-integration@example.test';
const ORIGINAL_PASSWORD = 'P'.repeat(24);
const REPLACEMENT_PASSWORD = 'R'.repeat(24);
const SECRET = 's'.repeat(64);
const DATABASE_URL = Config.redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.redacted('DATABASE_URL')),
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
  const database = yield* makeCommercePortalAuthDatabase(configuration);
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
    accountCorrelation: makeCommercePortalAuthAccountCreationCorrelation(database.executor),
    configuration,
    databaseAdapter: database.adapter,
    emailDelivery,
  });
  yield* Effect.tryPromise({
    catch: (cause) => cause,
    try: () =>
      auth.api.signUpEmail({
        body: { email, name: 'Recovery integration fixture', password },
        headers: { origin: ORIGIN, 'x-forwarded-for': ip },
      }),
  });
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
