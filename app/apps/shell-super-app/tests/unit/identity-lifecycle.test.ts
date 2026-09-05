// @effect-diagnostics asyncFunction:off
import { expect, test } from '@rstest/core';
import {
  ActionTransactionError,
  IdentityTargetInvalidError,
  PrincipalBindingMissingError,
} from '@app/core-runtime';
import { inspect } from 'node:util';
import { Effect, Redacted, Schema } from 'effect';
import { ApiKeyIssueResponseSchema } from '../../shared/api.ts';
import {
  ApiKeyProviderUnavailableError,
  ApiKeyStateInconsistentError,
  classifyPendingApiKeyCleanup,
} from '../../api/auth/api-key-service.ts';
import { makeIdentityLifecycleService } from '../../api/auth/identity-lifecycle.ts';
import {
  actionCoreFailure,
  actionDefect,
  actionDomainFailure,
  actionSuccess,
  makeActionRuntimeDouble,
} from '../support/action-runtime-double.ts';
import {
  makeApiKeyServiceDouble,
  makePrincipalResolverDouble,
} from '../support/identity-service-doubles.ts';

const principal = {
  authBindingId: '00000000-0000-4000-8000-000000000002',
  authContextRef: 'better-auth-session:identity-lifecycle-test',
  authMethod: 'session' as const,
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
};
const issued = {
  createdAt: '2026-08-09T00:00:00.000Z',
  enabled: true,
  expiresAt: null,
  name: 'automation',
  providerKeyId: 'private-provider-key-id',
  secret: Redacted.make('ontos-secret'),
  start: 'onto',
};
const resolver = makePrincipalResolverDouble({
  loadApiKeyBindingForAdministration: () =>
    Effect.succeed({ providerSubjectId: 'old-provider-key-id', status: 'active' }),
});
const actionTransactionFailure = (reason: string) =>
  new ActionTransactionError({ code: 'action_transaction_failed', reason });
const pendingMetadata = (
  lifecycleOperationId: string,
  scope: { readonly issuerPrincipalId?: string; readonly tenantId?: string } = {},
) =>
  JSON.stringify({
    issuerPrincipalId: scope.issuerPrincipalId ?? principal.principalId,
    lifecycleOperationId,
    ontosLifecycle: 'binding_pending_v1',
    tenantId: scope.tenantId ?? principal.tenantId,
  });

test('compensates a failed Core bind and never exposes the provider key identifier', async () => {
  const disabled: string[] = [];
  const bindFailure = new IdentityTargetInvalidError({
    code: 'identity_target_invalid',
    reason: 'The requested binding target is invalid',
  });
  const service = makeIdentityLifecycleService(
    makeActionRuntimeDouble([actionDomainFailure(bindFailure)]).runtime,
    makeApiKeyServiceDouble({
      clearPendingCleanup: () => Effect.void,
      issue: () => Effect.succeed(issued),
      pendingCleanup: () => Effect.succeed({ hasMore: false, providerKeyIds: [] }),
      setEnabled: (keyId) => {
        disabled.push(keyId);
        return Effect.succeed({ ...issued, providerKeyId: keyId });
      },
    }),
    resolver,
  );

  const failure = await Effect.runPromise(
    Effect.flip(
      service.issue({
        correlationId: 'correlation-1',
        idempotencyKey: 'issue-1',
        principal,
        requestHeaders: new Headers(),
      }),
    ),
  );
  expect(failure).toBe(bindFailure);
  expect(failure._tag).toBe('IdentityTargetInvalidError');
  expect(disabled).toEqual(['private-provider-key-id']);
});

test('preserves resolver lifecycle failures instead of rewriting them as an outage', async () => {
  const resolverFailure = new PrincipalBindingMissingError();
  const service = makeIdentityLifecycleService(
    makeActionRuntimeDouble([actionDefect('must not run')]).runtime,
    makeApiKeyServiceDouble(),
    makePrincipalResolverDouble({
      loadApiKeyBindingForAdministration: () => Effect.fail(resolverFailure),
    }),
  );

  const failure = await Effect.runPromise(
    Effect.flip(
      service.setStatus({
        authBindingId: '00000000-0000-4000-8000-000000000005',
        correlationId: 'correlation-resolver-failure',
        expectedStatus: 'active',
        idempotencyKey: 'status-resolver-failure',
        newStatus: 'disabled',
        principal,
      }),
    ),
  );

  expect(failure).toBe(resolverFailure);
  expect(failure._tag).toBe('PrincipalBindingMissingError');
});

test('preserves a typed Core status-transition failure before touching provider state', async () => {
  const actionFailure = new IdentityTargetInvalidError({
    code: 'identity_target_invalid',
    reason: 'The requested status transition is invalid',
  });
  let providerCalls = 0;
  const service = makeIdentityLifecycleService(
    makeActionRuntimeDouble([actionDomainFailure(actionFailure)]).runtime,
    makeApiKeyServiceDouble({
      setEnabled: () => {
        providerCalls += 1;
        return Effect.succeed(issued);
      },
    }),
    resolver,
  );

  const failure = await Effect.runPromise(
    Effect.flip(
      service.setStatus({
        authBindingId: '00000000-0000-4000-8000-000000000005',
        correlationId: 'correlation-core-failure',
        expectedStatus: 'active',
        idempotencyKey: 'status-core-failure',
        newStatus: 'disabled',
        principal,
      }),
    ),
  );

  expect(failure).toBe(actionFailure);
  expect(failure._tag).toBe('IdentityTargetInvalidError');
  expect(providerCalls).toBe(0);
});

test('reconciles only expired pending leases in the trusted tenant and issuer scope', () => {
  const nowEpochMillis = new Date('2026-08-09T12:00:00.000Z').getTime();
  const selected = classifyPendingApiKeyCleanup(
    [
      {
        createdAt: new Date(nowEpochMillis - 1000),
        metadata: pendingMetadata('same-operation'),
        providerKeyId: 'same-key',
      },
      {
        createdAt: new Date(nowEpochMillis - 1000),
        metadata: pendingMetadata('concurrent-operation'),
        providerKeyId: 'concurrent-key',
      },
      {
        createdAt: new Date(nowEpochMillis - 6 * 60 * 1000),
        metadata: pendingMetadata('abandoned-operation'),
        providerKeyId: 'abandoned-key',
      },
      {
        createdAt: new Date(nowEpochMillis - 6 * 60 * 1000),
        metadata: pendingMetadata('foreign-tenant', {
          tenantId: '00000000-0000-4000-8000-000000000099',
        }),
        providerKeyId: 'foreign-tenant-key',
      },
      {
        createdAt: new Date(nowEpochMillis - 6 * 60 * 1000),
        metadata: pendingMetadata('foreign-issuer', {
          issuerPrincipalId: '00000000-0000-4000-8000-000000000098',
        }),
        providerKeyId: 'foreign-issuer-key',
      },
    ],
    {
      issuerPrincipalId: principal.principalId,
      lifecycleOperationId: 'same-operation',
      nowEpochMillis,
      tenantId: principal.tenantId,
    },
  );

  expect(selected).toEqual(['abandoned-key']);
});

test('returns a secret only after bind succeeds and strips the private provider key identifier', async () => {
  const service = makeIdentityLifecycleService(
    makeActionRuntimeDouble([
      actionSuccess({
        authBindingId: '00000000-0000-4000-8000-000000000004',
        status: 'active',
      }),
    ]).runtime,
    makeApiKeyServiceDouble({
      clearPendingCleanup: () => Effect.void,
      issue: () => Effect.succeed(issued),
      pendingCleanup: () => Effect.succeed({ hasMore: false, providerKeyIds: [] }),
      setEnabled: () => Effect.succeed(issued),
    }),
    resolver,
  );

  const result = await Effect.runPromise(
    service.issue({
      correlationId: 'correlation-2',
      idempotencyKey: 'issue-2',
      principal,
      requestHeaders: new Headers(),
    }),
  );
  expect(result.secret).toBe(issued.secret);
  expect(JSON.stringify(result)).not.toContain('ontos-secret');
  expect(Object.hasOwn(result, 'providerKeyId')).toBe(false);
  expect(Redacted.isRedacted(result.secret)).toBe(true);
  expect(String(result.secret)).not.toContain('ontos-secret');
  expect(inspect(result)).not.toContain('ontos-secret');
  // Only the one-time HTTP response projection reveals the synthetic credential.
  const response = { ...result, secret: Redacted.value(result.secret) };
  expect(Schema.is(ApiKeyIssueResponseSchema)(result)).toBe(false);
  expect(Schema.is(ApiKeyIssueResponseSchema)(response)).toBe(true);
  expect(response.secret).toBe('ontos-secret');
  expect(JSON.stringify(response)).toContain('ontos-secret');
  expect(response.authBindingId).toBe('00000000-0000-4000-8000-000000000004');
  expect(response.cleanupPending).toBe(false);
  expect(Object.hasOwn(response, 'providerKeyId')).toBe(false);
  expect(JSON.stringify(result)).not.toContain('ontos-secret');
});

test('revokes the replacement before failing when closing the old Core binding fails', async () => {
  const actionRuntime = makeActionRuntimeDouble([
    actionSuccess({
      authBindingId: '00000000-0000-4000-8000-000000000004',
      status: 'active',
    }),
    actionCoreFailure(actionTransactionFailure('old binding unavailable')),
    actionSuccess({ previousStatus: 'active', status: 'revoked' }),
  ]);
  const disabled: string[] = [];
  const service = makeIdentityLifecycleService(
    actionRuntime.runtime,
    makeApiKeyServiceDouble({
      clearPendingCleanup: () => Effect.void,
      issue: () => Effect.succeed(issued),
      metadata: () => Effect.succeed(issued),
      pendingCleanup: () => Effect.succeed({ hasMore: false, providerKeyIds: [] }),
      setEnabled: (keyId, enabled) => {
        if (!enabled) {
          disabled.push(keyId);
        }
        return Effect.succeed({ ...issued, providerKeyId: keyId });
      },
    }),
    resolver,
  );

  await expect(
    Effect.runPromise(
      service.rotate({
        correlationId: 'correlation-3',
        idempotencyKey: 'rotate-1',
        oldAuthBindingId: '00000000-0000-4000-8000-000000000005',
        principal,
        reason: 'Scheduled credential rotation',
        requestHeaders: new Headers(),
      }),
    ),
  ).rejects.toBeDefined();
  expect(actionRuntime.invocationCount()).toBe(3);
  expect(disabled).toEqual(['old-provider-key-id']);
});

test('returns the replacement secret when both old closure and replacement rollback are unavailable', async () => {
  const actionRuntime = makeActionRuntimeDouble([
    actionSuccess({
      authBindingId: '00000000-0000-4000-8000-000000000004',
      status: 'active',
    }),
    actionCoreFailure(actionTransactionFailure('Core unavailable')),
    actionCoreFailure(actionTransactionFailure('Core unavailable')),
  ]);
  const service = makeIdentityLifecycleService(
    actionRuntime.runtime,
    makeApiKeyServiceDouble({
      clearPendingCleanup: () => Effect.void,
      issue: () => Effect.succeed(issued),
      pendingCleanup: () => Effect.succeed({ hasMore: false, providerKeyIds: [] }),
    }),
    resolver,
  );

  const result = await Effect.runPromise(
    service.rotate({
      correlationId: 'correlation-4',
      idempotencyKey: 'rotate-2',
      oldAuthBindingId: '00000000-0000-4000-8000-000000000005',
      principal,
      reason: 'Scheduled credential rotation',
      requestHeaders: new Headers(),
    }),
  );
  expect(result.secret).toBe(issued.secret);
  expect(JSON.stringify(result)).not.toContain('ontos-secret');
  expect(result.cleanupPending).toBe(true);
  expect(actionRuntime.invocationCount()).toBe(3);
});

test('returns the replacement secret when old Core closure committed but provider state is unavailable', async () => {
  let resolverCalls = 0;
  const providerUnavailable = new ApiKeyProviderUnavailableError({
    code: 'api_key_provider_unavailable',
    reason: 'The provider is unavailable',
  });
  const actionRuntime = makeActionRuntimeDouble([
    actionSuccess({
      authBindingId: '00000000-0000-4000-8000-000000000004',
      status: 'active',
    }),
    actionSuccess({ previousStatus: 'active', status: 'revoked' }),
  ]);
  const service = makeIdentityLifecycleService(
    actionRuntime.runtime,
    makeApiKeyServiceDouble({
      clearPendingCleanup: () => Effect.void,
      issue: () => Effect.succeed(issued),
      metadata: () => Effect.fail(providerUnavailable),
      pendingCleanup: () => Effect.succeed({ hasMore: false, providerKeyIds: [] }),
      setEnabled: (keyId, enabled) =>
        keyId === 'old-provider-key-id' && !enabled
          ? Effect.fail(providerUnavailable)
          : Effect.succeed({ ...issued, providerKeyId: keyId }),
    }),
    makePrincipalResolverDouble({
      loadApiKeyBindingForAdministration: () => {
        resolverCalls += 1;
        return Effect.succeed({
          providerSubjectId: 'old-provider-key-id',
          status: resolverCalls === 1 ? 'active' : 'revoked',
        });
      },
    }),
  );

  const result = await Effect.runPromise(
    service.rotate({
      correlationId: 'correlation-old-core-closed',
      idempotencyKey: 'rotate-old-core-closed',
      oldAuthBindingId: '00000000-0000-4000-8000-000000000005',
      principal,
      reason: 'Scheduled credential rotation',
      requestHeaders: new Headers(),
    }),
  );

  expect(result.secret).toBe(issued.secret);
  expect(JSON.stringify(result)).not.toContain('ontos-secret');
  expect(result.cleanupPending).toBe(true);
  expect(actionRuntime.invocationCount()).toBe(2);
  expect(resolverCalls).toBe(2);
});

test('does not return a replacement secret after rollback definitely revoked its Core binding', async () => {
  let replacementReads = 0;
  const providerUnavailable = new ApiKeyProviderUnavailableError({
    code: 'api_key_provider_unavailable',
    reason: 'The provider is unavailable',
  });
  const oldFailure = new IdentityTargetInvalidError({
    code: 'identity_target_invalid',
    reason: 'The old binding could not be closed',
  });
  const actionRuntime = makeActionRuntimeDouble([
    actionSuccess({
      authBindingId: '00000000-0000-4000-8000-000000000004',
      status: 'active',
    }),
    actionDomainFailure(oldFailure),
    actionSuccess({ previousStatus: 'active', status: 'revoked' }),
  ]);
  const service = makeIdentityLifecycleService(
    actionRuntime.runtime,
    makeApiKeyServiceDouble({
      clearPendingCleanup: () => Effect.void,
      issue: () => Effect.succeed(issued),
      metadata: () => Effect.fail(providerUnavailable),
      pendingCleanup: () => Effect.succeed({ hasMore: false, providerKeyIds: [] }),
      setEnabled: () => Effect.fail(providerUnavailable),
    }),
    makePrincipalResolverDouble({
      loadApiKeyBindingForAdministration: (input) => {
        if (input.authBindingId === '00000000-0000-4000-8000-000000000004') {
          replacementReads += 1;
          return Effect.succeed({
            providerSubjectId: 'replacement-provider-key-id',
            status: replacementReads === 1 ? 'active' : 'revoked',
          });
        }
        return Effect.succeed({
          providerSubjectId: 'old-provider-key-id',
          status: 'active',
        });
      },
    }),
  );

  const failure = await Effect.runPromise(
    Effect.flip(
      service.rotate({
        correlationId: 'correlation-definite-replacement-rollback',
        idempotencyKey: 'definite-replacement-rollback',
        oldAuthBindingId: '00000000-0000-4000-8000-000000000005',
        principal,
        reason: 'Scheduled credential rotation',
        requestHeaders: new Headers(),
      }),
    ),
  );

  expect(failure).toBe(oldFailure);
  expect(actionRuntime.invocationCount()).toBe(3);
  expect(replacementReads).toBe(2);
});

test('cleans one bounded pending batch and requires a retry before issuing another key', async () => {
  const disabled: string[] = [];
  let issueCalls = 0;
  const service = makeIdentityLifecycleService(
    makeActionRuntimeDouble([actionDefect('must not bind')]).runtime,
    makeApiKeyServiceDouble({
      clearPendingCleanup: () => Effect.void,
      issue: () => {
        issueCalls += 1;
        return Effect.succeed(issued);
      },
      pendingCleanup: () => Effect.succeed({ hasMore: true, providerKeyIds: ['bounded-orphan'] }),
      setEnabled: (keyId, enabled) => {
        if (!enabled) {
          disabled.push(keyId);
        }
        return Effect.succeed({ ...issued, providerKeyId: keyId });
      },
    }),
    makePrincipalResolverDouble({
      resolveBetterAuthApiKey: () => Effect.fail(new PrincipalBindingMissingError()),
    }),
  );

  const failure = await Effect.runPromise(
    Effect.flip(
      service.issue({
        correlationId: 'correlation-bounded-cleanup',
        idempotencyKey: 'bounded-cleanup',
        principal,
        requestHeaders: new Headers(),
      }),
    ),
  );

  expect(failure._tag).toBe('IdentityLifecycleOperationError');
  expect(disabled).toEqual(['bounded-orphan']);
  expect(issueCalls).toBe(0);
});

test('retries provider cleanup without repeating an already committed Core transition', async () => {
  const actionRuntime = makeActionRuntimeDouble([actionDefect(new Error('must not run'))]);
  const service = makeIdentityLifecycleService(
    actionRuntime.runtime,
    makeApiKeyServiceDouble({
      metadata: () => Effect.succeed({ ...issued, enabled: false }),
      setEnabled: () => Effect.succeed({ ...issued, enabled: false }),
    }),
    makePrincipalResolverDouble({
      loadApiKeyBindingForAdministration: () =>
        Effect.succeed({ providerSubjectId: 'old-provider-key-id', status: 'revoked' }),
    }),
  );

  const result = await Effect.runPromise(
    service.setStatus({
      authBindingId: '00000000-0000-4000-8000-000000000005',
      correlationId: 'correlation-5',
      expectedStatus: 'active',
      idempotencyKey: 'revoke-retry',
      newStatus: 'revoked',
      principal,
      reason: 'Retry provider cleanup',
    }),
  );
  expect(result.cleanupPending).toBe(false);
  expect(actionRuntime.invocationCount()).toBe(0);
});

test('preserves provider metadata failure after a safe Core disable instead of fabricating state', async () => {
  const metadataFailure = new ApiKeyStateInconsistentError({
    code: 'api_key_state_inconsistent',
    reason: 'The provider key row is missing',
  });
  const actionRuntime = makeActionRuntimeDouble([
    actionSuccess({ previousStatus: 'active', status: 'disabled' }),
  ]);
  const service = makeIdentityLifecycleService(
    actionRuntime.runtime,
    makeApiKeyServiceDouble({
      metadata: () => Effect.fail(metadataFailure),
      setEnabled: () =>
        Effect.fail(
          new ApiKeyProviderUnavailableError({
            code: 'api_key_provider_unavailable',
            reason: 'The provider is unavailable',
          }),
        ),
    }),
    resolver,
  );

  const failure = await Effect.runPromise(
    Effect.flip(
      service.setStatus({
        authBindingId: '00000000-0000-4000-8000-000000000005',
        correlationId: 'correlation-provider-metadata-failure',
        expectedStatus: 'active',
        idempotencyKey: 'disable-provider-metadata-failure',
        newStatus: 'disabled',
        principal,
        reason: 'Disable a missing provider key',
      }),
    ),
  );

  expect(failure).toBe(metadataFailure);
  expect(actionRuntime.invocationCount()).toBe(1);
});

test('reconciles a provider key left pending by failed bind compensation before retrying issue', async () => {
  const disabled: string[] = [];
  const cleared: string[] = [];
  const service = makeIdentityLifecycleService(
    makeActionRuntimeDouble([
      actionSuccess({
        authBindingId: '00000000-0000-4000-8000-000000000004',
        status: 'active',
      }),
    ]).runtime,
    makeApiKeyServiceDouble({
      clearPendingCleanup: (keyId) => {
        cleared.push(keyId);
        return Effect.void;
      },
      issue: () => Effect.succeed(issued),
      pendingCleanup: () =>
        Effect.succeed({ hasMore: false, providerKeyIds: ['orphan-provider-key-id'] }),
      setEnabled: (keyId, enabled) => {
        if (!enabled) {
          disabled.push(keyId);
        }
        return Effect.succeed({ ...issued, providerKeyId: keyId });
      },
    }),
    makePrincipalResolverDouble({
      resolveBetterAuthApiKey: () => Effect.fail(new PrincipalBindingMissingError()),
    }),
  );

  const result = await Effect.runPromise(
    service.issue({
      correlationId: 'correlation-6',
      idempotencyKey: 'issue-retry',
      principal,
      requestHeaders: new Headers(),
    }),
  );

  expect(result.secret).toBe(issued.secret);
  expect(JSON.stringify(result)).not.toContain('ontos-secret');
  expect(disabled).toEqual(['orphan-provider-key-id']);
  expect(cleared).toEqual(['orphan-provider-key-id', 'private-provider-key-id']);
});
