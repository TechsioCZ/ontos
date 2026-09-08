import assert from 'node:assert/strict';
import test from 'node:test';
import { Schema } from 'effect';
import {
  CounterpartiesProviderRequestSchema,
  CounterpartiesProviderResponseSchema,
} from '../../shared/apis/counterparties-search.ts';
import {
  PartiesProviderRequestSchema,
  PartiesProviderResponseSchema,
} from '../../shared/apis/parties-search.ts';
import {
  COUNTERPARTY_SEARCH_SEMANTICS,
  PARTY_SEARCH_SEMANTICS,
} from '../../shared/domain/search-descriptor.ts';

test('Party-owned search semantics expose only current approved V1 facts', () => {
  const searchableFacts: readonly string[] = PARTY_SEARCH_SEMANTICS.searchableFacts;
  assert.deepEqual(PARTY_SEARCH_SEMANTICS.searchableFacts, [
    'DISPLAY_NAME',
    'ACTIVE_OFFICIAL_IDENTIFIER',
    'ACTIVE_EMAIL',
    'ACTIVE_PHONE',
  ]);
  assert.equal(searchableFacts.includes('ADDRESS'), false);
  assert.equal(searchableFacts.includes('HISTORICAL_IDENTIFIER'), false);
  assert.equal(PARTY_SEARCH_SEMANTICS.contactPointIdentityAuthority, 'NON_UNIQUE');
  assert.equal(PARTY_SEARCH_SEMANTICS.resultMatchAuthority, 'NONE');
});

test('Counterparty semantics retain Legal Entity and current-period role boundaries', () => {
  assert.equal(COUNTERPARTY_SEARCH_SEMANTICS.legalEntityScope, 'REQUIRED_TRUSTED_CONTEXT');
  assert.deepEqual(COUNTERPARTY_SEARCH_SEMANTICS.roleFilters, ['CUSTOMER', 'SUPPLIER']);
  assert.equal(COUNTERPARTY_SEARCH_SEMANTICS.rolePeriodSemantics, 'CURRENT_AT_EFFECTIVE_TIME');
  assert.equal(COUNTERPARTY_SEARCH_SEMANTICS.deduplicateBy, 'COUNTERPARTY_IDENTITY');
});

test('Party Search accepts a bounded query and an explicit archived switch', () => {
  assert.deepEqual(
    Schema.decodeUnknownSync(PartiesProviderRequestSchema)({
      includeArchived: true,
      query: '  ACME  ',
    }),
    { includeArchived: true, query: 'ACME' },
  );
  assert.throws(() => Schema.decodeUnknownSync(PartiesProviderRequestSchema)({ query: '   ' }));
  assert.throws(() =>
    Schema.decodeUnknownSync(PartiesProviderRequestSchema)({ query: 'a'.repeat(201) }),
  );
});

test('Counterparty Search exposes only the closed current-role filter', () => {
  assert.deepEqual(
    Schema.decodeUnknownSync(CounterpartiesProviderRequestSchema)({
      includeArchived: false,
      query: 'ACME',
      role: 'CUSTOMER',
    }),
    { includeArchived: false, query: 'ACME', role: 'CUSTOMER' },
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(CounterpartiesProviderRequestSchema)({
      query: 'ACME',
      role: 'BUSINESS_PARTNER',
    }),
  );
});

test('Party Search result is a minimal canonical projection without PII match evidence', () => {
  const result = Schema.decodeUnknownSync(PartiesProviderResponseSchema)([
    {
      archived: false,
      matchedViaAlias: true,
      ref: {
        moduleId: 'party.registry',
        resourceId: 'party-1',
        resourceType: 'party.registry.party',
        tenantId: '10000000-0000-4000-8000-000000000001',
      },
      title: 'ACME',
    },
  ]);

  assert.deepEqual(Object.keys(result[0] ?? {}).toSorted(), [
    'archived',
    'matchedViaAlias',
    'ref',
    'title',
  ]);
  assert.equal('email' in (result[0] ?? {}), false);
  assert.equal('identifier' in (result[0] ?? {}), false);
  assert.equal('matchedValue' in (result[0] ?? {}), false);
});

test('Counterparty Search result distinguishes Counterparty and canonical Party', () => {
  const tenantId = '10000000-0000-4000-8000-000000000001';
  const result = Schema.decodeUnknownSync(CounterpartiesProviderResponseSchema)([
    {
      currentRoles: ['CUSTOMER', 'SUPPLIER'],
      legalEntity: {
        legalEntityId: '20000000-0000-4000-8000-000000000002',
        tenantId,
      },
      party: {
        archived: false,
        matchedViaAlias: false,
        ref: {
          moduleId: 'party.registry',
          resourceId: 'party-1',
          resourceType: 'party.registry.party',
          tenantId,
        },
        title: 'ACME',
      },
      ref: {
        moduleId: 'party.registry',
        resourceId: 'counterparty-1',
        resourceType: 'party.registry.counterparty',
        tenantId,
      },
    },
  ]);

  assert.equal(result[0]?.ref.resourceType, 'party.registry.counterparty');
  assert.equal(result[0]?.party.ref.resourceType, 'party.registry.party');
  assert.equal('email' in (result[0]?.party ?? {}), false);
  assert.equal('phone' in (result[0]?.party ?? {}), false);
});
