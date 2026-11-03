import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CounterpartiesProviderResponseSchema } from '../../shared/apis/counterparties-search.ts';
import { counterpartiesRead } from '../../src/search/counterparties.provider.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const partyRef = {
  moduleId: 'party.registry',
  resourceId: '50000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const counterpartyRef = (suffix: string) => ({
  moduleId: 'party.registry',
  resourceId: `60000000-0000-4000-8000-00000000000${suffix}`,
  resourceType: 'party.registry.counterparty',
  tenantId,
});
const result = (suffix: string) => ({
  collision: {
    counterpartyRefs: [counterpartyRef('1'), counterpartyRef('2')],
    kind: 'CANONICAL_PARTY_COUNTERPARTY_COLLISION' as const,
  },
  currentRoles: ['CUSTOMER' as const],
  legalEntity: { legalEntityId, tenantId },
  party: { archived: false, matchedViaAlias: false, ref: partyRef, title: 'Společná strana' },
  ref: counterpartyRef(suffix),
});
const scope = {
  authContextRef: 'job:party-search:run:collection-authorization',
  authMethod: 'system' as const,
  correlationId: 'party-collection-authorization',
  legalEntityId,
  principalId: '30000000-0000-4000-8000-000000000003',
  tenantId,
};
const keyFor = (ref: { readonly moduleId: string; readonly resourceId: string; readonly resourceType: string }) =>
  `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`;

const selectRetained = (items: readonly unknown[], allowed: readonly string[]) =>
  Effect.gen(function* selectPartyCollection() {
    const authorization = counterpartiesRead.descriptor.resultAuthorization;
    if (authorization?.kind !== 'search-collection') {
      return yield* Effect.die('Counterparty Read must declare search-collection authorization');
    }
    const selection = yield* authorization.select(items, scope);
    return selection.retain(new Set(allowed));
  });

it.effect('scrubs a collision down to authorized retained counterparty refs', () =>
  Effect.gen(function* scrubbedCollision() {
    const items = yield* Schema.decodeUnknownEffect(CounterpartiesProviderResponseSchema)([result('1'), result('2')]);
    const retained = yield* selectRetained(items, [keyFor(counterpartyRef('1'))]);
    const response = yield* Schema.decodeUnknownEffect(CounterpartiesProviderResponseSchema)(retained.result);
    expect(response.map(({ ref }) => ref.resourceId)).toEqual([counterpartyRef('1').resourceId]);
    expect(response[0]).not.toHaveProperty('collision');
    expect(
      response.some(({ collision }) =>
        collision?.counterpartyRefs.some(({ resourceId }) => resourceId === counterpartyRef('2').resourceId),
      ),
    ).toBe(false);
    expect(retained.resultCount).toBe(1);
  }),
);

it.effect('keeps a collision only while at least two retained counterparties share the canonical party', () =>
  Effect.gen(function* retainedCollision() {
    const items = yield* Schema.decodeUnknownEffect(CounterpartiesProviderResponseSchema)([result('1'), result('2')]);
    const retained = yield* selectRetained(items, [keyFor(counterpartyRef('1')), keyFor(counterpartyRef('2'))]);
    const response = yield* Schema.decodeUnknownEffect(CounterpartiesProviderResponseSchema)(retained.result);
    expect(response.map(({ ref }) => ref.resourceId)).toEqual([
      counterpartyRef('1').resourceId,
      counterpartyRef('2').resourceId,
    ]);
    expect(response[0]?.collision?.counterpartyRefs.map(({ resourceId }) => resourceId)).toEqual([
      counterpartyRef('1').resourceId,
      counterpartyRef('2').resourceId,
    ]);
    expect(retained.resultCount).toBe(2);
  }),
);
