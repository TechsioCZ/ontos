import { expect, it } from 'effect-rstest';
import { Effect } from 'effect';
import type { PartySearchProjectionGatewayService } from '../../shared/domain/search-projection-gateway.ts';
import {
  counterpartiesRead,
  loadCounterpartySearch,
} from '../../src/search/counterparties.provider.ts';
import { loadPartySearch, partiesRead } from '../../src/search/parties.provider.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';

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
    const calls: unknown[] = [];
    const gateway: PartySearchProjectionGatewayService = {
      searchCounterparties: () => Effect.succeed([]),
      searchParties: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return [];
        }),
    };

    const result = yield* loadPartySearch(
      gateway,
      { tenantId },
      { includeArchived: true, query: 'ACME' },
    );
    expect(result).toEqual([]);
    expect(calls).toEqual([{ includeArchived: true, query: 'ACME', tenantId }]);
  }),
);

it.effect(
  'Counterparty provider derives Legal Entity from trusted scope and never from payload',
  () =>
    Effect.gen(function* trustedCounterpartyScope() {
      const calls: unknown[] = [];
      const gateway: PartySearchProjectionGatewayService = {
        searchCounterparties: (input) =>
          Effect.sync(() => {
            calls.push(input);
            return [];
          }),
        searchParties: () => Effect.succeed([]),
      };

      const result = yield* loadCounterpartySearch(
        gateway,
        { legalEntityId, tenantId },
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
