import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
import { expect, test } from '@rstest/core';
import {
  ActionRuntime,
  ActionAlreadyCommitted,
  ActionPermissionDenied,
  ActionTransactionError,
  ContextAccess,
  IdentityTargetInvalidError,
  PrincipalResolver,
  SupportRecoveryPrincipalContextResolver,
} from '@app/core-runtime';
import type {
  ActionRuntimeService,
  ContextAccessService,
  PrincipalResolverService,
  SupportRecoveryPrincipalContextResolverService,
} from '@app/core-runtime';
import { makeSignature } from 'better-auth/crypto';
import { Context, Effect, Match, Option } from 'effect';
import type {
  SupportAuthProvider,
  SupportImpersonationStore,
  SupportRecoveryRecord,
} from '../../api/auth/impersonation-service.ts';
import {
  makeSupportImpersonationService,
  SupportAuthProviderService,
  SupportImpersonationCorrelationId,
  SupportImpersonationStoreService,
} from '../../api/auth/impersonation-service.ts';
import { AuthConfig } from '../../api/auth/config.ts';
import { AuthenticationService } from '../../api/auth/service.ts';
import type { AuthenticationServiceContract } from '../../api/auth/service.ts';
import { PrincipalManagementRepository } from '../../../../packages/core-runtime/src/auth/principal-management.ts';
import type { PrincipalManagementRepositoryService } from '../../../../packages/core-runtime/src/auth/principal-management.ts';
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

const configuration = {
  baseUrl: 'http://localhost:3000',
  connectionString: 'postgresql://unused',
  secret: 'unit-test-secret-unit-test-secret',
  secureCookies: false,
  supportUserIds: ['original-provider-user'],
  trustedOrigins: ['http://localhost:3000'],
};

const unconfiguredPrincipalManagement = (operation: string) =>
  Effect.die(`${operation} is not configured in this test`);
const principalManagementRepository: PrincipalManagementRepositoryService = {
  bindApiKey: () => unconfiguredPrincipalManagement('bindApiKey'),
  changePrincipalStatus: () => unconfiguredPrincipalManagement('changePrincipalStatus'),
  createNonHumanPrincipal: () => unconfiguredPrincipalManagement('createNonHumanPrincipal'),
  setApiKeyBindingStatus: () => unconfiguredPrincipalManagement('setApiKeyBindingStatus'),
  validateSupportImpersonation: () =>
    unconfiguredPrincipalManagement('validateSupportImpersonation'),
};
const providePrincipalManagementRepository = Effect.provideService(
  PrincipalManagementRepository,
  principalManagementRepository,
);
const contextAccess: ContextAccessService = {
  legalEntities: ({ legalEntityIds }) =>
    Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
  modules: ({ moduleIds }) =>
    Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
  resources: ({ resources }) =>
    Effect.succeed(
      resources.map(({ moduleId, resourceId, resourceType }) => ({
        decision: 'allowed' as const,
        key: `${moduleId}:${resourceType}:${resourceId}`,
      })),
    ),
  tenants: ({ tenantIds }) =>
    Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
};
const provideContextAccess = Effect.provideService(ContextAccess, contextAccess);

const makeService = (options: {
  readonly actionRuntime: ActionRuntimeService;
  readonly authentication: AuthenticationServiceContract;
  readonly configuration: typeof configuration;
  readonly provider: SupportAuthProvider;
  readonly resolver: PrincipalResolverService;
  readonly store: SupportImpersonationStore;
  readonly supportRecoveryPrincipal: SupportRecoveryPrincipalContextResolverService;
}) => {
  const service = makeSupportImpersonationService(
    Context.empty().pipe(
      Context.add(ActionRuntime, options.actionRuntime),
      Context.add(AuthenticationService, options.authentication),
      Context.add(AuthConfig, options.configuration),
      Context.add(PrincipalResolver, options.resolver),
      Context.add(SupportRecoveryPrincipalContextResolver, options.supportRecoveryPrincipal),
      Context.add(SupportAuthProviderService, options.provider),
      Context.add(SupportImpersonationStoreService, options.store),
    ),
  );
  return Object.freeze({
    start: (input: Parameters<typeof service.start>[0]) =>
      service.start(input).pipe(providePrincipalManagementRepository, provideContextAccess),
    stop: (input: Parameters<typeof service.stop>[0]) =>
      service.stop(input).pipe(providePrincipalManagementRepository, provideContextAccess),
  });
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
  await runEffectTestPromise(
    Effect.forEach(
      failures,
      (failure) =>
        Effect.gen(function* assertRequestedCheckpointFailure() {
          let providerCalls = 0;
          const outcome = Match.value(failure).pipe(
            Match.tag('IdentityTargetInvalidError', actionDomainFailure),
            Match.orElse(actionCoreFailure),
          );
          const service = makeService({
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

          const actual = yield* Effect.flip(
            service
              .start({
                idempotencyKey: `start-${failure._tag}`,
                reason: 'Investigate a support incident',
                requestHeaders: new Headers(),
                targetPrincipalId,
              })
              .pipe(
                Effect.provideService(
                  SupportImpersonationCorrelationId,
                  `correlation-${failure._tag}`,
                ),
              ),
          );

          expect(actual).toBe(failure);
          expect(providerCalls).toBe(0);
        }),
      { concurrency: 1, discard: true },
    ),
  );
});

test('removes the provider session and recovery when started evidence cannot commit', async () => {
  const startedFailure = new ActionPermissionDenied({
    code: 'action_permission_denied',
    reason: 'The started checkpoint was denied',
  });
  const deletedTables: string[] = [];
  const actionRuntime = makeActionRuntimeDouble([
    actionSuccess({ checkpoint: 'requested', recorded: true }),
    actionCoreFailure(startedFailure),
  ]);
  const service = makeService({
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
      deleteRecovery: () =>
        Effect.sync(() => {
          deletedTables.push('deleted');
        }),
      deleteSession: () =>
        Effect.sync(() => {
          deletedTables.push('deleted');
        }),
      insertRecovery: () => Effect.void,
      updateImpersonationSession: () => Effect.void,
    }),
    supportRecoveryPrincipal,
  });

  const failure = await runEffectTestPromise(
    Effect.flip(
      service
        .start({
          idempotencyKey: 'started-compensation',
          reason: 'Investigate a support incident',
          requestHeaders: new Headers(),
          targetPrincipalId,
        })
        .pipe(
          Effect.provideService(
            SupportImpersonationCorrelationId,
            'correlation-started-compensation',
          ),
        ),
    ),
  );

  expect(failure).toBe(startedFailure);
  expect(actionRuntime.invocationCount()).toBe(2);
  expect(deletedTables).toHaveLength(2);
});

test('persists stop recovery before provider restoration and returns restored cookies on evidence failure', async () => {
  let recovery: SupportRecoveryRecord | undefined;
  let resolverCalled = false;
  const transactionFailure = new ActionTransactionError({
    code: 'action_transaction_failed',
    reason: 'The stopped checkpoint transaction failed',
  });
  const service = makeService({
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
      deleteSession: () => Effect.void,
      insertRecovery: (value) =>
        Effect.sync(() => {
          recovery = value;
        }),
    }),
    supportRecoveryPrincipal,
  });

  const result = await runEffectTestPromise(
    service
      .stop({
        idempotencyKey: 'stop-request-1',
        requestHeaders: new Headers(),
      })
      .pipe(Effect.provideService(SupportImpersonationCorrelationId, 'correlation-1')),
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
  const service = makeService({
    actionRuntime: actionRuntime.runtime,
    authentication: makeAuthenticationServiceDouble(),
    configuration,
    provider: provider(false),
    resolver: makePrincipalResolverDouble(),
    store: makeSupportImpersonationStoreDouble({
      deleteRecovery: () =>
        Effect.sync(() => {
          recoveryDeleted = true;
        }),
      deleteSession: () =>
        Effect.sync(() => {
          targetSessionActive = false;
        }),
      loadRecoveries: () => Effect.succeed([recovery]),
    }),
    supportRecoveryPrincipal,
  });

  const result = await runEffectTestPromise(
    service
      .stop({
        idempotencyKey: 'stop-request-2',
        requestHeaders: new Headers(),
      })
      .pipe(Effect.provideService(SupportImpersonationCorrelationId, 'correlation-2')),
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
  let deleteCount = 0;
  const actionRuntime = makeActionRuntimeDouble([
    actionSuccess({ checkpoint: 'stopped', recorded: true }),
    actionSuccess({ checkpoint: 'stopped', recorded: true }),
  ]);
  const service = makeService({
    actionRuntime: actionRuntime.runtime,
    authentication: makeAuthenticationServiceDouble(),
    configuration,
    provider: provider(false),
    resolver: makePrincipalResolverDouble(),
    store: makeSupportImpersonationStoreDouble({
      deleteRecovery: () =>
        Effect.sync(() => {
          deleteCount += 1;
        }),
      deleteSession: () =>
        Effect.sync(() => {
          deleteCount += 1;
        }),
      loadRecoveries: () => Effect.succeed(recoveries),
    }),
    supportRecoveryPrincipal,
  });

  const result = await runEffectTestPromise(
    service
      .stop({
        idempotencyKey: 'stop-request-3',
        requestHeaders: new Headers(),
      })
      .pipe(Effect.provideService(SupportImpersonationCorrelationId, 'correlation-3')),
  );

  expect(actionRuntime.payloads).toEqual([
    expect.objectContaining({ sessionRef: `better-auth-session:${impersonationSessionId}` }),
    expect.objectContaining({ sessionRef: `better-auth-session:${secondImpersonationSessionId}` }),
  ]);
  expect(result.checkpointPending).toBe(false);
  expect(deleteCount).toBe(4);
});

test('persists and completes stopped evidence on the first stop after impersonation expiry', async () => {
  const expiredToken = 'expired-impersonation-token';
  const signedToken = encodeURIComponent(
    `${expiredToken}.${await makeSignature(expiredToken, configuration.secret)}`,
  );
  let persistedRecovery: SupportRecoveryRecord | undefined;
  let deleteCalls = 0;
  const actionRuntime = makeActionRuntimeDouble([
    actionSuccess({ checkpoint: 'stopped', recorded: true }),
  ]);
  const service = makeService({
    actionRuntime: actionRuntime.runtime,
    authentication: makeAuthenticationServiceDouble(),
    configuration,
    provider: makeSupportAuthProviderDouble({
      getSession: async () => ({ headers: new Headers(), response: null }),
    }),
    resolver: makePrincipalResolverDouble(),
    store: makeSupportImpersonationStoreDouble({
      deleteRecovery: () =>
        Effect.sync(() => {
          deleteCalls += 1;
        }),
      deleteSession: () =>
        Effect.sync(() => {
          deleteCalls += 1;
        }),
      insertRecovery: (value) =>
        Effect.sync(() => {
          persistedRecovery = value;
        }),
      loadExpiredRecovery: () =>
        Effect.succeed(
          Option.some({
            actionId: 'expired-impersonation-action',
            impersonationSessionId,
            originalAuthBindingId,
            originalPrincipalId,
            originalSessionId: restoredSessionId,
            reason: 'Investigate support request',
            targetPrincipalId,
            tenantId,
          }),
        ),
    }),
    supportRecoveryPrincipal,
  });

  const result = await runEffectTestPromise(
    service
      .stop({
        idempotencyKey: 'first-expired-stop',
        requestHeaders: new Headers({
          cookie: `better-auth.session_token=${signedToken}`,
        }),
      })
      .pipe(
        Effect.provideService(SupportImpersonationCorrelationId, 'correlation-first-expired-stop'),
      ),
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

const makeLostResponseRecoveryService = (recovery: SupportRecoveryRecord, expiresAt: Date) => {
  let deleted = false;
  const actionRuntime = makeActionRuntimeDouble([
    actionSuccess({ checkpoint: 'stopped', recorded: true }),
  ]);
  const service = makeService({
    actionRuntime: actionRuntime.runtime,
    authentication: makeAuthenticationServiceDouble(),
    configuration,
    provider: makeSupportAuthProviderDouble({
      getSession: async () => ({ headers: new Headers(), response: null }),
    }),
    resolver: makePrincipalResolverDouble(),
    store: makeSupportImpersonationStoreDouble({
      deleteRecovery: () =>
        Effect.sync(() => {
          deleted = true;
        }),
      deleteSession: () => Effect.void,
      loadOriginalSession: () =>
        Effect.succeed(
          Option.some({
            expiresAt,
            id: restoredSessionId,
          }),
        ),
      loadRecoveries: () => Effect.succeed([recovery]),
    }),
    supportRecoveryPrincipal,
  });
  return { actionRuntime, deleted: () => deleted, service };
};

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
  const { actionRuntime, deleted, service } = makeLostResponseRecoveryService(
    recovery,
    new Date('2099-01-01T00:00:00.000Z'),
  );

  const result = await runEffectTestPromise(
    service
      .stop({
        idempotencyKey: 'stop-response-loss',
        requestHeaders,
      })
      .pipe(Effect.provideService(SupportImpersonationCorrelationId, 'correlation-response-loss')),
  );

  expect(result.active).toBe(false);
  expect(result.checkpointPending).toBe(false);
  expect(actionRuntime.invocationCount()).toBe(1);
  expect(deleted()).toBe(true);
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
  const { actionRuntime, deleted, service } = makeLostResponseRecoveryService(
    recovery,
    new Date('2000-01-01T00:00:00.000Z'),
  );

  const result = await runEffectTestPromise(
    service
      .stop({
        idempotencyKey: 'stop-expired-lost-response',
        requestHeaders: new Headers({
          cookie: `better-auth.admin_session=${adminCookie}`,
        }),
      })
      .pipe(
        Effect.provideService(
          SupportImpersonationCorrelationId,
          'correlation-expired-lost-response',
        ),
      ),
  );

  expect(result.active).toBe(false);
  expect(result.checkpointPending).toBe(false);
  expect(actionRuntime.invocationCount()).toBe(1);
  expect(deleted()).toBe(true);
  expect(result.setCookieHeaders.every((header) => header.includes('Max-Age=0'))).toBe(true);
});

test('clears a mismatched restored session and completes recovery from the recorded original', async () => {
  let deleted = false;
  const actionRuntime = makeActionRuntimeDouble([
    actionSuccess({ checkpoint: 'stopped', recorded: true }),
  ]);
  const service = makeService({
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
      deleteRecovery: () =>
        Effect.sync(() => {
          deleted = true;
        }),
      insertRecovery: () => Effect.void,
    }),
    supportRecoveryPrincipal,
  });

  const result = await runEffectTestPromise(
    service
      .stop({
        idempotencyKey: 'stop-mismatched-restore',
        requestHeaders: new Headers(),
      })
      .pipe(
        Effect.provideService(SupportImpersonationCorrelationId, 'correlation-mismatched-restore'),
      ),
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
  const service = makeService({
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
      deleteSession: () =>
        Effect.sync(() => {
          deleteCalls += 1;
        }),
      insertRecovery: () => Effect.void,
    }),
    supportRecoveryPrincipal,
  });

  const result = await runEffectTestPromise(
    service
      .stop({
        idempotencyKey: 'stop-expired-original',
        requestHeaders: new Headers(),
      })
      .pipe(
        Effect.provideService(SupportImpersonationCorrelationId, 'correlation-expired-original'),
      ),
  );

  expect(result.active).toBe(false);
  expect(result.checkpointPending).toBe(true);
  expect(deleteCalls).toBe(1);
  expect(result.setCookieHeaders.every((header) => header.includes('Max-Age=0'))).toBe(true);
});
