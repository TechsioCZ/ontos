import type { OperationalScope } from '@app/core-runtime';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { TenantIntentLoader } from '@app/core-runtime/access/intent/tenant-intent-loader';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { taskLookupAccess } from '../../src/services/task-lookup-access.ts';
import { lookupCatalog } from '../support/lookup-catalog.ts';

const scope: OperationalScope = {
  authBindingId: '20000000-0000-4000-8000-000000000003',
  authContextRef: 'session:test',
  authMethod: 'session',
  correlationId: 'test:lookup-access',
  legalEntityId: '20000000-0000-4000-8000-000000000004',
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId: '20000000-0000-4000-8000-000000000001',
};
for (const [outcome, expected] of [
  ['ALLOWED', 'allowed'],
  ['DENIED', 'denied'],
  ['UNAVAILABLE', 'unavailable'],
  ['NEEDS_APPROVAL', 'denied'],
] as const) {
  it.effect(`lookup hints use actual published owner reads and preserve ${outcome}`, () =>
    Effect.gen(function* test() {
      const gate = makeTestAccessDecision({ defaultAnswer: { outcome } });
      const result = yield* taskLookupAccess(scope).pipe(
        Effect.provideService(AccessDecisionGate, gate),
        Effect.provideService(TenantIntentLoader, lookupCatalog()),
      );
      expect(Object.values(result)).toEqual([expected, expected, expected, expected]);
      expect(gate.askedLists.map(({ carrier }) => carrier.accessDeclaration?.key)).toEqual([
        'legal.agreements.api-records.read',
        'party.registry.customer.list',
        'demo.sales-pipeline.api-records.read',
        'property.portfolio.api-records.read',
      ]);
      expect(
        gate.askedLists.every(
          (question) => question.scope === scope && question.carrier.accessDeclaration?.risk === 'sensitive',
        ),
      ).toBe(true);
    }),
  );
}
it.effect('an absent published declaration never becomes guessed lookup authority', () =>
  Effect.gen(function* test() {
    const gate = makeTestAccessDecision({ defaultAnswer: { outcome: 'ALLOWED' } });
    const result = yield* taskLookupAccess(scope).pipe(
      Effect.provideService(AccessDecisionGate, gate),
      Effect.provideService(TenantIntentLoader, lookupCatalog('customers')),
    );
    expect(result.customers).toBe('unavailable');
    expect(result.properties).toBe('allowed');
    expect(gate.askedLists).toHaveLength(3);
  }),
);
it.effect('missing company scope asks no lookup or gate', () =>
  Effect.gen(function* test() {
    const { legalEntityId: _company, ...unscoped } = scope;
    const result = yield* taskLookupAccess(unscoped).pipe(
      Effect.provideService(TenantIntentLoader, lookupCatalog()),
      Effect.provideService(AccessDecisionGate, makeTestAccessDecision({ defaultAnswer: { outcome: 'DENIED' } })),
    );
    expect(Object.values(result)).toEqual(['unavailable', 'unavailable', 'unavailable', 'unavailable']);
  }),
);

it.effect('a malformed allowed list without its owner predicate does not reveal lookup fields', () =>
  Effect.gen(function* missingPredicate() {
    const gate = makeTestAccessDecision({ defaultAnswer: { outcome: 'ALLOWED' } });
    const result = yield* taskLookupAccess(scope).pipe(
      Effect.provideService(AccessDecisionGate, {
        ...gate,
        list: (question) => gate.list(question).pipe(Effect.map(({ decision }) => ({ decision }))),
      }),
      Effect.provideService(TenantIntentLoader, lookupCatalog()),
    );
    expect(Object.values(result)).toEqual(['unavailable', 'unavailable', 'unavailable', 'unavailable']);
  }),
);
