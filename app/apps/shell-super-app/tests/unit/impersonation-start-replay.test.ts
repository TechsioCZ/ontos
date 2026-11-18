import {
  ActionCommitIndeterminate,
  ActionRequestHashConflict,
  ActionRuntime,
  PrincipalResolver,
  SupportRecoveryPrincipalContextResolver,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import type { ActionRuntimeService, SupportRecoveryPrincipalContextResolverService } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { makeSignature } from 'better-auth/crypto';
import { Context, Effect, Option, Predicate, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { PrincipalManagementRepository } from '../../../../packages/core-runtime/src/auth/principal-management.ts';
import type { PrincipalManagementRepositoryService } from '../../../../packages/core-runtime/src/auth/principal-management.ts';
import { AuthConfig } from '../../api/auth/config.ts';
import type { SupportRecoveryRecord } from '../../api/auth/impersonation-service.ts';
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
 * session: the provider creates one session for the key, whichever checkpoint's reply was lost.
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
 */
const makeSavedReplyCore = (loseReply: ReadonlySet<string>) => {
  const committed = new Map<string, string>();
  const lost = new Set<string>();
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
          calls.push({ key, payload, replayed: true });
          yield* input.onReplay?.({ invocationId: `invocation-${key}` }) ?? Effect.void;
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

/** The provider and the auth tables: each impersonateUser call creates one new session. */
const makeAuthState = (options: { readonly impersonationExpiresAt?: Date } = {}) => {
  const sessions = new Map<string, StoredSession>([
    [
      originalSessionId,
      { expiresAt: new Date('2099-01-01T00:00:00.000Z'), impersonatedBy: null, token: originalSessionToken },
    ],
  ]);
  const recoveries: SupportRecoveryRecord[] = [];
  let created = 0;
  const provider = makeSupportAuthProviderDouble({
    impersonateUser: () => {
      created += 1;
      const id = `impersonation-session-${created}`;
      sessions.set(id, {
        expiresAt: options.impersonationExpiresAt ?? new Date('2099-01-01T00:00:00.000Z'),
        impersonatedBy: 'original-provider-user',
        token: `impersonation-token-${created}`,
      });
      const headers = new Headers();
      headers.append('set-cookie', `better-auth.session_token=impersonation-token-${created}; Path=/; HttpOnly`);
      return Promise.resolve({ headers, response: { session: { id } } });
    },
  });
  const store = makeSupportImpersonationStoreDouble({
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
    updateImpersonationSession: () => Effect.void,
  });
  return { createdSessions: () => created, provider, recoveries, sessions, store };
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
