import { ContextAccess } from '@app/core-runtime';
import type { ContextAccessDecision, ContextAccessService, OperationalScope } from '@app/core-runtime';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { taskLookupAccess } from '../../src/services/task-lookup-access.ts';

const scope: OperationalScope = {
  authBindingId: '20000000-0000-4000-8000-000000000003',
  authContextRef: 'session:test',
  authMethod: 'session',
  correlationId: 'test:lookup-access',
  legalEntityId: '20000000-0000-4000-8000-000000000004',
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId: '20000000-0000-4000-8000-000000000001',
};
const fakeAccess = (
  decision: ContextAccessDecision,
  customerDecision: ContextAccessDecision = decision,
): ContextAccessService => ({
  legalEntities: ({ legalEntityIds, permission }) => {
    expect(permission).toBe('read_counterparty');
    return Effect.succeed(legalEntityIds.map((key) => ({ decision: customerDecision, key })));
  },
  modules: (input) => {
    expect(input.legalEntityId).toBe(scope.legalEntityId);
    expect(input.principalId).toBe(scope.principalId);
    expect(input.tenantId).toBe(scope.tenantId);
    return Effect.succeed(input.moduleIds.map((key) => ({ decision, key })));
  },
  resources: () => Effect.succeed([]),
  tenants: () => Effect.succeed([]),
});

it.effect('preserves scoped permitted lookups for manager and salesperson', () =>
  Effect.gen(function* permittedLookups() {
    const result = yield* taskLookupAccess(scope).pipe(Effect.provideService(ContextAccess, fakeAccess('allowed')));
    expect(Object.values(result)).toEqual(['allowed', 'allowed', 'allowed', 'allowed']);
  }),
);
it.effect('marks inaccessible optional directories denied rather than failed', () =>
  Effect.gen(function* deniedLookups() {
    const result = yield* taskLookupAccess(scope).pipe(Effect.provideService(ContextAccess, fakeAccess('denied')));
    expect(Object.values(result)).toEqual(['denied', 'denied', 'denied', 'denied']);
  }),
);
it.effect('requires customer legal-entity permission in addition to module access', () =>
  Effect.gen(function* customerPermission() {
    const result = yield* taskLookupAccess(scope).pipe(
      Effect.provideService(ContextAccess, fakeAccess('allowed', 'denied')),
    );
    expect(result.customers).toBe('denied');
  }),
);
it.effect('keeps real authorization unavailability distinguishable from intentional denial', () =>
  Effect.gen(function* unavailableLookups() {
    const result = yield* taskLookupAccess(scope).pipe(Effect.provideService(ContextAccess, fakeAccess('unavailable')));
    expect(Object.values(result)).toEqual(['unavailable', 'unavailable', 'unavailable', 'unavailable']);
  }),
);
it.effect('fails closed for absent or mismatched permission results', () =>
  Effect.gen(function* missingResults() {
    const result = yield* taskLookupAccess(scope).pipe(
      Effect.provideService(ContextAccess, {
        ...fakeAccess('allowed'),
        modules: () => Effect.succeed([{ decision: 'allowed', key: 'another-module' }]),
      }),
    );
    expect(Object.values(result)).toEqual(['unavailable', 'unavailable', 'unavailable', 'unavailable']);
  }),
);
it.effect('uses the Core module.access alias, never an unrelated named permission', () =>
  Effect.gen(function* coreAlias() {
    const result = yield* taskLookupAccess(scope).pipe(
      Effect.provideService(ContextAccess, {
        ...fakeAccess('allowed'),
        contextPermissions: () => Effect.die('module.access must use modules()'),
      }),
    );
    expect(Object.values(result)).toEqual(['allowed', 'allowed', 'allowed', 'allowed']);
  }),
);
