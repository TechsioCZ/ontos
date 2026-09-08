import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import assert from 'node:assert/strict';
import { test } from '@rstest/core';
import { ContextAccess, LegalEntityContext } from '@app/core-runtime';
import type { ContextAccessService, LegalEntityContextService } from '@app/core-runtime';
import { Effect, Layer } from 'effect';
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

const context = (entities = [alpha, beta] as const): LegalEntityContextService => ({
  listActiveForTenant: () => Effect.succeed(entities),
  validateSelection: (_tenantId, legalEntityId) => {
    const selected = entities.find((entity) => entity.legalEntityId === legalEntityId);
    return selected === undefined ? Effect.die('missing fixture entity') : Effect.succeed(selected);
  },
});

const access = (
  decisions: Readonly<Record<string, 'allowed' | 'denied' | 'unavailable'>>,
): ContextAccessService => ({
  legalEntities: ({ legalEntityIds }) =>
    Effect.succeed(legalEntityIds.map((key) => ({ decision: decisions[key] ?? 'denied', key }))),
  modules: ({ moduleIds }) =>
    Effect.succeed(moduleIds.map((key) => ({ decision: 'denied' as const, key }))),
  resources: () => Effect.succeed([]),
  tenants: ({ tenantIds }) =>
    Effect.succeed(tenantIds.map((key) => ({ decision: 'denied' as const, key }))),
});

const provideSelectionServices = <Success, Failure>(
  effect: Effect.Effect<Success, Failure, ContextAccess | LegalEntityContext>,
  legalEntityContext: LegalEntityContextService,
  contextAccess: ContextAccessService,
): Effect.Effect<Success, Failure> =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LegalEntityContext, legalEntityContext),
        Layer.succeed(ContextAccess, contextAccess),
      ),
    ),
  );

test('auto-selects the only authorized entity and preserves an exact saved choice', async () => {
  const only = await runEffectTestPromise(
    provideSelectionServices(
      resolveAuthorizedLegalEntities({ principalId, tenantId }),
      context(),
      access({ [alpha.legalEntityId]: 'allowed' }),
    ),
  );
  assert.deepEqual(only, { available: [alpha], selected: alpha, state: 'selected' });
  const saved = await runEffectTestPromise(
    provideSelectionServices(
      resolveAuthorizedLegalEntities({
        principalId,
        savedLegalEntityId: beta.legalEntityId,
        tenantId,
      }),
      context(),
      access({ [alpha.legalEntityId]: 'allowed', [beta.legalEntityId]: 'allowed' }),
    ),
  );
  assert.deepEqual(saved, { available: [alpha, beta], selected: beta, state: 'selected' });
});

test('requires a choice for several entities and blocks zero definite grants', async () => {
  assert.deepEqual(
    await runEffectTestPromise(
      provideSelectionServices(
        resolveAuthorizedLegalEntities({ principalId, tenantId }),
        context(),
        access({ [alpha.legalEntityId]: 'allowed', [beta.legalEntityId]: 'allowed' }),
      ),
    ),
    { available: [alpha, beta], state: 'selection_required' },
  );
  assert.deepEqual(
    await runEffectTestPromise(
      provideSelectionServices(
        resolveAuthorizedLegalEntities({ principalId, tenantId }),
        context(),
        access({}),
      ),
    ),
    { available: [], state: 'access_blocked' },
  );
});

test('fails closed for authorization uncertainty and validates a switch independently', async () => {
  const unavailable = await runEffectTestPromise(
    Effect.flip(
      provideSelectionServices(
        resolveAuthorizedLegalEntities({ principalId, tenantId }),
        context(),
        access({ [alpha.legalEntityId]: 'unavailable' }),
      ),
    ),
  );
  assert.equal(unavailable._tag, 'LegalEntitySelectionUnavailableError');
  assert.deepEqual(
    await runEffectTestPromise(
      provideSelectionServices(
        validateAuthorizedLegalEntity({
          legalEntityId: beta.legalEntityId,
          principalId,
          tenantId,
        }),
        context(),
        access({ [beta.legalEntityId]: 'allowed' }),
      ),
    ),
    beta,
  );
});
