import type {
  CoreSearchProjectionHit,
  OperationalScope,
  CoreSearchProjectionReplacement,
  CoreSearchQueryRuntimeService,
  OutboxWorkerHandlerContext,
} from '@app/core-runtime';
import {
  CoreSearchProjectionReplacementSchema,
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  CoreSearchProjectionHitSchema,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { PropertyStateSchema } from '../../shared/apis/records.ts';
import { PropertiesProviderResponseSchema } from '../../shared/apis/properties-search.ts';
import { buildSearchDocuments } from '../../src/search/projection.ts';
import type { SearchSourceSnapshot } from '../../src/search/projection.ts';
import { loadOwnerSearch } from '../../src/search/search-read.ts';
import { projectSearchSnapshot } from '../../src/services/search-projector.ts';
import { applyPropertyCommand } from '../../src/services/persistence.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const otherCompany = '20000000-0000-4000-8000-000000000002';
const scope = {
  authContextRef: 'job:property-search:run:test',
  authMethod: 'system',
  correlationId: 'property-search-test',
  legalEntityId,
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId,
} as const;
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
const fixture = Effect.gen(function* makeFixture() {
  const transitionContext = {
    legalEntityId,
    now: '2026-11-01T09:00:00.000Z',
    resourceId: '40000000-0000-4000-8000-000000000001',
    tenantId,
  };
  const property = yield* applyPropertyCommand(
    { assets: [], properties: [], units: [] },
    { _tag: 'CreateProperty', address: 'Parková 12', code: 'PARK', name: 'Parková zahrada' },
    transitionContext,
  );
  const parent = yield* Effect.fromNullishOr(property.state.properties[0]);
  const unit = yield* applyPropertyCommand(
    property.state,
    { _tag: 'CreateUnit', capacity: 2, code: 'A101', name: 'Západní byt', propertyRef: parent.propertyRef },
    { ...transitionContext, resourceId: '40000000-0000-4000-8000-000000000002' },
  );
  return {
    companies: [{ legalEntityId, state: unit.state }],
    projectionVersion: '1',
    tenantId,
  } satisfies SearchSourceSnapshot;
});

it.effect('projects properties AND units with company scope and only allowlisted business text', () =>
  Effect.gen(function* scenario() {
    const snapshot = yield* fixture;
    const company = yield* Effect.fromNullishOr(snapshot.companies[0]);
    const state = yield* Schema.decodeUnknownEffect(PropertyStateSchema)({
      ...company.state,
      properties: company.state.properties.map((property) => ({
        ...property,
        note: 'PRIVATE NOTE',
        propertyType: 'Obytný dům',
        responsibleEmployeeIds: ['30000000-0000-4000-8000-000000000099'],
        responsiblePerson: 'PRIVATE PERSON',
      })),
      units: company.state.units.map((unit) => ({ ...unit, note: 'PRIVATE UNIT NOTE', unitKind: 'Byt' })),
    });
    const documents = yield* buildSearchDocuments({ ...snapshot, companies: [{ legalEntityId, state }] });
    expect(documents.map((document) => document.ref.resourceType)).toEqual([
      'property.portfolio.property',
      'property.portfolio.unit',
    ]);
    expect(documents.map((document) => document.selectedLegalEntityId)).toEqual([legalEntityId, legalEntityId]);
    expect(documents[0]?.searchableText).toEqual(['Parková zahrada', 'PARK', 'Parková 12', 'Obytný dům']);
    expect(documents[1]?.title).toBe('Západní byt');
    expect(documents[1]?.searchableText).toEqual(['Západní byt', 'A101', 'Byt']);
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(documents);
    expect(encoded).not.toContain('PRIVATE');
    expect(encoded).not.toContain('30000000-0000-4000-8000-000000000099');
    for (const mismatch of [
      { ...snapshot, tenantId: '10000000-0000-4000-8000-000000000002' },
      { ...snapshot, companies: [{ ...company, legalEntityId: otherCompany }] },
    ]) {
      expect(Exit.isFailure(yield* Effect.exit(buildSearchDocuments(mismatch)))).toBe(true);
    }
  }),
);

it.effect('omits absent property type and unit kind instead of publishing empty evidence', () =>
  Effect.gen(function* absentKindsScenario() {
    const snapshot = yield* fixture;
    const documents = yield* buildSearchDocuments(snapshot);
    expect(documents[0]?.searchableText).toEqual(['Parková zahrada', 'PARK', 'Parková 12']);
    expect(documents[1]?.searchableText).toEqual(['Západní byt', 'A101']);
  }),
);

it.effect('publishes complete types once and refreshes property labels without an ingestion pass', () =>
  Effect.gen(function* replacementScenario() {
    const original = yield* fixture;
    const snapshot = {
      ...original,
      companies: original.companies.map((company) => ({
        ...company,
        state: {
          ...company.state,
          properties: company.state.properties.map((property) => ({ ...property, code: 'OLD-PARENT-921' })),
        },
      })),
    };
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
          resourceType: 'property.portfolio.property',
          selectedLegalEntityId: legalEntityId,
          tenantId,
        },
        scope,
      );
    yield* project(snapshot);
    expect(replacements.map(({ documents, resourceType }) => [resourceType, documents.length])).toEqual([
      ['property.portfolio.property', 1],
      ['property.portfolio.unit', 1],
      ['property.portfolio.asset', 0],
    ]);
    expect((yield* search('OLD-PARENT-921')).length).toBe(1);
    const conflicting = {
      ...snapshot,
      companies: snapshot.companies.map((company) => ({
        ...company,
        state: {
          ...company.state,
          properties: company.state.properties.map((property) => ({ ...property, code: 'CONFLICT-PARENT-000' })),
        },
      })),
    };
    expect(Exit.isFailure(yield* Effect.exit(project(conflicting)))).toBe(true);
    expect(replacements.length).toBe(3);
    expect((yield* search('CONFLICT-PARENT-000')).length).toBe(0);
    expect((yield* search('OLD-PARENT-921')).length).toBe(1);
    const renamed = {
      ...snapshot,
      companies: snapshot.companies.map((company) => ({
        ...company,
        state: {
          ...company.state,
          properties: company.state.properties.map((property) => ({
            ...property,
            code: 'NEW-PARENT-634',
            name: 'Přejmenovaná nemovitost',
          })),
        },
      })),
      projectionVersion: '2',
    };
    yield* project(renamed);
    expect(replacements.length).toBe(6);
    expect(yield* search('OLD-PARENT-921')).toEqual([]);
    expect(yield* search('Parková zahrada')).toEqual([]);
    expect((yield* search('NEW-PARENT-634')).length).toBe(1);
    expect((yield* search('Přejmenovaná nemovitost')).length).toBe(1);
    yield* project({ ...renamed, companies: [], projectionVersion: '3' });
    expect(replacements.slice(-3).map(({ documents }) => documents)).toEqual([[], [], []]);
    expect(yield* search('NEW-PARENT-634')).toEqual([]);
  }),
);

it.effect('refreshes, removes stale units, isolates companies and refuses stale replay resurrection', () =>
  Effect.gen(function* scenario() {
    let snapshot: SearchSourceSnapshot = yield* fixture;
    const store = makeInMemoryCoreSearchProjectionStore();
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const project = (claim: OutboxWorkerHandlerContext, rebuild: boolean) =>
      projectSearchSnapshot(snapshot, claim, rebuild).pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const search = (query: string, selectedScope: OperationalScope = scope) =>
      runtime.search(
        {
          includeArchived: false,
          moduleId: 'property.portfolio',
          query,
          resourceType: 'property.portfolio.unit',
          selectedLegalEntityId: selectedScope.legalEntityId,
          tenantId: selectedScope.tenantId,
        },
        selectedScope,
      );
    yield* project(context, false);
    expect((yield* search('zapadni')).length).toBe(1);
    expect(yield* search('byt', { ...scope, legalEntityId: otherCompany })).toEqual([]);
    expect(yield* search('byt', { ...scope, tenantId: '10000000-0000-4000-8000-000000000002' })).toEqual([]);
    const old = snapshot;
    snapshot = {
      ...snapshot,
      companies: snapshot.companies.map((company) => ({ ...company, state: { ...company.state, units: [] } })),
      projectionVersion: '2',
    };
    yield* project(context, false);
    expect(yield* search('byt')).toEqual([]);
    snapshot = old;
    yield* project(context, false);
    expect(yield* search('byt')).toEqual([]);
    snapshot = { ...snapshot, companies: [], projectionVersion: '3' };
    const rebuild = attestOutboxWorkerHandlerContext({
      ...context,
      topic: 'property.portfolio.search-rebuild-requested.v1',
      workerKey: 'property.portfolio.rebuild-search',
    });
    yield* project(rebuild, true);
    yield* project(rebuild, true);
    expect(
      yield* runtime.search(
        {
          includeArchived: false,
          moduleId: 'property.portfolio',
          query: 'Park',
          resourceType: 'property.portfolio.property',
          selectedLegalEntityId: legalEntityId,
          tenantId,
        },
        scope,
      ),
    ).toEqual([]);
  }),
);

it.effect('hides archived parents, archived units, disposed properties and retired units', () =>
  Effect.gen(function* scenario() {
    const snapshot = yield* fixture;
    const company = yield* Effect.fromNullishOr(snapshot.companies[0]);
    const archive = { archivedAt: '2026-11-01T10:00:00.000Z', archivedBy: 'person', reason: 'Archived' };
    for (const state of [
      { ...company.state, properties: company.state.properties.map((property) => ({ ...property, archive })) },
      {
        ...company.state,
        properties: company.state.properties.map((property) => ({ ...property, lifecycleState: 'DISPOSED' as const })),
      },
    ]) {
      expect(yield* buildSearchDocuments({ ...snapshot, companies: [{ legalEntityId, state }] })).toEqual([]);
    }
    for (const units of [
      company.state.units.map((unit) => ({ ...unit, archive })),
      company.state.units.map((unit) => ({ ...unit, lifecycleState: 'RETIRED' as const })),
    ]) {
      expect(
        (yield* buildSearchDocuments({
          ...snapshot,
          companies: [{ legalEntityId, state: { ...company.state, units } }],
        })).length,
      ).toBe(1);
    }
  }),
);

it.effect('current scoped labels ignore foreign index rows and require company and tenant in the wire schema', () =>
  Effect.gen(function* scenario() {
    const snapshot = yield* fixture;
    const documents = yield* buildSearchDocuments(snapshot);
    const document = yield* Effect.fromNullishOr(documents[0]);
    const hit: CoreSearchProjectionHit = document;
    const seen: unknown[] = [];
    const forged = yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))([
      hit,
      { ...hit, selectedLegalEntityId: otherCompany },
      { ...hit, ref: { ...hit.ref, tenantId: otherCompany } },
    ]);
    const runtime = {
      search: (query: Parameters<CoreSearchQueryRuntimeService['search']>[0]) => {
        seen.push(query);
        return Effect.succeed(forged);
      },
    };
    const result = yield* loadOwnerSearch(
      scope,
      'Park',
      'property.portfolio.property',
      { groups: [] },
      yield* Effect.fromNullishOr(snapshot.companies[0]?.state),
      [],
    ).pipe(Effect.provideService(CoreSearchQueryRuntime, runtime));
    expect(result).toEqual([{ ref: hit.ref, selectedLegalEntityId: legalEntityId, title: hit.title }]);
    expect(seen).toEqual([]);
    expect(Schema.is(PropertiesProviderResponseSchema)(result)).toBe(true);
    expect(Schema.is(PropertiesProviderResponseSchema)([{ ref: hit.ref, title: hit.title }])).toBe(false);
    expect(
      Schema.is(PropertiesProviderResponseSchema)([
        {
          ref: { moduleId: hit.ref.moduleId, resourceId: hit.ref.resourceId, resourceType: hit.ref.resourceType },
          selectedLegalEntityId: legalEntityId,
          title: hit.title,
        },
      ]),
    ).toBe(false);
    const { legalEntityId: _company, ...withoutCompany } = scope;
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          loadOwnerSearch(
            withoutCompany,
            'Park',
            'property.portfolio.property',
            { groups: [] },
            yield* Effect.fromNullishOr(snapshot.companies[0]?.state),
            [],
          ).pipe(Effect.provideService(CoreSearchQueryRuntime, runtime)),
        ),
      ),
    ).toBe(true);
    expect(seen).toEqual([]);
  }),
);

it.effect('rejects orphan units, ambiguous parents and foreign parent refs even for hidden records', () =>
  Effect.gen(function* invalidParentScenario() {
    const snapshot = yield* fixture;
    const company = yield* Effect.fromNullishOr(snapshot.companies[0]);
    const parent = yield* Effect.fromNullishOr(company.state.properties[0]);
    const archive = { archivedAt: '2026-11-01T10:00:00.000Z', archivedBy: 'person', reason: 'Archived' };
    for (const input of [
      { ...company.state, properties: [] },
      { ...company.state, properties: [parent, { ...parent, archive }] },
      {
        ...company.state,
        units: company.state.units.map((unit) => ({
          ...unit,
          archive,
          propertyRef: { ...unit.propertyRef, tenantId: otherCompany },
        })),
      },
      {
        ...company.state,
        units: company.state.units.map((unit) => ({
          ...unit,
          unitRef: { ...unit.unitRef, tenantId: otherCompany },
        })),
      },
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

it.effect('rejects duplicate resource identities across companies before publication', () =>
  Effect.gen(function* duplicateCompanyScenario() {
    const snapshot = yield* fixture;
    const company = yield* Effect.fromNullishOr(snapshot.companies[0]);
    const duplicate = {
      ...snapshot,
      companies: [
        company,
        {
          ...company,
          legalEntityId: otherCompany,
          state: {
            ...company.state,
            properties: company.state.properties.map((property) => ({
              ...property,
              legalEntityRef: { ...property.legalEntityRef, resourceId: otherCompany },
            })),
          },
        },
      ],
    };
    expect(Exit.isFailure(yield* Effect.exit(buildSearchDocuments(duplicate)))).toBe(true);
  }),
);
