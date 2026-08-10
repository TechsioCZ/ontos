// @effect-diagnostics anyUnknownInErrorContext:off asyncFunction:off
/* eslint-disable no-await-in-loop -- The table-driven assertions intentionally preserve failure locality. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import {
  bindApiKey,
  changePrincipalStatus,
  setApiKeyBindingStatus,
  validateSupportImpersonation,
} from '../../src/auth/principal-management.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const authBindingId = '30000000-0000-4000-8000-000000000001';

const selecting = (record: unknown) => {
  const query = {
    innerJoin: () => query,
    where: () => ({ limit: () => Promise.resolve(record === undefined ? [] : [record]) }),
  };
  return { select: () => ({ from: () => query }) };
};

const transactionForSupportParticipants = (results: readonly (readonly unknown[])[]) => {
  let call = 0;
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: () => {
              const result = results[call] ?? [];
              call += 1;
              return Promise.resolve(result);
            },
          }),
        }),
      }),
    }),
  } as never;
};

test('rejects human principal administration and managed keys targeting humans', async () => {
  const transaction = selecting({ kind: 'human', status: 'active' }) as never;
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
        selecting({
          bindingStatus: 'disabled',
          principalKind: 'service',
          principalStatus: 'active',
        }) as never,
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
        selecting({
          bindingStatus: 'revoked',
          principalKind: 'service',
          principalStatus: 'active',
        }) as never,
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
        selecting({
          bindingStatus: 'active',
          principalKind: 'service',
          principalStatus: 'active',
        }) as never,
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
  for (const record of [
    { bindingStatus: 'active', principalKind: 'human', principalStatus: 'active' },
    { bindingStatus: 'active', principalKind: 'service', principalStatus: 'disabled' },
  ]) {
    const error = await Effect.runPromise(
      Effect.flip(
        setApiKeyBindingStatus(selecting(record) as never, {
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
  let inserted: Record<string, unknown> | undefined;
  const transaction = {
    ...selecting({ kind: 'service', status: 'active' }),
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        inserted = value;
        return {
          returning: () => Promise.resolve([{ authBindingId }]),
        };
      },
    }),
  } as never;
  const result = await Effect.runPromise(
    bindApiKey(transaction, {
      managed: true,
      principalId,
      providerSubjectId: 'provider-key-id',
      tenantId,
    }),
  );

  assert.deepEqual(result, { authBindingId, status: 'active' });
  assert.equal(inserted?.['providerSubjectId'], 'provider-key-id');
  assert.equal('key' in (inserted ?? {}), false);
  assert.equal('secret' in (inserted ?? {}), false);
  assert.equal('hash' in (inserted ?? {}), false);
});

test('maps wrapped PostgreSQL uniqueness failures to a lifecycle conflict', async () => {
  const transaction = {
    ...selecting({ kind: 'service', status: 'active' }),
    insert: () => ({
      values: () => ({
        returning: () =>
          Promise.reject(
            new Error('Drizzle query failed', {
              cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
            }),
          ),
      }),
    }),
  } as never;

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
  const input = {
    checkpoint: 'requested' as const,
    originalAuthBindingId: authBindingId,
    originalPrincipalId: principalId,
    targetPrincipalId: '20000000-0000-4000-8000-000000000002',
    tenantId,
  };

  await Effect.runPromise(
    validateSupportImpersonation(transactionForSupportParticipants([original, target]), input),
  );
  const error = await Effect.runPromise(
    Effect.flip(
      validateSupportImpersonation(transactionForSupportParticipants([original, []]), input),
    ),
  );

  assert.equal(error._tag, 'IdentityTargetInvalidError');

  await Effect.runPromise(
    validateSupportImpersonation(transactionForSupportParticipants([original, target]), {
      ...input,
      checkpoint: 'stopped',
    }),
  );
});
