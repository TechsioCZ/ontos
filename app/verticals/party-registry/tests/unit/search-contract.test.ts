import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CounterpartiesProviderRequestSchema,
  CounterpartiesProviderResponseSchema,
} from '../../shared/apis/counterparties-search.ts';
import { PartiesProviderRequestSchema, PartiesProviderResponseSchema } from '../../shared/apis/parties-search.ts';

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
