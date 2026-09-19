import { createHmac } from 'node:crypto';

import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Context, DateTime, Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { COMMERCE_PORTAL_AUTH_INTERNAL_BASE_PATH } from '../../shared/deployment-paths.ts';
import type {
  CommercePortalAuthEmailVerificationTokenRegistration,
  CommercePortalAuthRecoveryProvider,
  CommercePortalAuthRecoveryStore,
} from '../../api/portal-auth/provider/recovery/index.ts';
import type { CommercePortalAuthEmailDelivery } from '../../api/portal-auth/provider/auth.ts';
import {
  CommercePortalAuthRecoveryUnavailable,
  CommercePortalAuthRecoveryProviderService,
  CommercePortalAuthRecoveryReconciliationService,
  CommercePortalAuthRecoveryRejected,
  CommercePortalAuthRecoveryService,
  CommercePortalAuthRecoveryStoreService,
  makeCommercePortalAuthEmailDelivery,
  makeCommercePortalAuthRecoveryReconciliation,
  makeCommercePortalAuthRecoveryRateLimit,
  makeCommercePortalAuthRecoveryService,
  portalAuthRecoveryApiLive,
} from '../../api/portal-auth/provider/recovery/index.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { COMMERCE_PORTAL_AUTH_POLICY, parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { UNRESOLVED_PORTAL_AUTH_CLIENT_KEY } from '../../api/portal-auth/http-transport.ts';
import { CommercePortalAuthRecoveryRateLimitService } from '../../api/portal-auth/rate-limit-service.ts';
import type { CommercePortalAuthRecoveryRateLimit } from '../../api/portal-auth/rate-limit-service.ts';
import {
  commercePortalAuthRecoveryInvalidCallbackProblem,
  commercePortalAuthRecoveryInvalidProblem,
  commercePortalAuthRecoveryUntrustedOriginProblem,
} from '../../api/portal-auth/provider/recovery/problems.ts';
import {
  CommercePortalAuthRecoveryApi,
  CommercePortalAuthRecoveryForbiddenProblemSchema,
  CommercePortalAuthRecoveryInvalidProblemSchema,
} from '../../shared/portal-auth/recovery-api.ts';

const EMAIL = 'customer@example.test';
const BYSTANDER_EMAIL = 'bystander@example.test';
const ORIGIN = 'https://portal.example.test';
const SECRET = 's'.repeat(64);
const ORIGINAL_SUBJECT = 'commerce-user-original';
const REPLACEMENT_SUBJECT = 'commerce-user-replacement';
const VERIFICATION_TOKEN = Redacted.make('verification-token');
const VERIFICATION_TOKEN_EXPIRES_AT = new Date('2099-01-01T00:00:00.000Z');

interface MemoryRecoveryStoreFixture {
  /** Every key the transport spent against, in order: the key *is* the isolation invariant. */
  readonly budgetKeys: () => readonly string[];
  readonly replaceEmail: (email: string) => void;
  readonly replaceSubject: (providerSubjectId: string) => void;
  readonly store: CommercePortalAuthRecoveryStore;
}

const epochMillis = (value: Date): number => {
  const date = DateTime.make(value);
  return Option.isSome(date) ? DateTime.toEpochMillis(date.value) : Number.NaN;
};

const makeMemoryRecoveryStore = (
  initialSubject: string = ORIGINAL_SUBJECT,
  initialEmail: string = EMAIL,
): MemoryRecoveryStoreFixture => {
  let currentEmail = initialEmail;
  let currentSubject = initialSubject;
  let currentVerified = false;
  let reservationSubject: string | null = null;
  let token: Redacted.Redacted | null = null;
  let tokenExpiresAt: Date | null = null;
  let tokenSubject: string | null = null;
  let tokenEmail: string | null = null;
  const spentBudgets = new Map<string, number>();

  const replaceEmail = (email: string): void => {
    currentEmail = email;
    currentVerified = false;
  };

  const replaceSubject = (providerSubjectId: string): void => {
    currentSubject = providerSubjectId;
    currentVerified = false;
  };

  const store: CommercePortalAuthRecoveryStore = {
    consumeEmailVerification: (input) =>
      Effect.sync(() => {
        if (
          token === null ||
          tokenSubject === null ||
          tokenEmail === null ||
          tokenExpiresAt === null ||
          Redacted.value(token) !== Redacted.value(input.token) ||
          epochMillis(tokenExpiresAt) <= epochMillis(input.now)
        ) {
          return Option.none<string>();
        }
        const consumedSubject = tokenSubject;
        const consumedEmail = tokenEmail;
        token = null;
        tokenExpiresAt = null;
        tokenSubject = null;
        tokenEmail = null;
        if (consumedSubject !== currentSubject || consumedEmail !== currentEmail.toLowerCase() || currentVerified) {
          return Option.none<string>();
        }
        currentVerified = true;
        return Option.some(consumedSubject);
      }),
    consumeRateLimitBudget: (input) =>
      Effect.sync(() => {
        const counted = spentBudgets.get(input.key) ?? 0;
        if (counted >= input.rule.max) {
          return false;
        }
        spentBudgets.set(input.key, counted + 1);
        return true;
      }),
    registerEmailVerificationToken: (
      input: CommercePortalAuthEmailVerificationTokenRegistration & { readonly expiresAt: Date },
    ) =>
      Effect.sync(() => {
        if (input.email.toLowerCase() !== currentEmail.toLowerCase() || input.providerSubjectId !== currentSubject) {
          return false;
        }
        if (reservationSubject !== null && reservationSubject !== input.providerSubjectId) {
          return false;
        }
        const { expiresAt, providerSubjectId, token: registeredToken } = input;
        reservationSubject = null;
        token = registeredToken;
        tokenExpiresAt = expiresAt;
        tokenSubject = providerSubjectId;
        tokenEmail = input.email.toLowerCase();
        return true;
      }),
    reserveEmailVerificationSubject: (input) =>
      Effect.sync(() => {
        if (
          currentVerified ||
          input.email.toLowerCase() !== currentEmail.toLowerCase() ||
          input.providerSubjectId !== currentSubject
        ) {
          return false;
        }
        reservationSubject = input.providerSubjectId;
        return true;
      }),
  };

  return { budgetKeys: () => [...spentBudgets.keys()], replaceEmail, replaceSubject, store };
};

const successfulProvider = (): CommercePortalAuthRecoveryProvider => ({
  requestPasswordReset: () => Effect.succeed({ message: 'If the account exists, an email was sent.', status: true }),
  resetPassword: () => Effect.succeed({ status: true }),
  sendVerificationEmail: () => Effect.succeed({ status: true }),
});

const verificationEmailData = {
  token: Redacted.value(VERIFICATION_TOKEN),
  url: 'https://portal.example.test/api/portal-auth/verify-email?token=verification-token',
  user: {
    createdAt: new Date(0),
    email: EMAIL,
    emailVerified: false,
    id: ORIGINAL_SUBJECT,
    image: null,
    name: 'Recovery callback user',
    updatedAt: new Date(0),
  },
} satisfies Parameters<CommercePortalAuthEmailDelivery['sendVerificationEmail']>[0];

const resetPasswordEmailData = {
  token: 'reset-callback-token',
  url: 'https://portal.example.test/api/portal-auth/reset-password?token=reset-callback-token',
  user: {
    createdAt: new Date(0),
    email: EMAIL,
    emailVerified: false,
    id: ORIGINAL_SUBJECT,
    image: null,
    name: 'Recovery callback user',
    updatedAt: new Date(0),
  },
} satisfies Parameters<CommercePortalAuthEmailDelivery['sendResetPassword']>[0];

/**
 * The reconciliation collaborator is wired for real here (store-backed, not a stub) so every test
 * — including the hook-wiring tests below — exercises the same composition production uses. Most
 * fixture stores in this file implement only the four base methods, so `detect()` degrades to no
 * conflict for them, exactly as it did before reconciliation existed; the hook-wiring tests below
 * add the optional evidence methods to prove detection actually runs and is honored.
 */
const runWithRecovery = <Value>(
  provider: CommercePortalAuthRecoveryProvider,
  store: CommercePortalAuthRecoveryStore,
  invoke: (service: CommercePortalAuthRecoveryService['Service']) => Effect.Effect<Value, unknown>,
) =>
  makeCommercePortalAuthRecoveryService().pipe(
    Effect.provideService(CommercePortalAuthRecoveryProviderService, provider),
    Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
    Effect.provideServiceEffect(
      CommercePortalAuthRecoveryReconciliationService,
      makeCommercePortalAuthRecoveryReconciliation().pipe(
        Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
      ),
    ),
    Effect.flatMap(invoke),
  );

/**
 * The group is mounted on an API carrying the MicroVertical identifier so the recovery routes are
 * driven exactly as the composition root serves them, without the rest of the owner contract.
 */
const recoveryTransportApi = HttpApi.make('CommerceCustomerContextApi').addHttpApi(CommercePortalAuthRecoveryApi);
const transportContext = Context.makeUnsafe<unknown>(new Map());
const recoveryConfiguration = parseCommercePortalAuthConfig({
  COMMERCE_PORTAL_AUTH_DATABASE_URL: 'postgresql://commerce:secret@example.test/commerce_auth',
  COMMERCE_PORTAL_AUTH_SECRET: SECRET,
  COMMERCE_PORTAL_AUTH_URL: ORIGIN,
});

/**
 * The deployment derives this budget from the recovery store, so the transport is driven through
 * the same factory the composition root provides; the fixture store keeps that contract — one
 * budget per key, shared by every holder of the store — without a database.
 */
const makeRecoveryTransport = (
  recovery: CommercePortalAuthRecoveryService['Service'],
  rateLimit: CommercePortalAuthRecoveryRateLimit = makeCommercePortalAuthRecoveryRateLimit(
    makeMemoryRecoveryStore().store,
  ),
) =>
  Effect.gen(function* makeRecoveryTransportEffect() {
    const configuration = yield* recoveryConfiguration;
    const apiLayer = HttpApiBuilder.layer(recoveryTransportApi).pipe(
      Layer.provide(portalAuthRecoveryApiLive),
      Layer.provide(Layer.succeed(CommercePortalAuthRecoveryService, recovery)),
      Layer.provide(Layer.succeed(CommercePortalAuthRecoveryRateLimitService, rateLimit)),
      Layer.provide(Layer.succeed(CommercePortalAuthConfig, configuration)),
      Layer.provide(HttpServer.layerServices),
    );
    return yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(apiLayer, { disableLogger: true })),
      (handler) => Effect.promise(handler.dispose.bind(handler)).pipe(Effect.orDie),
    );
  });

const recoveryRoute = (route: string): string => `${ORIGIN}${COMMERCE_PORTAL_AUTH_INTERNAL_BASE_PATH}${route}`;

/**
 * The durable budget key the transport spends for one recovery subject, recomputed here from the
 * same deployment secret `provider/recovery/http.ts` keys it under. The subject half is what keeps
 * one caller from denying recovery to everybody: this transport is a web handler with no socket
 * peer, so `resolveClientKey` answers the same unattributable value for every request and a
 * client-only key would be a single deployment-wide counter per route.
 */
const recoveryBudgetKey = (subject: string, route: string): string =>
  `${UNRESOLVED_PORTAL_AUTH_CLIENT_KEY}|${createHmac('sha256', SECRET).update(subject).digest('base64url')}|${route}`;

it.effect('rejects verification resend for a different subject before provider delivery', () => {
  let providerCalls = 0;
  const provider: CommercePortalAuthRecoveryProvider = {
    ...successfulProvider(),
    sendVerificationEmail: () =>
      Effect.sync(() => {
        providerCalls += 1;
        return { status: true };
      }),
  };
  const fixture = makeMemoryRecoveryStore();
  fixture.replaceSubject(REPLACEMENT_SUBJECT);
  return runWithRecovery(provider, fixture.store, (service) =>
    service.requestEmailVerification({ email: EMAIL, providerSubjectId: ORIGINAL_SUBJECT }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(CommercePortalAuthRecoveryRejected);
            if (Schema.is(CommercePortalAuthRecoveryRejected)(result.failure)) {
              expect(result.failure.code).toBe('INVALID_SUBJECT');
            }
          }
          expect(providerCalls).toBe(0);
        }),
      ),
    ),
  );
});

it.effect('consumes a verification token once after binding it to the reserved subject', () => {
  let providerCalls = 0;
  const provider: CommercePortalAuthRecoveryProvider = {
    ...successfulProvider(),
    sendVerificationEmail: () =>
      Effect.sync(() => {
        providerCalls += 1;
        return { status: true };
      }),
  };
  const fixture = makeMemoryRecoveryStore();
  return runWithRecovery(provider, fixture.store, (service) =>
    Effect.gen(function* verificationLifecycle() {
      const requested = yield* service.requestEmailVerification({
        email: EMAIL,
        providerSubjectId: ORIGINAL_SUBJECT,
      });
      expect(requested.outcome).toBe('EMAIL_VERIFICATION_STARTED');
      expect(providerCalls).toBe(1);

      yield* service.registerEmailVerificationToken({
        email: EMAIL,
        providerSubjectId: ORIGINAL_SUBJECT,
        token: VERIFICATION_TOKEN,
      });
      const verified = yield* service.verifyEmail({ token: VERIFICATION_TOKEN });
      expect(verified.outcome).toBe('EMAIL_VERIFICATION_COMPLETED_SAME_SUBJECT');

      const replay = yield* Effect.result(service.verifyEmail({ token: VERIFICATION_TOKEN }));
      expect(Result.isFailure(replay)).toBe(true);
      if (Result.isFailure(replay)) {
        expect(replay.failure).toBeInstanceOf(CommercePortalAuthRecoveryRejected);
        if (Schema.is(CommercePortalAuthRecoveryRejected)(replay.failure)) {
          expect(replay.failure.code).toBe('INVALID_TOKEN');
        }
      }
    }),
  );
});

it.effect('rejects a token after the provider identifier is replaced', () => {
  const fixture = makeMemoryRecoveryStore();
  return runWithRecovery(successfulProvider(), fixture.store, (service) =>
    Effect.gen(function* replacementLifecycle() {
      yield* service.registerEmailVerificationToken({
        email: EMAIL,
        providerSubjectId: ORIGINAL_SUBJECT,
        token: VERIFICATION_TOKEN,
      });
      fixture.replaceSubject(REPLACEMENT_SUBJECT);

      const result = yield* Effect.result(service.verifyEmail({ token: VERIFICATION_TOKEN }));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(CommercePortalAuthRecoveryRejected);
        if (Schema.is(CommercePortalAuthRecoveryRejected)(result.failure)) {
          expect(result.failure.code).toBe('INVALID_TOKEN');
        }
      }
    }),
  );
});

it.effect('rejects a token after the same provider subject changes email', () => {
  const fixture = makeMemoryRecoveryStore();
  return runWithRecovery(successfulProvider(), fixture.store, (service) =>
    Effect.gen(function* emailReplacementLifecycle() {
      yield* service.registerEmailVerificationToken({
        email: EMAIL,
        providerSubjectId: ORIGINAL_SUBJECT,
        token: VERIFICATION_TOKEN,
      });
      fixture.replaceEmail('replacement@example.test');

      const result = yield* Effect.result(service.verifyEmail({ token: VERIFICATION_TOKEN }));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(CommercePortalAuthRecoveryRejected);
        if (Schema.is(CommercePortalAuthRecoveryRejected)(result.failure)) {
          expect(result.failure.code).toBe('INVALID_TOKEN');
        }
      }
    }),
  );
});

it.effect(
  'registers verification before delivery, passes OTP through unchanged, and delegates reset through the ledger wrapper',
  () => {
    const events: string[] = [];
    const fixture = makeMemoryRecoveryStore();
    const raw: CommercePortalAuthEmailDelivery = {
      sendOTP: () => Promise.resolve(),
      sendResetPassword: (data) => {
        events.push(`reset:${data.token}`);
        return Promise.resolve();
      },
      sendVerificationEmail: () => {
        events.push('delivered');
        return Promise.resolve();
      },
    };
    const store: CommercePortalAuthRecoveryStore = {
      ...fixture.store,
      registerEmailVerificationToken: (input) =>
        fixture.store.registerEmailVerificationToken(input).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              events.push('registered');
            }),
          ),
        ),
    };
    return makeCommercePortalAuthEmailDelivery(raw).pipe(
      Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
      Effect.flatMap((delivery) =>
        Effect.tryPromise({
          catch: (cause) => cause,
          try: () => delivery.sendVerificationEmail(verificationEmailData),
        }).pipe(
          Effect.flatMap(() =>
            Effect.tryPromise({
              catch: (cause) => cause,
              // The fixture store does not implement the optional reset-password ledger method,
              // so this exercises the documented degrade-gracefully path: delivery proceeds
              // straight through to the raw callback without registering anything.
              try: () => delivery.sendResetPassword(resetPasswordEmailData),
            }),
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              // OTP is never wrapped for a ledger: the raw reference is preserved exactly.
              expect(delivery.sendOTP).toBe(raw.sendOTP);
              expect(events).toStrictEqual(['registered', 'delivered', `reset:${resetPasswordEmailData.token}`]);
            }),
          ),
        ),
      ),
    );
  },
);

it.effect('propagates a verification delivery failure after recording its binding', () => {
  const events: string[] = [];
  const fixture = makeMemoryRecoveryStore();
  const deliveryFailure = new Error('delivery failed');
  const raw: CommercePortalAuthEmailDelivery = {
    sendOTP: () => Promise.resolve(),
    sendResetPassword: () => Promise.resolve(),
    sendVerificationEmail: () => {
      events.push('delivered');
      return Promise.reject(deliveryFailure);
    },
  };
  const store: CommercePortalAuthRecoveryStore = {
    ...fixture.store,
    registerEmailVerificationToken: (input) =>
      fixture.store.registerEmailVerificationToken(input).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            events.push('registered');
          }),
        ),
      ),
  };
  return makeCommercePortalAuthEmailDelivery(raw).pipe(
    Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
    Effect.flatMap((delivery) =>
      Effect.tryPromise({
        catch: (cause) => cause,
        try: () => delivery.sendVerificationEmail(verificationEmailData),
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(Result.isFailure(result)).toBe(true);
            expect(events).toStrictEqual(['registered', 'delivered']);
          }),
        ),
      ),
    ),
  );
});

it.effect('stops verification delivery when ledger registration fails', () => {
  let providerCalls = 0;
  const fixture = makeMemoryRecoveryStore();
  const raw: CommercePortalAuthEmailDelivery = {
    sendOTP: () => Promise.resolve(),
    sendResetPassword: () => Promise.resolve(),
    sendVerificationEmail: () => {
      providerCalls += 1;
      return Promise.resolve();
    },
  };
  const store: CommercePortalAuthRecoveryStore = {
    ...fixture.store,
    registerEmailVerificationToken: () =>
      Effect.fail(
        new CommercePortalAuthRecoveryUnavailable({
          operation: 'verification-token-register',
          reason: 'test registration failure',
        }),
      ),
  };
  return makeCommercePortalAuthEmailDelivery(raw).pipe(
    Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
    Effect.flatMap((delivery) =>
      Effect.tryPromise({
        catch: (cause) => cause,
        try: () => delivery.sendVerificationEmail(verificationEmailData),
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(Result.isFailure(result)).toBe(true);
            expect(providerCalls).toBe(0);
          }),
        ),
      ),
    ),
  );
});

it.effect('unwraps reset credentials only at the provider boundary and returns a subject-free outcome', () => {
  let receivedPassword: Redacted.Redacted | null = null;
  let receivedToken: Redacted.Redacted | null = null;
  const provider: CommercePortalAuthRecoveryProvider = {
    ...successfulProvider(),
    resetPassword: (input) =>
      input === undefined
        ? Effect.succeed({ status: true })
        : Effect.sync(() => {
            const { body } = input;
            receivedPassword = Redacted.make(body.newPassword);
            if (body.token !== undefined) {
              receivedToken = Redacted.make(body.token);
            }
            return { status: true };
          }),
  };
  const fixture = makeMemoryRecoveryStore();
  return runWithRecovery(provider, fixture.store, (service) =>
    service.resetPassword({ newPassword: Redacted.make('P'.repeat(24)), token: Redacted.make('reset-token') }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toStrictEqual({ outcome: 'ACCOUNT_RECOVERY_COMPLETED_SAME_SUBJECT' });
          expect(receivedPassword === null ? undefined : Redacted.value(receivedPassword)).toBe('P'.repeat(24));
          expect(receivedToken === null ? undefined : Redacted.value(receivedToken)).toBe('reset-token');
          expect('providerSubjectId' in result).toBe(false);
        }),
      ),
    ),
  );
});

/**
 * Reconciliation runs before the provider ever sees the reset token: a rebound identifier is
 * terminal, and the token must be left unspent for the same reason the callback route already
 * treats it as sensitive — a reconciliation-required outcome is not a completed reset.
 */
it.effect('returns reconciliation-required and never spends the reset token when the identifier was rebound', () => {
  let resetCalls = 0;
  const fixture = makeMemoryRecoveryStore();
  const provider: CommercePortalAuthRecoveryProvider = {
    ...successfulProvider(),
    resetPassword: () =>
      Effect.sync(() => {
        resetCalls += 1;
        return { status: true };
      }),
  };
  const store: CommercePortalAuthRecoveryStore = {
    ...fixture.store,
    accountExists: () => Effect.succeed(true),
    findAccountSubjectForEmail: () => Effect.succeed(Option.some(REPLACEMENT_SUBJECT)),
    peekPasswordResetLedger: () => Effect.succeed(Option.some({ email: EMAIL, providerSubjectId: ORIGINAL_SUBJECT })),
    recordRecoveryReconciliation: () => Effect.void,
  };
  return runWithRecovery(provider, store, (service) =>
    service.resetPassword({ newPassword: Redacted.make('P'.repeat(24)), token: Redacted.make('reset-token') }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toStrictEqual({
            conflictClass: 'IDENTIFIER_REBOUND',
            outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED',
          });
          // Terminal before any token is spent: the provider that would consume it is never reached.
          expect(resetCalls).toBe(0);
        }),
      ),
    ),
  );
});

/**
 * Same terminal contract for email verification: a conflict must be found before the ledger token
 * is consumed, so a reconciliation-required outcome never restores access or marks the account
 * verified.
 */
it.effect(
  'returns reconciliation-required and never consumes the verification ledger when the subject was rebound',
  () => {
    let consumeCalls = 0;
    const fixture = makeMemoryRecoveryStore();
    const store: CommercePortalAuthRecoveryStore = {
      ...fixture.store,
      accountExists: () => Effect.succeed(true),
      consumeEmailVerification: () =>
        Effect.sync(() => {
          consumeCalls += 1;
          return Option.none<string>();
        }),
      findAccountSubjectForEmail: () => Effect.succeed(Option.some(REPLACEMENT_SUBJECT)),
      peekEmailVerificationLedger: () =>
        Effect.succeed(Option.some({ email: EMAIL, providerSubjectId: ORIGINAL_SUBJECT })),
      recordRecoveryReconciliation: () => Effect.void,
    };
    return runWithRecovery(successfulProvider(), store, (service) =>
      service.verifyEmail({ token: VERIFICATION_TOKEN }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result).toStrictEqual({
              conflictClass: 'VERIFICATION_LEDGER_SUBJECT_MISMATCH',
              outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED',
            });
            // No session change: the ledger token that would flip the account to verified is
            // never consumed, so no subject is ever bound by this call.
            expect(consumeCalls).toBe(0);
          }),
        ),
      ),
    );
  },
);

it.effect('serves only the declared recovery routes and keeps the verification route provider-free', () => {
  let resetCalls = 0;
  const fixture = makeMemoryRecoveryStore();
  const provider: CommercePortalAuthRecoveryProvider = {
    ...successfulProvider(),
    resetPassword: () =>
      Effect.sync(() => {
        resetCalls += 1;
        return { status: true };
      }),
  };
  return Effect.gen(function* declaredRecoveryRoutes() {
    const recovery = yield* runWithRecovery(provider, fixture.store, (service) => Effect.succeed(service));
    // The transport runs on the platform clock, so the ledger entry is seeded with a wall-clock expiry.
    expect(
      yield* fixture.store.registerEmailVerificationToken({
        email: EMAIL,
        expiresAt: VERIFICATION_TOKEN_EXPIRES_AT,
        providerSubjectId: ORIGINAL_SUBJECT,
        token: VERIFICATION_TOKEN,
      }),
    ).toBe(true);
    const app = yield* makeRecoveryTransport(recovery);

    const verification = yield* Effect.promise(() =>
      app.handler(
        new Request(
          `${recoveryRoute('/verify-email')}?token=${encodeURIComponent(Redacted.value(VERIFICATION_TOKEN))}`,
        ),
        transportContext,
      ),
    );
    expect(verification.status).toBe(200);
    expect(verification.headers.get('cache-control')).toBe('no-store');
    expect(verification.headers.get('pragma')).toBe('no-cache');
    expect(yield* Effect.promise(verification.json.bind(verification))).toStrictEqual({
      outcome: 'EMAIL_VERIFICATION_COMPLETED_SAME_SUBJECT',
    });
    expect(resetCalls).toBe(0);

    const reset = yield* Effect.promise(() =>
      app.handler(
        new Request(recoveryRoute('/reset-password'), {
          body: JSON.stringify({ newPassword: 'P'.repeat(24), token: 'reset-token' }),
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          method: 'POST',
        }),
        transportContext,
      ),
    );
    expect(reset.status).toBe(200);
    expect(yield* Effect.promise(reset.json.bind(reset))).toStrictEqual({
      outcome: 'ACCOUNT_RECOVERY_COMPLETED_SAME_SUBJECT',
    });
    expect(resetCalls).toBe(1);

    const signUp = yield* Effect.promise(() =>
      app.handler(
        new Request(recoveryRoute('/sign-up/email'), {
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          method: 'POST',
        }),
        transportContext,
      ),
    );
    expect(signUp.status).toBe(404);
    expect(resetCalls).toBe(1);

    const wrongMethod = yield* Effect.promise(() =>
      app.handler(new Request(recoveryRoute('/request-password-reset')), transportContext),
    );
    expect(wrongMethod.status).toBe(404);
    expect(resetCalls).toBe(1);
  });
});

it.effect('spends the recovery budget before the provider is reached and then answers 429', () => {
  let requestCalls = 0;
  const fixture = makeMemoryRecoveryStore();
  const provider: CommercePortalAuthRecoveryProvider = {
    ...successfulProvider(),
    requestPasswordReset: () =>
      Effect.sync(() => {
        requestCalls += 1;
        return { message: 'If the account exists, an email was sent.', status: true };
      }),
  };
  return Effect.gen(function* recoveryBudgetLifecycle() {
    const recovery = yield* runWithRecovery(provider, fixture.store, (service) => Effect.succeed(service));
    const app = yield* makeRecoveryTransport(recovery, makeCommercePortalAuthRecoveryRateLimit(fixture.store));
    const requestPasswordReset = () =>
      Effect.promise(() =>
        app.handler(
          new Request(recoveryRoute('/request-password-reset'), {
            body: JSON.stringify({ email: EMAIL }),
            headers: { 'content-type': 'application/json', origin: ORIGIN },
            method: 'POST',
          }),
          transportContext,
        ),
      );

    const budget = COMMERCE_PORTAL_AUTH_POLICY.rateLimit.recovery.max;
    for (let attempt = 0; attempt < budget; attempt += 1) {
      const granted = yield* requestPasswordReset();
      expect(granted.status).toBe(200);
    }

    const denied = yield* requestPasswordReset();
    expect(denied.status).toBe(429);
    expect(denied.headers.get('cache-control')).toBe('no-store');
    expect(requestCalls).toBe(budget);
    // Everything this window spent went to one key, and that key names the address the attempts
    // were for. A key of `${UNRESOLVED_PORTAL_AUTH_CLIENT_KEY}|/request-password-reset` would be
    // one counter for the whole deployment, spendable by any caller against every customer.
    expect(fixture.budgetKeys()).toStrictEqual([recoveryBudgetKey(EMAIL, '/request-password-reset')]);
  });
});

/**
 * This transport is mounted as a web handler, so no request carries a socket peer and the resolved
 * client is the same unattributable value for everybody. A budget keyed on that value alone would
 * be one counter for the whole deployment: the exhaustion above would have left every other
 * customer answering 429 on password recovery for the rest of the hour.
 */
it.effect('keeps one caller from spending every other customer recovery budget', () => {
  const fixture = makeMemoryRecoveryStore();
  return Effect.gen(function* recoveryBudgetIsolation() {
    const recovery = yield* runWithRecovery(successfulProvider(), fixture.store, (service) => Effect.succeed(service));
    const app = yield* makeRecoveryTransport(recovery, makeCommercePortalAuthRecoveryRateLimit(fixture.store));
    const attempt = (email: string) =>
      Effect.promise(() =>
        app.handler(
          new Request(recoveryRoute('/request-password-reset'), {
            body: JSON.stringify({ email }),
            headers: { 'content-type': 'application/json', origin: ORIGIN },
            method: 'POST',
          }),
          transportContext,
        ),
      ).pipe(Effect.map((response) => response.status));

    const budget = COMMERCE_PORTAL_AUTH_POLICY.rateLimit.recovery.max;
    const targeted = yield* Effect.forEach(
      Array.from({ length: budget + 1 }, (_unused, index) => index),
      () => attempt(EMAIL),
      { concurrency: 1 },
    );
    expect(targeted).toStrictEqual([...Array.from({ length: budget }, () => 200), 429]);

    // The same window, a different account: the deployment still recovers its customers.
    expect(yield* attempt(BYSTANDER_EMAIL)).toBe(200);
    // Casing names the same account, so a re-cased address cannot mint itself a fresh budget.
    expect(yield* attempt(EMAIL.toUpperCase())).toBe(429);
    expect(fixture.budgetKeys()).toStrictEqual([
      recoveryBudgetKey(EMAIL, '/request-password-reset'),
      recoveryBudgetKey(BYSTANDER_EMAIL, '/request-password-reset'),
    ]);
  });
});

/**
 * The two token routes name their subject the same way, so one issued token's budget is its own:
 * a submitted token can only spend what its holder was issued.
 */
it.effect('keys the token recovery budgets on the submitted token', () => {
  const fixture = makeMemoryRecoveryStore();
  return Effect.gen(function* tokenScopedRecoveryBudgets() {
    const recovery = yield* runWithRecovery(successfulProvider(), fixture.store, (service) => Effect.succeed(service));
    expect(
      yield* fixture.store.registerEmailVerificationToken({
        email: EMAIL,
        expiresAt: VERIFICATION_TOKEN_EXPIRES_AT,
        providerSubjectId: ORIGINAL_SUBJECT,
        token: VERIFICATION_TOKEN,
      }),
    ).toBe(true);
    const app = yield* makeRecoveryTransport(recovery, makeCommercePortalAuthRecoveryRateLimit(fixture.store));
    const reset = (token: string) =>
      Effect.promise(() =>
        app.handler(
          new Request(recoveryRoute('/reset-password'), {
            body: JSON.stringify({ newPassword: 'P'.repeat(24), token }),
            headers: { 'content-type': 'application/json', origin: ORIGIN },
            method: 'POST',
          }),
          transportContext,
        ),
      ).pipe(Effect.map((response) => response.status));

    expect(yield* reset('reset-token-one')).toBe(200);
    expect(yield* reset('reset-token-two')).toBe(200);
    const verification = yield* Effect.promise(() =>
      app.handler(
        new Request(
          `${recoveryRoute('/verify-email')}?token=${encodeURIComponent(Redacted.value(VERIFICATION_TOKEN))}`,
        ),
        transportContext,
      ),
    );
    expect(verification.status).toBe(200);

    expect(fixture.budgetKeys()).toStrictEqual([
      recoveryBudgetKey('reset-token-one', '/reset-password'),
      recoveryBudgetKey('reset-token-two', '/reset-password'),
      recoveryBudgetKey(Redacted.value(VERIFICATION_TOKEN), '/verify-email'),
    ]);
  });
});

it.effect('spends one store-backed budget across two independent HttpApi runtimes', () => {
  let requestCalls = 0;
  const fixture = makeMemoryRecoveryStore();
  const provider: CommercePortalAuthRecoveryProvider = {
    ...successfulProvider(),
    requestPasswordReset: () =>
      Effect.sync(() => {
        requestCalls += 1;
        return { message: 'If the account exists, an email was sent.', status: true };
      }),
  };
  return Effect.gen(function* sharedRecoveryBudgetLifecycle() {
    const recovery = yield* runWithRecovery(provider, fixture.store, (service) => Effect.succeed(service));
    // Two runtimes are built independently and share nothing but the one recovery store, exactly
    // as two replicas of the deployment do.
    const first = yield* makeRecoveryTransport(recovery, makeCommercePortalAuthRecoveryRateLimit(fixture.store));
    const second = yield* makeRecoveryTransport(recovery, makeCommercePortalAuthRecoveryRateLimit(fixture.store));
    const budget = COMMERCE_PORTAL_AUTH_POLICY.rateLimit.recovery.max;
    const attempts = Array.from({ length: budget + 1 }, (_unused, attempt) => (attempt % 2 === 0 ? first : second));

    const statuses = yield* Effect.forEach(
      attempts,
      (app) =>
        Effect.promise(() =>
          app.handler(
            new Request(recoveryRoute('/request-password-reset'), {
              body: JSON.stringify({ email: EMAIL }),
              headers: { 'content-type': 'application/json', origin: ORIGIN },
              method: 'POST',
            }),
            transportContext,
          ),
        ).pipe(Effect.map((response) => response.status)),
      { concurrency: 1 },
    );

    expect(statuses).toStrictEqual([...Array.from({ length: budget }, () => 200), 429]);
    expect(requestCalls).toBe(budget);
  });
});

it.effect('answers 503 when the recovery budget store cannot decide the step', () => {
  let requestCalls = 0;
  const fixture = makeMemoryRecoveryStore();
  const provider: CommercePortalAuthRecoveryProvider = {
    ...successfulProvider(),
    requestPasswordReset: () =>
      Effect.sync(() => {
        requestCalls += 1;
        return { message: 'If the account exists, an email was sent.', status: true };
      }),
  };
  const store: CommercePortalAuthRecoveryStore = {
    ...fixture.store,
    consumeRateLimitBudget: () =>
      Effect.fail(
        new CommercePortalAuthRecoveryUnavailable({
          operation: 'recovery-rate-limit',
          reason: 'test budget store failure',
        }),
      ),
  };
  return Effect.gen(function* unavailableRecoveryBudgetLifecycle() {
    const recovery = yield* runWithRecovery(provider, fixture.store, (service) => Effect.succeed(service));
    const app = yield* makeRecoveryTransport(recovery, makeCommercePortalAuthRecoveryRateLimit(store));
    const response = yield* Effect.promise(() =>
      app.handler(
        new Request(recoveryRoute('/request-password-reset'), {
          body: JSON.stringify({ email: EMAIL }),
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          method: 'POST',
        }),
        transportContext,
      ),
    );
    expect(response.status).toBe(503);
    expect(requestCalls).toBe(0);
  });
});

it.effect('rejects an untrusted origin before the recovery provider is reached', () => {
  let resetCalls = 0;
  const fixture = makeMemoryRecoveryStore();
  const provider: CommercePortalAuthRecoveryProvider = {
    ...successfulProvider(),
    resetPassword: () =>
      Effect.sync(() => {
        resetCalls += 1;
        return { status: true };
      }),
  };
  return Effect.gen(function* untrustedRecoveryOrigin() {
    const recovery = yield* runWithRecovery(provider, fixture.store, (service) => Effect.succeed(service));
    const app = yield* makeRecoveryTransport(recovery, makeCommercePortalAuthRecoveryRateLimit(fixture.store));
    const response = yield* Effect.promise(() =>
      app.handler(
        new Request(recoveryRoute('/reset-password'), {
          body: JSON.stringify({ newPassword: 'P'.repeat(24), token: 'reset-token' }),
          headers: { 'content-type': 'application/json', origin: 'https://evil.example.test' },
          method: 'POST',
        }),
        transportContext,
      ),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(
      yield* Schema.decodeUnknownEffect(CommercePortalAuthRecoveryForbiddenProblemSchema)(
        yield* Effect.promise(response.json.bind(response)),
      ),
    ).toStrictEqual(commercePortalAuthRecoveryUntrustedOriginProblem);
    expect(resetCalls).toBe(0);
    // The gate runs before the budget: a refused request leaves the token's budget untouched.
    expect(fixture.budgetKeys()).toStrictEqual([]);
  });
});

/**
 * A recovery body is a CORS simple request, so a third-party page can drive a visitor's browser
 * into this handler without a preflight. The trusted-origin list is the only CSRF authority for
 * the route, and it must refuse such a request before the durable budget is touched — otherwise
 * the page could burn the named account's whole 3-per-hour budget and collect its 403 afterwards.
 */
it.effect('refuses a cross-origin recovery request before it can spend the budget', () => {
  let requestCalls = 0;
  const fixture = makeMemoryRecoveryStore();
  const provider: CommercePortalAuthRecoveryProvider = {
    ...successfulProvider(),
    requestPasswordReset: () =>
      Effect.sync(() => {
        requestCalls += 1;
        return { message: 'If the account exists, an email was sent.', status: true };
      }),
  };
  return Effect.gen(function* crossOriginRecoveryBudget() {
    const recovery = yield* runWithRecovery(provider, fixture.store, (service) => Effect.succeed(service));
    const app = yield* makeRecoveryTransport(recovery, makeCommercePortalAuthRecoveryRateLimit(fixture.store));
    const attempt = (origin: string) =>
      Effect.promise(() =>
        app.handler(
          new Request(recoveryRoute('/request-password-reset'), {
            body: JSON.stringify({ email: EMAIL }),
            headers: { 'content-type': 'application/json', origin },
            method: 'POST',
          }),
          transportContext,
        ),
      ).pipe(Effect.map((response) => response.status));

    const budget = COMMERCE_PORTAL_AUTH_POLICY.rateLimit.recovery.max;
    const forged = yield* Effect.forEach(
      Array.from({ length: budget + 1 }, (_unused, index) => index),
      () => attempt('https://attacker.example.test'),
      { concurrency: 1 },
    );
    expect(forged).toStrictEqual(Array.from({ length: budget + 1 }, () => 403));
    expect(requestCalls).toBe(0);
    expect(fixture.budgetKeys()).toStrictEqual([]);

    // The victim's own budget is untouched: the first genuine attempt still reaches the provider.
    expect(yield* attempt(ORIGIN)).toBe(200);
    expect(requestCalls).toBe(1);
  });
});

it.effect('rejects an unexpected reset field before the recovery provider is reached', () => {
  let resetCalls = 0;
  const fixture = makeMemoryRecoveryStore();
  const provider: CommercePortalAuthRecoveryProvider = {
    ...successfulProvider(),
    resetPassword: () =>
      Effect.sync(() => {
        resetCalls += 1;
        return { status: true };
      }),
  };
  return Effect.gen(function* unexpectedResetField() {
    const recovery = yield* runWithRecovery(provider, fixture.store, (service) => Effect.succeed(service));
    const app = yield* makeRecoveryTransport(recovery);
    const response = yield* Effect.promise(() =>
      app.handler(
        new Request(recoveryRoute('/reset-password'), {
          body: JSON.stringify({ callbackURL: 'https://evil.example.test', newPassword: 'P'.repeat(24), token: 'x' }),
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          method: 'POST',
        }),
        transportContext,
      ),
    );
    expect(response.status).toBe(400);
    expect(
      yield* Schema.decodeUnknownEffect(CommercePortalAuthRecoveryInvalidProblemSchema)(
        yield* Effect.promise(response.json.bind(response)),
      ),
    ).toStrictEqual(commercePortalAuthRecoveryInvalidProblem);
    expect(resetCalls).toBe(0);
  });
});

it.effect('returns a no-store pending response for the password reset callback without echoing its token', () => {
  const fixture = makeMemoryRecoveryStore();
  return Effect.gen(function* resetCallbackLifecycle() {
    const recovery = yield* runWithRecovery(successfulProvider(), fixture.store, (service) => Effect.succeed(service));
    const app = yield* makeRecoveryTransport(recovery);
    const response = yield* Effect.promise(() =>
      app.handler(
        new Request(`${recoveryRoute('/reset-password/raw-reset-token')}?callbackURL=%2Freset-password`),
        transportContext,
      ),
    );
    const body = yield* Effect.promise(response.json.bind(response));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toStrictEqual({
      callbackURL: `${ORIGIN}/reset-password`,
      outcome: 'PASSWORD_RESET_PENDING',
    });
    expect(JSON.stringify(body)).not.toContain('raw-reset-token');
  });
});

it.effect('rejects an untrusted password reset callback URL before any provider call', () => {
  let resetCalls = 0;
  const fixture = makeMemoryRecoveryStore();
  const provider: CommercePortalAuthRecoveryProvider = {
    ...successfulProvider(),
    resetPassword: () =>
      Effect.sync(() => {
        resetCalls += 1;
        return { status: true };
      }),
  };
  return Effect.gen(function* invalidResetCallbackLifecycle() {
    const recovery = yield* runWithRecovery(provider, fixture.store, (service) => Effect.succeed(service));
    const app = yield* makeRecoveryTransport(recovery);
    const response = yield* Effect.promise(() =>
      app.handler(
        new Request(
          `${recoveryRoute('/reset-password/raw-reset-token')}?callbackURL=https%3A%2F%2Fevil.example.test%2Freset`,
        ),
        transportContext,
      ),
    );
    expect(response.status).toBe(403);
    expect(
      yield* Schema.decodeUnknownEffect(CommercePortalAuthRecoveryForbiddenProblemSchema)(
        yield* Effect.promise(response.json.bind(response)),
      ),
    ).toStrictEqual(commercePortalAuthRecoveryInvalidCallbackProblem);
    expect(resetCalls).toBe(0);
  });
});

it.effect('spends one budget for email verification, which the owner ledger serves alone', () => {
  const fixture = makeMemoryRecoveryStore();
  return Effect.gen(function* verifyEmailBudgetLifecycle() {
    const recovery = yield* runWithRecovery(successfulProvider(), fixture.store, (service) => Effect.succeed(service));
    const app = yield* makeRecoveryTransport(recovery, makeCommercePortalAuthRecoveryRateLimit(fixture.store));
    const budget = COMMERCE_PORTAL_AUTH_POLICY.rateLimit.default.max;
    const submit = (token: string) =>
      Effect.promise(() =>
        app.handler(new Request(`${recoveryRoute('/verify-email')}?token=${token}`), transportContext),
      ).pipe(Effect.map((response) => response.status));
    const statuses = yield* Effect.forEach(
      Array.from({ length: budget + 1 }, (_unused, attempt) => attempt),
      () => submit('replayed-verification-token'),
      { concurrency: 1 },
    );
    // Better Auth never sees this route, so the owner's durable budget is the only ceiling on what
    // one submitted token can drive — the ledger consumes it once and every further submission is
    // a replay the owner has to stop serving.
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, budget).every((status) => status !== 429)).toBe(true);
    // And that ceiling is the token's own. A counter shared by the route would be one counter for
    // the whole deployment — this exhausted window would have denied every other customer's
    // verification link, which is precisely what a caller who can pick the token must not be able
    // to do. What bounds *guessing* is the token: it is high-entropy, single-use and consumed by
    // the owner ledger, and a guesser varying the token side-steps any shared counter anyway.
    expect(yield* submit('another-customers-verification-token')).not.toBe(429);
  });
});

it.effect('ignores a forged forwarded-for hop when keying the recovery budget', () => {
  const fixture = makeMemoryRecoveryStore();
  return Effect.gen(function* forgedForwardedForLifecycle() {
    const recovery = yield* runWithRecovery(successfulProvider(), fixture.store, (service) => Effect.succeed(service));
    const app = yield* makeRecoveryTransport(recovery, makeCommercePortalAuthRecoveryRateLimit(fixture.store));
    const budget = COMMERCE_PORTAL_AUTH_POLICY.rateLimit.recovery.max;
    const statuses = yield* Effect.forEach(
      Array.from({ length: budget + 1 }, (_unused, attempt) => attempt),
      (attempt) =>
        Effect.promise(() =>
          app.handler(
            new Request(recoveryRoute('/request-password-reset'), {
              body: JSON.stringify({ email: EMAIL }),
              headers: {
                'content-type': 'application/json',
                origin: ORIGIN,
                // A caller-chosen value: with no trusted proxy declared it must not open a budget.
                'x-forwarded-for': `203.0.113.${attempt}`,
              },
              method: 'POST',
            }),
            transportContext,
          ),
        ).pipe(Effect.map((response) => response.status)),
      { concurrency: 1 },
    );
    expect(statuses).toStrictEqual([...Array.from({ length: budget }, () => 200), 429]);
  });
});
