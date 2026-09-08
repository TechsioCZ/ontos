import { expect, it } from 'effect-rstest';
import { Effect, Schema, Predicate } from 'effect';
import { TestClock } from 'effect/testing';
import {
  makeCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '../../src/search/projection.ts';

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Any));

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '10000000-0000-4000-8000-000000000002';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const partyRef = {
  moduleId: 'party.registry',
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const aliasRef = {
  ...partyRef,
  resourceId: '30000000-0000-4000-8000-000000000002',
} as const;

type PartyOverrides = Partial<{
  readonly aliases: readonly object[];
  readonly archived: boolean;
  readonly matchedRef: typeof aliasRef;
  readonly projectionVersion: string;
  readonly ref: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  };
  readonly temporalSearchableText: readonly {
    readonly validFrom: string;
    readonly validTo?: string;
    readonly value: string;
  }[];
  readonly title: string;
}>;

const party = (overrides: PartyOverrides = {}) => ({
  archived: false,
  facets: [],
  metadata: [{ key: 'party-kind', kind: 'string', value: 'ORGANIZATION' }],
  projectionVersion: '1',
  ref: partyRef,
  searchableText: ['Acme, s.r.o.', 'CZ12345678', 'private@example.test'],
  title: 'Acme, s.r.o.',
  ...overrides,
});

it.effect(
  'a projection rebuild floor prevents unseen stale resources and rejects divergent equal-version rebuilds',
  () => {
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = makeCoreSearchQueryRuntime(store);
    const rebuild = {
      documents: [],
      moduleId: partyRef.moduleId,
      rebuildVersion: '2',
      resourceType: partyRef.resourceType,
      tenantId,
    };
    return Effect.gen(function* testProjectionRebuildFloor() {
      yield* store.replace(rebuild);
      yield* store.apply({ document: party(), kind: 'upsert' });
      yield* store.replace({ ...rebuild, documents: [party()], rebuildVersion: '1' });
      expect(
        yield* runtime.search({
          includeArchived: false,
          moduleId: partyRef.moduleId,
          query: 'acme',
          resourceType: partyRef.resourceType,
          tenantId,
        }),
      ).toEqual([]);
      yield* store.replace(rebuild);
      const divergent = yield* Effect.flip(store.replace({ ...rebuild, documents: [party()] }));
      expect(Predicate.isTagged(divergent, 'CoreSearchProjectionInvalid')).toBe(true);
      yield* store.apply({ document: party({ projectionVersion: '3' }), kind: 'upsert' });
      yield* store.replace(rebuild);
      const searchResults = yield* runtime.search({
        includeArchived: false,
        moduleId: partyRef.moduleId,
        query: 'acme',
        resourceType: partyRef.resourceType,
        tenantId,
      });
      expect(searchResults.length).toBe(1);
    });
  },
);

it.effect(
  'Core Search identifies alias-only matches while canonical evidence takes precedence',
  () => {
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = makeCoreSearchQueryRuntime(store);
    return Effect.gen(function* testAliasMatches() {
      yield* store.apply({
        document: party({
          aliases: [
            { kind: 'resource', ref: aliasRef, searchableText: ['Former Company', 'Acme'] },
          ],
          matchedRef: aliasRef,
        }),
        kind: 'upsert',
      });
      const search = (query: string) =>
        runtime.search({
          includeArchived: false,
          moduleId: partyRef.moduleId,
          query,
          resourceType: partyRef.resourceType,
          tenantId,
        });
      const aliasHits = yield* search('former');
      expect(aliasHits.length).toBe(1);
      expect(aliasHits[0]?.ref).toEqual(partyRef);
      expect(aliasHits[0]?.matchedRef).toEqual(aliasRef);
      expect(aliasHits[0]?.matchedSubjectRef).toBe(undefined);
      expect(encodeJson(aliasHits)).not.toMatch(/Former Company|searchableText|aliases/u);
      const canonicalHits = yield* search('acme');
      expect(canonicalHits[0]?.matchedRef).toBe(undefined);
    });
  },
);

it.effect(
  'Core Search rejects cross-tenant aliases and malformed or oversized temporal evidence',
  () => {
    const store = makeInMemoryCoreSearchProjectionStore();
    const invalidEvidence = [
      {
        aliases: [
          {
            kind: 'resource',
            ref: { ...aliasRef, tenantId: otherTenantId },
            searchableText: ['foreign'],
          },
        ],
      },
      { temporalSearchableText: [{ validFrom: 'not-a-date', value: 'private' }] },
      {
        temporalSearchableText: [
          { validFrom: '2026-02-01', validTo: '2026-02-01', value: 'private' },
        ],
      },
      {
        aliases: [
          {
            kind: 'subject',
            ref: aliasRef,
            searchableText: [],
            temporalSearchableText: [
              { validFrom: '2026-02-01', validTo: '2026-01-01', value: 'private' },
            ],
          },
        ],
      },
      {
        aliases: Array.from({ length: 101 }, () => ({
          kind: 'resource',
          ref: aliasRef,
          searchableText: ['private'],
        })),
      },
      {
        temporalSearchableText: Array.from({ length: 101 }, () => ({
          validFrom: '2026-01-01',
          value: 'private',
        })),
      },
    ];
    return Effect.gen(function* testInvalidEvidence() {
      const failures = yield* Effect.all(
        invalidEvidence.map((evidence) =>
          Effect.flip(store.apply({ document: party(evidence), kind: 'upsert' })),
        ),
        { concurrency: 'unbounded' },
      );
      for (const failure of failures) {
        expect(Predicate.isTagged(failure, 'CoreSearchProjectionInvalid')).toBe(true);
      }
    });
  },
);

it.effect('Core Search honors half-open evidence periods for canonical and subject aliases', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const runtime = makeCoreSearchQueryRuntime(store);
  return Effect.gen(function* testHalfOpenEvidencePeriods() {
    yield* TestClock.setTime(Date.parse('2026-09-03T00:00:00Z'));
    yield* store.apply({
      document: party({
        aliases: [
          {
            kind: 'subject',
            ref: aliasRef,
            searchableText: [],
            temporalSearchableText: [
              {
                validFrom: '2026-01-01T00:00:00Z',
                validTo: '2026-02-01T00:00:00Z',
                value: 'old-private@example.test',
              },
            ],
          },
        ],
        temporalSearchableText: [
          { validFrom: '2026-02-01T00:00:00Z', value: 'current-private@example.test' },
          {
            validFrom: '2000-01-01T00:00:00Z',
            validTo: '2100-01-01T00:00:00Z',
            value: 'long-lived@example.test',
          },
        ],
      }),
      kind: 'upsert',
    });
    const search = (query: string, effectiveAt?: string) => {
      const request = {
        includeArchived: false,
        moduleId: partyRef.moduleId,
        query,
        resourceType: partyRef.resourceType,
        tenantId,
      };
      return runtime.search(effectiveAt === undefined ? request : { ...request, effectiveAt });
    };
    const historicalHits = yield* search('old-private', '2026-01-01T00:00:00Z');
    expect(historicalHits[0]?.matchedSubjectRef).toEqual(aliasRef);
    expect(yield* search('old-private', '2026-02-01T00:00:00Z')).toEqual([]);
    expect(yield* search('current-private', '2026-01-31T23:59:59Z')).toEqual([]);
    const current = yield* search('current-private', '2026-02-01T00:00:00Z');
    expect(current.length).toBe(1);
    expect(current[0]?.matchedSubjectRef).toBe(undefined);
    expect(encodeJson(current)).not.toMatch(/private@example|temporalSearchableText/u);
    const longLivedHits = yield* search('long-lived');
    expect(longLivedHits.length).toBe(1);
  });
});

it.effect('Core Search rebuilds one owned projection atomically and isolates tenants', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const runtime = makeCoreSearchQueryRuntime(store);

  return Effect.gen(function* testOwnedProjectionRebuild() {
    yield* store.replace({
      documents: [party()],
      moduleId: 'party.registry',
      rebuildVersion: '1',
      resourceType: 'party.registry.party',
      tenantId,
    });
    yield* store.replace({
      documents: [
        party({
          ref: { ...partyRef, tenantId: otherTenantId },
          title: 'Other tenant',
        }),
      ],
      moduleId: 'party.registry',
      rebuildVersion: '1',
      resourceType: 'party.registry.party',
      tenantId: otherTenantId,
    });

    const result = yield* runtime.search({
      includeArchived: false,
      moduleId: 'party.registry',
      query: 'acme',
      resourceType: 'party.registry.party',
      tenantId,
    });
    expect(result).toEqual([
      {
        archived: false,
        facets: [],
        metadata: [{ key: 'party-kind', kind: 'string', value: 'ORGANIZATION' }],
        ref: partyRef,
        title: 'Acme, s.r.o.',
      },
    ]);
    expect(encodeJson(result)).not.toMatch(/private@example\.test/u);

    yield* store.replace({
      documents: [party({ archived: true, projectionVersion: '2', title: 'Replacement' })],
      moduleId: 'party.registry',
      rebuildVersion: '2',
      resourceType: 'party.registry.party',
      tenantId,
    });
    const hits = yield* runtime.search({
      includeArchived: false,
      moduleId: 'party.registry',
      query: 'acme',
      resourceType: 'party.registry.party',
      tenantId,
    });
    expect(hits).toEqual([]);
  });
});

it.effect(
  'Core Search applies typed Legal Entity and role facets without returning match evidence',
  () => {
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = makeCoreSearchQueryRuntime(store);
    const counterpartyRef = {
      moduleId: 'party.registry',
      resourceId: '40000000-0000-4000-8000-000000000001',
      resourceType: 'party.registry.counterparty',
      tenantId,
    } as const;
    return Effect.gen(function* testTypedLegalEntityAndRoleFacets() {
      yield* store.replace({
        documents: [
          {
            archived: false,
            facets: [],
            matchedSubjectRef: aliasRef,
            metadata: [{ key: 'current-roles', kind: 'strings', value: ['CUSTOMER', 'SUPPLIER'] }],
            projectionVersion: '1',
            ref: counterpartyRef,
            searchableText: ['Acme', 'private@example.test'],
            selectedLegalEntityId: legalEntityId,
            subjectRef: partyRef,
            temporalFacets: [
              {
                key: 'current-role',
                validFrom: '2026-01-01T00:00:00.000Z',
                value: 'CUSTOMER',
              },
              {
                key: 'current-role',
                validFrom: '2026-02-01T00:00:00.000Z',
                value: 'SUPPLIER',
              },
            ],
            title: 'Acme',
          },
        ],
        moduleId: 'party.registry',
        rebuildVersion: '1',
        resourceType: 'party.registry.counterparty',
        tenantId,
      });

      const result = yield* runtime.search({
        effectiveAt: '2026-09-03T00:00:00.000Z',
        facets: [{ key: 'current-role', values: ['SUPPLIER'] }],
        includeArchived: false,
        moduleId: 'party.registry',
        query: 'private@example.test',
        resourceType: 'party.registry.counterparty',
        selectedLegalEntityId: legalEntityId,
        tenantId,
      });
      expect(result).toEqual([
        {
          archived: false,
          facets: [],
          matchedSubjectRef: aliasRef,
          metadata: [{ key: 'current-roles', kind: 'strings', value: ['CUSTOMER', 'SUPPLIER'] }],
          ref: counterpartyRef,
          selectedLegalEntityId: legalEntityId,
          subjectRef: partyRef,
          temporalFacets: [
            {
              key: 'current-role',
              validFrom: '2026-01-01T00:00:00.000Z',
              value: 'CUSTOMER',
            },
            {
              key: 'current-role',
              validFrom: '2026-02-01T00:00:00.000Z',
              value: 'SUPPLIER',
            },
          ],
          title: 'Acme',
        },
      ]);
      expect(encodeJson(result)).not.toMatch(/private@example\.test/u);
      expect(
        yield* runtime.search({
          includeArchived: false,
          moduleId: 'party.registry',
          query: 'acme',
          resourceType: 'party.registry.counterparty',
          tenantId,
        }),
      ).toEqual([]);
    });
  },
);

it.effect(
  'Core Search rejects malformed or cross-owner rebuild documents without partial replacement',
  () => {
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = makeCoreSearchQueryRuntime(store);
    return Effect.gen(function* testMalformedRebuildDocuments() {
      yield* store.replace({
        documents: [party()],
        moduleId: 'party.registry',
        rebuildVersion: '1',
        resourceType: 'party.registry.party',
        tenantId,
      });

      const failure = yield* Effect.flip(
        store.replace({
          documents: [party({ ref: { ...partyRef, moduleId: 'foreign.module' } })],
          moduleId: 'party.registry',
          rebuildVersion: '1',
          resourceType: 'party.registry.party',
          tenantId,
        }),
      );
      expect(Predicate.isTagged(failure, 'CoreSearchProjectionInvalid')).toBe(true);
      const result = yield* runtime.search({
        includeArchived: false,
        moduleId: 'party.registry',
        query: 'acme',
        resourceType: 'party.registry.party',
        tenantId,
      });
      expect(result.length).toBe(1);
    });
  },
);

it.effect('Core Search makes duplicate and out-of-order lifecycle observations harmless', () => {
  const store = makeInMemoryCoreSearchProjectionStore();
  const runtime = makeCoreSearchQueryRuntime(store);
  const versionTwo = party({ projectionVersion: '2', title: 'Current title' });
  return Effect.gen(function* testDuplicateLifecycleObservations() {
    yield* store.apply({ document: versionTwo, kind: 'upsert' });
    yield* store.apply({ document: versionTwo, kind: 'upsert' });
    yield* store.apply({
      document: party({ projectionVersion: '1', title: 'Stale title' }),
      kind: 'upsert',
    });
    yield* store.apply({ kind: 'delete', projectionVersion: '3', ref: partyRef });
    yield* store.apply({ document: versionTwo, kind: 'upsert' });

    expect(
      yield* runtime.search({
        includeArchived: true,
        moduleId: 'party.registry',
        query: 'current',
        resourceType: 'party.registry.party',
        tenantId,
      }),
    ).toEqual([]);
  });
});
