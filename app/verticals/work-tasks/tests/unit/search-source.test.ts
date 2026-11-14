import {
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  CoreSearchWorkerSnapshot,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { CoreSearchWorkerSnapshotService } from '@app/core-runtime';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Exit, Layer } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { workRelations } from '../../src/database/schema.ts';
import { loadSearchSnapshot } from '../../src/services/search-source.ts';
import { buildSearchDocuments } from '../../src/services/search-projection.ts';
import { loadSearch as governedSearch } from '../../src/services/search-read.ts';

import { company, context, otherCompany, otherTenant, ref, scope, tenantId } from './search-fixtures.ts';

const loadSearch = (operationScope: Parameters<typeof governedSearch>[0], query: string) =>
  governedSearch(operationScope, query, { groups: [] });

interface SourceScenario {
  readonly records?: readonly unknown[];
  readonly rowCompany: string;
  readonly rowTenant: string;
  readonly snapshotTenant: string;
  readonly succeeds: boolean;
}
const checkSource = Effect.fn('Search.testSource')(function* checkSource(scenario: SourceScenario) {
  let queries = 0;
  const connection = testSqlConnection((statement, params) =>
    Effect.sync(() => {
      queries += 1;
      expect(statement).toContain('"work_tasks"."work_states"');
      expect(statement).toContain('"work_tasks"."work_states"."tenant_id" = $1');
      expect(statement).toContain('"work_tasks"."work_states"."legal_entity_id" = $2');
      expect(params).toEqual([tenantId, company]);
      expect(statement).toContain("'tasks'");
      expect(statement).toContain('jsonb_build_object');
      expect(statement).not.toMatch(/\bjoin\b/iu);
      expect(statement).not.toContain("'note'");
      expect(statement).not.toContain("'description'");
      expect(statement).not.toContain("'comments'");
      expect(statement).not.toContain("'storefrontInquiry'");
      return [
        {
          legalEntityId: scenario.rowCompany,
          records: scenario.records ?? [{ archived: false, ref, title: 'Veřejný název' }],
          tenantId: scenario.rowTenant,
        },
      ];
    }),
  );
  const driver = yield* Layer.build(
    scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer)),
  );
  const executor = yield* makeWithDefaults({ relations: workRelations }).pipe(
    Effect.provideService(PgClient.PgClient, Context.get(driver, PgClient.PgClient)),
  );
  const reader: CoreSearchWorkerSnapshotService = {
    read: (_claim, consume) =>
      consume({
        eventWatermark: '1',
        forLegalEntity: (id, read) => {
          expect(id).toBe(company);
          return read(executor);
        },
        legalEntityIds: [company],
        projectionVersion: '7',
        tenant: (read) => read(executor),
        tenantId: scenario.snapshotTenant,
      }),
  };
  const result = yield* loadSearchSnapshot(context).pipe(
    Effect.provideService(CoreSearchWorkerSnapshot, reader),
    Effect.exit,
  );
  expect(Exit.isSuccess(result)).toBe(scenario.succeeds);
  if (Exit.isSuccess(result)) {
    expect(result.value.projectionVersion).toBe('7');
    if (scenario.records === undefined) {
      expect(result.value.records).toMatchObject([{ legalEntityId: company, ref, title: 'Veřejný název' }]);
    }
  }
  expect(queries).toBe(scenario.snapshotTenant === tenantId ? 1 : 0);
  return result;
});
it.effect('compiled SQL selects only search fields under both trusted scope predicates; foreign rows fail closed', () =>
  Effect.forEach(
    [
      { rowCompany: company, rowTenant: tenantId, snapshotTenant: tenantId, succeeds: true },
      { rowCompany: otherCompany, rowTenant: tenantId, snapshotTenant: tenantId, succeeds: false },
      { rowCompany: company, rowTenant: otherTenant, snapshotTenant: tenantId, succeeds: false },
      { rowCompany: company, rowTenant: tenantId, snapshotTenant: otherTenant, succeeds: false },
    ],
    checkSource,
    { concurrency: 1, discard: true },
  ).pipe(Effect.scoped),
);

const validScenario = { rowCompany: company, rowTenant: tenantId, snapshotTenant: tenantId, succeeds: true };
const approvedRecord = {
  archived: false,
  dueDate: '2026-11-04',
  ownerPrincipalRef: { principalId: scope.principalId, tenantId },
  priority: 'HIGH',
  projectId: 'work-project-42',
  ref,
  state: 'WAITING',
  title: 'Příprava kanceláře',
};
it.effect('source decoding carries actual safe fields into searchable evidence but never private payloads', () =>
  Effect.gen(function* test() {
    const result = yield* checkSource({
      ...validScenario,
      records: [
        {
          ...approvedRecord,
          comments: [{ text: 'private-comment-term' }],
          description: 'private-description-term',
          history: [{ actorDisplayName: 'private-history-term' }],
          storefrontInquiry: { email: 'private-inquiry@example.test', message: 'private-inquiry-term' },
        },
      ],
    });
    if (Exit.isSuccess(result)) {
      expect(result.value.records).toEqual([{ ...approvedRecord, legalEntityId: company }]);
      const documents = yield* buildSearchDocuments(result.value);
      const store = makeInMemoryCoreSearchProjectionStore();
      yield* store.replace(
        {
          documents,
          moduleId: ref.moduleId,
          rebuildVersion: result.value.projectionVersion,
          resourceType: ref.resourceType,
          tenantId,
        },
        context,
      );
      const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
      for (const [query, score] of [
        ['priprava', 800],
        [ref.resourceId, 1000],
        [scope.principalId, 100],
        ['2026-11-04', 100],
        ['work-project-42', 100],
        ['WAITING', 100],
        ['HIGH', 100],
      ] as const) {
        expect(yield* loadSearch(scope, query).pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toEqual([
          { ref, relevance: { score, version: '1' }, selectedLegalEntityId: company, title: approvedRecord.title },
        ]);
      }
      for (const query of [
        'private-comment-term',
        'private-description-term',
        'private-history-term',
        'private-inquiry',
        'example.test',
      ]) {
        expect(yield* loadSearch(scope, query).pipe(Effect.provideService(CoreSearchQueryRuntime, runtime))).toEqual(
          [],
        );
      }
    }
  }).pipe(Effect.scoped),
);
it.effect(
  'malformed approved evidence and cross-tenant owner identities fail closed rather than silently indexing',
  () =>
    Effect.forEach(
      [
        { ...approvedRecord, dueDate: '2026-02-30' },
        { ...approvedRecord, ownerPrincipalRef: { principalId: scope.principalId, tenantId: otherTenant } },
        { ...approvedRecord, ownerPrincipalRef: { principalId: 'invalid', tenantId } },
        { ...approvedRecord, ownerPrincipalRef: { principalId: scope.principalId } },
        { ...approvedRecord, projectId: '' },
        { ...approvedRecord, priority: 'UNKNOWN' },
        { ...approvedRecord, state: 'UNKNOWN' },
      ],
      (record) => checkSource({ ...validScenario, records: [record], succeeds: false }),
      {
        concurrency: 1,
        discard: true,
      },
    ).pipe(Effect.scoped),
);
it.effect('empty task snapshots retain the reserved generation for deletion publication', () =>
  Effect.gen(function* test() {
    const result = yield* checkSource({ ...validScenario, records: [] });
    if (Exit.isSuccess(result)) {
      expect(result.value).toEqual({ projectionVersion: '7', records: [], tenantId });
    }
  }).pipe(Effect.scoped),
);
