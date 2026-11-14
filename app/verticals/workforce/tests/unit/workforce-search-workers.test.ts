import {
  CoreSearchProjectionStore,
  CoreSearchProjectionUnavailable,
  CoreSearchQuerySchema,
  CoreSearchWorkerSnapshot,
  ReadHandlerUnavailable,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { CoreSearchProjectionStoreService, CoreSearchWorkerSnapshotService } from '@app/core-runtime';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Layer, Schema, Struct } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { workforceRelations } from '../../src/database/schema.ts';
import { workforceSearchIngestionRegistrations } from '../../src/worker-host/search-ingestion-registrations.ts';
import { handleRebuildSearch, rebuildSearchWorker } from '../../src/workers/rebuild-search.worker.ts';
import { handleRefreshSearch, refreshSearchWorker } from '../../src/workers/refresh-search.worker.ts';
import {
  companyId,
  otherCompanyId,
  scope,
  searchRequestId,
  snapshot,
  tenantId,
  workerContext,
} from './workforce-search-fixtures.ts';

const workers = [
  { handle: handleRefreshSearch, kind: 'refresh', registration: refreshSearchWorker },
  { handle: handleRebuildSearch, kind: 'rebuild', registration: rebuildSearchWorker },
] as const;

it('admits exactly both generated self-consuming workers with explicit tenant-wide snapshot scope', () => {
  const declared = workers.map(({ registration }) =>
    Struct.pick(registration.descriptor, ['consumerModuleKey', 'producerModuleKey', 'topic', 'workerKey']),
  );
  expect(workforceSearchIngestionRegistrations).toEqual(declared);
  expect(Object.isFrozen(workforceSearchIngestionRegistrations)).toBe(true);
  for (const { registration } of workers) {
    expect(registration.descriptor.legalEntityScope).toBe('forbidden');
    expect(registration.descriptor.entrypoint.authorization).toEqual({ kind: 'owner_local_background' });
    expect(registration.descriptor.entrypoint.scope).toBe('tenant');
    expect(registration.descriptor.consumerModuleKey).toBe('demo.workforce');
    expect(registration.descriptor.producerModuleKey).toBe('demo.workforce');
  }
});

for (const { handle, kind } of workers) {
  it.effect(
    `${kind} delegates to the shared real source/projection pipeline and publishes only after its source closes`,
    () =>
      Effect.scoped(
        Effect.gen(function* workerDelegation() {
          const context = workerContext(kind);
          let snapshotOpen = false;
          let reads = 0;
          let replacements = 0;
          const companies: string[] = [];
          const services = yield* Layer.build(
            scriptedPgClientLayer(
              Effect.succeed(
                testSqlConnection((_sql, params) =>
                  Effect.succeed([
                    {
                      employees: snapshot.employees
                        .filter((row) => row.legalEntityId === params[1])
                        .map((row) => Struct.omit(row, ['tenantId', 'legalEntityId'])),
                      legalEntityId: params[1],
                      tenantId,
                    },
                  ]),
                ),
              ),
            ).pipe(Layer.provide(Reactivity.layer)),
          );
          const database = yield* makeWithDefaults({ relations: workforceRelations }).pipe(
            Effect.provideService(PgClient.PgClient, Context.get(services, PgClient.PgClient)),
          );
          const reader: CoreSearchWorkerSnapshotService = {
            read: (claim, read) =>
              Effect.gen(function* coherentSource() {
                reads += 1;
                expect(claim).toBe(context);
                snapshotOpen = true;
                return yield* read({
                  eventWatermark: '9',
                  forLegalEntity: (company, readCompany) => {
                    companies.push(company);
                    return readCompany({ select: database.select.bind(database) });
                  },
                  legalEntityIds: [companyId, otherCompanyId],
                  projectionVersion: '7',
                  tenant: () => Effect.die('No ambient tenant SQL'),
                  tenantId,
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      snapshotOpen = false;
                    }),
                  ),
                );
              }),
          };
          const store = makeInMemoryCoreSearchProjectionStore();
          const observedStore: CoreSearchProjectionStoreService = {
            ...store,
            replace: (input, claim) =>
              Effect.sync(() => {
                expect(snapshotOpen).toBe(false);
                expect(claim).toBe(context);
                replacements += 1;
              }).pipe(Effect.andThen(store.replace(input, claim))),
          };
          yield* handle({ requestId: searchRequestId }, context).pipe(
            Effect.provideService(CoreSearchWorkerSnapshot, reader),
            Effect.provideService(CoreSearchProjectionStore, observedStore),
          );
          expect(reads).toBe(1);
          expect(replacements).toBe(1);
          expect(companies).toEqual([companyId, otherCompanyId]);
          for (const company of companies) {
            const query = Schema.decodeSync(CoreSearchQuerySchema)({
              includeArchived: false,
              moduleId: 'demo.workforce',
              query: 'ignored-candidate-text',
              resourceType: 'demo.workforce.employee',
              selectedLegalEntityId: company,
              tenantId,
            });
            const documents = yield* store.queryCandidates(query, { ...scope, legalEntityId: company });
            expect(documents.length).toBe(1);
            expect(documents[0]?.projectionVersion).toBe('7');
            expect(documents[0]?.selectedLegalEntityId).toBe(company);
          }
        }),
      ),
  );

  it.effect(`${kind} propagates source/credential failure without publishing or declaring successful delivery`, () =>
    Effect.gen(function* workerFailure() {
      let replacements = 0;
      const store: CoreSearchProjectionStoreService = {
        apply: () => Effect.die('No incremental fallback'),
        queryCandidates: () => Effect.die('Search is not a source'),
        replace: () =>
          Effect.sync(() => {
            replacements += 1;
          }),
      };
      const failure = yield* handle({ requestId: searchRequestId }, workerContext(kind)).pipe(
        Effect.provideService(CoreSearchWorkerSnapshot, {
          read: () =>
            Effect.fail(
              new CoreSearchProjectionUnavailable({
                code: 'core_search_projection_unavailable',
                reason: 'Test worker source credentials unavailable',
              }),
            ),
        }),
        Effect.provideService(CoreSearchProjectionStore, store),
        Effect.flip,
      );
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      expect(replacements).toBe(0);
    }),
  );
}
