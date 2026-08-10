// @effect-diagnostics asyncFunction:off
/* eslint-disable no-await-in-loop -- Each typed checkpoint failure is asserted in isolation. */
import { expect, test } from '@rstest/core';
import {
  ActionAlreadyCommitted,
  ActionPermissionDenied,
  IdentityTargetInvalidError,
} from '@app/core-runtime';
import { makeSignature } from 'better-auth/crypto';
import { Effect } from 'effect';
import { session, supportImpersonationRecovery } from '../../api/auth/db/schema.ts';
import { makeSupportImpersonationService } from '../../api/auth/impersonation-service.ts';

const originalAuthBindingId = '10000000-0000-4000-8000-000000000001';
const originalPrincipalId = '20000000-0000-4000-8000-000000000001';
const targetPrincipalId = '30000000-0000-4000-8000-000000000001';
const tenantId = '40000000-0000-4000-8000-000000000001';
const impersonationSessionId = 'impersonated-session-id';
const restoredSessionId = 'restored-session-id';

const configuration = {
  baseUrl: 'http://localhost:3000',
  connectionString: 'postgresql://unused',
  secret: 'unit-test-secret-unit-test-secret',
  secureCookies: false,
  supportUserIds: ['original-provider-user'],
  trustedOrigins: ['http://localhost:3000'],
};
const supportRecoveryPrincipal = {
  resolveStoppedImpersonation: (input: {
    readonly originalAuthBindingId: string;
    readonly originalPrincipalId: string;
    readonly originalSessionId: string;
    readonly tenantId: string;
  }) =>
    Effect.succeed({
      authBindingId: input.originalAuthBindingId,
      authContextRef: `better-auth-session:${input.originalSessionId}`,
      authMethod: 'session' as const,
      principalId: input.originalPrincipalId,
      tenantId: input.tenantId,
    }),
};

const provider = (impersonated: boolean) => ({
  api: {
    getSession: () =>
      Promise.resolve({
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
    impersonateUser: () => Promise.reject(new Error('not used')),
    stopImpersonating: () => {
      const headers = new Headers();
      headers.append('set-cookie', 'session=restored; Path=/; HttpOnly');
      return Promise.resolve({
        headers,
        response: { session: { id: restoredSessionId } },
      });
    },
  },
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
      reason: 'The requested checkpoint was already committed',
    }),
  ] as const;
  for (const failure of failures) {
    let providerCalls = 0;
    const service = makeSupportImpersonationService({
      actionRuntime: { runAction: () => Effect.fail(failure) } as never,
      authentication: {
        resolveTenantContext: () =>
          Effect.succeed({
            principal: {
              authBindingId: originalAuthBindingId,
              authContextRef: `better-auth-session:${restoredSessionId}`,
              authMethod: 'session',
              principalId: originalPrincipalId,
              tenantId,
            },
            state: 'authenticated',
          }),
      } as never,
      configuration,
      database: {} as never,
      provider: {
        api: {
          impersonateUser: () => {
            providerCalls += 1;
            return Promise.reject(new Error('must not create a session'));
          },
        },
      } as never,
      resolver: {
        resolveBetterAuthUserForPrincipal: () => Effect.succeed('target-provider-user'),
      } as never,
      supportRecoveryPrincipal: supportRecoveryPrincipal as never,
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

test('removes the provider session and recovery when started evidence cannot commit', async () => {
  const startedFailure = new ActionPermissionDenied({
    code: 'action_permission_denied',
    reason: 'The started checkpoint was denied',
  });
  const deletedTables: string[] = [];
  let checkpointCalls = 0;
  const service = makeSupportImpersonationService({
    actionRuntime: {
      runAction: () => {
        checkpointCalls += 1;
        return checkpointCalls === 1
          ? Effect.succeed({ checkpoint: 'requested', recorded: true })
          : Effect.fail(startedFailure);
      },
    } as never,
    authentication: {
      resolveTenantContext: () =>
        Effect.succeed({
          principal: {
            authBindingId: originalAuthBindingId,
            authContextRef: `better-auth-session:${restoredSessionId}`,
            authMethod: 'session',
            principalId: originalPrincipalId,
            tenantId,
          },
          state: 'authenticated',
        }),
    } as never,
    configuration,
    database: {
      delete: () => ({
        where: () => {
          deletedTables.push('deleted');
          return Promise.resolve();
        },
      }),
      insert: () => ({ values: () => ({ onConflictDoNothing: () => Promise.resolve() }) }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    } as never,
    provider: {
      api: {
        impersonateUser: () =>
          Promise.resolve({
            headers: new Headers(),
            response: { session: { id: impersonationSessionId } },
          }),
      },
    } as never,
    resolver: {
      resolveBetterAuthUserForPrincipal: () => Effect.succeed('target-provider-user'),
    } as never,
    supportRecoveryPrincipal: supportRecoveryPrincipal as never,
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
  expect(checkpointCalls).toBe(2);
  expect(deletedTables).toHaveLength(2);
});

test('persists stop recovery before provider restoration and returns restored cookies on evidence failure', async () => {
  let recovery: Record<string, unknown> | undefined;
  let resolverCalled = false;
  const database = {
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        recovery = value;
        return { onConflictDoNothing: () => Promise.resolve() };
      },
    }),
  };
  const service = makeSupportImpersonationService({
    actionRuntime: { runAction: () => Effect.fail({ _tag: 'ActionTransactionError' }) } as never,
    authentication: {} as never,
    configuration,
    database: database as never,
    provider: provider(true) as never,
    resolver: {
      resolveBetterAuthUserForTenant: () => {
        resolverCalled = true;
        return Effect.fail(new Error('disabled principal'));
      },
    } as never,
    supportRecoveryPrincipal: supportRecoveryPrincipal as never,
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
  let checkpointPayload: unknown;
  const query = {
    orderBy: () => Promise.resolve([recovery]),
    where: () => query,
  };
  const database = {
    delete: (table: unknown) => ({
      where: () => {
        if (table === session) {
          targetSessionActive = false;
        }
        if (table === supportImpersonationRecovery) {
          recoveryDeleted = true;
        }
        return Promise.resolve();
      },
    }),
    select: () => ({ from: () => query }),
  };
  const service = makeSupportImpersonationService({
    actionRuntime: {
      runAction: (input: { readonly payload: unknown }) => {
        if (targetSessionActive) {
          return Effect.fail(new Error('target session remained active'));
        }
        checkpointPayload = input.payload;
        return Effect.succeed({ checkpoint: 'stopped', recorded: true });
      },
    } as never,
    authentication: {} as never,
    configuration,
    database: database as never,
    provider: provider(false) as never,
    resolver: {} as never,
    supportRecoveryPrincipal: supportRecoveryPrincipal as never,
  });

  const result = await Effect.runPromise(
    service.stop({
      correlationId: 'correlation-2',
      idempotencyKey: 'stop-request-2',
      requestHeaders: new Headers(),
    }),
  );

  expect(checkpointPayload).toEqual({
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

test('completes every pending checkpoint correlated to the restored session', async () => {
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
  const checkpointSessionRefs: string[] = [];
  let deleteCount = 0;
  const query = {
    orderBy: () => Promise.resolve(recoveries),
    where: () => query,
  };
  const database = {
    delete: () => ({
      where: () => {
        deleteCount += 1;
        return Promise.resolve();
      },
    }),
    select: () => ({ from: () => query }),
  };
  const service = makeSupportImpersonationService({
    actionRuntime: {
      runAction: (input: { readonly payload: { readonly sessionRef: string } }) => {
        checkpointSessionRefs.push(input.payload.sessionRef);
        return Effect.succeed({ checkpoint: 'stopped', recorded: true });
      },
    } as never,
    authentication: {} as never,
    configuration,
    database: database as never,
    provider: provider(false) as never,
    resolver: {} as never,
    supportRecoveryPrincipal: supportRecoveryPrincipal as never,
  });

  const result = await Effect.runPromise(
    service.stop({
      correlationId: 'correlation-3',
      idempotencyKey: 'stop-request-3',
      requestHeaders: new Headers(),
    }),
  );

  expect(checkpointSessionRefs).toEqual([
    `better-auth-session:${impersonationSessionId}`,
    `better-auth-session:${secondImpersonationSessionId}`,
  ]);
  expect(result.checkpointPending).toBe(false);
  expect(deleteCount).toBe(4);
});

test('persists and completes stopped evidence on the first stop after impersonation expiry', async () => {
  const expiredToken = 'expired-impersonation-token';
  const signedToken = encodeURIComponent(
    `${expiredToken}.${await makeSignature(expiredToken, configuration.secret)}`,
  );
  let persistedRecovery: Record<string, unknown> | undefined;
  let deleteCalls = 0;
  let checkpointPayload: unknown;
  const database = {
    delete: () => ({
      where: () => {
        deleteCalls += 1;
        return Promise.resolve();
      },
    }),
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        persistedRecovery = value;
        return { onConflictDoNothing: () => Promise.resolve() };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              {
                actionId: 'expired-impersonation-action',
                impersonatedBy: 'original-provider-user',
                impersonationSessionId,
                originalAuthBindingId,
                originalPrincipalId,
                originalSessionId: restoredSessionId,
                reason: 'Investigate support request',
                targetPrincipalId,
                tenantId,
              },
            ]),
        }),
      }),
    }),
  };
  const service = makeSupportImpersonationService({
    actionRuntime: {
      runAction: (input: { readonly payload: unknown }) => {
        checkpointPayload = input.payload;
        return Effect.succeed({ checkpoint: 'stopped', recorded: true });
      },
    } as never,
    authentication: {} as never,
    configuration,
    database: database as never,
    provider: {
      api: { getSession: () => Promise.resolve({ headers: new Headers(), response: null }) },
    } as never,
    resolver: {} as never,
    supportRecoveryPrincipal: supportRecoveryPrincipal as never,
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
  expect(checkpointPayload).toEqual({
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
    `${adminValue}.${await makeSignature(adminValue, configuration.secret)}`,
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
  let selectCall = 0;
  let checkpointed = false;
  let deleted = false;
  const database = {
    delete: () => ({
      where: () => {
        deleted = true;
        return Promise.resolve();
      },
    }),
    select: () => {
      selectCall += 1;
      if (selectCall === 1) {
        return {
          from: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve([
                  {
                    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
                    id: restoredSessionId,
                  },
                ]),
            }),
          }),
        };
      }
      const query = {
        orderBy: () => Promise.resolve([recovery]),
        where: () => query,
      };
      return { from: () => query };
    },
  };
  const service = makeSupportImpersonationService({
    actionRuntime: {
      runAction: () => {
        checkpointed = true;
        return Effect.succeed({ checkpoint: 'stopped', recorded: true });
      },
    } as never,
    authentication: {} as never,
    configuration,
    database: database as never,
    provider: {
      api: {
        getSession: () => Promise.resolve({ headers: new Headers(), response: null }),
      },
    } as never,
    resolver: {} as never,
    supportRecoveryPrincipal: supportRecoveryPrincipal as never,
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
  expect(checkpointed).toBe(true);
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
    `${adminValue}.${await makeSignature(adminValue, configuration.secret)}`,
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
  let selectCall = 0;
  let checkpointed = false;
  let deleted = false;
  const query = {
    orderBy: () => Promise.resolve([recovery]),
    where: () => query,
  };
  const database = {
    delete: () => ({
      where: () => {
        deleted = true;
        return Promise.resolve();
      },
    }),
    select: () => {
      selectCall += 1;
      return selectCall === 1
        ? {
            from: () => ({
              where: () => ({
                limit: () =>
                  Promise.resolve([
                    {
                      expiresAt: new Date('2000-01-01T00:00:00.000Z'),
                      id: restoredSessionId,
                    },
                  ]),
              }),
            }),
          }
        : { from: () => query };
    },
  };
  const service = makeSupportImpersonationService({
    actionRuntime: {
      runAction: () => {
        checkpointed = true;
        return Effect.succeed({ checkpoint: 'stopped', recorded: true });
      },
    } as never,
    authentication: {} as never,
    configuration,
    database: database as never,
    provider: {
      api: { getSession: () => Promise.resolve({ headers: new Headers(), response: null }) },
    } as never,
    resolver: {} as never,
    supportRecoveryPrincipal: supportRecoveryPrincipal as never,
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
  expect(checkpointed).toBe(true);
  expect(deleted).toBe(true);
  expect(result.setCookieHeaders.every((header) => header.includes('Max-Age=0'))).toBe(true);
});

test('clears a mismatched restored session and completes recovery from the recorded original', async () => {
  let checkpointed = false;
  let deleted = false;
  const database = {
    delete: () => ({
      where: () => {
        deleted = true;
        return Promise.resolve();
      },
    }),
    insert: () => ({ values: () => ({ onConflictDoNothing: () => Promise.resolve() }) }),
  };
  const mismatchedProvider = provider(true);
  mismatchedProvider.api.stopImpersonating = () => {
    const headers = new Headers();
    headers.append('set-cookie', 'better-auth.session_token=unexpected; Path=/; HttpOnly');
    return Promise.resolve({
      headers,
      response: { session: { id: 'unexpected-restored-session' } },
    });
  };
  const service = makeSupportImpersonationService({
    actionRuntime: {
      runAction: () => {
        checkpointed = true;
        return Effect.succeed({ checkpoint: 'stopped', recorded: true });
      },
    } as never,
    authentication: {} as never,
    configuration,
    database: database as never,
    provider: mismatchedProvider as never,
    resolver: {} as never,
    supportRecoveryPrincipal: supportRecoveryPrincipal as never,
  });

  const result = await Effect.runPromise(
    service.stop({
      correlationId: 'correlation-mismatched-restore',
      idempotencyKey: 'stop-mismatched-restore',
      requestHeaders: new Headers(),
    }),
  );

  expect(result.checkpointPending).toBe(false);
  expect(checkpointed).toBe(true);
  expect(deleted).toBe(true);
  expect(result.setCookieHeaders.every((header) => header.includes('Max-Age=0'))).toBe(true);
  expect(result.setCookieHeaders.some((header) => header.includes('unexpected'))).toBe(false);
});

test('deletes the impersonation session and clears cookies when original restoration fails', async () => {
  let deleteCalls = 0;
  const database = {
    delete: () => ({
      where: () => {
        deleteCalls += 1;
        return Promise.resolve();
      },
    }),
    insert: () => ({
      values: () => ({ onConflictDoNothing: () => Promise.resolve() }),
    }),
  };
  const failingProvider = provider(true);
  failingProvider.api.stopImpersonating = () => Promise.reject(new Error('admin session expired'));
  const service = makeSupportImpersonationService({
    actionRuntime: { runAction: () => Effect.fail({ _tag: 'OperationContextDenied' }) } as never,
    authentication: {} as never,
    configuration,
    database: database as never,
    provider: failingProvider as never,
    resolver: {} as never,
    supportRecoveryPrincipal: supportRecoveryPrincipal as never,
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
