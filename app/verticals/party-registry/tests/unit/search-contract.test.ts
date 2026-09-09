import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CounterpartiesProviderRequestSchema,
  CounterpartiesProviderResponseSchema,
} from '../../shared/apis/counterparties-search.ts';
import { PartiesProviderRequestSchema, PartiesProviderResponseSchema } from '../../shared/apis/parties-search.ts';
import { COUNTERPARTY_SEARCH_SEMANTICS, PARTY_SEARCH_SEMANTICS } from '../../shared/domain/search-descriptor.ts';

it('Party-owned search semantics expose only current approved V1 facts', () => {
  const searchableFacts: readonly string[] = PARTY_SEARCH_SEMANTICS.searchableFacts;
  expect(PARTY_SEARCH_SEMANTICS.searchableFacts).toEqual([
    'DISPLAY_NAME',
    'ACTIVE_OFFICIAL_IDENTIFIER',
    'ACTIVE_EMAIL',
    'ACTIVE_PHONE',
  ]);
  expect(searchableFacts.includes('ADDRESS')).toBe(false);
  expect(searchableFacts.includes('HISTORICAL_IDENTIFIER')).toBe(false);
  expect(PARTY_SEARCH_SEMANTICS.contactPointIdentityAuthority).toBe('NON_UNIQUE');
  expect(PARTY_SEARCH_SEMANTICS.resultMatchAuthority).toBe('NONE');
});

it('Counterparty semantics retain Legal Entity and current-period role boundaries', () => {
  expect(COUNTERPARTY_SEARCH_SEMANTICS.legalEntityScope).toBe('REQUIRED_TRUSTED_CONTEXT');
  expect(COUNTERPARTY_SEARCH_SEMANTICS.roleFilters).toEqual(['CUSTOMER', 'SUPPLIER']);
  expect(COUNTERPARTY_SEARCH_SEMANTICS.rolePeriodSemantics).toBe('CURRENT_AT_EFFECTIVE_TIME');
  expect(COUNTERPARTY_SEARCH_SEMANTICS.deduplicateBy).toBe('COUNTERPARTY_IDENTITY');
});

it.effect('Party Search accepts a bounded query and an explicit archived switch', () =>
  Effect.gen(function* testScenario() {
    expect(
      yield* Schema.decodeEffect(PartiesProviderRequestSchema)({
        includeArchived: true,
        query: '  ACME  ',
      }),
    ).toEqual({ includeArchived: true, query: 'ACME' });
    expect(() => Schema.decodeSync(PartiesProviderRequestSchema)({ query: '   ' })).toThrow();
    expect(() =>
      Schema.decodeSync(PartiesProviderRequestSchema)({
        query: 'a'.repeat(201),
      }),
    ).toThrow();
  }),
);

it.effect('Counterparty Search exposes only the closed current-role filter', () =>
  Effect.gen(function* testScenario() {
    expect(
      yield* Schema.decodeEffect(CounterpartiesProviderRequestSchema)({
        includeArchived: false,
        query: 'ACME',
        role: 'CUSTOMER',
      }),
    ).toEqual({ includeArchived: false, query: 'ACME', role: 'CUSTOMER' });
    expect(() =>
      Schema.decodeUnknownSync(CounterpartiesProviderRequestSchema)({
        query: 'ACME',
        role: 'BUSINESS_PARTNER',
      }),
    ).toThrow();
  }),
);

it.effect('Party Search result is a minimal canonical projection without PII match evidence', () =>
  Effect.gen(function* testScenario() {
    const result = yield* Schema.decodeEffect(PartiesProviderResponseSchema)([
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

    expect(Object.keys(result[0] ?? {}).toSorted()).toEqual(['archived', 'matchedViaAlias', 'ref', 'title']);
    expect('email' in (result[0] ?? {})).toBe(false);
    expect('identifier' in (result[0] ?? {})).toBe(false);
    expect('matchedValue' in (result[0] ?? {})).toBe(false);
  }),
);

it.effect('Counterparty Search result distinguishes Counterparty and canonical Party', () =>
  Effect.gen(function* testScenario() {
    const tenantId = '10000000-0000-4000-8000-000000000001';
    const result = yield* Schema.decodeEffect(CounterpartiesProviderResponseSchema)([
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

    expect(result[0]?.ref.resourceType).toBe('party.registry.counterparty');
    expect(result[0]?.party.ref.resourceType).toBe('party.registry.party');
    expect('email' in (result[0]?.party ?? {})).toBe(false);
    expect('phone' in (result[0]?.party ?? {})).toBe(false);
  }),
);
