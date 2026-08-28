import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off
import test from 'node:test';
import { Effect } from 'effect';
import {
  defineGlobalPolicy,
  defineMicroverticalPolicy,
  denyPolicy,
  isActionPolicy,
} from '../../src/actions/policy.ts';
import type { ActionPolicyEvaluatorInput } from '../../src/actions/policy.ts';

const input = {
  action: {
    actionKey: 'inventory.stock.reserve',
    owningModuleKey: 'inventory.stock',
    schemaVersion: '1',
  },
  payload: { quantity: 2 },
  principal: {
    authMethod: 'session',
    principalId: '00000000-0000-4000-8000-000000000002',
    tenantId: '00000000-0000-4000-8000-000000000001',
  },
  target: {
    targetModuleKey: 'inventory.stock',
    targetResourceId: 'sku-1',
    targetResourceType: 'stock-item',
  },
  transport: { correlationId: 'correlation-policy' },
} as const;

void test('defines immutable global and owner-local Policy references', () => {
  const globalPolicy = defineGlobalPolicy<typeof input.payload>({
    evaluate: () => Effect.void,
    policyKey: 'global.tenant-active.v1',
  });
  const modulePolicy = defineMicroverticalPolicy<typeof input.payload, 'inventory.stock'>({
    evaluate: () => Effect.void,
    owningModuleKey: 'inventory.stock',
    policyKey: 'inventory.stock.available.v1',
  });

  assert.deepEqual(
    { policyKey: globalPolicy.policyKey, scope: globalPolicy.scope },
    { policyKey: 'global.tenant-active.v1', scope: 'global' },
  );
  assert.deepEqual(
    {
      owningModuleKey: modulePolicy.owningModuleKey,
      policyKey: modulePolicy.policyKey,
      scope: modulePolicy.scope,
    },
    {
      owningModuleKey: 'inventory.stock',
      policyKey: 'inventory.stock.available.v1',
      scope: 'microvertical',
    },
  );
  assert.equal(Object.isFrozen(globalPolicy), true);
  assert.equal(Object.isFrozen(modulePolicy), true);
  assert.equal(isActionPolicy(globalPolicy), true);
  assert.equal(isActionPolicy({ ...globalPolicy }), false);
});

void test('evaluates typed allow and safe denial outcomes', async () => {
  const observed: ActionPolicyEvaluatorInput<typeof input.payload>[] = [];
  const allowed = defineGlobalPolicy<typeof input.payload>({
    evaluate: (evaluationInput) => {
      observed.push(evaluationInput);
      return Effect.void;
    },
    policyKey: 'global.allowed.v1',
  });
  const denied = defineMicroverticalPolicy<typeof input.payload, 'inventory.stock'>({
    evaluate: () =>
      Effect.fail(denyPolicy('stock_unavailable', 'Requested stock is unavailable — retry later')),
    owningModuleKey: 'inventory.stock',
    policyKey: 'inventory.stock.available.v1',
  });

  await Effect.runPromise(allowed.evaluate(input));
  const denial = await Effect.runPromise(Effect.flip(denied.evaluate(input)));

  assert.deepEqual(observed, [input]);
  assert.equal(denial._tag, 'PolicyDenied');
  assert.equal(denial.reasonCode, 'stock_unavailable');
  assert.equal(denial.reason, 'Requested stock is unavailable — retry later');
  assert.equal(Object.isFrozen(denial), true);
});

void test('rejects empty stable identifiers and denial messages', () => {
  assert.throws(
    () => defineGlobalPolicy({ evaluate: () => Effect.void, policyKey: '  ' }),
    TypeError,
  );
  assert.throws(() => denyPolicy('', 'Safe message'), TypeError);
  assert.throws(() => denyPolicy('stable_code', ''), TypeError);
});
