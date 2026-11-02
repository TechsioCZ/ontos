import { CoreSearchWorkerSnapshot, ReadHandlerUnavailable } from '@app/core-runtime';
import type { CoreSearchWorkerSnapshotService } from '@app/core-runtime';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { CrmStateSchema } from '../../shared/domain/state.ts';
import { crmRelations } from '../../src/database/schema.ts';
import { SearchSource, searchSourceLive } from '../../src/services/search-source.service.ts';
import { companyId, context, otherCompanyId, scope, state } from './search-fixtures.ts';

interface SourceScenario {
  readonly rowCompany: string;
  readonly rowTenant: string;
  readonly snapshotTenant: string;
  readonly succeeds: boolean;
}
const checkSource = Effect.fn('Crm.testSearchSource')(function* checkSource(scenario: SourceScenario) {
  const encoded = yield* Schema.encodeEffect(CrmStateSchema)(state);
  let queries = 0;
  const connection = testSqlConnection((sql, params) =>
    Effect.sync(() => {
      queries += 1;
      expect(sql).toContain('"demo_crm"."crm_states"');
      expect(sql).toContain('"demo_crm"."crm_states"."tenant_id" = $1');
      expect(sql).toContain('"demo_crm"."crm_states"."legal_entity_id" = $2');
      expect(params).toEqual([scope.tenantId, companyId, 1]);
      return [{ legalEntityId: scenario.rowCompany, state: encoded, tenantId: scenario.rowTenant }];
    }),
  );
  const driver = yield* Layer.build(
    scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer)),
  );
  const executor = yield* makeWithDefaults({ relations: crmRelations }).pipe(
    Effect.provideService(PgClient.PgClient, Context.get(driver, PgClient.PgClient)),
  );
  const reader: CoreSearchWorkerSnapshotService = {
    read: (_claim, consumeSnapshot) =>
      consumeSnapshot({
        eventWatermark: '1',
        forLegalEntity: (legalEntityId, read) => {
          expect(legalEntityId).toBe(companyId);
          return read(executor);
        },
        legalEntityIds: [companyId],
        projectionVersion: '7',
        tenant: (read) => read(executor),
        tenantId: scenario.snapshotTenant,
      }),
  };
  const source = yield* SearchSource.pipe(
    Effect.provide(searchSourceLive),
    Effect.provideService(CoreSearchWorkerSnapshot, reader),
  );
  if (scenario.succeeds) {
    const loaded = yield* source.load(context);
    expect(loaded.projectionVersion).toBe('7');
    expect(loaded.companies.map((company) => company.legalEntityId)).toEqual([companyId]);
    expect(loaded.companies[0]?.state.clients.items[0]?.name).toBe('Železárny Hanák');
  } else {
    expect(Schema.is(ReadHandlerUnavailable)(yield* source.load(context).pipe(Effect.flip))).toBe(true);
  }
  expect(queries).toBe(scenario.snapshotTenant === scope.tenantId ? 1 : 0);
});

it.effect('Core snapshot generation and exact tenant/company predicates fence every canonical owner read', () =>
  Effect.forEach(
    [
      { rowCompany: companyId, rowTenant: scope.tenantId, snapshotTenant: scope.tenantId, succeeds: true },
      { rowCompany: otherCompanyId, rowTenant: scope.tenantId, snapshotTenant: scope.tenantId, succeeds: false },
      { rowCompany: companyId, rowTenant: otherCompanyId, snapshotTenant: scope.tenantId, succeeds: false },
      { rowCompany: companyId, rowTenant: scope.tenantId, snapshotTenant: otherCompanyId, succeeds: false },
    ],
    checkSource,
    { concurrency: 1, discard: true },
  ).pipe(Effect.scoped),
);
