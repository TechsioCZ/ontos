import type { CoreSearchProjectionReplacement } from '@app/core-runtime';
import {
  ContextAccess,
  CoreSearchProjectionReplacementSchema,
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { RecordKeySchema } from '@app/core-runtime/access/ids';
import { propertyPortfolioRegistration } from '../../vertical.registration.ts';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { NodeCrypto } from '@effect/platform-node';
import { Context, Crypto, DateTime, Effect, Exit, Layer, Schema } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import { searchStateRow } from '../support/search-state.ts';
import { PropertyStateSchema } from '../../shared/apis/records.ts';
import type { PropertyState } from '../../shared/apis/records.ts';
import { AssetsProviderResponseSchema } from '../../shared/apis/assets-search.ts';
import { assetsRead } from '../../src/search/assets.provider.ts';
import { buildSearchDocuments } from '../../src/search/projection.ts';
import type { SearchSourceSnapshot } from '../../src/search/projection.ts';
import { projectSearchSnapshot } from '../../src/services/search-projector.ts';
import { applyPropertyCommand } from '../../src/services/persistence.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const otherCompany = '20000000-0000-4000-8000-000000000002';
const compositionRevision = 'a'.repeat(64);
const scope = trustVerifiedGatewayPrincipalContext(
  {
    authBindingId: '60000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:property-asset-search-test',
    authMethod: 'session',
    correlationId: 'property-asset-search-test',
    legalEntityId,
    principalId: '30000000-0000-4000-8000-000000000001',
    tenantId,
  },
  compositionRevision,
);
const context = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: 'claim',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: 'property.portfolio',
  deliveryId: 'delivery',
  domainEventId: 'event',
  messageId: 'message',
  producerModuleKey: 'property.portfolio',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'property.portfolio.search-refresh-requested.v1',
  workerKey: 'property.portfolio.refresh-search',
});
const transitionContext = {
  legalEntityId,
  now: '2026-11-01T09:00:00.000Z',
  resourceId: '40000000-0000-4000-8000-000000000001',
  tenantId,
};
const fixture = Effect.gen(function* makeFixture() {
  const property = yield* applyPropertyCommand(
    { assets: [], properties: [], units: [] } satisfies PropertyState,
    { _tag: 'CreateProperty', address: 'Parková 12', code: 'PARK', name: 'Parková zahrada' },
    transitionContext,
  );
  const parent = yield* Effect.fromNullishOr(property.state.properties[0]);
  const unit = yield* applyPropertyCommand(
    property.state,
    { _tag: 'CreateUnit', capacity: 2, code: 'A101', name: 'Západní byt', propertyRef: parent.propertyRef },
    { ...transitionContext, resourceId: '40000000-0000-4000-8000-000000000002' },
  );
  const created = yield* applyPropertyCommand(
    unit.state,
    {
      _tag: 'CreateAsset',
      category: 'Stroj',
      code: 'LOAD-1',
      name: 'Kolový nakladač',
      propertyRef: parent.propertyRef,
      unitRef: null,
    },
    { ...transitionContext, resourceId: '40000000-0000-4000-8000-000000000003' },
  );
  const assetRef = yield* Effect.fromNullishOr(created.state.assets[0]?.assetRef);
  const updated = yield* applyPropertyCommand(
    created.state,
    { _tag: 'UpdateAsset', assetRef, category: 'Stroj', name: 'Kolový nakladač', serialNumber: 'SN-42' },
    transitionContext,
  );
  return {
    assetRef,
    company: { legalEntityId, state: updated.state },
    parent,
    snapshot: {
      companies: [{ legalEntityId, state: updated.state }],
      projectionVersion: '1',
      tenantId,
    } satisfies SearchSourceSnapshot,
    unit,
  };
});
const assetDocuments = (snapshot: SearchSourceSnapshot) =>
  buildSearchDocuments(snapshot).pipe(
    Effect.map((documents) => documents.filter(({ ref }) => ref.resourceType === 'property.portfolio.asset')),
  );

it.effect('projects an actual asset with only approved own fields, never its parent property label', () =>
  Effect.gen(function* scenario() {
    const { assetRef, snapshot } = yield* fixture;
    const documents = yield* buildSearchDocuments(snapshot);
    expect(documents.map(({ ref }) => ref.resourceType)).toEqual([
      'property.portfolio.property',
      'property.portfolio.unit',
      'property.portfolio.asset',
    ]);
    const asset = yield* Effect.fromNullishOr(documents[2]);
    expect(asset.ref).toEqual(assetRef);
    expect(asset.title).toBe('Kolový nakladač');
    expect(asset.selectedLegalEntityId).toBe(legalEntityId);
    expect(asset.searchableText).toEqual(['Kolový nakladač', 'Stroj', 'LOAD-1', 'SN-42']);
    // The unit is an eligibility parent only; it is not approved asset evidence.
    expect(asset.searchableText).not.toContain('Západní byt');
    expect(asset.searchableText).not.toContain('A101');
  }),
);

it.effect('discards asset notes, people, prices and any other non-allowlisted owner field', () =>
  Effect.gen(function* scenario() {
    const { company, snapshot } = yield* fixture;
    const state = yield* Schema.decodeUnknownEffect(PropertyStateSchema)({
      ...company.state,
      assets: company.state.assets.map((asset) => ({
        ...asset,
        note: 'PRIVATE ASSET NOTE',
        privatePrice: 'PRICE-PRIVATE-77',
        responsiblePerson: 'PRIVATE PERSON',
      })),
    });
    const documents = yield* buildSearchDocuments({ ...snapshot, companies: [{ legalEntityId, state }] });
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(documents);
    expect(encoded).not.toContain('PRIVATE');
    expect(encoded).not.toContain('PRICE-PRIVATE-77');
    expect(encoded).toContain('SN-42');
  }),
);

it.effect('hides disposed assets and assets of archived, disposed or retired parents', () =>
  Effect.gen(function* scenario() {
    const { company, parent, snapshot } = yield* fixture;
    const archived = { archivedAt: '2026-11-01T10:00:00.000Z', archivedBy: 'person', reason: 'Archived' };
    const withState = (state: PropertyState) =>
      buildSearchDocuments({ ...snapshot, companies: [{ legalEntityId, state }] });
    for (const input of [
      {
        ...company.state,
        assets: company.state.assets.map((asset) => ({ ...asset, lifecycleState: 'DISPOSED' as const })),
      },
      {
        ...company.state,
        properties: company.state.properties.map((property) => ({ ...property, archive: archived })),
      },
      {
        ...company.state,
        properties: company.state.properties.map((property) => ({
          ...property,
          lifecycleState: 'DISPOSED' as const,
        })),
      },
    ]) {
      const state = yield* Schema.decodeUnknownEffect(PropertyStateSchema)(input);
      expect(yield* assetDocuments({ ...snapshot, companies: [{ legalEntityId, state }] })).toEqual([]);
    }
    const linked = yield* applyPropertyCommand(
      company.state,
      {
        _tag: 'CreateAsset',
        category: 'Stroj',
        code: 'LOAD-2',
        name: 'Čelní nakladač',
        propertyRef: parent.propertyRef,
        unitRef: company.state.units[0]?.unitRef ?? null,
      },
      { ...transitionContext, resourceId: '40000000-0000-4000-8000-000000000004' },
    );
    const unit = yield* Effect.fromNullishOr(linked.state.units[0]);
    for (const lifecycleState of ['RETIRED', 'OUT_OF_SERVICE'] as const) {
      const retired = yield* applyPropertyCommand(
        linked.state,
        { _tag: 'ChangeUnitLifecycle', lifecycleState, unitRef: unit.unitRef },
        transitionContext,
      );
      const documents = yield* withState(retired.state);
      expect(documents).toHaveLength(lifecycleState === 'RETIRED' ? 2 : 4);
      if (lifecycleState === 'RETIRED') {
        expect(documents.map(({ ref }) => ref.resourceType).filter((type) => type.endsWith('.asset'))).toEqual([
          'property.portfolio.asset',
        ]);
      }
    }
  }),
);

it.effect('fails closed for foreign, orphaned, mismatched or duplicate asset identities', () =>
  Effect.gen(function* scenario() {
    const { assetRef, company, parent, snapshot } = yield* fixture;
    const otherParent = yield* applyPropertyCommand(
      { assets: [], properties: [], units: [] },
      { _tag: 'CreateProperty', address: 'Hlavní 8', code: 'MAIN', name: 'Hlavní dům' },
      { ...transitionContext, resourceId: '40000000-0000-4000-8000-000000000005' },
    );
    const secondProperty = yield* Effect.fromNullishOr(otherParent.state.properties[0]);
    const secondUnit = yield* applyPropertyCommand(
      otherParent.state,
      { _tag: 'CreateUnit', capacity: 1, code: 'B201', name: 'Východní byt', propertyRef: secondProperty.propertyRef },
      { ...transitionContext, resourceId: '40000000-0000-4000-8000-000000000006' },
    );
    const secondUnitRecord = yield* Effect.fromNullishOr(secondUnit.state.units[0]);
    for (const input of [
      { ...company.state, assets: [{ ...company.state.assets[0], assetRef: { ...assetRef, tenantId: otherCompany } }] },
      {
        ...company.state,
        assets: [{ ...company.state.assets[0], propertyRef: { ...parent.propertyRef, tenantId: otherCompany } }],
      },
      { ...company.state, assets: [{ ...company.state.assets[0], propertyRef: secondProperty.propertyRef }] },
      {
        ...company.state,
        assets: company.state.assets.map((asset) => ({ ...asset, unitRef: secondUnitRecord.unitRef })),
        properties: [...company.state.properties, secondProperty],
        units: [...company.state.units, secondUnitRecord],
      },
      { ...company.state, assets: [company.state.assets[0], company.state.assets[0]] },
    ]) {
      const state = yield* Schema.decodeUnknownEffect(PropertyStateSchema)(input);
      expect(
        Exit.isFailure(
          yield* Effect.exit(buildSearchDocuments({ ...snapshot, companies: [{ legalEntityId, state }] })),
        ),
      ).toBe(true);
    }
  }),
);

it.effect('serves an actual asset hit through the governed Read with verified Core relevance', () =>
  Effect.scoped(
    Effect.gen(function* scenario() {
      const { company } = yield* fixture;
      const original = yield* Effect.fromNullishOr(company.state.assets[0]);
      const current = {
        ...company.state,
        assets: [
          original,
          {
            ...original,
            assetRef: { ...original.assetRef, resourceId: '40000000-0000-4000-8000-000000000009' },
            name: 'Nízká relevance Kolový',
          },
        ],
      };
      const cryptoServices = yield* Layer.build(NodeCrypto.layer);
      const crypto = Context.get(cryptoServices, Crypto.Crypto);
      const harness = yield* makeReadTestHarness({
        accessDecision: makeTestBoundAccessGate({
          answers: {
            'property.portfolio.search-assets.read': { outcome: 'ALLOWED', predicate: { groups: [] } },
          },
        }).bound,
        compositionRevision,
        executeOwnerQuery: () => Effect.succeed([searchStateRow(current)]),
        operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-01T09:00:00.000Z')),
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: propertyPortfolioRegistration,
        permissionDecision: 'allowed',
        scope,
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      const result = yield* harness.runtime.runRead({
        input: { query: 'Kolový' },
        principal: scope,
        registration: assetsRead,
        transport: { correlationId: scope.correlationId },
      });
      expect(Schema.is(AssetsProviderResponseSchema)(result)).toBe(true);
      expect(result.map(({ relevance, title }) => [title, relevance?.score])).toEqual([
        ['Kolový nakladač', 800],
        ['Nízká relevance Kolový', 700],
      ]);
      expect(result.every(({ selectedLegalEntityId }) => selectedLegalEntityId === legalEntityId)).toBe(true);
      expect(harness.snapshot().ownerQueries).toHaveLength(1);
      expect(harness.snapshot().statements).toContain('COMMIT');
      expect(harness.snapshot().evidenceWrites).toBe(1);
    }),
  ),
);

it.effect('omits assets outside the canonical record predicate without retired resource checks', () =>
  Effect.scoped(
    Effect.gen(function* scenario() {
      const { company } = yield* fixture;
      const cryptoServices = yield* Layer.build(NodeCrypto.layer);
      const crypto = Context.get(cryptoServices, Crypto.Crypto);
      const harness = yield* makeReadTestHarness({
        accessDecision: makeTestBoundAccessGate({
          answers: {
            'property.portfolio.search-assets.read': {
              outcome: 'ALLOWED',
              predicate: {
                groups: [
                  {
                    clauses: [
                      {
                        conditions: [
                          {
                            _tag: 'RecordKeyIn',
                            recordKeys: [RecordKeySchema.make('40000000-0000-4000-8000-000000000009')],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
        }).bound,
        compositionRevision,
        executeOwnerQuery: () => Effect.succeed([searchStateRow(company.state)]),
        operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-01T09:00:00.000Z')),
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: propertyPortfolioRegistration,
        permissionDecision: 'allowed',
        scope,
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      const services = yield* Layer.build(harness.layer);
      const access = Context.get(services, ContextAccess);
      const check = rs
        .spyOn(access, 'resources')
        .mockImplementation(() => Effect.die('Retired resource authority was invoked'));
      const result = yield* harness.runtime
        .runRead({
          input: { query: 'Kolový' },
          principal: scope,
          registration: assetsRead,
          transport: { correlationId: scope.correlationId },
        })
        .pipe(
          Effect.provideService(CoreSearchQueryRuntime, {
            search: () => Effect.die('No current admitted asset means no index observation'),
          }),
          Effect.ensuring(Effect.sync(() => check.mockRestore())),
        );
      expect(result).toEqual([]);
      expect(check).not.toHaveBeenCalled();
      expect(harness.snapshot().evidenceWrites).toBe(1);
      expect(harness.snapshot().stages).toContain('evidence_persisted');
      expect(harness.snapshot().ownerQueries).toHaveLength(1);
    }),
  ),
);

it.effect('publishes the complete asset type third and preserves floor and tombstones', () =>
  Effect.gen(function* scenario() {
    const { company, snapshot } = yield* fixture;
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const replacements: CoreSearchProjectionReplacement[] = [];
    const project = (source: SearchSourceSnapshot) =>
      projectSearchSnapshot(source, context, false).pipe(
        Effect.provideService(CoreSearchProjectionStore, {
          ...store,
          replace: (input, claim) =>
            Effect.gen(function* observedReplace() {
              const replacement = yield* Schema.decodeUnknownEffect(CoreSearchProjectionReplacementSchema)(input).pipe(
                Effect.orDie,
              );
              yield* store.replace(replacement, claim);
              replacements.push(replacement);
            }),
        }),
      );
    const search = (query: string) =>
      runtime.search(
        {
          includeArchived: false,
          moduleId: 'property.portfolio',
          query,
          resourceType: 'property.portfolio.asset',
          selectedLegalEntityId: legalEntityId,
          tenantId,
        },
        scope,
      );
    yield* project(snapshot);
    expect(replacements.map(({ resourceType }) => resourceType)).toEqual([
      'property.portfolio.property',
      'property.portfolio.unit',
      'property.portfolio.asset',
    ]);
    expect(replacements[2]?.documents.map(({ title }) => title)).toEqual(['Kolový nakladač']);
    expect((yield* search('Kolový')).map(({ title }) => title)).toEqual(['Kolový nakladač']);
    const renamed = {
      ...snapshot,
      companies: snapshot.companies.map((item) => ({
        ...item,
        state: {
          ...item.state,
          assets: item.state.assets.map((asset) => ({ ...asset, name: 'Přeskládaný nakladač' })),
          properties: item.state.properties.map((property) => ({ ...property, name: 'Přejmenovaná zahrada' })),
        },
      })),
      projectionVersion: '2',
    };
    yield* project(renamed);
    expect(yield* search('Kolový')).toEqual([]);
    expect((yield* search('Přeskládaný')).map(({ title }) => title)).toEqual(['Přeskládaný nakladač']);
    expect(yield* search('Přejmenovaná')).toEqual([]);
    const renamedCompany = yield* Effect.fromNullishOr(renamed.companies[0]);
    const empty = {
      ...renamed,
      companies: [{ ...company, state: { ...renamedCompany.state, assets: [] } }],
      projectionVersion: '3',
    };
    yield* project(empty);
    expect(replacements.at(-1)).toMatchObject({ documents: [], resourceType: 'property.portfolio.asset' });
    expect(yield* search('Přeskládaný')).toEqual([]);
    expect(Exit.isFailure(yield* Effect.exit(project({ ...snapshot, projectionVersion: '3' })))).toBe(true);
    expect(yield* search('Kolový')).toEqual([]);
  }),
);
