import { randomUUID } from 'node:crypto';

import { ResendEmailDeliveryConfig } from '@app/email-delivery/resend';
import { eq } from 'drizzle-orm';
import { Config, Effect, Layer, Redacted } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  commercePortalAuthRealmLive,
  makeCommerceCustomerContextApiRuntime,
  productionActionRuntimeLive,
  productionReadRuntimeLive,
} from '../../api/index.ts';
import { GatewayAssertionRedemptionLive } from '../../api/auth/gateway-assertion-redemption.ts';
import { makeCommercePortalAuth } from '../../api/portal-auth/provider/auth.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { makeCommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { session, user } from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import { acquireOutlivingCleanup } from '../../../../packages/core-runtime/tests/support/database.ts';

/**
 * The portal realm never answers a question it was not asked: runs against the real composition
 * root on the migrated `commerce_auth` schema; nothing here is a double.
 */

const ORIGIN = 'http://localhost:3020';
const SECRET = 'n'.repeat(64);
const PASSWORD = 'P'.repeat(24);

const providerDatabaseUrl = Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.Redacted('DATABASE_URL')),
);

const realmConfiguration = Effect.gen(function* realmConfiguration() {
  const databaseUrl = yield* providerDatabaseUrl;
  return yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(databaseUrl),
    COMMERCE_PORTAL_AUTH_SECRET: SECRET,
    COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: ORIGIN,
    COMMERCE_PORTAL_AUTH_URL: ORIGIN,
  });
});

/** The transport credentials are a required input of the provider graph; nothing here sends mail. */
const emailDeliveryConfiguration = Layer.succeed(ResendEmailDeliveryConfig, {
  apiKey: Redacted.make('re_commerce_portal_auth_non_enumeration_test'),
  endpoint: 'https://api.resend.com/emails',
  from: 'no-reply@commerce.example.test',
});

const configuredRuntime = Effect.acquireRelease(
  Effect.gen(function* buildConfiguredRuntime() {
    const configuration = yield* realmConfiguration;
    return makeCommerceCustomerContextApiRuntime(
      productionReadRuntimeLive,
      productionActionRuntimeLive,
      GatewayAssertionRedemptionLive,
      commercePortalAuthRealmLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(Layer.succeed(CommercePortalAuthConfig, configuration), emailDeliveryConfiguration),
        ),
      ),
      Layer.empty,
    ).createHandler();
  }),
  (runtime) => Effect.promise(async () => await runtime.dispose()),
);

interface EnrolledAccount {
  readonly email: string;
  readonly userId: string;
}

/**
 * One real portal account, created through the provider's own sign-up so the stored credential is
 * a genuine Better Auth password record rather than a row this test invented.
 */
const makeEnrolledAccount = Effect.fnUntraced(function* makeEnrolledAccount(
  caseName: string,
): Effect.fn.Return<EnrolledAccount, unknown, Scope.Scope> {
  const configuration = yield* realmConfiguration;
  const database = yield* acquireOutlivingCleanup(makeCommercePortalAuthDatabase(configuration));
  const email = `non-enumeration-${caseName}-${randomUUID()}@example.test`;
  const auth = yield* makeCommercePortalAuth({
    configuration,
    databaseAdapter: database.adapter,
    emailDelivery: {
      sendOTP: () => Promise.resolve(),
      sendResetPassword: () => Promise.resolve(),
      sendVerificationEmail: () => Promise.resolve(),
    },
  });
  yield* Effect.tryPromise({
    catch: (cause) => cause,
    try: async () =>
      await auth.api.signUpEmail({
        body: { email, name: 'Non-enumeration acceptance account', password: PASSWORD },
        headers: { origin: ORIGIN },
      }),
  });
  const rows = yield* database.executor.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  const enrolled = rows.at(0);
  if (enrolled === undefined) {
    return yield* Effect.fail(new Error('The non-enumeration fixture account was not persisted'));
  }
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* removeFixtureAccount() {
      yield* database.executor.delete(session).where(eq(session.userId, enrolled.id));
      yield* database.executor.delete(user).where(eq(user.id, enrolled.id));
    }).pipe(Effect.orDie),
  );
  return { email, userId: enrolled.id };
});

type CommerceApiHandler = Effect.Success<typeof configuredRuntime>;

const signInRequest = (email: string) =>
  new Request(`${ORIGIN}/api/portal-auth/sign-in/email`, {
    body: JSON.stringify({ email, password: 'W'.repeat(24) }),
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    method: 'POST',
  });

const requestPasswordReset = (email: string) =>
  new Request(`${ORIGIN}/api/portal-auth/request-password-reset`, {
    body: JSON.stringify({ email }),
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    method: 'POST',
  });

interface ObservedAnswer {
  readonly body: unknown;
  readonly contentType: string | null;
  readonly setCookie: readonly string[];
  readonly status: number;
}

const observe = (runtime: CommerceApiHandler, request: Request): Effect.Effect<ObservedAnswer> =>
  Effect.promise(async () => {
    const response = await runtime.handler(request);
    const body: unknown = await response.clone().json();
    return {
      body,
      contentType: response.headers.get('content-type'),
      setCookie: response.headers.getSetCookie(),
      status: response.status,
    };
  });

const SAMPLES = 3;

const sample = (runtime: CommerceApiHandler, request: () => Request) =>
  Effect.forEach([...Array.from({ length: SAMPLES }).keys()], () => observe(runtime, request()), { concurrency: 1 });

/** Every sampled answer must be byte-identical: a wall-clock floor is a flaky proxy for this. */
const sameOnEverySample = (answers: readonly ObservedAnswer[], expected: ObservedAnswer) =>
  answers.every(
    (answer) =>
      answer.status === expected.status &&
      answer.contentType === expected.contentType &&
      JSON.stringify(answer.body) === JSON.stringify(expected.body) &&
      JSON.stringify(answer.setCookie) === JSON.stringify(expected.setCookie),
  );

it.live('sign-in answers an unknown identifier exactly as it answers a known one', () =>
  Effect.scoped(
    Effect.gen(function* signInNonEnumeration() {
      const runtime = yield* configuredRuntime;
      const account = yield* makeEnrolledAccount('sign-in');
      const unknownEmail = `absent-${randomUUID()}@example.test`;

      const known = yield* sample(runtime, () => signInRequest(account.email));
      const unknown = yield* sample(runtime, () => signInRequest(unknownEmail));
      const [knownAnswer] = known;
      const [unknownAnswer] = unknown;
      if (knownAnswer === undefined || unknownAnswer === undefined) {
        yield* Effect.fail(new Error('The non-enumeration probe produced no answer'));
        return;
      }

      // The registered account answers a wrong password and the absent account answers an absent
      // identifier. Neither answer may distinguish the two.
      expect(knownAnswer.status).toBe(401);
      expect(unknownAnswer.status).toBe(knownAnswer.status);
      expect(unknownAnswer.contentType).toBe(knownAnswer.contentType);
      expect(unknownAnswer.body).toStrictEqual(knownAnswer.body);
      expect(knownAnswer.body).toMatchObject({ code: 'authentication_failed', status: 401 });
      // A rejected sign-in issues no session material on either path.
      expect(knownAnswer.setCookie).toStrictEqual([]);
      expect(unknownAnswer.setCookie).toStrictEqual([]);

      // An absent identifier must not short-circuit the credential-verification path: every
      // repeated attempt on both sides answers identically, not just the first.
      expect(sameOnEverySample(known, knownAnswer)).toBe(true);
      expect(sameOnEverySample(unknown, knownAnswer)).toBe(true);
    }),
  ),
);

it.live('a password-reset request answers an unknown identifier exactly as it answers a known one', () =>
  Effect.scoped(
    Effect.gen(function* recoveryNonEnumeration() {
      const runtime = yield* configuredRuntime;
      const account = yield* makeEnrolledAccount('recovery');
      const unknownEmail = `absent-${randomUUID()}@example.test`;

      const known = yield* observe(runtime, requestPasswordReset(account.email));
      const unknown = yield* observe(runtime, requestPasswordReset(unknownEmail));

      expect(unknown.status).toBe(known.status);
      expect(unknown.setCookie).toStrictEqual(known.setCookie);
      expect(unknown.contentType).toBe(known.contentType);
      expect(unknown.body).toStrictEqual(known.body);
      // Whatever the deployment's transport does next, the caller is told only that recovery
      // started — never whether the identifier named an account.
      expect(known.body).toStrictEqual({ outcome: 'ACCOUNT_RECOVERY_STARTED' });
    }),
  ),
);

it.live('a password-reset request answers an unknown identifier the same way on every attempt', () =>
  Effect.scoped(
    Effect.gen(function* recoveryRepeatedAttempts() {
      const runtime = yield* configuredRuntime;
      const account = yield* makeEnrolledAccount('recovery-repeated');

      const known = yield* sample(runtime, () => requestPasswordReset(account.email));
      const unknown = yield* sample(runtime, () => requestPasswordReset(`absent-${randomUUID()}@example.test`));
      const [knownAnswer] = known;
      if (knownAnswer === undefined) {
        yield* Effect.fail(new Error('The non-enumeration probe produced no answer'));
        return;
      }

      // An identifier that names no account must not short-circuit the recovery path on some
      // attempts and not others: every sample on both sides answers identically.
      expect(sameOnEverySample(known, knownAnswer)).toBe(true);
      expect(sameOnEverySample(unknown, knownAnswer)).toBe(true);
    }),
  ),
);
