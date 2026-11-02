import { NodeCrypto } from '@effect/platform-node';
import { CoreSearchProjectionHitSchema, CoreSearchQueryRuntime, ContextAccess } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { Context, Effect, Exit, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { AssetsProviderResponseSchema } from '../../shared/apis/assets-search.ts';
import { DevicesProviderResponseSchema } from '../../shared/apis/devices-search.ts';
import { DocumentsProviderResponseSchema } from '../../shared/apis/documents-search.ts';
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
  'Core checks every result resource after owner loading and denies rows even when the module gate allows',
  () =>
    Effect.scoped(
      Effect.gen(function* resourceGate() {
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
          });
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
          expect(Exit.isSuccess(result)).toBe(decision === 'allowed' && agendaPermission === 'allowed');
          expect(loaded).toBe(agendaPermission === 'allowed');
          expect(resources).toEqual(agendaPermission === 'allowed' ? [hit.ref] : []);
        }
        return yield* Effect.void;
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);
