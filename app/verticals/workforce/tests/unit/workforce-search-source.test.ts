import {
  CoreSearchProjectionStore,
  CoreSearchProjectionUnavailable,
  CoreSearchWorkerSnapshot,
} from '@app/core-runtime';
import type { CoreSearchWorkerSnapshotService } from '@app/core-runtime';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Exit, Layer, Struct } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { workforceRelations } from '../../src/database/schema.ts';
import { projectWorkforceSearch } from '../../src/services/workforce-search-projection.ts';
import { loadWorkforceSearchSnapshot } from '../../src/services/workforce-search-source.ts';
import { companyId, otherCompanyId, snapshot, tenantId, workerContext } from './workforce-search-fixtures.ts';

interface SourceScenario {
  readonly companies?: readonly string[];
  readonly foreignCompany?: boolean;
  readonly foreignTenant?: boolean;
  readonly malformedCompany?: string;
  readonly missingCompany?: string;
  readonly snapshotTenant?: string;
  readonly unavailableCredentials?: boolean;
}

/** Only the SQL transport is scripted: Core owns the source port and Drizzle builds/decodes the real owner query. */
const scenario = Effect.fn('WorkforceSearchTest.source')(function* source(options: SourceScenario = {}) {
  const queries: { readonly params: readonly unknown[]; readonly sql: string }[] = [];
  const scopes: string[] = [];
  const services = yield* Layer.build(
    scriptedPgClientLayer(
      Effect.succeed(
        testSqlConnection((sql, params) => {
          queries.push({ params, sql });
          const [, company] = params;
          if (company === options.missingCompany) {
            return Effect.succeed([]);
          }
          return Effect.succeed([
            {
              employees:
                company === options.malformedCompany
                  ? null
                  : snapshot.employees
                      .filter((employee) => employee.legalEntityId === company)
                      .map((employee) => Struct.omit(employee, ['legalEntityId', 'tenantId'])),
              legalEntityId: options.foreignCompany === true ? tenantId : company,
              tenantId: options.foreignTenant === true ? otherCompanyId : tenantId,
            },
          ]);
        }),
      ),
    ).pipe(Layer.provide(Reactivity.layer)),
  );
  const database = yield* makeWithDefaults({ relations: workforceRelations }).pipe(
    Effect.provideService(PgClient.PgClient, Context.get(services, PgClient.PgClient)),
  );
  const reader: CoreSearchWorkerSnapshotService = {
    read: (_claim, consume) =>
      options.unavailableCredentials === true
        ? Effect.fail(
            new CoreSearchProjectionUnavailable({
              code: 'core_search_projection_unavailable',
              reason: 'Test source database credentials are unavailable',
            }),
          )
        : consume({
            eventWatermark: '12',
            forLegalEntity: (legalEntityId, read) => {
              scopes.push(legalEntityId);
              return read({ select: database.select.bind(database) });
            },
            legalEntityIds: options.companies ?? [companyId, otherCompanyId],
            projectionVersion: '37',
            tenant: () => Effect.die('Workforce source must never use tenant-wide SQL'),
            tenantId: options.snapshotTenant ?? tenantId,
          }),
  };
  let publications = 0;
  const exit = yield* Effect.exit(
    projectWorkforceSearch(workerContext()).pipe(
      Effect.provideService(CoreSearchWorkerSnapshot, reader),
      Effect.provideService(CoreSearchProjectionStore, {
        apply: () => Effect.die('A complete Workforce snapshot uses replacement, never partial mutation'),
        queryCandidates: () => Effect.die('No query fallback supplies source data'),
        replace: () =>
          Effect.sync(() => {
            publications += 1;
          }),
      }),
    ),
  );
  const loaded = yield* Effect.exit(
    loadWorkforceSearchSnapshot(workerContext()).pipe(Effect.provideService(CoreSearchWorkerSnapshot, reader)),
  );
  return { exit, loaded, publications, queries, scopes };
});

it.effect('reads every exact company with safe SQL fields and publishes one complete tenant replacement', () =>
  Effect.scoped(
    Effect.gen(function* safeSource() {
      const result = yield* scenario();
      expect(Exit.isSuccess(result.exit)).toBe(true);
      expect(result.publications).toBe(1);
      expect(result.scopes).toEqual([companyId, otherCompanyId, companyId, otherCompanyId]);
      expect(result.queries.map((query) => query.params)).toEqual([
        [tenantId, companyId, 1],
        [tenantId, otherCompanyId, 1],
        [tenantId, companyId, 1],
        [tenantId, otherCompanyId, 1],
      ]);
      expect(Exit.isSuccess(result.loaded)).toBe(true);
      if (Exit.isSuccess(result.loaded)) {
        expect(result.loaded.value).toEqual({ ...snapshot, projectionVersion: '37' });
      }
      for (const { sql } of result.queries) {
        expect(sql).toContain('"demo_workforce"."workforce_states"');
        expect(sql).toContain('jsonb_typeof(');
        expect(sql).toContain("->'employees'");
        expect(sql).toContain('jsonb_array_elements');
        expect(sql).not.toMatch(/email|phone|principalRef|createdAt|updatedAt|auth\.|core\.|\bjoin\b/iu);
        const fields = [...sql.matchAll(/employee->'(?<key>[^']+)'/gu)].flatMap((match) =>
          match.groups?.key === undefined ? [] : [match.groups.key],
        );
        expect(new Set(fields)).toEqual(new Set(['active', 'department', 'fullName', 'id', 'role']));
        expect(fields).toHaveLength(5);
      }
    }),
  ),
);

it.effect('an absent owner row is authoritative empty, but never prevents reading sibling companies', () =>
  Effect.scoped(
    Effect.gen(function* absentCompany() {
      const result = yield* scenario({ missingCompany: companyId });
      expect(Exit.isSuccess(result.loaded)).toBe(true);
      expect(result.publications).toBe(1);
      if (Exit.isSuccess(result.loaded)) {
        expect(result.loaded.value.employees).toEqual(
          snapshot.employees.filter((row) => row.legalEntityId !== companyId),
        );
      }
    }),
  ),
);

const failures: readonly (readonly [string, SourceScenario])[] = [
  ['foreign tenant row', { foreignTenant: true }],
  ['foreign company row', { foreignCompany: true }],
  ['malformed second company', { malformedCompany: otherCompanyId }],
  ['foreign snapshot tenant', { snapshotTenant: otherCompanyId }],
  ['empty company enumeration', { companies: [] }],
  ['duplicate company enumeration', { companies: [companyId, companyId] }],
  ['unavailable source credentials', { unavailableCredentials: true }],
];
for (const [name, options] of failures) {
  it.effect(
    `${name} fails closed without publishing an incomplete projection or falling back to other credentials`,
    () =>
      Effect.scoped(
        Effect.gen(function* failedSource() {
          const result = yield* scenario(options);
          expect(Exit.isFailure(result.exit)).toBe(true);
          expect(Exit.isFailure(result.loaded)).toBe(true);
          expect(result.publications).toBe(0);
          if (
            options.unavailableCredentials === true ||
            options.snapshotTenant !== undefined ||
            options.companies !== undefined
          ) {
            expect(result.queries).toEqual([]);
          }
        }),
      ),
  );
}
