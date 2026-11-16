import { NodeCrypto } from '@effect/platform-node';
import { CoreSearchProjectionHitSchema, CoreSearchQueryRuntime } from '@app/core-runtime';
import { runFacilitySearchScenario } from './facility-search-harness.ts';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { AssetsProviderRelevanceSchema, AssetsProviderResponseSchema } from '../../shared/apis/assets-search.ts';
import { DevicesProviderRelevanceSchema, DevicesProviderResponseSchema } from '../../shared/apis/devices-search.ts';
import {
  DocumentsProviderRelevanceSchema,
  DocumentsProviderResponseSchema,
} from '../../shared/apis/documents-search.ts';
import { AssetRefSchema } from '../../shared/resources/asset.ts';
import { assetsRead } from '../../src/search/assets.provider.ts';
import { devicesRead } from '../../src/search/devices.provider.ts';
import { documentsRead } from '../../src/search/documents.provider.ts';
import { loadFacilitySearch } from '../../src/services/facility-search-read.ts';
import { buildFacilitySearchDocuments } from '../../src/services/facility-search-projection.ts';
import { company, otherCompany, scope, snapshot, tenantId } from './facility-search-fixtures.ts';

it.effect('queries only trusted scope and rejects forged tenant/company/owner/type/archive results', () =>
  Effect.gen(function* isolation() {
    const [document] = yield* buildFacilitySearchDocuments(snapshot);
    if (document === undefined) {
      return yield* Effect.die('Missing fixture');
    }
    const base = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)(document);
    const calls: unknown[] = [];
    const result = yield* loadFacilitySearch(scope, 'asset', 'cerpadlo', AssetRefSchema).pipe(
      Effect.provideService(CoreSearchQueryRuntime, {
        search: (input, trusted) =>
          Effect.sync(() => {
            calls.push([input, trusted]);
            return [base];
          }),
      }),
    );
    expect(result[0]?.selectedLegalEntityId).toBe(company);
    expect(calls).toEqual([
      [
        {
          includeArchived: false,
          includeRelevance: true,
          moduleId: 'facility.operations',
          query: 'cerpadlo',
          resourceType: 'facility.operations.asset',
          selectedLegalEntityId: company,
          tenantId,
        },
        scope,
      ],
    ]);
    for (const bad of [
      { ...base, selectedLegalEntityId: otherCompany },
      { ...base, archived: true },
      { ...base, ref: { ...base.ref, tenantId: otherCompany } },
      { ...base, ref: { ...base.ref, moduleId: 'foreign.owner' } },
      { ...base, ref: { ...base.ref, resourceType: 'facility.operations.device' } },
      { ...base, ref: { ...base.ref, resourceId: `${otherCompany}.asset-1` } },
      { ...base, subjectRef: base.ref },
    ]) {
      const hit = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)(bad);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            loadFacilitySearch(scope, 'asset', '', AssetRefSchema).pipe(
              Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed([hit]) }),
            ),
          ),
        ),
      ).toBe(true);
    }
    const { legalEntityId: _company, ...withoutCompany } = scope;
    let queried = false;
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          loadFacilitySearch(withoutCompany, 'asset', '', AssetRefSchema).pipe(
            Effect.provideService(CoreSearchQueryRuntime, {
              search: () =>
                Effect.sync(() => {
                  queried = true;
                  return [];
                }),
            }),
          ),
        ),
      ),
    ).toBe(true);
    expect(queried).toBe(false);
    return yield* Effect.void;
  }),
);

it.effect('passes through verified Core relevance v1 and never invents one', () =>
  Effect.gen(function* relevance() {
    const [document] = yield* buildFacilitySearchDocuments(snapshot);
    if (document === undefined) {
      return yield* Effect.die('Missing fixture');
    }
    const withoutRelevance = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)(document);
    const withRelevance = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)({
      ...document,
      relevance: { score: 1000, version: '1' },
    });
    const result = yield* loadFacilitySearch(scope, 'asset', 'cerpadlo', AssetRefSchema).pipe(
      Effect.provideService(CoreSearchQueryRuntime, {
        search: () => Effect.succeed([withRelevance, withoutRelevance]),
      }),
    );
    expect(result.map((hit) => hit.title)).toEqual([document.title, document.title]);
    expect(result[0]?.relevance).toEqual({ score: 1000, version: '1' });
    expect(result[1]).not.toHaveProperty('relevance');
    return yield* Effect.void;
  }),
);

it.effect('accepts only verified relevance v1 scores 0..1000 on the facility wire contracts', () =>
  Effect.gen(function* relevanceWire() {
    const result = {
      ref: {
        moduleId: 'facility.operations',
        resourceId: `${company}.asset-1`,
        resourceType: 'facility.operations.asset',
        tenantId,
      },
      selectedLegalEntityId: company,
      title: 'Čerpadlo',
    } as const;
    expect(Schema.is(AssetsProviderResponseSchema)([result])).toBe(true);
    for (const score of [0, 1000]) {
      expect(Schema.is(AssetsProviderResponseSchema)([{ ...result, relevance: { score, version: '1' } }])).toBe(true);
    }
    for (const relevance of [
      { score: -1, version: '1' },
      { score: 1001, version: '1' },
      { score: 500.5, version: '1' },
      { score: 500, version: '2' },
    ]) {
      expect(Schema.is(AssetsProviderResponseSchema)([{ ...result, relevance }])).toBe(false);
    }
    for (const schema of [
      AssetsProviderRelevanceSchema,
      DevicesProviderRelevanceSchema,
      DocumentsProviderRelevanceSchema,
    ]) {
      expect(Schema.is(schema)({ score: 0, version: '1' })).toBe(true);
      expect(Schema.is(schema)({ score: 1000, version: '1' })).toBe(true);
      expect(Schema.is(schema)({ score: 1001, version: '1' })).toBe(false);
    }
    return yield* Effect.void;
  }),
);

it.effect('requires tenant and selected company in all three wire schemas', () =>
  Effect.gen(function* wire() {
    for (const response of [
      AssetsProviderResponseSchema,
      DevicesProviderResponseSchema,
      DocumentsProviderResponseSchema,
    ]) {
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            Schema.decodeUnknownEffect(response)([
              {
                ref: { moduleId: 'facility.operations', resourceId: 'x', resourceType: 'facility.operations.asset' },
                title: 'Record',
              },
            ]),
          ),
        ),
      ).toBe(true);
    }
    for (const read of [assetsRead, devicesRead, documentsRead]) {
      expect(read.descriptor.legalEntityScope).toBe('required');
      expect(read.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
    }
  }),
);

it.effect('the canonical list intersects current owner records after agenda admission', () =>
  Effect.gen(function* recordReach() {
    for (const resource of ['asset', 'device', 'document'] as const) {
      const permitted = yield* runFacilitySearchScenario(resource);
      expect(Exit.isSuccess(permitted.exit)).toBe(true);
      if (Exit.isSuccess(permitted.exit)) {
        expect(permitted.exit.value).toHaveLength(3);
      }
      const hidden = yield* runFacilitySearchScenario(resource, { operationalOnly: true });
      expect(hidden.exit).toEqual(Exit.succeed([]));
      expect(hidden.searched).toBe(false);
      expect(hidden.snapshot.ownerQueries).toEqual([]);
      const denied = yield* runFacilitySearchScenario(resource, { listOutcome: 'DENIED' });
      expect(Exit.isFailure(denied.exit)).toBe(true);
      expect(denied.searched).toBe(false);
    }
  }).pipe(Effect.provide(NodeCrypto.layer)),
);
