import { NodeCrypto } from '@effect/platform-node';
import { CoreSearchProjectionHitSchema, CoreSearchQueryRuntime, ContextAccess } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { Context, Crypto, Effect, Exit, Layer, Schema } from 'effect';
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
import { loadFacilitySearch } from '../../src/search/search-read.ts';
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
      expect(read.descriptor.entrypoint.authorization).toEqual({
        kind: 'context_permission',
        permission: 'facility.operations.read_all',
      });
    }
  }),
);

it.effect(
  'Core checks every result resource after owner loading and filters denied rows only after agenda admission',
  () =>
    Effect.scoped(
      Effect.gen(function* resourceGate() {
        const cryptoServices = yield* Layer.build(NodeCrypto.layer);
        const crypto = Context.get(cryptoServices, Crypto.Crypto);
        const [document] = yield* buildFacilitySearchDocuments(snapshot);
        if (document === undefined) {
          return yield* Effect.die('Missing fixture');
        }
        const hit = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)(document);
        for (const [decision, agendaPermission] of [
          ['allowed', 'allowed'],
          ['denied', 'allowed'],
          ['allowed', 'denied'],
        ] as const) {
          const harness = yield* makeReadTestHarness({
            executeOwnerQuery: () => Effect.die('No owner SQL expected'),
            operationTime: new Date('2026-11-02T12:00:00Z'),
            ownerAuthorizationDecision: 'allowed',
            permissionDecision: 'allowed',
            scope,
          }).pipe(Effect.provideService(Crypto.Crypto, crypto));
          const resources: unknown[] = [];
          let loaded = false;
          Object.assign(Context.get(yield* Layer.build(harness.layer), ContextAccess), {
            contextPermissions: ({
              targets,
            }: {
              readonly targets: readonly { readonly moduleId: string; readonly permission: string }[];
            }) =>
              Effect.succeed(
                targets.map((target) => ({
                  decision: agendaPermission,
                  key: `${target.moduleId}:${target.permission}`,
                })),
              ),
            resources: ({
              resources: refs,
            }: {
              readonly resources: readonly {
                readonly moduleId: string;
                readonly resourceId: string;
                readonly resourceType: string;
              }[];
            }) =>
              Effect.sync(() => {
                expect(loaded).toBe(true);
                resources.push(...refs);
                return refs.map((ref) => ({ decision, key: `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}` }));
              }),
          });
          const result = yield* Effect.exit(
            harness.runtime
              .runRead({
                input: { query: 'cerpadlo' },
                principal: scope,
                registration: assetsRead,
                transport: { correlationId: scope.correlationId },
              })
              .pipe(
                Effect.provideService(CoreSearchQueryRuntime, {
                  search: () =>
                    Effect.sync(() => {
                      loaded = true;
                      return [hit];
                    }),
                }),
              ),
          );
          expect(Exit.isSuccess(result)).toBe(agendaPermission === 'allowed');
          if (Exit.isSuccess(result)) {
            expect(result.value.map(({ ref }) => ref.resourceId)).toEqual(
              decision === 'allowed' ? [hit.ref.resourceId] : [],
            );
          }
          expect(loaded).toBe(agendaPermission === 'allowed');
          expect(resources).toEqual(
            agendaPermission === 'allowed'
              ? [
                  {
                    moduleId: hit.ref.moduleId,
                    resourceId: hit.ref.resourceId,
                    resourceType: hit.ref.resourceType,
                  },
                ]
              : [],
          );
        }
        return yield* Effect.void;
      }),
    ),
);
