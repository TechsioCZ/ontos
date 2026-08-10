// @effect-diagnostics asyncFunction:off
import { expect, test } from '@rstest/core';
import { IdentityTargetInvalidError, PrincipalBindingMissingError } from '@app/core-runtime';
import { Effect } from 'effect';
import {
  ApiKeyProviderUnavailableError,
  ApiKeyStateInconsistentError,
  classifyPendingApiKeyCleanup,
} from '../../api/auth/api-key-service.ts';
import { makeIdentityLifecycleService } from '../../api/auth/identity-lifecycle.ts';

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
  secret: 'ontos-secret',
  start: 'onto',
};
const resolver = {
  loadApiKeyBindingForAdministration: () =>
    Effect.succeed({ providerSubjectId: 'old-provider-key-id', status: 'active' as const }),
};
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
    { runAction: () => Effect.fail(bindFailure) } as never,
    {
      clearPendingCleanup: () => Effect.void,
      issue: () => Effect.succeed(issued),
      pendingCleanup: () => Effect.succeed({ hasMore: false, providerKeyIds: [] }),
      setEnabled: (keyId: string) => {
        disabled.push(keyId);
        return Effect.succeed({ ...issued, providerKeyId: keyId });
      },
    } as never,
    resolver as never,
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
    { runAction: () => Effect.die('must not run') } as never,
    {} as never,
    {
      loadApiKeyBindingForAdministration: () => Effect.fail(resolverFailure),
    } as never,
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
    { runAction: () => Effect.fail(actionFailure) } as never,
    {
      setEnabled: () => {
        providerCalls += 1;
        return Effect.succeed(issued);
      },
    } as never,
    resolver as never,
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
    {
      runAction: () =>
        Effect.succeed({
          authBindingId: '00000000-0000-4000-8000-000000000004',
          status: 'active',
        }),
    } as never,
    {
      clearPendingCleanup: () => Effect.void,
      issue: () => Effect.succeed(issued),
      pendingCleanup: () => Effect.succeed({ hasMore: false, providerKeyIds: [] }),
      setEnabled: () => Effect.succeed(issued),
    } as never,
    resolver as never,
  );

  const result = await Effect.runPromise(
    service.issue({
      correlationId: 'correlation-2',
      idempotencyKey: 'issue-2',
      principal,
      requestHeaders: new Headers(),
    }),
  );
  expect(result.secret).toBe('ontos-secret');
  expect(Object.hasOwn(result, 'providerKeyId')).toBe(false);
});

test('revokes the replacement before failing when closing the old Core binding fails', async () => {
  let calls = 0;
  const disabled: string[] = [];
  const service = makeIdentityLifecycleService(
    {
      runAction: () => {
        calls += 1;
        return calls === 1 || calls === 3
          ? Effect.succeed({
              authBindingId: '00000000-0000-4000-8000-000000000004',
              status: 'active',
            })
          : Effect.fail(new Error('old binding unavailable'));
      },
    } as never,
    {
      clearPendingCleanup: () => Effect.void,
      issue: () => Effect.succeed(issued),
      metadata: () => Effect.succeed(issued),
      pendingCleanup: () => Effect.succeed({ hasMore: false, providerKeyIds: [] }),
      setEnabled: (keyId: string, enabled: boolean) => {
        if (!enabled) {
          disabled.push(keyId);
        }
        return Effect.succeed({ ...issued, providerKeyId: keyId });
      },
    } as never,
    resolver as never,
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
  expect(calls).toBe(3);
  expect(disabled).toEqual(['old-provider-key-id']);
});

test('returns the replacement secret when both old closure and replacement rollback are unavailable', async () => {
  let calls = 0;
  const service = makeIdentityLifecycleService(
    {
      runAction: () => {
        calls += 1;
        return calls === 1
          ? Effect.succeed({
              authBindingId: '00000000-0000-4000-8000-000000000004',
              status: 'active',
            })
          : Effect.fail(new Error('Core unavailable'));
      },
    } as never,
    {
      clearPendingCleanup: () => Effect.void,
      issue: () => Effect.succeed(issued),
      pendingCleanup: () => Effect.succeed({ hasMore: false, providerKeyIds: [] }),
    } as never,
    resolver as never,
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
  expect(result.secret).toBe('ontos-secret');
  expect(result.cleanupPending).toBe(true);
  expect(calls).toBe(3);
});

test('returns the replacement secret when old Core closure committed but provider state is unavailable', async () => {
  let actionCalls = 0;
  let resolverCalls = 0;
  const providerUnavailable = new ApiKeyProviderUnavailableError({
    code: 'api_key_provider_unavailable',
    reason: 'The provider is unavailable',
  });
  const service = makeIdentityLifecycleService(
    {
      runAction: () => {
        actionCalls += 1;
        return Effect.succeed(
          actionCalls === 1
            ? {
                authBindingId: '00000000-0000-4000-8000-000000000004',
                status: 'active',
              }
            : { status: 'revoked' },
        );
      },
    } as never,
    {
      clearPendingCleanup: () => Effect.void,
      issue: () => Effect.succeed(issued),
      metadata: () => Effect.fail(providerUnavailable),
      pendingCleanup: () => Effect.succeed({ hasMore: false, providerKeyIds: [] }),
      setEnabled: (keyId: string, enabled: boolean) =>
        keyId === 'old-provider-key-id' && !enabled
          ? Effect.fail(providerUnavailable)
          : Effect.succeed({ ...issued, providerKeyId: keyId }),
    } as never,
    {
      loadApiKeyBindingForAdministration: () => {
        resolverCalls += 1;
        return Effect.succeed({
          providerSubjectId: 'old-provider-key-id',
          status: resolverCalls === 1 ? ('active' as const) : ('revoked' as const),
        });
      },
    } as never,
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

  expect(result.secret).toBe('ontos-secret');
  expect(result.cleanupPending).toBe(true);
  expect(actionCalls).toBe(2);
  expect(resolverCalls).toBe(2);
});

test('does not return a replacement secret after rollback definitely revoked its Core binding', async () => {
  let actionCalls = 0;
  let replacementReads = 0;
  const providerUnavailable = new ApiKeyProviderUnavailableError({
    code: 'api_key_provider_unavailable',
    reason: 'The provider is unavailable',
  });
  const oldFailure = new IdentityTargetInvalidError({
    code: 'identity_target_invalid',
    reason: 'The old binding could not be closed',
  });
  const service = makeIdentityLifecycleService(
    {
      runAction: () => {
        actionCalls += 1;
        if (actionCalls === 1) {
          return Effect.succeed({
            authBindingId: '00000000-0000-4000-8000-000000000004',
            status: 'active',
          });
        }
        return actionCalls === 2 ? Effect.fail(oldFailure) : Effect.succeed({ status: 'revoked' });
      },
    } as never,
    {
      clearPendingCleanup: () => Effect.void,
      issue: () => Effect.succeed(issued),
      metadata: () => Effect.fail(providerUnavailable),
      pendingCleanup: () => Effect.succeed({ hasMore: false, providerKeyIds: [] }),
      setEnabled: () => Effect.fail(providerUnavailable),
    } as never,
    {
      loadApiKeyBindingForAdministration: (input: { readonly authBindingId: string }) => {
        if (input.authBindingId === '00000000-0000-4000-8000-000000000004') {
          replacementReads += 1;
          return Effect.succeed({
            providerSubjectId: 'replacement-provider-key-id',
            status: replacementReads === 1 ? ('active' as const) : ('revoked' as const),
          });
        }
        return Effect.succeed({
          providerSubjectId: 'old-provider-key-id',
          status: 'active' as const,
        });
      },
    } as never,
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
  expect(actionCalls).toBe(3);
  expect(replacementReads).toBe(2);
});

test('cleans one bounded pending batch and requires a retry before issuing another key', async () => {
  const disabled: string[] = [];
  let issueCalls = 0;
  const service = makeIdentityLifecycleService(
    { runAction: () => Effect.die('must not bind') } as never,
    {
      clearPendingCleanup: () => Effect.void,
      issue: () => {
        issueCalls += 1;
        return Effect.succeed(issued);
      },
      pendingCleanup: () => Effect.succeed({ hasMore: true, providerKeyIds: ['bounded-orphan'] }),
      setEnabled: (keyId: string, enabled: boolean) => {
        if (!enabled) {
          disabled.push(keyId);
        }
        return Effect.succeed({ ...issued, providerKeyId: keyId });
      },
    } as never,
    {
      resolveBetterAuthApiKey: () => Effect.fail(new PrincipalBindingMissingError()),
    } as never,
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
  let actionCalls = 0;
  const service = makeIdentityLifecycleService(
    {
      runAction: () => {
        actionCalls += 1;
        return Effect.fail(new Error('must not run'));
      },
    } as never,
    {
      metadata: () => Effect.succeed({ ...issued, enabled: false }),
      setEnabled: () => Effect.succeed({ ...issued, enabled: false }),
    } as never,
    {
      loadApiKeyBindingForAdministration: () =>
        Effect.succeed({ providerSubjectId: 'old-provider-key-id', status: 'revoked' }),
    } as never,
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
  expect(actionCalls).toBe(0);
});

test('preserves provider metadata failure after a safe Core disable instead of fabricating state', async () => {
  const metadataFailure = new ApiKeyStateInconsistentError({
    code: 'api_key_state_inconsistent',
    reason: 'The provider key row is missing',
  });
  let actionCalls = 0;
  const service = makeIdentityLifecycleService(
    {
      runAction: () => {
        actionCalls += 1;
        return Effect.succeed({ status: 'disabled' });
      },
    } as never,
    {
      metadata: () => Effect.fail(metadataFailure),
      setEnabled: () =>
        Effect.fail(
          new ApiKeyProviderUnavailableError({
            code: 'api_key_provider_unavailable',
            reason: 'The provider is unavailable',
          }),
        ),
    } as never,
    resolver as never,
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
  expect(actionCalls).toBe(1);
});

test('reconciles a provider key left pending by failed bind compensation before retrying issue', async () => {
  const disabled: string[] = [];
  const cleared: string[] = [];
  const service = makeIdentityLifecycleService(
    {
      runAction: () =>
        Effect.succeed({
          authBindingId: '00000000-0000-4000-8000-000000000004',
          status: 'active',
        }),
    } as never,
    {
      clearPendingCleanup: (keyId: string) => {
        cleared.push(keyId);
        return Effect.void;
      },
      issue: () => Effect.succeed(issued),
      pendingCleanup: () =>
        Effect.succeed({ hasMore: false, providerKeyIds: ['orphan-provider-key-id'] }),
      setEnabled: (keyId: string, enabled: boolean) => {
        if (!enabled) {
          disabled.push(keyId);
        }
        return Effect.succeed({ ...issued, providerKeyId: keyId });
      },
    } as never,
    {
      resolveBetterAuthApiKey: () => Effect.fail({ _tag: 'PrincipalBindingMissingError' as const }),
    } as never,
  );

  const result = await Effect.runPromise(
    service.issue({
      correlationId: 'correlation-6',
      idempotencyKey: 'issue-retry',
      principal,
      requestHeaders: new Headers(),
    }),
  );

  expect(result.secret).toBe('ontos-secret');
  expect(disabled).toEqual(['orphan-provider-key-id']);
  expect(cleared).toEqual(['orphan-provider-key-id', 'private-provider-key-id']);
});
