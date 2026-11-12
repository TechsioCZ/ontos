import { CoreSearchProjectionHitSchema, CoreSearchQueryRuntime, CoreSearchProjectionInvalid } from '@app/core-runtime';
import type { CoreSearchAuthorization, CoreSearchProjectionHit } from '@app/core-runtime';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { RecordKeySchema } from '@app/core-runtime/access/ids';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import type { PropertyState } from '../../shared/apis/records.ts';
import { loadOwnerSearch } from '../../src/services/search-read.ts';
import { searchCompanyId, searchRecordIds, searchState, searchTenantId } from '../support/search-state.ts';

const scope = {
  authContextRef: 'job:search:run:current',
  authMethod: 'system',
  correlationId: 'current-search',
  legalEntityId: searchCompanyId,
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId: searchTenantId,
} as const;

for (const resource of ['unit', 'asset'] as const) {
  it.effect(`${resource} never observes an index for denied parent-only text, even with old indexed evidence`, () =>
    Effect.gen(function* parentOracle() {
      let observations = 0;
      const ref = resource === 'unit' ? searchState.units[0]?.unitRef : searchState.assets[0]?.assetRef;
      const stale = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)({
        archived: false,
        facets: [],
        metadata: [],
        ref,
        relevance: { score: 1000, version: '1' },
        selectedLegalEntityId: searchCompanyId,
        title: 'Private parent',
      });
      const result = yield* loadOwnerSearch(
        scope,
        'Private parent',
        `property.portfolio.${resource}`,
        { groups: [] },
        searchState,
        [],
      ).pipe(
        Effect.provideService(CoreSearchQueryRuntime, {
          search: () => {
            observations += 1;
            return Effect.succeed([stale]);
          },
        }),
      );
      expect(result).toEqual([]);
      expect(observations).toBe(0);
    }),
  );
}

const allRecords = { groups: [] } satisfies ListAccessPredicate;
const recordKeys = (ids: readonly string[]): ListAccessPredicate => ({
  groups: [
    {
      clauses: [
        {
          conditions: [
            { _tag: 'RecordKeyIn', recordKeys: Schema.decodeUnknownSync(Schema.NonEmptyArray(RecordKeySchema))(ids) },
          ],
        },
      ],
    },
  ],
});
const currentSearch = (
  resource: 'property' | 'unit' | 'asset',
  state = searchState,
  query = 'park',
  predicate: ListAccessPredicate | undefined = allRecords,
  deniedFieldPaths: readonly (readonly string[])[] | undefined = [],
  hits?: readonly CoreSearchProjectionHit[],
) =>
  Effect.gen(function* currentScenario() {
    const observed: CoreSearchAuthorization[] = [];
    const exit = yield* loadOwnerSearch(
      scope,
      query,
      `property.portfolio.${resource}`,
      predicate,
      state,
      deniedFieldPaths,
    ).pipe(
      Effect.provideService(CoreSearchQueryRuntime, {
        search: (_query, requester, authorization) => {
          expect(requester).toBe(scope);
          if (authorization !== undefined) {
            observed.push(authorization);
          }
          return Effect.succeed(hits ?? []);
        },
      }),
      Effect.exit,
    );
    return { exit, observed };
  });

const archive = { archivedAt: '2026-11-01T00:00:00Z', archivedBy: 'person', reason: 'Archived' };
for (const resource of ['unit', 'asset'] as const) {
  for (const term of ['Private parent', 'HIDDEN-PARENT', 'Secret boulevard']) {
    it.effect(`${resource} refuses old parent name, code and address text: ${term}`, () =>
      Effect.gen(function* staleParentTerms() {
        const proof = yield* currentSearch(resource, searchState, term);
        expect(proof.exit).toEqual(Exit.succeed([]));
        expect(proof.observed).toEqual([]);
      }),
    );
  }
  for (const change of ['archive', 'dispose'] as const) {
    it.effect(`${resource} hides a currently ${change}d property before index observation`, () =>
      Effect.gen(function* staleParentLifecycle() {
        const state: PropertyState = {
          ...searchState,
          properties: searchState.properties.map((property) =>
            change === 'archive' ? { ...property, archive } : { ...property, lifecycleState: 'DISPOSED' },
          ),
        };
        const proof = yield* currentSearch(resource, state);
        expect(proof.exit).toEqual(Exit.succeed([]));
        expect(proof.observed).toEqual([]);
      }),
    );
  }
}
for (const change of ['archive', 'retire'] as const) {
  for (const resource of ['unit', 'asset'] as const) {
    it.effect(`${resource} hides currently ${change}d units and their linked assets without refreshing the index`, () =>
      Effect.gen(function* staleUnitLifecycle() {
        const unitRef = yield* Effect.fromNullishOr(searchState.units[0]?.unitRef);
        const state: PropertyState = {
          ...searchState,
          assets: searchState.assets.map((asset) => ({ ...asset, unitRef })),
          units: searchState.units.map((unit) =>
            change === 'archive' ? { ...unit, archive } : { ...unit, lifecycleState: 'RETIRED' },
          ),
        };
        const proof = yield* currentSearch(resource, state);
        expect(proof.exit).toEqual(Exit.succeed([]));
        expect(proof.observed).toEqual([]);
      }),
    );
  }
}
for (const change of ['dispose', 'remove'] as const) {
  it.effect(`asset hides current ${change} despite a still-live index row`, () =>
    Effect.gen(function* staleAssetLifecycle() {
      const state: PropertyState = {
        ...searchState,
        assets:
          change === 'remove' ? [] : searchState.assets.map((asset) => ({ ...asset, lifecycleState: 'DISPOSED' })),
      };
      const proof = yield* currentSearch('asset', state);
      expect(proof.exit).toEqual(Exit.succeed([]));
      expect(proof.observed).toEqual([]);
    }),
  );
}
for (const resource of ['property', 'unit', 'asset'] as const) {
  it.effect(`${resource} rematches current text and returns current titles, never stale index title or score`, () =>
    Effect.gen(function* currentText() {
      const state: PropertyState = {
        ...searchState,
        assets: searchState.assets.map((asset) => ({ ...asset, code: 'NEW', name: 'Park' })),
        properties: searchState.properties.map((property) => ({ ...property, code: 'NEW', name: 'Park' })),
        units: searchState.units.map((unit) => ({ ...unit, code: 'NEW', name: 'Park' })),
      };
      const proof = yield* currentSearch(resource, state, 'park', recordKeys(searchRecordIds));
      expect(Exit.isSuccess(proof.exit)).toBe(true);
      if (Exit.isSuccess(proof.exit)) {
        expect(proof.exit.value).toHaveLength(3);
        expect(proof.exit.value.every((hit) => hit.title === 'Park')).toBe(true);
        if (resource === 'asset') {
          expect(proof.exit.value.map((hit) => hit.relevance?.score)).toEqual([900, 900, 900]);
        }
      }
      const removedTerm = yield* currentSearch(resource, state, { asset: 'A0', property: 'P0', unit: 'U0' }[resource]);
      expect(removedTerm.exit).toEqual(Exit.succeed([]));
      expect(removedTerm.observed).toEqual([]);
    }),
  );
}
it.effect('relevance and ordering use only current own evidence, never old parent title boosts', () =>
  Effect.gen(function* currentRank() {
    const first = yield* Effect.fromNullishOr(searchState.assets[0]);
    const second = yield* Effect.fromNullishOr(searchState.assets[1]);
    const state = {
      ...searchState,
      assets: [
        { ...first, category: 'park', name: 'Machine' },
        { ...second, name: 'Park' },
      ],
    };
    const stale = yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))([
      {
        archived: false,
        facets: [],
        metadata: [],
        ref: first.assetRef,
        relevance: { score: 1000, version: '1' },
        selectedLegalEntityId: searchCompanyId,
        title: 'Park',
      },
      {
        archived: false,
        facets: [],
        metadata: [],
        ref: second.assetRef,
        relevance: { score: 0, version: '1' },
        selectedLegalEntityId: searchCompanyId,
        title: 'Hidden parent',
      },
    ]);
    const proof = yield* currentSearch('asset', state, 'park', allRecords, [], stale);
    expect(proof.exit).toEqual(
      Exit.succeed([
        {
          ref: second.assetRef,
          relevance: { score: 900, version: '1' },
          selectedLegalEntityId: searchCompanyId,
          title: 'Park',
        },
        {
          ref: first.assetRef,
          relevance: { score: 100, version: '1' },
          selectedLegalEntityId: searchCompanyId,
          title: 'Machine',
        },
      ]),
    );
  }),
);
for (const mismatch of ['tenant', 'company'] as const) {
  it.effect(`rejects current owner ${mismatch} mismatch before any index observation`, () =>
    Effect.gen(function* foreignOwnerState() {
      const state = {
        ...searchState,
        properties: searchState.properties.map((property) => ({
          ...property,
          legalEntityRef: {
            ...property.legalEntityRef,
            ...(mismatch === 'tenant'
              ? { tenantId: '10000000-0000-4000-8000-000000000002' }
              : { resourceId: '20000000-0000-4000-8000-000000000002' }),
          },
        })),
      };
      const proof = yield* currentSearch('unit', state);
      expect(Exit.isFailure(proof.exit)).toBe(true);
      expect(proof.observed).toEqual([]);
    }),
  );
}
it.effect('rejects missing predicate and unavailable or denied search-field metadata', () =>
  Effect.gen(function* invalidAdmission() {
    const noPredicate = yield* loadOwnerSearch(
      scope,
      'park',
      'property.portfolio.unit',
      undefined,
      searchState,
      [],
    ).pipe(
      Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.die('Missing predicate must not search') }),
      Effect.flip,
    );
    expect(Schema.is(CoreSearchProjectionInvalid)(noPredicate)).toBe(true);
    for (const fields of [undefined, [['title']], [['searchableText']]]) {
      const error = yield* loadOwnerSearch(
        scope,
        'park',
        'property.portfolio.unit',
        allRecords,
        searchState,
        fields,
      ).pipe(
        Effect.provideService(CoreSearchQueryRuntime, {
          search: () => Effect.die('Denied or missing fields must not search'),
        }),
        Effect.flip,
      );
      expect(Schema.is(CoreSearchProjectionInvalid)(error)).toBe(true);
    }
  }),
);
it.effect('applies canonical AND/OR reach to current matching rows before ordering or result counts', () =>
  Effect.gen(function* currentIntersection() {
    const first = yield* Effect.fromNullishOr(searchState.assets[0]);
    const second = yield* Effect.fromNullishOr(searchState.assets[1]);
    const third = yield* Effect.fromNullishOr(searchState.assets[2]);
    const state = { ...searchState, assets: [{ ...first, name: 'Old machine' }, second, third] };
    const firstKey = yield* Schema.decodeUnknownEffect(RecordKeySchema)(first.assetRef.resourceId);
    const secondKey = yield* Schema.decodeUnknownEffect(RecordKeySchema)(second.assetRef.resourceId);
    const thirdKey = yield* Schema.decodeUnknownEffect(RecordKeySchema)(third.assetRef.resourceId);
    const predicate: ListAccessPredicate = {
      groups: [
        {
          clauses: [
            { conditions: [{ _tag: 'RecordKeyIn', recordKeys: [firstKey] }] },
            { conditions: [{ _tag: 'RecordKeyIn', recordKeys: [secondKey, thirdKey] }] },
          ],
        },
        { clauses: [{ conditions: [{ _tag: 'RecordKeyIn', recordKeys: [firstKey, secondKey] }] }] },
      ],
    };
    const result = yield* loadOwnerSearch(scope, 'park', 'property.portfolio.asset', predicate, state, []);
    expect(result.map(({ ref }) => ref.resourceId)).toEqual([second.assetRef.resourceId]);
  }),
);
it.effect('returns every admitted current match without an index candidate budget or public truncation', () =>
  Effect.gen(function* noIndexBudget() {
    const asset = yield* Effect.fromNullishOr(searchState.assets[0]);
    const assets = Array.from({ length: 10_001 }, (_value, index) => ({
      ...asset,
      assetRef: { ...asset.assetRef, resourceId: `45000000-0000-4000-8000-${String(index).padStart(12, '0')}` },
      name: 'Orchid',
    }));
    const result = yield* loadOwnerSearch(
      scope,
      'Orchid',
      'property.portfolio.asset',
      allRecords,
      { ...searchState, assets },
      [],
    );
    expect(result).toHaveLength(10_001);
    expect(result[0]?.ref.resourceId).toBe('45000000-0000-4000-8000-000000000000');
    expect(result.at(-1)?.ref.resourceId).toBe('45000000-0000-4000-8000-000000010000');
    expect(result.every((hit) => hit.title === 'Orchid' && hit.relevance?.score === 900)).toBe(true);
  }),
);
