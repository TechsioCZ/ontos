import { expect, it } from '@app/effect-rstest';
import { Effect, Predicate } from 'effect';
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

it('defines immutable global and owner-local Policy references', () => {
  const globalPolicy = defineGlobalPolicy<typeof input.payload>({
    evaluate: () => Effect.void,
    policyKey: 'global.tenant-active.v1',
  });
  const modulePolicy = defineMicroverticalPolicy<typeof input.payload, 'inventory.stock'>({
    evaluate: () => Effect.void,
    owningModuleKey: 'inventory.stock',
    policyKey: 'inventory.stock.available.v1',
  });

  expect({ policyKey: globalPolicy.policyKey, scope: globalPolicy.scope }).toEqual({
    policyKey: 'global.tenant-active.v1',
    scope: 'global',
  });
  expect({
    owningModuleKey: modulePolicy.owningModuleKey,
    policyKey: modulePolicy.policyKey,
    scope: modulePolicy.scope,
  }).toEqual({
    owningModuleKey: 'inventory.stock',
    policyKey: 'inventory.stock.available.v1',
    scope: 'microvertical',
  });
  expect(Object.isFrozen(globalPolicy)).toBe(true);
  expect(Object.isFrozen(modulePolicy)).toBe(true);
  expect(isActionPolicy(globalPolicy)).toBe(true);
  expect(isActionPolicy({ ...globalPolicy })).toBe(false);
});

it.effect(
  'evaluates typed allow and safe denial outcomes',
  Effect.fn(function* testProgram1() {
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
        Effect.fail(
          denyPolicy('stock_unavailable', 'Requested stock is unavailable — retry later'),
        ),
      owningModuleKey: 'inventory.stock',
      policyKey: 'inventory.stock.available.v1',
    });

    yield* allowed.evaluate(input);
    const denial = yield* Effect.flip(denied.evaluate(input));

    expect(observed).toEqual([input]);
    expect(Predicate.isTagged(denial, 'PolicyDenied')).toBe(true);

    expect(denial.reasonCode).toBe('stock_unavailable');
    expect(denial.reason).toBe('Requested stock is unavailable — retry later');
    expect(Object.isFrozen(denial)).toBe(true);
  }),
);

it('rejects empty stable identifiers and denial messages', () => {
  expect(() => defineGlobalPolicy({ evaluate: () => Effect.void, policyKey: '  ' })).toThrow(
    TypeError,
  );
  expect(() => denyPolicy('', 'Safe message')).toThrow(TypeError);
  expect(() => denyPolicy('stable_code', '')).toThrow(TypeError);
});
