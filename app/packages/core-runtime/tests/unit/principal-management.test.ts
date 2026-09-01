// @effect-diagnostics anyUnknownInErrorContext:off asyncFunction:off
/* eslint-disable no-await-in-loop -- The table-driven assertions intentionally preserve failure locality. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import type { PrincipalManagementRepositoryService } from '../../src/auth/principal-management.ts';
import {
  bindApiKey,
  changePrincipalStatus,
  setApiKeyBindingStatus,
  validateSupportImpersonation,
} from '../../src/auth/principal-management.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const authBindingId = '30000000-0000-4000-8000-000000000001';

const unconfigured = (operation: string) =>
  Promise.reject(new Error(`${operation} is not configured in this test`));
const repositoryDefaults: PrincipalManagementRepositoryService = {
  createPrincipal: () => unconfigured('createPrincipal'),
  insertApiKeyBinding: () => unconfigured('insertApiKeyBinding'),
  loadApiKeyBinding: () => unconfigured('loadApiKeyBinding'),
  loadPrincipal: () => unconfigured('loadPrincipal'),
  loadSupportBindings: () => unconfigured('loadSupportBindings'),
  updateApiKeyBindingStatus: () => unconfigured('updateApiKeyBindingStatus'),
  updatePrincipalStatus: () => unconfigured('updatePrincipalStatus'),
};
const repository = (
  overrides: Partial<PrincipalManagementRepositoryService>,
): PrincipalManagementRepositoryService => ({ ...repositoryDefaults, ...overrides });
const selectingPrincipal = (
  record: Awaited<ReturnType<PrincipalManagementRepositoryService['loadPrincipal']>>,
) => repository({ loadPrincipal: () => Promise.resolve(record) });
const selectingBinding = (
  record: Awaited<ReturnType<PrincipalManagementRepositoryService['loadApiKeyBinding']>>,
) => repository({ loadApiKeyBinding: () => Promise.resolve(record) });
const repositoryForSupportParticipants = (
  results: readonly (readonly { readonly authBindingId: string }[])[],
) => {
  let call = 0;
  return repository({
    loadSupportBindings: () => {
      const result = results[call] ?? [];
      call += 1;
      return Promise.resolve(result);
    },
  });
};

test('rejects human principal administration and managed keys targeting humans', async () => {
  const transaction = selectingPrincipal({ kind: 'human', status: 'active' });
  const principalError = await Effect.runPromise(
    Effect.flip(
      changePrincipalStatus(transaction, {
        expectedStatus: 'active',
        newStatus: 'disabled',
        principalId,
        reason: 'Offboarding',
        tenantId,
      }),
    ),
  );
  const bindingError = await Effect.runPromise(
    Effect.flip(
      bindApiKey(transaction, {
        managed: true,
        principalId,
        providerSubjectId: 'provider-key-id',
        tenantId,
      }),
    ),
  );

  assert.equal(principalError._tag, 'IdentityTargetInvalidError');
  assert.equal(bindingError._tag, 'IdentityTargetInvalidError');
});

test('enforces expected state, terminal revocation, and revocation reasons', async () => {
  const conflictError = await Effect.runPromise(
    Effect.flip(
      setApiKeyBindingStatus(
        selectingBinding({
          bindingStatus: 'disabled',
          principalKind: 'service',
          principalStatus: 'active',
        }),
        {
          authBindingId,
          expectedStatus: 'active',
          managed: true,
          newStatus: 'revoked',
          principalId,
          reason: 'Rotate',
          tenantId,
        },
      ),
    ),
  );
  const terminalError = await Effect.runPromise(
    Effect.flip(
      setApiKeyBindingStatus(
        selectingBinding({
          bindingStatus: 'revoked',
          principalKind: 'service',
          principalStatus: 'active',
        }),
        {
          authBindingId,
          expectedStatus: 'revoked',
          managed: true,
          newStatus: 'active',
          principalId,
          tenantId,
        },
      ),
    ),
  );
  const reasonError = await Effect.runPromise(
    Effect.flip(
      setApiKeyBindingStatus(
        selectingBinding({
          bindingStatus: 'active',
          principalKind: 'service',
          principalStatus: 'active',
        }),
        {
          authBindingId,
          expectedStatus: 'active',
          managed: true,
          newStatus: 'revoked',
          principalId,
          reason: '   ',
          tenantId,
        },
      ),
    ),
  );

  assert.equal(conflictError._tag, 'IdentityLifecycleConflictError');
  assert.equal(terminalError._tag, 'IdentityLifecycleConflictError');
  assert.equal(reasonError._tag, 'IdentityTargetInvalidError');
});

test('rejects managed binding transitions for human or inactive targets', async () => {
  const records = [
    { bindingStatus: 'active', principalKind: 'human', principalStatus: 'active' },
    { bindingStatus: 'active', principalKind: 'service', principalStatus: 'disabled' },
  ] satisfies readonly NonNullable<
    Awaited<ReturnType<PrincipalManagementRepositoryService['loadApiKeyBinding']>>
  >[];
  for (const record of records) {
    const error = await Effect.runPromise(
      Effect.flip(
        setApiKeyBindingStatus(selectingBinding(record), {
          authBindingId,
          expectedStatus: 'active',
          managed: true,
          newStatus: 'disabled',
          principalId,
          tenantId,
        }),
      ),
    );
    assert.equal(error._tag, 'IdentityTargetInvalidError');
  }
});

test('binds only eligible active self and managed principal kinds without secret material', async () => {
  let inserted:
    | Parameters<PrincipalManagementRepositoryService['insertApiKeyBinding']>[0]
    | undefined;
  const transaction = repository({
    insertApiKeyBinding: (value) => {
      inserted = value;
      return Promise.resolve({ authBindingId });
    },
    loadPrincipal: () => Promise.resolve({ kind: 'service', status: 'active' }),
  });
  const result = await Effect.runPromise(
    bindApiKey(transaction, {
      managed: true,
      principalId,
      providerSubjectId: 'provider-key-id',
      tenantId,
    }),
  );

  assert.deepEqual(result, { authBindingId, status: 'active' });
  assert.equal(inserted?.providerSubjectId, 'provider-key-id');
  assert.equal('key' in (inserted ?? {}), false);
  assert.equal('secret' in (inserted ?? {}), false);
  assert.equal('hash' in (inserted ?? {}), false);
});

test('maps wrapped PostgreSQL uniqueness failures to a lifecycle conflict', async () => {
  const transaction = repository({
    insertApiKeyBinding: () =>
      Promise.reject(
        new Error('Drizzle query failed', {
          cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
        }),
      ),
    loadPrincipal: () => Promise.resolve({ kind: 'service', status: 'active' }),
  });

  const error = await Effect.runPromise(
    Effect.flip(
      bindApiKey(transaction, {
        managed: true,
        principalId,
        providerSubjectId: 'duplicate-provider-key-id',
        tenantId,
      }),
    ),
  );

  assert.equal(error._tag, 'IdentityLifecycleConflictError');
});

test('requires exactly one active tenant-local user binding for both impersonation participants', async () => {
  const original = [{ authBindingId }];
  const target = [{ authBindingId: '30000000-0000-4000-8000-000000000002' }];
  const input: Parameters<typeof validateSupportImpersonation>[1] = {
    checkpoint: 'requested',
    originalAuthBindingId: authBindingId,
    originalPrincipalId: principalId,
    targetPrincipalId: '20000000-0000-4000-8000-000000000002',
    tenantId,
  };

  await Effect.runPromise(
    validateSupportImpersonation(repositoryForSupportParticipants([original, target]), input),
  );
  const error = await Effect.runPromise(
    Effect.flip(
      validateSupportImpersonation(repositoryForSupportParticipants([original, []]), input),
    ),
  );

  assert.equal(error._tag, 'IdentityTargetInvalidError');

  await Effect.runPromise(
    validateSupportImpersonation(repositoryForSupportParticipants([original, target]), {
      ...input,
      checkpoint: 'stopped',
    }),
  );
});
