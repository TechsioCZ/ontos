import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { configureDatabasePool } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { and, eq, inArray } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import {
  Cause,
  Config,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  Redacted,
  Schema,
} from 'effect';
import { Reactivity } from 'effect/reactivity';
import { ConnectionError, isSqlError, SqlError } from 'effect/sql/SqlError';
import { expect, it } from 'effect-rstest';
import { createHash, randomUUID } from 'node:crypto';

import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';
import { hashSubjectKey, UNRESOLVED_PORTAL_AUTH_CLIENT_KEY } from '../../api/portal-auth/http-transport.ts';
import { makeCommercePortalAuth } from '../../api/portal-auth/provider/auth.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import {
  CommercePortalAuthRecoveryProviderService,
  CommercePortalAuthRecoveryRateLimitService,
  CommercePortalAuthRecoveryReconciliationService,
  CommercePortalAuthRecoveryService,
  CommercePortalAuthRecoveryStoreService,
  makeCommercePortalAuthEmailDelivery,
  makeCommercePortalAuthRecoveryRateLimit,
  makeCommercePortalAuthRecoveryReconciliation,
  makeCommercePortalAuthRecoveryService,
  portalAuthRecoveryApiLive,
} from '../../api/portal-auth/provider/recovery/index.ts';
import { CommercePortalAuthRecoveryUnavailable } from '../../api/portal-auth/provider/recovery/unavailable.ts';
import { makeCommercePortalAuthRecoveryProvider } from '../../api/portal-auth/provider/recovery/provider-service.ts';
import { makeCommercePortalAuthAuditRecorder } from '../../src/portal-auth/audit/audit.ts';
import { portalAuthAuditEvent } from '../../src/portal-auth/audit/audit-tables.ts';
import { makeCommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { makeCommercePortalAuthRecoveryStore } from '../../src/portal-auth/persistence/portal-auth-recovery-store.ts';
import {
  commercePortalAuthRelations,
  rateLimit,
  recoveryReconciliation,
  user,
  verification,
} from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import { COMMERCE_PORTAL_AUTH_INTERNAL_BASE_PATH } from '../../shared/deployment-paths.ts';
import { CommercePortalAuthRecoveryApi } from '../../shared/portal-auth/recovery-api.ts';
import { verificationSettlementTransport } from '../support/portal-auth-verification-settlement-transport.ts';
import type { VerificationSettlementFault } from '../support/portal-auth-verification-settlement-transport.ts';

const origin = 'https://verification-settlement.example.test';
const secret = 'verification-settlement-isolated-test-secret'.repeat(2);
const databaseURL = Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.Redacted('DATABASE_URL')),
);
const api = HttpApi.make('CommerceCustomerContextApi').addHttpApi(CommercePortalAuthRecoveryApi);
const context = Context.makeUnsafe<unknown>(new Map());

/** Real configured Better Auth issuance and owner layers; only the native fault client's stream differs. */
const makeFixture = Effect.fn('VerificationSettlementIntegration.makeFixture')(function* makeFixture(
  bodyFailure?: Effect.Effect<never>,
) {
  const connectionString = yield* databaseURL;
  const configuration = yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(connectionString),
    COMMERCE_PORTAL_AUTH_SECRET: secret,
    COMMERCE_PORTAL_AUTH_URL: origin,
  });
  // An independent clean pool remains available to inspect durable truth after the fault pool dies.
  const clean = yield* makeCommercePortalAuthDatabase(configuration);
  const transport = verificationSettlementTransport(new URL(Redacted.value(connectionString)));
  yield* Effect.addFinalizer(() => Effect.sync(() => transport.close()));
  const poolConfiguration = yield* configureDatabasePool(connectionString);
  const reactivity = yield* Reactivity.make;
  const faultClient = yield* PgClient.make({ ...poolConfiguration, prepare: false, stream: transport.stream }).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
  );
  const executor = yield* makeWithDefaults({ relations: commercePortalAuthRelations }).pipe(
    Effect.provideService(PgClient.PgClient, faultClient),
  );
  const cryptoContext = yield* Layer.build(commercePortalAuthPlatformCryptoLive);
  const store = yield* makeCommercePortalAuthRecoveryStore(executor).pipe(Effect.provide(cryptoContext));
  const tokens: string[] = [];
  const emailDelivery = yield* makeCommercePortalAuthEmailDelivery({
    sendOTP: () => Promise.resolve(),
    sendResetPassword: () => Promise.resolve(),
    sendVerificationEmail: ({ token }) => {
      tokens.push(token);
      return Promise.resolve();
    },
  }).pipe(Effect.provideService(CommercePortalAuthRecoveryStoreService, store));
  const auth = yield* makeCommercePortalAuth({ configuration, databaseAdapter: clean.adapter, emailDelivery });
  const email = `settlement-${randomUUID()}@example.test`;
  yield* Effect.tryPromise({
    catch: () => new Error('Verification settlement account setup failed'),
    try: () =>
      auth.api.signUpEmail({
        body: { email, name: 'Verification settlement fixture', password: randomUUID().repeat(2) },
        headers: { origin },
      }),
  });
  yield* Effect.tryPromise({
    catch: () => new Error('Verification settlement token setup failed'),
    try: () => auth.api.sendVerificationEmail({ body: { email }, headers: { origin } }),
  });
  const token = tokens.at(-1);
  if (token === undefined) {
    return yield* Effect.fail(new Error('Verification settlement fixture received no token'));
  }
  const digest = createHash('sha256').update(token).digest('hex');
  const identifier = `commerce-email-verification:${digest}`;
  const [subject] = yield* clean.executor.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (subject === undefined) {
    return yield* Effect.fail(new Error('Verification settlement fixture received no subject'));
  }
  const budgetKeys = [token, 'unissued-verification-fixture'].map(
    (credential) =>
      `${UNRESOLVED_PORTAL_AUTH_CLIENT_KEY}|${hashSubjectKey(credential, configuration.secret)}|/verify-email`,
  );
  yield* Effect.addFinalizer(() =>
    clean.executor
      .transaction((transaction) =>
        Effect.gen(function* cleanupFixture() {
          yield* transaction.delete(verification).where(inArray(verification.identifier, [identifier, email]));
          yield* transaction.delete(rateLimit).where(inArray(rateLimit.key, budgetKeys));
          yield* transaction
            .delete(recoveryReconciliation)
            .where(eq(recoveryReconciliation.providerSubjectId, subject.id));
          yield* transaction.delete(portalAuthAuditEvent).where(eq(portalAuthAuditEvent.providerSubjectId, subject.id));
          yield* transaction.delete(user).where(eq(user.email, email));
        }),
      )
      .pipe(Effect.orDie),
  );
  let receivingStore = store;
  if (bodyFailure !== undefined) {
    // Supplemental component fault: keep real provider/gates; native PostgreSQL evidence stays separate.
    const [ledger] = yield* clean.executor
      .select({ expiresAt: verification.expiresAt, id: verification.id, value: verification.value })
      .from(verification)
      .where(eq(verification.identifier, identifier));
    if (ledger === undefined) {
      return yield* Effect.fail(new Error('Component fixture ledger missing'));
    }
    const rollbackError = new SqlError({
      reason: new ConnectionError({ cause: new Error('Component rollback failure'), operation: 'ROLLBACK' }),
    });
    const scriptedContext = yield* Layer.build(
      scriptedPgClientLayer(
        Effect.succeed(
          testSqlConnection((statement) => {
            if (statement.startsWith('select')) {
              return Effect.succeed([{ expires_at: ledger.expiresAt, id: ledger.id, value: ledger.value }]);
            }
            if (statement.startsWith('update')) {
              return bodyFailure;
            }
            if (statement === 'ROLLBACK') {
              return Effect.fail(rollbackError);
            }
            return Effect.succeed([]);
          }),
        ),
      ).pipe(Layer.provideMerge(Reactivity.layer)),
    );
    const scriptedExecutor = yield* makeWithDefaults({ relations: commercePortalAuthRelations }).pipe(
      Effect.provide(scriptedContext),
    );
    const componentStore = yield* makeCommercePortalAuthRecoveryStore(scriptedExecutor).pipe(
      Effect.provide(cryptoContext),
    );
    receivingStore = { ...store, consumeEmailVerificationWithAudit: componentStore.consumeEmailVerificationWithAudit };
  }
  const reconciliation = yield* makeCommercePortalAuthRecoveryReconciliation().pipe(
    Effect.provideService(CommercePortalAuthRecoveryStoreService, store),
  );
  const recovery = yield* makeCommercePortalAuthRecoveryService(makeCommercePortalAuthAuditRecorder(executor)).pipe(
    Effect.provideService(CommercePortalAuthRecoveryProviderService, makeCommercePortalAuthRecoveryProvider(auth)),
    Effect.provideService(CommercePortalAuthRecoveryStoreService, receivingStore),
    Effect.provideService(CommercePortalAuthRecoveryReconciliationService, reconciliation),
  );
  const layer = HttpApiBuilder.layer(api).pipe(
    Layer.provide(portalAuthRecoveryApiLive),
    Layer.provide(Layer.succeed(CommercePortalAuthRecoveryService, recovery)),
    Layer.provide(
      Layer.succeed(CommercePortalAuthRecoveryRateLimitService, makeCommercePortalAuthRecoveryRateLimit(store)),
    ),
    Layer.provide(Layer.succeed(CommercePortalAuthConfig, configuration)),
    Layer.provide(HttpServer.layerServices),
    Layer.provide(Logger.layer([])),
  );
  const handler = yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(layer, { disableLogger: true })),
    (runtime) => Effect.promise(() => runtime.dispose()).pipe(Effect.orDie),
  );
  const request = (credential = token) =>
    Effect.promise(() =>
      handler.handler(
        new Request(
          `${origin}${COMMERCE_PORTAL_AUTH_INTERNAL_BASE_PATH}/verify-email?token=${encodeURIComponent(credential)}`,
        ),
        context,
      ),
    );
  const truth = () =>
    Effect.scoped(
      Effect.gen(function* durableTruth() {
        const fresh = yield* makeCommercePortalAuthDatabase(configuration);
        const [account] = yield* fresh.executor
          .select({ verified: user.emailVerified })
          .from(user)
          .where(eq(user.id, subject.id));
        const ledger = yield* fresh.executor
          .select({ id: verification.id })
          .from(verification)
          .where(eq(verification.identifier, identifier));
        const completion = yield* fresh.executor
          .select({ id: portalAuthAuditEvent.auditEventId })
          .from(portalAuthAuditEvent)
          .where(
            and(
              eq(portalAuthAuditEvent.providerSubjectId, subject.id),
              eq(portalAuthAuditEvent.eventType, 'commerce.portal-auth.email-verification-consumed.v1'),
            ),
          );
        return { completion: completion.length, ledger: ledger.length, verified: account?.verified };
      }),
    );
  return { auth, clean, email, identifier, request, store: receivingStore, subject, token, transport, truth };
});

for (const fault of [
  'commit-cut',
  'commit-ack-lost',
  'audit-error',
  'audit-error-rollback-cut',
] satisfies VerificationSettlementFault[]) {
  it.live(`mounted verification declares safe unavailability for native ${fault}`, () =>
    Effect.scoped(
      Effect.gen(function* nativeSettlementFailure() {
        const fixture = yield* makeFixture();
        fixture.transport.arm(fault);
        const response = yield* fixture.request();
        expect(response.status).toBe(503);
        expect(response.headers.get('cache-control')).toContain('no-store');
        const problem = yield* Effect.promise(() => response.json());
        expect(problem).toMatchObject({ code: 'authentication_unavailable', retryable: true });
        const serialized = JSON.stringify(problem);
        expect(
          [fixture.token, fixture.email, secret, 'commerce_auth', 'insert into'].some((privateText) =>
            serialized.includes(privateText),
          ),
        ).toBe(false);
        const truth = yield* fixture.truth();
        expect(truth).toEqual(
          fault === 'commit-ack-lost'
            ? { completion: 1, ledger: 0, verified: true }
            : { completion: 0, ledger: 1, verified: false },
        );
        if (fault === 'commit-cut') {
          expect(fixture.transport.observed.commitCut).toBe(true);
        }
        if (fault === 'commit-ack-lost') {
          expect(fixture.transport.observed.commitForwarded).toBe(true);
          expect(fixture.transport.observed.idleCommitObserved).toBe(true);
        }
        if (fault.startsWith('audit-error')) {
          expect(fixture.transport.observed.auditError).toBe(true);
          expect(fixture.transport.observed.bodyErrorResponse).toBe(true);
        }
        if (fault === 'audit-error-rollback-cut') {
          expect(fixture.transport.observed.rollbackCut).toBe(true);
        }
      }),
    ).pipe(Effect.provide(Logger.layer([]))),
  );
}

it.live('acknowledged verification commits flag, token consumption and completion exactly once', () =>
  Effect.scoped(
    Effect.gen(function* acknowledgedSuccess() {
      const fixture = yield* makeFixture();
      const response = yield* fixture.request();
      expect(response.status).toBe(200);
      expect(yield* fixture.truth()).toEqual({ completion: 1, ledger: 0, verified: true });
      expect((yield* fixture.request()).status).not.toBe(200);
      expect(yield* fixture.truth()).toEqual({ completion: 1, ledger: 0, verified: true });
    }),
  ).pipe(Effect.provide(Logger.layer([]))),
);

it.live('actual five-second mounted deadline interrupts native verification body I/O', () =>
  Effect.scoped(
    Effect.gen(function* nativeDeadline() {
      const fixture = yield* makeFixture();
      fixture.transport.arm('body-timeout');
      const [duration, response] = yield* fixture.request().pipe(Effect.timed);
      expect(response.status).toBe(503);
      const elapsed = Duration.toMillis(duration);
      expect(elapsed).toBeGreaterThanOrEqual(4500);
      expect(elapsed).toBeLessThan(9000);
      expect(fixture.transport.observed.timeoutInjected).toBe(true);
      expect(yield* fixture.truth()).toEqual({ completion: 0, ledger: 1, verified: false });
    }),
  ),
);

for (const refusal of ['unissued', 'expired', 'malformed', 'ambiguous']) {
  it.live(`mounted native verification refuses ${refusal} credentials without granting verification`, () =>
    Effect.scoped(
      Effect.gen(function* refusedCredential() {
        const fixture = yield* makeFixture();
        if (refusal === 'expired') {
          yield* fixture.clean.executor
            .update(verification)
            .set({ expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe('2020-01-01T00:00:00Z')) })
            .where(eq(verification.identifier, fixture.identifier));
        }
        if (refusal === 'malformed') {
          yield* fixture.clean.executor
            .update(verification)
            .set({ value: 'invalid-native-fixture-binding' })
            .where(eq(verification.identifier, fixture.identifier));
        }
        if (refusal === 'ambiguous') {
          const [ledger] = yield* fixture.clean.executor
            .select()
            .from(verification)
            .where(eq(verification.identifier, fixture.identifier));
          if (ledger === undefined) {
            throw new Error('Native fixture ledger absent before ambiguity control');
          }
          yield* fixture.clean.executor.insert(verification).values({ ...ledger, id: randomUUID() });
        }
        const response = yield* fixture.request(
          refusal === 'unissued' ? 'unissued-verification-fixture' : fixture.token,
        );
        expect(response.status).toBe(400);
        expect(yield* fixture.truth()).toEqual({
          completion: 0,
          ledger: refusal === 'unissued' ? 1 : 0,
          verified: false,
        });
      }),
    ),
  );
}

for (const change of ['email', 'subject']) {
  it.live(`mounted native verification reconciles a changed ${change} without admitting the old binding`, () =>
    Effect.scoped(
      Effect.gen(function* changedIssuanceBinding() {
        const fixture = yield* makeFixture();
        if (change === 'email') {
          yield* fixture.clean.executor
            .update(user)
            .set({ email: `changed-${fixture.email}` })
            .where(eq(user.id, fixture.subject.id));
          yield* Effect.addFinalizer(() =>
            fixture.clean.executor.delete(user).where(eq(user.id, fixture.subject.id)).pipe(Effect.orDie),
          );
        } else {
          yield* fixture.clean.executor.delete(user).where(eq(user.id, fixture.subject.id));
          yield* Effect.tryPromise({
            catch: () => new Error('Native replacement account setup failed'),
            try: () =>
              fixture.auth.api.signUpEmail({
                body: { email: fixture.email, name: 'Replacement verification fixture', password: randomUUID() },
                headers: { origin },
              }),
          });
        }
        const response = yield* fixture.request();
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          outcome: 'ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED',
        });
        const truth = yield* fixture.truth();
        expect(truth.completion).toBe(0);
        expect(truth.ledger).toBe(1);
        const accounts = yield* fixture.clean.executor
          .select({ verified: user.emailVerified })
          .from(user)
          .where(eq(user.email, change === 'email' ? `changed-${fixture.email}` : fixture.email));
        expect(accounts).toEqual([{ verified: false }]);
      }),
    ),
  );
}

it.live('retains the real server audit error alongside failed native ROLLBACK diagnostics', () =>
  Effect.scoped(
    Effect.gen(function* nativeBodyAndSettlementDiagnostics() {
      const fixture = yield* makeFixture();
      fixture.transport.arm('audit-error-rollback-cut');
      const exit = yield* fixture.store
        .consumeEmailVerificationWithAudit({
          audit: {
            eventType: 'commerce.portal-auth.email-verification-consumed.v1',
            occurredAt: yield* DateTime.nowAsDate,
            operation: 'verify-email',
            outcome: 'success',
          },
          now: yield* DateTime.nowAsDate,
          token: Redacted.make(fixture.token),
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errors = exit.cause.reasons
          .filter(Cause.isFailReason)
          .map((reason) => reason.error)
          .filter(Schema.is(CommercePortalAuthRecoveryUnavailable));
        const settlement = errors.find(
          (error) => Object.getOwnPropertyDescriptor(error, 'cause')?.value?.settlementCause !== undefined,
        );
        const descriptor = Object.getOwnPropertyDescriptor(settlement, 'cause');
        expect(descriptor?.enumerable).toBe(false);
        expect(Option.isSome(descriptor?.value.bodyExit)).toBe(true);
        const bodyExit = descriptor?.value.bodyExit.value;
        expect(Exit.isFailure(bodyExit)).toBe(true);
        expect(bodyExit.cause.reasons.some((reason: Cause.Reason<unknown>) => Cause.isFailReason(reason))).toBe(true);
        expect(
          descriptor?.value.settlementCause.reasons.some(
            (reason: Cause.Reason<unknown>) => Cause.isDieReason(reason) && isSqlError(reason.defect),
          ),
        ).toBe(true);
      }
      expect(fixture.transport.observed.auditError).toBe(true);
      expect(fixture.transport.observed.bodyErrorResponse).toBe(true);
      expect(fixture.transport.observed.rollbackCut).toBe(true);
      expect(yield* fixture.truth()).toEqual({ completion: 0, ledger: 1, verified: false });
    }),
  ),
);

for (const interruption of [false, true]) {
  it.live(
    `component injection keeps unexpected ${interruption ? 'interruption' : 'body defect'} and SQL rollback defect through the mounted handler`,
    () =>
      Effect.scoped(
        Effect.gen(function* mountedUnexpectedCause() {
          const defect = new Error('Component verification body defect');
          const fixture = yield* makeFixture(interruption ? Effect.interrupt : Effect.die(defect));
          const exit = yield* fixture.store
            .consumeEmailVerificationWithAudit({
              audit: {
                eventType: 'commerce.portal-auth.email-verification-consumed.v1',
                occurredAt: yield* DateTime.nowAsDate,
                operation: 'verify-email',
                outcome: 'success',
              },
              now: yield* DateTime.nowAsDate,
              token: Redacted.make(fixture.token),
            })
            .pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(exit.cause.reasons.some(Cause.isFailReason)).toBe(false);
            expect(exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && isSqlError(reason.defect))).toBe(
              true,
            );
            if (interruption) {
              expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true);
            } else {
              expect(exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect)).toBe(
                true,
              );
            }
          }
          // Native rollback defect is unexpected too: generic server failure, never ordinary availability.
          const response = yield* fixture.request();
          expect(response.status).toBe(500);
          const body = yield* Effect.promise(() => response.text());
          expect(body.includes('authentication_unavailable')).toBe(false);
          expect(body.includes(fixture.token)).toBe(false);
          expect(yield* fixture.truth()).toEqual({ completion: 0, ledger: 1, verified: false });
        }),
      ),
  );
}
