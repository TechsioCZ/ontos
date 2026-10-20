import { Effect } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import type { PartySearchProjectionGatewayService } from '../../shared/domain/search-projection-gateway.ts';
import { counterpartiesRead, loadCounterpartySearch } from '../../src/search/counterparties.provider.ts';
import { loadPartySearch, partiesRead } from '../../src/search/parties.provider.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const tenantScope = {
  authMethod: 'system',
  authContextRef: 'job:party-search:run:provider-test',
  correlationId: 'party-search-provider-test',
  principalId: '30000000-0000-4000-8000-000000000003',
  tenantId,
} as const;
const legalEntityScope = { ...tenantScope, legalEntityId } as const;

it('Party provider declares optional Legal Entity context and tenant Party-read authority', () => {
  expect(partiesRead.descriptor.accessKind).toBe('search');
  expect(partiesRead.descriptor.legalEntityScope).toBe('optional');
  expect(partiesRead.descriptor.permissionTarget).toBe('tenant');
});

it('Counterparty provider requires trusted Legal Entity context and candidate authorization', () => {
  expect(counterpartiesRead.descriptor.accessKind).toBe('search');
  expect(counterpartiesRead.descriptor.legalEntityScope).toBe('required');
  expect(counterpartiesRead.descriptor.permissionTarget).toBe('legal_entity');
});

it.effect('Party provider sends only trusted tenant scope to the Core projection gateway', () =>
  Effect.gen(function* trustedPartyScope() {
    const calls: (readonly [unknown, unknown])[] = [];
    const gateway: PartySearchProjectionGatewayService = {
      searchCounterparties: () => Effect.succeed([]),
      searchParties: (input, scope) =>
        Effect.sync(() => {
          calls.push([input, scope]);
          return [];
        }),
    };

    const result = yield* loadPartySearch(gateway, tenantScope, { includeArchived: true, query: 'ACME' });
    expect(result).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([{ includeArchived: true, query: 'ACME', tenantId }, tenantScope]);
    expect(calls[0]?.[1]).toBe(tenantScope);
  }),
);

it.effect('Counterparty provider derives Legal Entity from trusted scope and never from payload', () =>
  Effect.gen(function* trustedCounterpartyScope() {
    const calls: unknown[] = [];
    const gateway: PartySearchProjectionGatewayService = {
      searchCounterparties: (input, scope) =>
        Effect.sync(() => {
          calls.push(input);
          expect(scope).toBe(legalEntityScope);
          return [];
        }),
      searchParties: () => Effect.succeed([]),
    };

    const result = yield* loadCounterpartySearch(
      gateway,
      legalEntityScope,
      legalEntityId,
      { includeArchived: false, query: 'ACME', role: 'SUPPLIER' },
      '2026-09-03T12:00:00.000Z',
    );
    expect(result).toEqual([]);
    expect(calls).toEqual([
      {
        effectiveAt: '2026-09-03T12:00:00.000Z',
        includeArchived: false,
        legalEntityId,
        query: 'ACME',
        role: 'SUPPLIER',
        tenantId,
      },
    ]);
  }),
);

it.effect('Counterparty provider preserves typed normalization failures and omits an absent role', () =>
  Effect.gen(function* invalidCounterpartyInstant() {
    const calls: unknown[] = [];
    const gateway: PartySearchProjectionGatewayService = {
      searchCounterparties: (input) => {
        calls.push(input);
        return Effect.succeed([]);
      },
      searchParties: () => Effect.succeed([]),
    };
    const error = yield* Effect.flip(
      loadCounterpartySearch(gateway, legalEntityScope, legalEntityId, { query: 'ACME' }, 'invalid'),
    );
    assert.equal(error.code, 'party_search_projection_unavailable');
    assert.equal(error.reason, 'Counterparty Search effective time is invalid');
    assert.deepEqual(calls, [
      {
        effectiveAt: 'invalid',
        includeArchived: false,
        legalEntityId,
        query: 'ACME',
        tenantId,
      },
    ]);
  }),
);
