import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import type { PartySearchProjectionGatewayService } from '../../shared/domain/search-projection-gateway.ts';
import {
  counterpartiesRead,
  loadCounterpartySearch,
} from '../../src/search/counterparties.provider.ts';
import { loadPartySearch, partiesRead } from '../../src/search/parties.provider.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';

test('Party provider declares optional Legal Entity context and tenant Party-read authority', () => {
  assert.equal(partiesRead.descriptor.accessKind, 'search');
  assert.equal(partiesRead.descriptor.legalEntityScope, 'optional');
  assert.equal(partiesRead.descriptor.permissionTarget, 'tenant');
});

test('Counterparty provider requires trusted Legal Entity context and candidate authorization', () => {
  assert.equal(counterpartiesRead.descriptor.accessKind, 'search');
  assert.equal(counterpartiesRead.descriptor.legalEntityScope, 'required');
  assert.equal(counterpartiesRead.descriptor.permissionTarget, 'legal_entity');
});

test('Party provider sends only trusted tenant scope to the Core projection gateway', () =>
  Effect.runPromise(
    Effect.gen(function* trustedPartyScope() {
      const calls: unknown[] = [];
      const gateway: PartySearchProjectionGatewayService = {
        searchCounterparties: () => Effect.succeed([]),
        searchParties: (input) => {
          calls.push(input);
          return Effect.succeed([]);
        },
      };

      const result = yield* loadPartySearch(
        gateway,
        { tenantId },
        { includeArchived: true, query: 'ACME' },
      );
      assert.deepEqual(result, []);
      assert.deepEqual(calls, [{ includeArchived: true, query: 'ACME', tenantId }]);
    }),
  ));

test('Counterparty provider derives Legal Entity from trusted scope and never from payload', () =>
  Effect.runPromise(
    Effect.gen(function* trustedCounterpartyScope() {
      const calls: unknown[] = [];
      const gateway: PartySearchProjectionGatewayService = {
        searchCounterparties: (input) => {
          calls.push(input);
          return Effect.succeed([]);
        },
        searchParties: () => Effect.succeed([]),
      };

      const result = yield* loadCounterpartySearch(
        gateway,
        { legalEntityId, tenantId },
        { includeArchived: false, query: 'ACME', role: 'SUPPLIER' },
        '2026-09-03T12:00:00.000Z',
      );
      assert.deepEqual(result, []);
      assert.deepEqual(calls, [
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
  ));
