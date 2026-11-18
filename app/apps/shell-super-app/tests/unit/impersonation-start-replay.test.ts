import {
  ActionCommitIndeterminate,
  ActionInvocationPersistenceError,
  ActionRequestHashConflict,
  ActionRuntime,
  PrincipalResolver,
  SupportRecoveryPrincipalContextResolver,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import type { ActionRuntimeService, SupportRecoveryPrincipalContextResolverService } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { makeSignature } from 'better-auth/crypto';
import { Context, Effect, Fiber, Option, Predicate, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { PrincipalManagementRepository } from '../../../../packages/core-runtime/src/auth/principal-management.ts';
import type { PrincipalManagementRepositoryService } from '../../../../packages/core-runtime/src/auth/principal-management.ts';
import { AuthConfig } from '../../api/auth/config.ts';
import type { SupportImpersonationStartKey, SupportRecoveryRecord } from '../../api/auth/impersonation-service.ts';
import {
  makeSupportImpersonationService,
  SupportAuthProviderService,
  SupportImpersonationCorrelationId,
  SupportImpersonationStoreService,
} from '../../api/auth/impersonation-service.ts';
import { AuthenticationService } from '../../api/auth/service.ts';
import { makeShellTestAccessGate } from '../support/access-decision-double.ts';
import { makePrincipalResolverDouble } from '../support/identity-service-doubles.ts';
import {
  makeAuthenticationServiceDouble,
  makeSupportAuthProviderDouble,
  makeSupportImpersonationStoreDouble,
} from '../support/impersonation-service-doubles.ts';

/**
 * A support impersonation start retried with its key after a lost reply ends with the original
 * session: the provider creates one session for the key, whichever checkpoint's reply was lost, and
 * never a second one, whether the retry overlaps the first request or comes after the impersonation
 * ended.
 */

const originalAuthBindingId = '10000000-0000-4000-8000-000000000011';
const originalPrincipalId = '20000000-0000-4000-8000-000000000011';
const targetPrincipalId = '30000000-0000-4000-8000-000000000011';
const tenantId = '40000000-0000-4000-8000-000000000011';
const originalSessionId = 'original-session-id';
const originalSessionToken = 'original-session-token';
const idempotencyKey = 'start-impersonation-once';
const reason = 'Investigate a support incident';

const configuration = {
  baseUrl: 'http://localhost:3000',
  connectionString: 'postgresql://unused',
  secret: 'unit-test-secret-unit-test-secret',
  secureCookies: false,
  supportUserIds: ['original-provider-user'],
  trustedOrigins: ['http://localhost:3000'],
};

const unconfigured = (operation: string) => Effect.die(`${operation} is not configured in this test`);
const principalManagementRepository: PrincipalManagementRepositoryService = {
  bindApiKey: () => unconfigured('bindApiKey'),
  changePrincipalStatus: () => unconfigured('changePrincipalStatus'),
  createNonHumanPrincipal: () => unconfigured('createNonHumanPrincipal'),
  setApiKeyBindingStatus: () => unconfigured('setApiKeyBindingStatus'),
  validateSupportImpersonation: () => unconfigured('validateSupportImpersonation'),
};

const shellPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: originalAuthBindingId,
  authContextRef: `better-auth-session:${originalSessionId}`,
  authenticationNamespaceId: 'test.staff.better-auth.v1',
  authMethod: 'session',
  principalId: originalPrincipalId,
  tenantId,
});

const CheckpointSchema = Schema.Struct({ checkpoint: Schema.String });
const SessionRefSchema = Schema.Struct({ sessionRef: Schema.String });

const supportRecoveryPrincipal: SupportRecoveryPrincipalContextResolverService = {
  resolveStoppedImpersonation: () => Effect.succeed(shellPrincipal),
};

/**
 * Core's saved replies for one support user: a key commits once, the same key and payload replays
 * the saved reply, and another payload under it is a request-hash conflict. A key named in `loseReply`
 * commits and then answers ActionCommitIndeterminate once, as when the commit acknowledgement is lost.
 * A key named in `failReplay` answers its first replay with a retryable persistence failure.
 */
const makeSavedReplyCore = (loseReply: ReadonlySet<string>, failReplay: ReadonlySet<string> = new Set()) => {
  const committed = new Map<string, string>();
  const lost = new Set<string>();
  const failedReplays = new Set<string>();
  const calls: { readonly key: string; readonly payload: unknown; readonly replayed: boolean }[] = [];
  const runtime: ActionRuntimeService = {
    resolveActionCommit: () => Effect.die('resolveActionCommit is not used'),
    runAction: (input) =>
      Effect.gen(function* savedReplyCore() {
        const { transport } = input;
        const key =
          Predicate.hasProperty(transport, 'idempotencyKey') && Predicate.isString(transport.idempotencyKey)
            ? transport.idempotencyKey
            : '';
        const { payload } = input;
        const { checkpoint } = Schema.decodeUnknownSync(CheckpointSchema)(payload);
        const hash = JSON.stringify(payload);
        const saved = committed.get(key);
        const result = Schema.decodeUnknownSync(input.registration.descriptor.resultSchema)({
          checkpoint,
          recorded: true,
        });
        if (saved !== undefined) {
          if (saved !== hash) {
            calls.push({ key, payload, replayed: false });
            return yield* new ActionRequestHashConflict({
              code: 'action_request_hash_conflict',
              reason: 'This idempotency key was already used for a different Action request',
            });
          }
          if (failReplay.has(key) && !failedReplays.has(key)) {
            failedReplays.add(key);
            return yield* new ActionInvocationPersistenceError({
              code: 'action_invocation_persistence_failed',
              reason: 'The saved reply could not be read',
            });
          }
          calls.push({ key, payload, replayed: true });
          return result;
        }
        committed.set(key, hash);
        calls.push({ key, payload, replayed: false });
        if (loseReply.has(key) && !lost.has(key)) {
          lost.add(key);
          return yield* new ActionCommitIndeterminate({
            code: 'action_commit_indeterminate',
            invocationId: `invocation-${key}`,
            reason: 'The commit acknowledgement was lost',
          });
        }
        return result;
      }),
  };
  return { calls, runtime };
};

interface StoredSession {
  readonly expiresAt: Date;
  readonly impersonatedBy: null | string;
  readonly token: string;
}

const claimKey = (key: SupportImpersonationStartKey) =>
  JSON.stringify([key.tenantId, key.originalPrincipalId, key.actionId]);

/**
 * The provider and the auth tables: each impersonateUser call creates one new session, which
 * `holdProvider` delays until its release. A start claim is held until `lapseClaims` ends its lease.
 */
const makeAuthState = (options: { readonly impersonationExpiresAt?: Date } = {}) => {
  const sessions = new Map<string, StoredSession>([
    [
      originalSessionId,
      { expiresAt: new Date('2099-01-01T00:00:00.000Z'), impersonatedBy: null, token: originalSessionToken },
    ],
  ]);
  const recoveries: SupportRecoveryRecord[] = [];
  const claims = new Set<string>();
  let claimsLapsed = false;
  let created = 0;
  let providerCalls = 0;
  let providerGate = Promise.resolve(null);
  const createSession = () => {
    created += 1;
    const id = `impersonation-session-${created}`;
    sessions.set(id, {
      expiresAt: options.impersonationExpiresAt ?? new Date('2099-01-01T00:00:00.000Z'),
      impersonatedBy: 'original-provider-user',
      token: `impersonation-token-${created}`,
    });
    const headers = new Headers();
    headers.append('set-cookie', `better-auth.session_token=impersonation-token-${created}; Path=/; HttpOnly`);
    return { headers, response: { session: { id } } };
  };
  const provider = makeSupportAuthProviderDouble({
    impersonateUser: () => {
      providerCalls += 1;
      return providerGate.then(createSession);
    },
  });
  const store = makeSupportImpersonationStoreDouble({
    claimStart: (key) =>
      Effect.sync(() => {
        if (!claims.has(claimKey(key))) {
          claims.add(claimKey(key));
          return 'claimed' as const;
        }
        return claimsLapsed ? ('lapsed' as const) : ('held' as const);
      }),
    deleteRecovery: (sessionId) =>
      Effect.sync(() => {
        const index = recoveries.findIndex((recovery) => recovery.impersonationSessionId === sessionId);
        if (index !== -1) {
          recoveries.splice(index, 1);
        }
      }),
    deleteSession: (sessionId) =>
      Effect.sync(() => {
        sessions.delete(sessionId);
      }),
    insertRecovery: (recovery) =>
      Effect.sync(() => {
        recoveries.push(recovery);
      }),
    loadRecoveries: (sessionId) =>
      Effect.sync(() => recoveries.filter((recovery) => recovery.originalSessionId === sessionId)),
    loadSession: (sessionId) =>
      Effect.sync(() =>
        Option.map(Option.fromNullishOr(sessions.get(sessionId)), (stored) => ({
          expiresAt: stored.expiresAt,
          id: sessionId,
          impersonatedBy: stored.impersonatedBy,
          token: Redacted.make(stored.token),
        })),
      ),
    releaseStart: (key) =>
      Effect.sync(() => {
        claims.delete(claimKey(key));
      }),
    updateImpersonationSession: () => Effect.void,
  });
  return {
    createdSessions: () => created,
    holdProvider: () => {
      const held = Promise.withResolvers<null>();
      providerGate = held.promise;
      return () => held.resolve(null);
    },
    lapseClaims: () => {
      claimsLapsed = true;
    },
    provider,
    providerCalls: () => providerCalls,
    recoveries,
    sessions,
    store,
  };
};

const makeStart = (core: ReturnType<typeof makeSavedReplyCore>, auth: ReturnType<typeof makeAuthState>) => {
  const service = makeSupportImpersonationService(
    Context.empty().pipe(
      Context.add(ActionRuntime, core.runtime),
      Context.add(
        AuthenticationService,
        makeAuthenticationServiceDouble({
          resolveTenantContext: () =>
            Effect.succeed({
              identity: {
                displayName: 'Original administrator',
                email: 'original@example.test',
                principalId: originalPrincipalId,
                tenantId,
              },
              principal: shellPrincipal,
              setCookieHeaders: [],
              state: 'authenticated',
            }),
        }),
      ),
      Context.add(AuthConfig, configuration),
      Context.add(
        PrincipalResolver,
        makePrincipalResolverDouble({
          resolveBetterAuthUserForPrincipal: () => Effect.succeed('target-provider-user'),
        }),
      ),
      Context.add(SupportRecoveryPrincipalContextResolver, supportRecoveryPrincipal),
      Context.add(SupportAuthProviderService, auth.provider),
      Context.add(SupportImpersonationStoreService, auth.store),
    ),
  );
  return () =>
    service
      .start({ idempotencyKey, reason, requestHeaders: new Headers(), targetPrincipalId })
      .pipe(
        Effect.provideService(SupportImpersonationCorrelationId, 'correlation-start-replay'),
        Effect.provideService(PrincipalManagementRepository, principalManagementRepository),
        Effect.provideService(AccessDecisionGate, makeShellTestAccessGate({ defaultAnswer: 'allowed' })),
      );
};

const signed = (value: string) =>
  Effect.promise(() => makeSignature(value, configuration.secret)).pipe(
    Effect.map((signature) => encodeURIComponent(`${value}.${signature}`)),
  );

const startedSessionRefs = (core: ReturnType<typeof makeSavedReplyCore>) =>
  core.calls
    .filter((call) => call.key === `${idempotencyKey}:started`)
    .map((call) => Schema.decodeUnknownSync(SessionRefSchema)(call.payload).sessionRef);

it.effect('answers a retry after the whole start reply was lost with the original session', () =>
  Effect.gen(function* wholeReplyLost() {
    const core = makeSavedReplyCore(new Set());
    const auth = makeAuthState();
    const start = makeStart(core, auth);

    const original = yield* start();
    // The browser never received `original`; the support user retries with the same key.
    const retry = yield* start();

    expect(auth.createdSessions()).toBe(1);
    expect(retry.active).toBe(true);
    expect(retry.targetPrincipalId).toBe(original.targetPrincipalId);
    expect(retry.setCookieHeaders).toContain(
      `better-auth.session_token=${yield* signed('impersonation-token-1')}; Path=/; HttpOnly; SameSite=Lax`,
    );
    const adminCookie = retry.setCookieHeaders.find((header) => header.startsWith('better-auth.admin_session='));
    const adminValue = yield* signed(`${originalSessionToken}:`);
    expect(adminCookie?.startsWith(`better-auth.admin_session=${adminValue};`)).toBe(true);
    expect(retry.setCookieHeaders.some((header) => header.startsWith('better-auth.dont_remember='))).toBe(true);
    // Both checkpoints replayed with the original session; nothing new was recorded.
    expect(startedSessionRefs(core)).toEqual([
      'better-auth-session:impersonation-session-1',
      'better-auth-session:impersonation-session-1',
    ]);
    expect(core.calls.filter((call) => call.replayed).map((call) => call.key)).toEqual([
      `${idempotencyKey}:requested`,
      `${idempotencyKey}:started`,
    ]);
    expect(auth.recoveries.map((recovery) => recovery.impersonationSessionId)).toEqual(['impersonation-session-1']);
  }),
);

it.effect('resumes the created session when the started checkpoint reply was lost', () =>
  Effect.gen(function* startedReplyLost() {
    const core = makeSavedReplyCore(new Set([`${idempotencyKey}:started`]));
    const auth = makeAuthState();
    const start = makeStart(core, auth);

    const lost = yield* Effect.flip(start());
    // The checkpoint may have committed with this session, so the session and its recovery stay.
    expect(Schema.is(ActionCommitIndeterminate)(lost)).toBe(true);
    expect(auth.sessions.has('impersonation-session-1')).toBe(true);
    expect(auth.recoveries).toHaveLength(1);

    const retry = yield* start();

    expect(auth.createdSessions()).toBe(1);
    expect(retry.active).toBe(true);
    expect(retry.setCookieHeaders).toContain(
      `better-auth.session_token=${yield* signed('impersonation-token-1')}; Path=/; HttpOnly; SameSite=Lax`,
    );
    expect(startedSessionRefs(core)).toEqual([
      'better-auth-session:impersonation-session-1',
      'better-auth-session:impersonation-session-1',
    ]);
  }),
);

it.effect('creates the one session when only the requested checkpoint reply was lost', () =>
  Effect.gen(function* requestedReplyLost() {
    const core = makeSavedReplyCore(new Set([`${idempotencyKey}:requested`]));
    const auth = makeAuthState();
    const start = makeStart(core, auth);

    const lost = yield* Effect.flip(start());
    expect(Schema.is(ActionCommitIndeterminate)(lost)).toBe(true);
    expect(auth.createdSessions()).toBe(0);

    const retry = yield* start();

    // The first request stopped before the provider call, so the retry makes it, once.
    expect(auth.createdSessions()).toBe(1);
    expect(retry.active).toBe(true);
    expect(retry.setCookieHeaders).toContain('better-auth.session_token=impersonation-token-1; Path=/; HttpOnly');
    expect(startedSessionRefs(core)).toEqual(['better-auth-session:impersonation-session-1']);
  }),
);

it.effect('stops an ended impersonation and refuses its retry without a new session', () =>
  Effect.gen(function* endedImpersonation() {
    yield* TestClock.setTime(new Date('2026-11-18T12:00:00.000Z').getTime());
    const core = makeSavedReplyCore(new Set());
    const auth = makeAuthState({ impersonationExpiresAt: new Date('2000-01-01T00:00:00.000Z') });
    const start = makeStart(core, auth);

    yield* start();
    const refused = yield* Effect.flip(start());

    expect(Predicate.isTagged(refused, 'SupportImpersonationDeniedError')).toBe(true);
    expect(auth.createdSessions()).toBe(1);
    // The expired session is terminated, its stop is recorded and its recovery removed.
    expect(auth.sessions.has('impersonation-session-1')).toBe(false);
    expect(auth.recoveries).toEqual([]);
    expect(core.calls.at(-1)?.key).toBe(`${idempotencyKey}:stopped`);
  }),
);

it.effect('answers a same-key start that overlaps the running one retryable, then resumes its session', () =>
  Effect.gen(function* overlappingRetry() {
    const core = makeSavedReplyCore(new Set());
    const auth = makeAuthState();
    const releaseProvider = auth.holdProvider();
    const start = makeStart(core, auth);

    const first = yield* Effect.forkChild(start());
    while (auth.providerCalls() === 0) {
      yield* Effect.yieldNow;
    }
    // The browser gave up on the first request and retried while the provider was creating its session.
    const overlapping = yield* Effect.flip(start());
    releaseProvider();
    yield* Fiber.join(first);

    expect(Predicate.isTagged(overlapping, 'SupportImpersonationUnavailableError')).toBe(true);
    expect(auth.providerCalls()).toBe(1);
    const retry = yield* start();
    expect(auth.providerCalls()).toBe(1);
    expect(auth.createdSessions()).toBe(1);
    expect(retry.setCookieHeaders).toContain(
      `better-auth.session_token=${yield* signed('impersonation-token-1')}; Path=/; HttpOnly; SameSite=Lax`,
    );
  }),
);

it.effect('refuses a same-key start after its impersonation was stopped without asking the provider again', () =>
  Effect.gen(function* retryAfterStop() {
    const core = makeSavedReplyCore(new Set());
    const auth = makeAuthState();
    const start = makeStart(core, auth);

    yield* start();
    // The support user stopped the impersonation: its session and its recovery are gone.
    auth.sessions.delete('impersonation-session-1');
    auth.recoveries.splice(0);

    // Within the claim lease the start may still be running, so the answer is retryable.
    const early = yield* Effect.flip(start());
    expect(Predicate.isTagged(early, 'SupportImpersonationUnavailableError')).toBe(true);
    auth.lapseClaims();
    const refused = yield* Effect.flip(start());

    expect(Predicate.isTagged(refused, 'SupportImpersonationDeniedError')).toBe(true);
    expect(auth.createdSessions()).toBe(1);
    expect(startedSessionRefs(core)).toEqual(['better-auth-session:impersonation-session-1']);
  }),
);

it.effect('keeps the started session when replaying its checkpoint fails retryably', () =>
  Effect.gen(function* resumeFailsRetryably() {
    const startedKey = `${idempotencyKey}:started`;
    const core = makeSavedReplyCore(new Set([startedKey]), new Set([startedKey]));
    const auth = makeAuthState();
    const start = makeStart(core, auth);

    yield* Effect.flip(start());
    const failed = yield* Effect.flip(start());

    expect(Schema.is(ActionInvocationPersistenceError)(failed)).toBe(true);
    expect(auth.sessions.has('impersonation-session-1')).toBe(true);
    expect(auth.recoveries.map((recovery) => recovery.impersonationSessionId)).toEqual(['impersonation-session-1']);
    const retry = yield* start();
    expect(auth.createdSessions()).toBe(1);
    expect(retry.setCookieHeaders).toContain(
      `better-auth.session_token=${yield* signed('impersonation-token-1')}; Path=/; HttpOnly; SameSite=Lax`,
    );
  }),
);
