import assert from 'node:assert/strict';
import { test } from '@rstest/core';
import type { ContextAccessShape, LegalEntityContextShape } from '@app/core-runtime';
import { Effect } from 'effect';
import {
  resolveAuthorizedLegalEntities,
  validateAuthorizedLegalEntity,
} from '../../api/auth/legal-entity-selection.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const alpha = {
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  legalName: 'Alpha',
};
const beta = {
  legalEntityId: '30000000-0000-4000-8000-000000000002',
  legalName: 'Beta',
};

const context = (entities = [alpha, beta] as const): LegalEntityContextShape => ({
  listActiveForTenant: () => Effect.succeed(entities),
  validateSelection: (_tenantId, legalEntityId) => {
    const selected = entities.find((entity) => entity.legalEntityId === legalEntityId);
    return selected === undefined ? Effect.die('missing fixture entity') : Effect.succeed(selected);
  },
});

const access = (
  decisions: Readonly<Record<string, 'allowed' | 'denied' | 'unavailable'>>,
): ContextAccessShape => ({
  legalEntities: ({ legalEntityIds }) =>
    Effect.succeed(legalEntityIds.map((key) => ({ decision: decisions[key] ?? 'denied', key }))),
  modules: ({ moduleIds }) =>
    Effect.succeed(moduleIds.map((key) => ({ decision: 'denied' as const, key }))),
  resources: () => Effect.succeed([]),
});

test('auto-selects the only authorized entity and preserves an exact saved choice', async () => {
  const only = await Effect.runPromise(
    resolveAuthorizedLegalEntities(context(), access({ [alpha.legalEntityId]: 'allowed' }), {
      principalId,
      tenantId,
    }),
  );
  assert.deepEqual(only, { available: [alpha], selected: alpha, state: 'selected' });
  const saved = await Effect.runPromise(
    resolveAuthorizedLegalEntities(
      context(),
      access({ [alpha.legalEntityId]: 'allowed', [beta.legalEntityId]: 'allowed' }),
      { principalId, savedLegalEntityId: beta.legalEntityId, tenantId },
    ),
  );
  assert.deepEqual(saved, { available: [alpha, beta], selected: beta, state: 'selected' });
});

test('requires a choice for several entities and blocks zero definite grants', async () => {
  assert.deepEqual(
    await Effect.runPromise(
      resolveAuthorizedLegalEntities(
        context(),
        access({ [alpha.legalEntityId]: 'allowed', [beta.legalEntityId]: 'allowed' }),
        { principalId, tenantId },
      ),
    ),
    { available: [alpha, beta], state: 'selection_required' },
  );
  assert.deepEqual(
    await Effect.runPromise(
      resolveAuthorizedLegalEntities(context(), access({}), { principalId, tenantId }),
    ),
    { available: [], state: 'access_blocked' },
  );
});

test('fails closed for authorization uncertainty and validates a switch independently', async () => {
  const unavailable = await Effect.runPromise(
    Effect.flip(
      resolveAuthorizedLegalEntities(context(), access({ [alpha.legalEntityId]: 'unavailable' }), {
        principalId,
        tenantId,
      }),
    ),
  );
  assert.equal(unavailable._tag, 'LegalEntitySelectionUnavailableError');
  assert.deepEqual(
    await Effect.runPromise(
      validateAuthorizedLegalEntity(context(), access({ [beta.legalEntityId]: 'allowed' }), {
        legalEntityId: beta.legalEntityId,
        principalId,
        tenantId,
      }),
    ),
    beta,
  );
});
