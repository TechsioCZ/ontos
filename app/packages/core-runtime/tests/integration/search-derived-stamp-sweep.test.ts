import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { Crypto, Effect, Exit, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { coreRelations } from '../../src/db/schema.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../src/db/types.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import {
  makeCoreSearchDerivedStampSweep,
  makePostgresCoreSearchProjectionStore,
} from '../../src/search/persistence.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { makeIsolatedNativeDatabaseFixture } from '../../src/testing/isolated-native-database.ts';
import { makeApplicationCompositionSnapshotFixture } from '../../src/testing/module-contract.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT, FIXTURE_WORKER_IDENTITY } from '../support/database-identities.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const compositionMarker = 'search-derived-stamp-sweep';
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
    readonly sweep: ReturnType<typeof makeCoreSearchDerivedStampSweep>;
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
      yield* adminClient.unsafe(`grant select on core.tenants to ${FIXTURE_WORKER_IDENTITY.role}`);
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
      const sweep = makeCoreSearchDerivedStampSweep(
        { executor: withWorkerExecutor(executor) },
        FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      );
      return yield* consume({
        admin: adminClient,
        compositionRevision: snapshot.composition.revision,
        store,
        sweep,
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

const document = (tenantId: string, resourceId: string, version: string, title: string, text: string) => ({
  archived: false,
  facets: [],
  metadata: [],
  projectionVersion: version,
  ref: { moduleId, resourceId, resourceType, tenantId },
  searchableText: [text],
  title,
});

interface StampRow {
  readonly id: string;
  readonly search_format_version: number | null;
  readonly search_source_version: string | null;
  readonly search_text_v1: string | null;
  readonly version: string;
}

const readStamps = (admin: PgClient.PgClient, tenantId: string) =>
  admin.unsafe<StampRow>(
    `select source_resource_id as id, search_text_v1, search_format_version,
       search_source_version::text as search_source_version, projection_version::text as version
     from core.search_index_entries where tenant_id = $1 order by source_resource_id`,
    [tenantId],
  );

const stamped = (id: string, version: string, text: string): StampRow => ({
  id,
  search_format_version: 1,
  search_source_version: version,
  search_text_v1: text,
  version,
});

it.layer(Layer.merge(nativeServices, NodeCrypto.layer), { excludeTestServices: true })(
  'Core search derived stamp sweep',
  (suite) => {
    suite.effect(
      'restores missing and stale stamps without lifecycle changes, then finds nothing to repair',
      () =>
        withFixture(({ admin, compositionRevision, store, sweep, workerScope }) =>
          Effect.gen(function* sweepRepairs() {
            const context = workerContext(workerScope.tenantId, compositionRevision, 'sweep');
            yield* store.apply(
              { document: document(workerScope.tenantId, 'sweep-1', '3', 'Alpha', 'alpha'), kind: 'upsert' },
              context,
            );
            yield* store.apply(
              { document: document(workerScope.tenantId, 'sweep-2', '5', 'Beta', 'beta'), kind: 'upsert' },
              context,
            );
            yield* store.apply(
              { document: document(workerScope.tenantId, 'sweep-3', '1', 'Gamma', 'gamma'), kind: 'upsert' },
              context,
            );
            // An old writer left NULL stamps; a format change left a stale one; the third row is current.
            yield* admin.unsafe(
              `update core.search_index_entries
               set search_text_v1 = null, search_format_version = null, search_source_version = null
               where tenant_id = $1 and source_resource_id = 'sweep-1'`,
              [workerScope.tenantId],
            );
            yield* admin.unsafe(
              `update core.search_index_entries set search_text_v1 = 'stale', search_format_version = 0
               where tenant_id = $1 and source_resource_id = 'sweep-2'`,
              [workerScope.tenantId],
            );

            const first = yield* sweep({ compositionRevision, modules: { only: [moduleId] } });
            expect(first).toEqual({ repaired: 2, units: 1 });
            expect(yield* readStamps(admin, workerScope.tenantId)).toEqual([
              stamped('sweep-1', '3', 'alpha\nalpha'),
              stamped('sweep-2', '5', 'beta\nbeta'),
              stamped('sweep-3', '1', 'gamma\ngamma'),
            ]);

            const second = yield* sweep({ compositionRevision, modules: { only: [moduleId] } });
            expect(second).toEqual({ repaired: 0, units: 0 });
          }),
        ),
      60_000,
    );

    suite.effect(
      'a superseded composition revision cannot rewrite stamps',
      () =>
        withFixture(({ admin, compositionRevision, store, sweep, workerScope }) =>
          Effect.gen(function* fencedSweep() {
            const context = workerContext(workerScope.tenantId, compositionRevision, 'fence');
            yield* store.apply(
              { document: document(workerScope.tenantId, 'fence-1', '2', 'Delta', 'delta'), kind: 'upsert' },
              context,
            );
            yield* admin.unsafe(
              `update core.search_index_entries
               set search_text_v1 = null, search_format_version = null, search_source_version = null
               where tenant_id = $1 and source_resource_id = 'fence-1'`,
              [workerScope.tenantId],
            );
            const superseded = yield* Effect.exit(
              sweep({ compositionRevision: 'f'.repeat(64), modules: { only: [moduleId] } }),
            );
            expect(Exit.isFailure(superseded)).toBe(true);
            expect(yield* readStamps(admin, workerScope.tenantId)).toEqual([
              {
                id: 'fence-1',
                search_format_version: null,
                search_source_version: null,
                search_text_v1: null,
                version: '2',
              },
            ]);
          }),
        ),
      60_000,
    );

    suite.effect(
      'leaves the modules outside its identity untouched',
      () =>
        withFixture(({ admin, compositionRevision, store, sweep, workerScope }) =>
          Effect.gen(function* excludedModules() {
            const context = workerContext(workerScope.tenantId, compositionRevision, 'excluded');
            yield* store.apply(
              { document: document(workerScope.tenantId, 'excluded-1', '4', 'Omega', 'omega'), kind: 'upsert' },
              context,
            );
            yield* admin.unsafe(
              `update core.search_index_entries set search_source_version = 0
               where tenant_id = $1 and source_resource_id = 'excluded-1'`,
              [workerScope.tenantId],
            );
            const result = yield* sweep({ compositionRevision, modules: { except: [moduleId] } });
            expect(result).toEqual({ repaired: 0, units: 0 });
            expect((yield* readStamps(admin, workerScope.tenantId))[0]?.search_source_version).toBe('0');
          }),
        ),
      60_000,
    );
  },
);
