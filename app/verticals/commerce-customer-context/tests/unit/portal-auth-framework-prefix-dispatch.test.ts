import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import {
  HttpApi,
  HttpApiBuilder,
  HttpRouter,
  HttpServer,
  dispatchEffectBffRequest,
} from '@modern-js/bff-effect/effect-edge';
import { Context, Effect, Layer, Option, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import {
  CommercePortalAuthRecoveryProviderService,
  CommercePortalAuthRecoveryReconciliationService,
  CommercePortalAuthRecoveryService,
  CommercePortalAuthRecoveryStoreService,
  makeCommercePortalAuthRecoveryService,
  portalAuthRecoveryApiLive,
} from '../../api/portal-auth/provider/recovery/index.ts';
import {
  makeCommercePortalAuthRecoveryProvider,
  makeCommercePortalAuthRecoveryRateLimit,
} from '../../api/portal-auth/provider/recovery/provider-service.ts';
import { CommercePortalAuthRecoveryRateLimitService } from '../../api/portal-auth/rate-limit-service.ts';
import type { CommercePortalAuthRecoveryStore } from '../../api/portal-auth/provider/recovery/index.ts';
import { makeCommercePortalAuthOptions } from '../../api/portal-auth/provider/auth.ts';
import type { CommercePortalAuthEmailDelivery } from '../../api/portal-auth/provider/auth.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { CommercePortalAuthRecoveryApi } from '../../shared/portal-auth/recovery-api.ts';
import {
  COMMERCE_CUSTOMER_CONTEXT_API_PREFIX,
  COMMERCE_PORTAL_AUTH_PUBLIC_BASE_PATH,
} from '../../shared/deployment-paths.ts';
import { unauditedCommercePortalAuthRecorder } from '../../src/portal-auth/audit/audit.ts';

const ORIGIN = 'https://portal.example.test';
const EMAIL = 'framework-prefix-owner@example.test';
const PASSWORD = 'P'.repeat(24);
const SUBJECT = 'commerce-user-framework-prefix';

const recoveryTransportApi = HttpApi.make('CommerceCustomerContextApi').addHttpApi(CommercePortalAuthRecoveryApi);
const transportContext = Context.makeUnsafe<unknown>(new Map());

const portalConfiguration = parseCommercePortalAuthConfig({
  COMMERCE_PORTAL_AUTH_DATABASE_URL: 'postgresql://commerce:secret@example.test/commerce_auth',
  COMMERCE_PORTAL_AUTH_SECRET: 's'.repeat(64),
  COMMERCE_PORTAL_AUTH_URL: ORIGIN,
});

const makeMemoryAuth = (emailDelivery: CommercePortalAuthEmailDelivery) =>
  Effect.gen(function* makeMemoryAuthEffect() {
    const configuration = yield* portalConfiguration;
    const options = yield* makeCommercePortalAuthOptions({
      // This realm creates no account through the private port, so nothing carries a correlation
      // and nothing may be recorded: a write here would mean the hook lost its governed identity.
      accountCorrelation: { record: () => Effect.die('no account creation belongs to this dispatch test') },
      configuration,
      databaseAdapter: drizzleAdapter({}, { provider: 'pg' }),
      emailDelivery,
    });
    const database = { account: [], rateLimit: [], session: [], user: [], verification: [] };
    return betterAuth({ ...options, database: memoryAdapter(database) });
  });

it.effect('serves prefixed recovery routes through the owner group and rejects a foreign prefix', () =>
  Effect.gen(function* frameworkPrefixRecovery() {
    const verificationURLs: string[] = [];
    const resetURLs: string[] = [];
    let consumedToken: string | undefined;
    const emailDelivery: CommercePortalAuthEmailDelivery = {
      sendOTP: () => Promise.resolve(),
      sendResetPassword: ({ url }) => {
        resetURLs.push(url);
        return Promise.resolve();
      },
      sendVerificationEmail: ({ url }) => {
        verificationURLs.push(url);
        return Promise.resolve();
      },
    };
    const auth = yield* makeMemoryAuth(emailDelivery);
    const configuration = yield* portalConfiguration;
    // The owner ledger owns the recovery budget, so the fake counts the same way the deployment's
    // durable counter does: one shared tally per key, refused once the rule's window is spent.
    const budget = new Map<string, number>();
    const store: CommercePortalAuthRecoveryStore = {
      accountExists: () => Effect.die('unused: this test substitutes reconciliation.detect directly'),
      consumeEmailVerification: ({ token }) =>
        Effect.sync(() => {
          consumedToken = Redacted.value(token);
          return Option.some(SUBJECT);
        }),
      consumePasswordResetLedger: () => Effect.die('unused: this test drives email verification only'),
      consumeRateLimitBudget: ({ key, rule }) =>
        Effect.sync(() => {
          const spent = (budget.get(key) ?? 0) + 1;
          budget.set(key, spent);
          return spent <= rule.max;
        }),
      findAccountSubjectForEmail: () => Effect.die('unused: this test substitutes reconciliation.detect directly'),
      // Read by the evidence path, not by detection: the verify route names the ledger subject on
      // its intent row. This route's ledger holds no binding for the token the test submits.
      peekEmailVerificationLedger: () => Effect.succeed(Option.none()),
      peekPasswordResetLedger: () => Effect.die('unused: this test substitutes reconciliation.detect directly'),
      recordRecoveryReconciliation: () => Effect.die('unused: this test substitutes reconciliation.detect directly'),
      registerEmailVerificationToken: () => Effect.succeed(true),
      registerPasswordResetToken: () => Effect.die('unused: this test substitutes reconciliation.detect directly'),
      reserveEmailVerificationSubject: () => Effect.succeed(true),
    };
    // This test substitutes reconciliation.detect directly, so the store's *detection* methods are
    // never called: they exist here only to satisfy the interface.
    const reconciliation = { detect: () => Effect.succeed(Option.none()) };
    const recovery = yield* makeCommercePortalAuthRecoveryService(unauditedCommercePortalAuthRecorder).pipe(
      Effect.provideService(CommercePortalAuthRecoveryProviderService, makeCommercePortalAuthRecoveryProvider(auth)),
      Effect.provideService(CommercePortalAuthRecoveryReconciliationService, reconciliation),
      Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
    );
    const apiLayer = HttpApiBuilder.layer(recoveryTransportApi).pipe(
      Layer.provide(portalAuthRecoveryApiLive),
      Layer.provide(Layer.succeed(CommercePortalAuthRecoveryService, recovery)),
      // The owner store backs the budget, exactly as the deployment spends it.
      Layer.provide(
        Layer.succeed(CommercePortalAuthRecoveryRateLimitService, makeCommercePortalAuthRecoveryRateLimit(store)),
      ),
      Layer.provide(Layer.succeed(CommercePortalAuthConfig, configuration)),
      Layer.provide(HttpServer.layerServices),
    );
    const app = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(apiLayer, { disableLogger: true })),
      (handler) => Effect.promise(handler.dispose.bind(handler)).pipe(Effect.orDie),
    );
    const dispatchThroughModern = (request: Request) =>
      Effect.promise(() =>
        dispatchEffectBffRequest((mounted) => app.handler(mounted, transportContext), request, {
          prefix: COMMERCE_CUSTOMER_CONTEXT_API_PREFIX,
        }),
      );

    yield* Effect.promise(() =>
      auth.api.signUpEmail({
        body: { email: EMAIL, name: 'Framework Prefix Owner', password: PASSWORD },
        headers: { origin: ORIGIN },
      }),
    );
    const verificationURL = verificationURLs.at(0);
    if (verificationURL === undefined) {
      return yield* Effect.fail(new Error('Better Auth did not capture a verification URL'));
    }
    expect(new URL(verificationURL).pathname).toBe(`${COMMERCE_PORTAL_AUTH_PUBLIC_BASE_PATH}/verify-email`);

    const resetResponse = yield* dispatchThroughModern(
      new Request(`${ORIGIN}${COMMERCE_PORTAL_AUTH_PUBLIC_BASE_PATH}/request-password-reset`, {
        body: JSON.stringify({ email: EMAIL }),
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        method: 'POST',
      }),
    );
    expect(resetResponse.status).toBe(200);
    expect(yield* Effect.promise(resetResponse.json.bind(resetResponse))).toStrictEqual({
      outcome: 'ACCOUNT_RECOVERY_STARTED',
    });
    const resetURL = resetURLs.at(0);
    if (resetURL === undefined) {
      return yield* Effect.fail(new Error('Better Auth did not capture a reset URL'));
    }
    expect(new URL(resetURL).pathname.startsWith(`${COMMERCE_PORTAL_AUTH_PUBLIC_BASE_PATH}/reset-password/`)).toBe(
      true,
    );

    const wrongPrefixResponse = yield* dispatchThroughModern(
      new Request(`${ORIGIN}/foreign-prefix/api/portal-auth/request-password-reset`, {
        body: JSON.stringify({ email: EMAIL }),
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        method: 'POST',
      }),
    );
    expect(wrongPrefixResponse.status).toBe(404);
    expect(resetURLs).toHaveLength(1);

    const resetCallbackResponse = yield* dispatchThroughModern(new Request(resetURL));
    expect(resetCallbackResponse.status).toBe(200);
    expect(yield* Effect.promise(resetCallbackResponse.json.bind(resetCallbackResponse))).toStrictEqual({
      outcome: 'PASSWORD_RESET_PENDING',
    });

    const verificationResponse = yield* dispatchThroughModern(new Request(verificationURL));
    expect(verificationResponse.status).toBe(200);
    expect(yield* Effect.promise(verificationResponse.json.bind(verificationResponse))).toStrictEqual({
      outcome: 'EMAIL_VERIFICATION_COMPLETED_SAME_SUBJECT',
    });
    expect(consumedToken).toBe(new URL(verificationURL).searchParams.get('token'));
    return yield* Effect.void;
  }),
);
