import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { Crypto, Effect, Layer, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { coreRelations } from '../../src/db/schema.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../src/db/types.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import { makePostgresCoreSearchProjectionStore } from '../../src/search/persistence.ts';
import {
  CoreSearchProjectionStore,
  CoreSearchQuerySchema,
  createCoreSearchQueryRuntime,
} from '../../src/search/projection.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { makeIsolatedNativeDatabaseFixture } from '../../src/testing/isolated-native-database.ts';
import { makeApplicationCompositionSnapshotFixture } from '../../src/testing/module-contract.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT, FIXTURE_WORKER_IDENTITY } from '../support/database-identities.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const compositionMarker = 'search-indexed-query';
const moduleId = 'party.registry';
const resourceType = 'party.registry.party';

const runAsWorkerTransaction = <Value, Failure, Requirements>(
  transaction: CoreTransaction,
  body: (transaction: CoreTransaction) => Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.gen(function* workerTransaction() {
    // The real worker cohort role, switched on the transaction's own connection. This is
    // the existing fixture role; no new global reader or owner bypass is introduced.
    yield* transaction
      .execute(sql`set local session authorization ${sql.identifier(FIXTURE_WORKER_IDENTITY.role)}`, 'objects')
      .pipe(Effect.orDie);
    return yield* body(transaction);
  });

const withWorkerExecutor = (executor: CoreDatabaseExecutor): CoreDatabaseExecutor =>
  new Proxy(executor, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return <Value, Failure, Requirements>(
          body: (transaction: CoreTransaction) => Effect.Effect<Value, Failure, Requirements>,
        ) => target.transaction((transaction) => runAsWorkerTransaction(transaction, body));
      }
      return Reflect.get(target, property, receiver);
    },
  });

const withFixture = <Value, Failure, Requirements>(
  consume: (fixture: {
    readonly admin: PgClient.PgClient;
    readonly compositionRevision: string;
    readonly store: ReturnType<typeof makePostgresCoreSearchProjectionStore>;
    readonly workerScope: OperationalScope;
  }) => Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.scoped(
    Effect.gen(function* fixture() {
      const isolated = yield* makeIsolatedNativeDatabaseFixture({
        mode: 'empty',
        // The empty-mode purpose gates unrelated composition controls; this suite only uses the
        // helper's owned database creation, migration bootstrap and cleanup.
        purpose: 'stabilization-1258-privacy-drain',
      });
      yield* isolated.migrateCoreSchema();
      const adminClient = yield* makeTestPgClient(isolated.connections.admin.connectionString);
      const crypto = yield* Crypto.Crypto;
      const tenantId = yield* crypto.randomUUIDv4();
      yield* adminClient.unsafe(
        `insert into core.tenants (tenant_id, slug, name, status, default_locale)
         values ($1, $2, 'Indexed query tenant', 'active', 'en')`,
        [tenantId, `search-${tenantId.slice(0, 8)}`],
      );
      yield* adminClient.unsafe(`grant usage on schema core to ${FIXTURE_WORKER_IDENTITY.role}`);
      yield* adminClient.unsafe(
        `grant select on core.application_composition_authority to ${FIXTURE_WORKER_IDENTITY.role}`,
      );
      yield* adminClient.unsafe(
        `grant select, insert, update on core.search_index_entries to ${FIXTURE_WORKER_IDENTITY.role}`,
      );
      yield* adminClient.unsafe(
        `grant select, insert, update on core.search_projection_generations to ${FIXTURE_WORKER_IDENTITY.role}`,
      );
      yield* adminClient.unsafe(
        `grant select, insert, update on core.search_projection_rebuilds to ${FIXTURE_WORKER_IDENTITY.role}`,
      );
      const snapshot = yield* makeApplicationCompositionSnapshotFixture(['search'], compositionMarker);
      yield* isolated.publishInitialComposition(snapshot);
      const principalId = yield* crypto.randomUUIDv4();
      const workerPrincipal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
        authBindingId: '40000000-0000-4000-8000-000000000009',
        authContextRef: 'better-auth-session:search-indexed-query',
        authMethod: 'session',
        principalId,
        tenantId,
      });
      const executor = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const store = makePostgresCoreSearchProjectionStore(
        { executor: withWorkerExecutor(executor) },
        FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      );
      return yield* consume({
        admin: adminClient,
        compositionRevision: snapshot.composition.revision,
        store,
        workerScope: { ...workerPrincipal, correlationId: compositionMarker },
      });
    }),
  );

const workerContext = (tenantId: string, compositionRevision: string, suffix: string) =>
  attestOutboxWorkerHandlerContext({
    attemptNumber: 1,
    claimId: `claim-${suffix}`,
    compositionRevision,
    consumerModuleKey: moduleId,
    deliveryId: `delivery-${suffix}`,
    domainEventId: `event-${suffix}`,
    legalEntityScope: 'forbidden',
    messageId: `message-${suffix}`,
    producerModuleKey: moduleId,
    tenantId,
    tenantSequenceNo: 1n,
    topic: 'party.registry.party-updated.v1',
    workerKey: 'party.registry.project-party-updated-to-search',
  });

const queryFor = (tenantId: string, text: string) =>
  Schema.decodeEffect(CoreSearchQuerySchema)({
    includeArchived: false,
    moduleId,
    query: text,
    resourceType,
    tenantId,
  });

const document = (tenantId: string, resourceId: string, version: string, title: string, text: string) => ({
  archived: false,
  facets: [],
  metadata: [],
  projectionVersion: version,
  ref: { moduleId, resourceId, resourceType, tenantId },
  searchableText: [text],
  title,
});

it.layer(Layer.merge(nativeServices, NodeCrypto.layer), { excludeTestServices: true })(
  'Core search indexed query',
  (suite) => {
    suite.effect(
      'writes derived evidence and repairs the same accepted version without advancing versions, generations or floors',
      () =>
        withFixture(({ admin, compositionRevision, store, workerScope }) =>
          Effect.gen(function* derivedWrites() {
            yield* admin.unsafe(
              `insert into core.search_projection_generations
               (tenant_id, source_module_key, generation, event_watermark)
               values ($1, $2, 7, 11)`,
              [workerScope.tenantId, moduleId],
            );
            yield* admin.unsafe(
              `insert into core.search_projection_rebuilds
               (tenant_id, source_module_key, source_resource_type, rebuild_version, fingerprint)
               values ($1, $2, $3, 1, $4)`,
              [workerScope.tenantId, moduleId, resourceType, 'a'.repeat(64)],
            );
            const context = workerContext(workerScope.tenantId, compositionRevision, 'derived');
            yield* store.apply(
              { document: document(workerScope.tenantId, 'derived-1', '2', 'Needle', 'needle'), kind: 'upsert' },
              context,
            );
            const [written] = yield* admin.unsafe<{
              readonly search_format_version: number | null;
              readonly search_source_version: string | null;
              readonly search_text_v1: string | null;
              readonly version: string;
            }>(
              `select search_text_v1, search_format_version, search_source_version::text as search_source_version,
                projection_version::text as version
              from core.search_index_entries
              where tenant_id = $1 and source_resource_id = 'derived-1'`,
              [workerScope.tenantId],
            );
            expect(written).toEqual({
              search_format_version: 1,
              search_source_version: '2',
              search_text_v1: 'needle\nneedle',
              version: '2',
            });

            // Corrupt only the derived representation. The accepted v2 payload is unchanged, so the
            // idempotent same-version write must repair evidence without a lifecycle advance.
            yield* admin.unsafe(
              `update core.search_index_entries
               set search_text_v1 = 'stale', search_format_version = 0, search_source_version = 0
               where tenant_id = $1 and source_resource_id = 'derived-1'`,
              [workerScope.tenantId],
            );
            yield* store.apply(
              { document: document(workerScope.tenantId, 'derived-1', '2', 'Needle', 'needle'), kind: 'upsert' },
              context,
            );
            expect(
              yield* admin.unsafe(
                `select search_text_v1, search_format_version, search_source_version::text as search_source_version,
                    projection_version::text as version
                 from core.search_index_entries
                 where tenant_id = $1 and source_resource_id = 'derived-1'`,
                [workerScope.tenantId],
              ),
            ).toEqual([
              {
                search_format_version: 1,
                search_source_version: '2',
                search_text_v1: 'needle\nneedle',
                version: '2',
              },
            ]);
            expect(
              yield* admin.unsafe(
                `select generation::text as generation, event_watermark::text as event_watermark
                 from core.search_projection_generations where tenant_id = $1 and source_module_key = $2`,
                [workerScope.tenantId, moduleId],
              ),
            ).toEqual([{ event_watermark: '11', generation: '7' }]);
            expect(
              yield* admin.unsafe(
                `select rebuild_version::text as rebuild_version, fingerprint
                 from core.search_projection_rebuilds
                 where tenant_id = $1 and source_module_key = $2 and source_resource_type = $3`,
                [workerScope.tenantId, moduleId, resourceType],
              ),
            ).toEqual([{ fingerprint: 'a'.repeat(64), rebuild_version: '1' }]);
          }),
        ),
      60_000,
    );

    suite.effect(
      'keeps stale and old-writer NULL rows in the candidate shortlist and verifies their exact v2 evidence',
      () =>
        withFixture(({ admin, compositionRevision, store, workerScope }) =>
          Effect.gen(function* staleFallback() {
            const context = workerContext(workerScope.tenantId, compositionRevision, 'fallback');
            yield* store.apply(
              { document: document(workerScope.tenantId, 'stale-1', '1', 'Needle', 'needle'), kind: 'upsert' },
              context,
            );
            yield* admin.unsafe(
              `update core.search_index_entries
               set search_text_v1 = 'stale', search_source_version = 0
               where tenant_id = $1 and source_resource_id = 'stale-1'`,
              [workerScope.tenantId],
            );
            // The old writer names only the original v2 columns; the three additive columns stay NULL.
            yield* admin.unsafe(
              `insert into core.search_index_entries
               (tenant_id, source_module_key, source_resource_type, source_resource_id, title, body_text,
                deleted, facets_json, projection_version)
               values ($1, $2, $3, 'legacy-1', 'Legacy needle', 'legacy needle' || chr(10) || 'needle',
                 false, '{"schemaVersion":"2","archived":false,"facets":[],"metadata":[],"searchableText":["needle"]}'::jsonb, 1),
               ($1, $2, $3, 'nonmatch-1', 'Other', 'other' || chr(10) || 'other',
                 false, '{"schemaVersion":"2","archived":false,"facets":[],"metadata":[],"searchableText":["other"]}'::jsonb, 1)`,
              [workerScope.tenantId, moduleId, resourceType],
            );
            expect(
              yield* admin.unsafe(
                `select search_text_v1, search_format_version, search_source_version
                 from core.search_index_entries where tenant_id = $1 and source_resource_id = 'legacy-1'`,
                [workerScope.tenantId],
              ),
            ).toEqual([{ search_format_version: null, search_source_version: null, search_text_v1: null }]);

            const query = yield* queryFor(workerScope.tenantId, 'needle');
            const candidates = yield* store.queryCandidates(query, workerScope);
            // The shortlist is intentionally necessary-only: NULL derived evidence is admitted and
            // the exact v2 payload decides the final hit set.
            expect(candidates.map(({ ref }) => ref.resourceId).toSorted()).toEqual([
              'legacy-1',
              'nonmatch-1',
              'stale-1',
            ]);
            const runtime = yield* createCoreSearchQueryRuntime.pipe(
              Effect.provideService(CoreSearchProjectionStore, store),
            );
            expect((yield* runtime.search(query, workerScope)).map(({ ref }) => ref.resourceId).toSorted()).toEqual([
              'legacy-1',
              'stale-1',
            ]);
            expect(
              (yield* runtime.search({ ...query, query: 'absent' }, workerScope)).map(({ ref }) => ref.resourceId),
            ).toEqual([]);
          }),
        ),
      60_000,
    );

    suite.effect(
      'applies the work budget to the selective shortlist and still fails closed on a full corpus bucket',
      () =>
        withFixture(({ admin, store, workerScope }) =>
          Effect.gen(function* selectiveBudget() {
            yield* admin.unsafe(
              `insert into core.search_index_entries
               (tenant_id, source_module_key, source_resource_type, source_resource_id, title, body_text,
                search_text_v1, search_format_version, search_source_version, deleted, facets_json, projection_version)
               select $1, $2, $3, 'corpus-' || value, 'Corpus', 'corpus' || chr(10) || 'corpus',
                 'corpus', 1, 1, false,
                 '{"schemaVersion":"2","archived":false,"facets":[],"metadata":[],"searchableText":["corpus"]}'::jsonb, 1
               from generate_series(1, 10005) as value`,
              [workerScope.tenantId, moduleId, resourceType],
            );
            yield* admin.unsafe(
              `insert into core.search_index_entries
               (tenant_id, source_module_key, source_resource_type, source_resource_id, title, body_text,
                search_text_v1, search_format_version, search_source_version, deleted, facets_json, projection_version)
               values ($1, $2, $3, 'selective-1', 'Selective needle', 'selective needle' || chr(10) || 'needle',
                 'needle', 1, 1, false,
                 '{"schemaVersion":"2","archived":false,"facets":[],"metadata":[],"searchableText":["needle"]}'::jsonb, 1)`,
              [workerScope.tenantId, moduleId, resourceType],
            );
            const selective = yield* store.queryCandidates(
              yield* queryFor(workerScope.tenantId, 'needle'),
              workerScope,
            );
            expect(selective.map(({ ref }) => ref.resourceId)).toEqual(['selective-1']);
            const failure = yield* Effect.flip(
              store.queryCandidates(yield* queryFor(workerScope.tenantId, 'corpus'), workerScope),
            );
            expect(Predicate.isTagged(failure, 'CoreSearchProjectionUnavailable')).toBe(true);
            // A decode failure would carry a cause; the budget guard fails before decoding any row.
            expect(failure.cause).toBeUndefined();
          }),
        ),
      60_000,
    );
  },
);
