// @effect-diagnostics asyncFunction:off
/* eslint-disable no-await-in-loop -- Each typed checkpoint failure is asserted in isolation. */
import { inspect } from 'node:util';
import { expect, test } from '@rstest/core';
import type { SupportRecoveryPrincipalContextResolverService } from '@app/core-runtime';
import {
  ActionAlreadyCommitted,
  ActionPermissionDenied,
  ActionTransactionError,
  IdentityTargetInvalidError,
} from '@app/core-runtime';
import { makeSignature } from 'better-auth/crypto';
import { Effect, Redacted, Schema } from 'effect';
import type { AuthConfigValue } from '../../api/auth/config.ts';
import type {
  SupportAuthProvider,
  SupportRecoveryRecord,
} from '../../api/auth/impersonation-service.ts';
import {
  makeSupportImpersonationService,
  SupportImpersonationUnavailableError,
} from '../../api/auth/impersonation-service.ts';
import {
  actionCoreFailure,
  actionDomainFailure,
  actionSuccess,
  makeActionRuntimeDouble,
} from '../support/action-runtime-double.ts';
import { makePrincipalResolverDouble } from '../support/identity-service-doubles.ts';
import {
  makeAuthenticationServiceDouble,
  makeSupportAuthProviderDouble,
  makeSupportImpersonationStoreDouble,
} from '../support/impersonation-service-doubles.ts';

const originalAuthBindingId = '10000000-0000-4000-8000-000000000001';
const originalPrincipalId = '20000000-0000-4000-8000-000000000001';
const targetPrincipalId = '30000000-0000-4000-8000-000000000001';
const tenantId = '40000000-0000-4000-8000-000000000001';
const impersonationSessionId = 'impersonated-session-id';
const restoredSessionId = 'restored-session-id';

const configuration: AuthConfigValue = {
  baseUrl: 'http://localhost:3000',
  connectionString: Redacted.make('postgresql://unused'),
  secret: Redacted.make('unit-test-secret-unit-test-secret'),
  secureCookies: false,
  supportUserIds: ['original-provider-user'],
  trustedOrigins: ['http://localhost:3000'],
};
const supportRecoveryPrincipal: SupportRecoveryPrincipalContextResolverService = {
  resolveStoppedImpersonation: (input: {
    readonly originalAuthBindingId: string;
    readonly originalPrincipalId: string;
    readonly originalSessionId: string;
    readonly tenantId: string;
  }) =>
    Effect.succeed({
      authBindingId: input.originalAuthBindingId,
      authContextRef: `better-auth-session:${input.originalSessionId}`,
      authMethod: 'session',
      principalId: input.originalPrincipalId,
      tenantId: input.tenantId,
    }),
};

const provider = (impersonated: boolean): SupportAuthProvider => ({
  api: {
    getSession: async () => ({
      headers: new Headers(),
      response: {
        session: impersonated
          ? {
              activeTenantId: tenantId,
              id: impersonationSessionId,
              impersonatedBy: 'original-provider-user',
              impersonationActionId: 'impersonation-action',
              impersonationOriginalAuthBindingId: originalAuthBindingId,
              impersonationOriginalPrincipalId: originalPrincipalId,
              impersonationOriginalSessionId: restoredSessionId,
              impersonationReason: 'Investigate support request',
              impersonationTargetPrincipalId: targetPrincipalId,
            }
          : { activeTenantId: tenantId, id: restoredSessionId },
        user: { id: 'original-provider-user' },
      },
    }),
    impersonateUser: async () => {
      throw new Error('not used');
    },
    stopImpersonating: async () => {
      const headers = new Headers();
      headers.append('set-cookie', 'session=restored; Path=/; HttpOnly');
      return {
        headers,
        response: { session: { id: restoredSessionId } },
      };
    },
  },
});

test('retains database failures privately without exposing their details', async () => {
  const secretMarker = 'synthetic database secret';
  const originalFailure = Object.assign(new Error(secretMarker), {
    code: 'SYNTHETIC_DB_SECRET',
  });
  const service = makeSupportImpersonationService({
    actionRuntime: makeActionRuntimeDouble([]).runtime,
    authentication: makeAuthenticationServiceDouble(),
    configuration,
    provider: provider(false),
    resolver: makePrincipalResolverDouble(),
    store: makeSupportImpersonationStoreDouble({
      loadRecoveries: async () => {
        throw originalFailure;
      },
    }),
    supportRecoveryPrincipal,
  });

  const failure = await Effect.runPromise(
    Effect.flip(
      service.stop({
        correlationId: 'correlation-database-failure',
        idempotencyKey: 'database-failure',
        requestHeaders: new Headers(),
      }),
    ),
  );

  if (!Schema.is(SupportImpersonationUnavailableError)(failure)) {
    throw new Error('Expected a support-impersonation-unavailable error');
  }
  expect(failure.getOriginalFailure()).toBe(originalFailure);
  const wire = Schema.encodeSync(SupportImpersonationUnavailableError)(failure);
  expect(wire).toEqual({
    _tag: 'SupportImpersonationUnavailableError',
    code: 'support_impersonation_unavailable',
    reason: 'Support impersonation is temporarily unavailable',
  });
  expect(JSON.stringify(failure)).not.toMatch(/synthetic database secret|SYNTHETIC_DB_SECRET/u);
  expect(JSON.stringify(wire)).not.toMatch(/synthetic database secret|SYNTHETIC_DB_SECRET/u);
  expect(inspect(failure, { showHidden: true })).not.toMatch(
    /synthetic database secret|SYNTHETIC_DB_SECRET/u,
  );
});

test('preserves definite requested-checkpoint errors for their declared HTTP mapping', async () => {
  const failures = [
    new ActionPermissionDenied({
      code: 'action_permission_denied',
      reason: 'The Action permission was denied',
    }),
    new IdentityTargetInvalidError({
      code: 'identity_target_invalid',
      reason: 'The support target is invalid',
    }),
    new ActionAlreadyCommitted({
      code: 'action_already_committed',
      invocationId: 'invocation-id',
      reason: 'The requested checkpoint was already committed',
    }),
  ];
  for (const failure of failures) {
    let providerCalls = 0;
    const outcome =
      failure._tag === 'IdentityTargetInvalidError'
        ? actionDomainFailure(failure)
        : actionCoreFailure(failure);
    const service = makeSupportImpersonationService({
      actionRuntime: makeActionRuntimeDouble([outcome]).runtime,
      authentication: makeAuthenticationServiceDouble({
        resolveTenantContext: () =>
          Effect.succeed({
            identity: {
              displayName: 'Original administrator',
              email: 'original@example.test',
              principalId: originalPrincipalId,
              tenantId,
            },
            principal: {
              authBindingId: originalAuthBindingId,
              authContextRef: `better-auth-session:${restoredSessionId}`,
              authMethod: 'session',
              principalId: originalPrincipalId,
              tenantId,
            },
            setCookieHeaders: [],
            state: 'authenticated',
          }),
      }),
      configuration,
      provider: makeSupportAuthProviderDouble({
        impersonateUser: async () => {
          providerCalls += 1;
          throw new Error('must not create a session');
        },
      }),
      resolver: makePrincipalResolverDouble({
        resolveBetterAuthUserForPrincipal: () => Effect.succeed('target-provider-user'),
      }),
      store: makeSupportImpersonationStoreDouble(),
      supportRecoveryPrincipal,
    });

    const actual = await Effect.runPromise(
      Effect.flip(
        service.start({
          correlationId: `correlation-${failure._tag}`,
          idempotencyKey: `start-${failure._tag}`,
          reason: 'Investigate a support incident',
          requestHeaders: new Headers(),
          targetPrincipalId,
        }),
      ),
    );

    expect(actual).toBe(failure);
    expect(providerCalls).toBe(0);
  }
});

test.each([false, true])(
  'orders cleanup and preserves the started failure (cleanup fails: %s)',
  async (cleanupFails) => {
    const startedFailure = new ActionPermissionDenied({
      code: 'action_permission_denied',
      reason: 'The started checkpoint was denied',
    });
    const deletedTables: string[] = [];
    const actionRuntime = makeActionRuntimeDouble([
      actionSuccess({ checkpoint: 'requested', recorded: true }),
      actionCoreFailure(startedFailure),
    ]);
    const service = makeSupportImpersonationService({
      actionRuntime: actionRuntime.runtime,
      authentication: makeAuthenticationServiceDouble({
        resolveTenantContext: () =>
          Effect.succeed({
            identity: {
              displayName: 'Original administrator',
              email: 'original@example.test',
              principalId: originalPrincipalId,
              tenantId,
            },
            principal: {
              authBindingId: originalAuthBindingId,
              authContextRef: `better-auth-session:${restoredSessionId}`,
              authMethod: 'session',
              principalId: originalPrincipalId,
              tenantId,
            },
            setCookieHeaders: [],
            state: 'authenticated',
          }),
      }),
      configuration,
      provider: makeSupportAuthProviderDouble({
        impersonateUser: async () => ({
          headers: new Headers(),
          response: { session: { id: impersonationSessionId } },
        }),
      }),
      resolver: makePrincipalResolverDouble({
        resolveBetterAuthUserForPrincipal: () => Effect.succeed('target-provider-user'),
      }),
      store: makeSupportImpersonationStoreDouble({
        deleteRecovery: async () => {
          deletedTables.push('recovery');
          if (cleanupFails) {
            throw new Error('recovery cleanup unavailable');
          }
        },
        deleteSession: async () => {
          deletedTables.push('session:start');
          await Promise.resolve();
          deletedTables.push('session:end');
        },
        insertRecovery: async () => {},
        updateImpersonationSession: async () => {},
      }),
      supportRecoveryPrincipal,
    });

    const failure = await Effect.runPromise(
      Effect.flip(
        service.start({
          correlationId: 'correlation-started-compensation',
          idempotencyKey: 'started-compensation',
          reason: 'Investigate a support incident',
          requestHeaders: new Headers(),
          targetPrincipalId,
        }),
      ),
    );

    expect(failure).toBe(startedFailure);
    expect(actionRuntime.invocationCount()).toBe(2);
    expect(deletedTables).toEqual(['session:start', 'session:end', 'recovery']);
  },
);

test('persists stop recovery before provider restoration and returns restored cookies on evidence failure', async () => {
  let recovery: SupportRecoveryRecord | undefined;
  let resolverCalled = false;
  const transactionFailure = new ActionTransactionError({
    code: 'action_transaction_failed',
    reason: 'The stopped checkpoint transaction failed',
  });
  const service = makeSupportImpersonationService({
    actionRuntime: makeActionRuntimeDouble([actionCoreFailure(transactionFailure)]).runtime,
    authentication: makeAuthenticationServiceDouble(),
    configuration,
    provider: provider(true),
    resolver: makePrincipalResolverDouble({
      resolveBetterAuthUserForTenant: () => {
        resolverCalled = true;
        return Effect.die('disabled principal');
      },
    }),
    store: makeSupportImpersonationStoreDouble({
      deleteSession: async () => {},
      insertRecovery: async (value) => {
        recovery = value;
      },
    }),
    supportRecoveryPrincipal,
  });

  const result = await Effect.runPromise(
    service.stop({
      correlationId: 'correlation-1',
      idempotencyKey: 'stop-request-1',
      requestHeaders: new Headers(),
    }),
  );

  expect(recovery).toEqual(
    expect.objectContaining({
      impersonationSessionId,
      originalAuthBindingId,
      originalPrincipalId,
      targetPrincipalId,
      tenantId,
    }),
  );
  expect(result.checkpointPending).toBe(true);
  expect(result.setCookieHeaders).toEqual(['session=restored; Path=/; HttpOnly']);
  expect(resolverCalled).toBe(false);
});

test('terminates the target session before retrying stopped evidence from the restored session', async () => {
  const recovery = {
    actionId: 'impersonation-action',
    createdAt: new Date('2026-08-09T00:00:00.000Z'),
    impersonationSessionId,
    originalAuthBindingId,
    originalPrincipalId,
    originalSessionId: restoredSessionId,
    reason: 'Investigate support request',
    targetPrincipalId,
    tenantId,
  };
  let recoveryDeleted = false;
  let targetSessionActive = true;
  const actionRuntime = makeActionRuntimeDouble([
    actionSuccess({ checkpoint: 'stopped', recorded: true }),
  ]);
  const service = makeSupportImpersonationService({
    actionRuntime: actionRuntime.runtime,
    authentication: makeAuthenticationServiceDouble(),
    configuration,
    provider: provider(false),
    resolver: makePrincipalResolverDouble(),
    store: makeSupportImpersonationStoreDouble({
      deleteRecovery: async () => {
        recoveryDeleted = true;
      },
      deleteSession: async () => {
        targetSessionActive = false;
      },
      loadRecoveries: async () => [recovery],
    }),
    supportRecoveryPrincipal,
  });

  const result = await Effect.runPromise(
    service.stop({
      correlationId: 'correlation-2',
      idempotencyKey: 'stop-request-2',
      requestHeaders: new Headers(),
    }),
  );

  expect(actionRuntime.payloads[0]).toEqual({
    checkpoint: 'stopped',
    originalPrincipalId,
    reason: 'Investigate support request',
    sessionRef: `better-auth-session:${impersonationSessionId}`,
    targetPrincipalId,
  });
  expect(result.checkpointPending).toBe(false);
  expect(targetSessionActive).toBe(false);
  expect(recoveryDeleted).toBe(true);
});

test.each([
  { lostResponse: false, checkpointFails: false },
  { lostResponse: false, checkpointFails: true },
  { lostResponse: true, checkpointFails: false },
  { lostResponse: true, checkpointFails: true },
])(
  'completes pending recoveries sequentially with partial failures: %o',
  async ({ lostResponse, checkpointFails }) => {
    const adminValue = 'original-session-token:true';
    const adminCookie = encodeURIComponent(
      `${adminValue}.${await makeSignature(adminValue, configuration.secret)}`,
    );
    const secondImpersonationSessionId = 'second-impersonated-session-id';
    const recoveries = [
      {
        actionId: 'impersonation-action-one',
        createdAt: new Date('2026-08-09T00:00:00.000Z'),
        impersonationSessionId,
        originalAuthBindingId,
        originalPrincipalId,
        originalSessionId: restoredSessionId,
        reason: 'First support request',
        targetPrincipalId,
        tenantId,
      },
      {
        actionId: 'impersonation-action-two',
        createdAt: new Date('2026-08-09T00:01:00.000Z'),
        impersonationSessionId: secondImpersonationSessionId,
        originalAuthBindingId,
        originalPrincipalId,
        originalSessionId: restoredSessionId,
        reason: 'Second support request',
        targetPrincipalId: '30000000-0000-4000-8000-000000000002',
        tenantId,
      },
    ];
    const events: string[] = [];
    const actionRuntime = makeActionRuntimeDouble([
      checkpointFails
        ? actionCoreFailure(
            new ActionTransactionError({
              code: 'action_transaction_failed',
              reason: 'First recovery checkpoint failed',
            }),
          )
        : actionSuccess({ checkpoint: 'stopped', recorded: true }),
      actionSuccess({ checkpoint: 'stopped', recorded: true }),
    ]);
    const service = makeSupportImpersonationService({
      actionRuntime: actionRuntime.runtime,
      authentication: makeAuthenticationServiceDouble(),
      configuration,
      provider: lostResponse
        ? makeSupportAuthProviderDouble({
            getSession: async () => ({ headers: new Headers(), response: null }),
          })
        : provider(false),
      resolver: makePrincipalResolverDouble(),
      store: makeSupportImpersonationStoreDouble({
        deleteRecovery: async (id) => {
          events.push(`recovery:${id}:start`);
          await Promise.resolve();
          events.push(`recovery:${id}:end`);
        },
        deleteSession: async (id) => {
          events.push(`session:${id}:start`);
          await Promise.resolve();
          events.push(`session:${id}:end`);
        },
        loadOriginalSession: async () => ({
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          id: restoredSessionId,
        }),
        loadRecoveries: async () => recoveries,
      }),
      supportRecoveryPrincipal,
    });

    const result = await Effect.runPromise(
      service.stop({
        correlationId: 'correlation-3',
        idempotencyKey: 'stop-request-3',
        requestHeaders: new Headers({ cookie: `better-auth.admin_session=${adminCookie}` }),
      }),
    );

    expect(actionRuntime.payloads).toEqual([
      expect.objectContaining({ sessionRef: `better-auth-session:${impersonationSessionId}` }),
      expect.objectContaining({
        sessionRef: `better-auth-session:${secondImpersonationSessionId}`,
      }),
    ]);
    expect(result.checkpointPending).toBe(checkpointFails);
    expect(events).toEqual([
      `session:${impersonationSessionId}:start`,
      `session:${impersonationSessionId}:end`,
      ...(checkpointFails
        ? []
        : [`recovery:${impersonationSessionId}:start`, `recovery:${impersonationSessionId}:end`]),
      `session:${secondImpersonationSessionId}:start`,
      `session:${secondImpersonationSessionId}:end`,
      `recovery:${secondImpersonationSessionId}:start`,
      `recovery:${secondImpersonationSessionId}:end`,
    ]);
  },
);

test('persists and completes stopped evidence on the first stop after impersonation expiry', async () => {
  const expiredToken = 'expired-impersonation-token';
  const signedToken = encodeURIComponent(
    `${expiredToken}.${await makeSignature(expiredToken, Redacted.value(configuration.secret))}`,
  );
  let persistedRecovery: SupportRecoveryRecord | undefined;
  let deleteCalls = 0;
  const actionRuntime = makeActionRuntimeDouble([
    actionSuccess({ checkpoint: 'stopped', recorded: true }),
  ]);
  const service = makeSupportImpersonationService({
    actionRuntime: actionRuntime.runtime,
    authentication: makeAuthenticationServiceDouble(),
    configuration,
    provider: makeSupportAuthProviderDouble({
      getSession: async () => ({ headers: new Headers(), response: null }),
    }),
    resolver: makePrincipalResolverDouble(),
    store: makeSupportImpersonationStoreDouble({
      deleteRecovery: async () => {
        deleteCalls += 1;
      },
      deleteSession: async () => {
        deleteCalls += 1;
      },
      insertRecovery: async (value) => {
        persistedRecovery = value;
      },
      loadExpiredRecovery: async () => ({
        actionId: 'expired-impersonation-action',
        impersonationSessionId,
        originalAuthBindingId,
        originalPrincipalId,
        originalSessionId: restoredSessionId,
        reason: 'Investigate support request',
        targetPrincipalId,
        tenantId,
      }),
    }),
    supportRecoveryPrincipal,
  });

  const result = await Effect.runPromise(
    service.stop({
      correlationId: 'correlation-first-expired-stop',
      idempotencyKey: 'first-expired-stop',
      requestHeaders: new Headers({
        cookie: `better-auth.session_token=${signedToken}`,
      }),
    }),
  );

  expect(persistedRecovery).toEqual(
    expect.objectContaining({
      actionId: 'expired-impersonation-action',
      impersonationSessionId,
      originalSessionId: restoredSessionId,
    }),
  );
  expect(actionRuntime.payloads[0]).toEqual({
    checkpoint: 'stopped',
    originalPrincipalId,
    reason: 'Investigate support request',
    sessionRef: `better-auth-session:${impersonationSessionId}`,
    targetPrincipalId,
  });
  expect(result.checkpointPending).toBe(false);
  expect(result.setCookieHeaders.every((header) => header.includes('Max-Age=0'))).toBe(true);
  expect(deleteCalls).toBe(2);
});

test('restores the original session and stopped checkpoint after the provider response is lost', async () => {
  const originalSessionToken = 'original-session-token';
  const adminValue = `${originalSessionToken}:true`;
  const adminCookie = encodeURIComponent(
    `${adminValue}.${await makeSignature(adminValue, Redacted.value(configuration.secret))}`,
  );
  const requestHeaders = new Headers({
    cookie: `better-auth.admin_session=${adminCookie}; better-auth.session_token=deleted`,
  });
  const recovery = {
    actionId: 'impersonation-action',
    createdAt: new Date('2026-08-09T00:00:00.000Z'),
    impersonationSessionId,
    originalAuthBindingId,
    originalPrincipalId,
    originalSessionId: restoredSessionId,
    reason: 'Investigate support request',
    targetPrincipalId,
    tenantId,
  };
  let deleted = false;
  const actionRuntime = makeActionRuntimeDouble([
    actionSuccess({ checkpoint: 'stopped', recorded: true }),
  ]);
  const service = makeSupportImpersonationService({
    actionRuntime: actionRuntime.runtime,
    authentication: makeAuthenticationServiceDouble(),
    configuration,
    provider: makeSupportAuthProviderDouble({
      getSession: async () => ({ headers: new Headers(), response: null }),
    }),
    resolver: makePrincipalResolverDouble(),
    store: makeSupportImpersonationStoreDouble({
      deleteRecovery: async () => {
        deleted = true;
      },
      deleteSession: async () => {},
      loadOriginalSession: async () => ({
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        id: restoredSessionId,
      }),
      loadRecoveries: async () => [recovery],
    }),
    supportRecoveryPrincipal,
  });

  const result = await Effect.runPromise(
    service.stop({
      correlationId: 'correlation-response-loss',
      idempotencyKey: 'stop-response-loss',
      requestHeaders,
    }),
  );

  expect(result.active).toBe(false);
  expect(result.checkpointPending).toBe(false);
  expect(actionRuntime.invocationCount()).toBe(1);
  expect(deleted).toBe(true);
  const restoredSessionCookie = result.setCookieHeaders.find((header) =>
    header.startsWith('better-auth.session_token='),
  );
  expect(restoredSessionCookie).toBeDefined();
  expect(restoredSessionCookie?.includes('Max-Age=')).toBe(false);
  const dontRememberCookie = result.setCookieHeaders.find((header) =>
    header.startsWith('better-auth.dont_remember='),
  );
  expect(dontRememberCookie).toBeDefined();
  expect(dontRememberCookie?.includes('Max-Age=0')).toBe(false);
  expect(
    result.setCookieHeaders.some(
      (header) => header.startsWith('better-auth.admin_session=') && header.includes('Max-Age=0'),
    ),
  ).toBe(true);
});

test('completes stopped recovery when a lost response leaves only an expired original session', async () => {
  const originalSessionToken = 'expired-original-session-token';
  const adminValue = `${originalSessionToken}:`;
  const adminCookie = encodeURIComponent(
    `${adminValue}.${await makeSignature(adminValue, Redacted.value(configuration.secret))}`,
  );
  const recovery = {
    actionId: 'expired-original-action',
    createdAt: new Date('2026-08-09T00:00:00.000Z'),
    impersonationSessionId,
    originalAuthBindingId,
    originalPrincipalId,
    originalSessionId: restoredSessionId,
    reason: 'Investigate support request',
    targetPrincipalId,
    tenantId,
  };
  let deleted = false;
  const actionRuntime = makeActionRuntimeDouble([
    actionSuccess({ checkpoint: 'stopped', recorded: true }),
  ]);
  const service = makeSupportImpersonationService({
    actionRuntime: actionRuntime.runtime,
    authentication: makeAuthenticationServiceDouble(),
    configuration,
    provider: makeSupportAuthProviderDouble({
      getSession: async () => ({ headers: new Headers(), response: null }),
    }),
    resolver: makePrincipalResolverDouble(),
    store: makeSupportImpersonationStoreDouble({
      deleteRecovery: async () => {
        deleted = true;
      },
      deleteSession: async () => {},
      loadOriginalSession: async () => ({
        expiresAt: new Date('2000-01-01T00:00:00.000Z'),
        id: restoredSessionId,
      }),
      loadRecoveries: async () => [recovery],
    }),
    supportRecoveryPrincipal,
  });

  const result = await Effect.runPromise(
    service.stop({
      correlationId: 'correlation-expired-lost-response',
      idempotencyKey: 'stop-expired-lost-response',
      requestHeaders: new Headers({
        cookie: `better-auth.admin_session=${adminCookie}`,
      }),
    }),
  );

  expect(result.active).toBe(false);
  expect(result.checkpointPending).toBe(false);
  expect(actionRuntime.invocationCount()).toBe(1);
  expect(deleted).toBe(true);
  expect(result.setCookieHeaders.every((header) => header.includes('Max-Age=0'))).toBe(true);
});

test('clears a mismatched restored session and completes recovery from the recorded original', async () => {
  let deleted = false;
  const actionRuntime = makeActionRuntimeDouble([
    actionSuccess({ checkpoint: 'stopped', recorded: true }),
  ]);
  const service = makeSupportImpersonationService({
    actionRuntime: actionRuntime.runtime,
    authentication: makeAuthenticationServiceDouble(),
    configuration,
    provider: makeSupportAuthProviderDouble({
      ...provider(true).api,
      stopImpersonating: async () => {
        const headers = new Headers();
        headers.append('set-cookie', 'better-auth.session_token=unexpected; Path=/; HttpOnly');
        return {
          headers,
          response: { session: { id: 'unexpected-restored-session' } },
        };
      },
    }),
    resolver: makePrincipalResolverDouble(),
    store: makeSupportImpersonationStoreDouble({
      deleteRecovery: async () => {
        deleted = true;
      },
      insertRecovery: async () => {},
    }),
    supportRecoveryPrincipal,
  });

  const result = await Effect.runPromise(
    service.stop({
      correlationId: 'correlation-mismatched-restore',
      idempotencyKey: 'stop-mismatched-restore',
      requestHeaders: new Headers(),
    }),
  );

  expect(result.checkpointPending).toBe(false);
  expect(actionRuntime.invocationCount()).toBe(1);
  expect(deleted).toBe(true);
  expect(result.setCookieHeaders.every((header) => header.includes('Max-Age=0'))).toBe(true);
  expect(result.setCookieHeaders.some((header) => header.includes('unexpected'))).toBe(false);
});

test('deletes the impersonation session and clears cookies when original restoration fails', async () => {
  let deleteCalls = 0;
  const checkpointFailure = new ActionPermissionDenied({
    code: 'action_permission_denied',
    reason: 'The stopped checkpoint was denied',
  });
  const service = makeSupportImpersonationService({
    actionRuntime: makeActionRuntimeDouble([actionCoreFailure(checkpointFailure)]).runtime,
    authentication: makeAuthenticationServiceDouble(),
    configuration,
    provider: makeSupportAuthProviderDouble({
      ...provider(true).api,
      stopImpersonating: async () => {
        throw new Error('admin session expired');
      },
    }),
    resolver: makePrincipalResolverDouble(),
    store: makeSupportImpersonationStoreDouble({
      deleteSession: async () => {
        deleteCalls += 1;
      },
      insertRecovery: async () => {},
    }),
    supportRecoveryPrincipal,
  });

  const result = await Effect.runPromise(
    service.stop({
      correlationId: 'correlation-expired-original',
      idempotencyKey: 'stop-expired-original',
      requestHeaders: new Headers(),
    }),
  );

  expect(result.active).toBe(false);
  expect(result.checkpointPending).toBe(true);
  expect(deleteCalls).toBe(1);
  expect(result.setCookieHeaders.every((header) => header.includes('Max-Age=0'))).toBe(true);
});
