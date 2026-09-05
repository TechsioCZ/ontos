// @effect-diagnostics anyUnknownInErrorContext:off asyncFunction:off
/* eslint-disable no-await-in-loop -- The table-driven assertions intentionally preserve failure locality. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { Effect, Schema } from 'effect';
import type { PrincipalManagementRepositoryService } from '../../src/auth/principal-management.ts';
import {
  bindApiKey,
  changePrincipalStatus,
  setApiKeyBindingStatus,
  validateSupportImpersonation,
} from '../../src/auth/principal-management.ts';
import { IdentityPersistenceUnavailableError } from '../../src/auth/principal-management-errors.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const authBindingId = '30000000-0000-4000-8000-000000000001';

const unconfigured = async (operation: string) => {
  throw new Error(`${operation} is not configured in this test`);
};
const repositoryDefaults: PrincipalManagementRepositoryService = {
  createPrincipal: async () => await unconfigured('createPrincipal'),
  insertApiKeyBinding: async () => await unconfigured('insertApiKeyBinding'),
  loadApiKeyBinding: async () => await unconfigured('loadApiKeyBinding'),
  loadPrincipal: async () => await unconfigured('loadPrincipal'),
  loadSupportBindings: async () => await unconfigured('loadSupportBindings'),
  updateApiKeyBindingStatus: async () => await unconfigured('updateApiKeyBindingStatus'),
  updatePrincipalStatus: async () => await unconfigured('updatePrincipalStatus'),
};
const repository = (
  overrides: Partial<PrincipalManagementRepositoryService>,
): PrincipalManagementRepositoryService => ({ ...repositoryDefaults, ...overrides });
const selectingPrincipal = (
  record: Awaited<ReturnType<PrincipalManagementRepositoryService['loadPrincipal']>>,
) => repository({ loadPrincipal: async () => record });
const selectingBinding = (
  record: Awaited<ReturnType<PrincipalManagementRepositoryService['loadApiKeyBinding']>>,
) => repository({ loadApiKeyBinding: async () => record });
const repositoryForSupportParticipants = (
  results: readonly (readonly { readonly authBindingId: string }[])[],
) => {
  let call = 0;
  return repository({
    loadSupportBindings: async () => {
      const result = results[call] ?? [];
      call += 1;
      return result;
    },
  });
};

void test('rejects human principal administration and managed keys targeting humans', async () => {
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

void test('enforces expected state, terminal revocation, and revocation reasons', async () => {
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

void test('rejects managed binding transitions for human or inactive targets', async () => {
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

void test('binds only eligible active self and managed principal kinds without secret material', async () => {
  let inserted:
    | Parameters<PrincipalManagementRepositoryService['insertApiKeyBinding']>[0]
    | undefined;
  const transaction = repository({
    insertApiKeyBinding: async (value) => {
      inserted = value;
      return { authBindingId };
    },
    loadPrincipal: async () => ({ kind: 'service', status: 'active' }),
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

void test('maps wrapped PostgreSQL uniqueness failures to a lifecycle conflict', async () => {
  const transaction = repository({
    insertApiKeyBinding: async () => {
      throw new Error('Drizzle query failed', {
        cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
      });
    },
    loadPrincipal: async () => ({ kind: 'service', status: 'active' }),
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

void test('preserves persistence causes outside the public error contract', async () => {
  const originalFailure = Object.assign(new Error('private driver detail'), {
    code: 'XX999',
    credential: 'private credential',
  });
  const transaction = repository({
    insertApiKeyBinding: async () => {
      throw originalFailure;
    },
    loadPrincipal: async () => ({ kind: 'service', status: 'active' }),
  });

  const error = await Effect.runPromise(
    Effect.flip(
      bindApiKey(transaction, {
        managed: true,
        principalId,
        providerSubjectId: 'provider-key-id',
        tenantId,
      }),
    ),
  );

  assert.equal(error._tag, 'IdentityPersistenceUnavailableError');
  if (!Schema.is(IdentityPersistenceUnavailableError)(error)) {
    assert.fail('Expected a persistence-unavailable error');
  }
  assert.strictEqual(error.getOriginalFailure(), originalFailure);
  const encoded = {
    _tag: 'IdentityPersistenceUnavailableError',
    code: 'identity_persistence_unavailable',
    reason: 'Identity state could not be persisted',
  } as const;
  assert.deepEqual(Schema.encodeSync(IdentityPersistenceUnavailableError)(error), encoded);
  const decoded = Schema.decodeUnknownSync(IdentityPersistenceUnavailableError)(encoded);
  assert.equal(decoded.getOriginalFailure(), undefined);
  assert.doesNotMatch(JSON.stringify(error), /private driver detail|private credential|XX999/u);
  assert.doesNotMatch(inspect(error), /private driver detail|private credential|XX999/u);
});

void test('requires exactly one active tenant-local user binding for both impersonation participants', async () => {
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
