import { CoreSearchWorkerSnapshot } from '@app/core-runtime';
import type { CoreSearchWorkerSnapshotService } from '@app/core-runtime';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Exit, Layer } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { workRelations } from '../../src/database/schema.ts';
import { loadSearchSnapshot } from '../../src/services/search-source.ts';
import { company, context, otherCompany, otherTenant, ref, tenantId } from './search-fixtures.ts';

interface SourceScenario {
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
      expect(statement).not.toContain("'note'");
      expect(statement).not.toContain("'description'");
      expect(statement).not.toContain("'comments'");
      expect(statement).not.toContain("'storefrontInquiry'");
      return [
        {
          legalEntityId: scenario.rowCompany,
          records: [{ archived: false, ref, title: 'Veřejný název' }],
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
    expect(result.value.records).toMatchObject([{ legalEntityId: company, ref, title: 'Veřejný název' }]);
  }
  expect(queries).toBe(scenario.snapshotTenant === tenantId ? 1 : 0);
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
