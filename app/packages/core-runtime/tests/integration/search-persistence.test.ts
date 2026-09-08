import {
  makeEffectTestCallback as nativeTestCallback,
  makeEffectTestCallback,
} from '@app/core-runtime/testing/effect-runtime';

import { Effect, Function as Fn, Exit as NativeExit, Scope as NativeScope, Schema } from 'effect';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after as afterNativeDatabase } from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';
import { Pool } from 'pg';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { makePostgresCoreSearchProjectionStore } from '../../src/search/persistence.ts';
import {
  CoreSearchProjectionStore,
  createCoreSearchQueryRuntime,
} from '../../src/search/projection.ts';
import { makeTestDatabaseFromPool } from '../support/database.ts';
import { runEffectTestSync as runNativeSync } from '../support/effect-runtime.ts';

const nativeDatabaseScope = runNativeSync(NativeScope.make());
afterNativeDatabase(
  NativeScope.close(nativeDatabaseScope, NativeExit.void).pipe(nativeTestCallback),
);

const queryEffect = <Row extends QueryResultRow = QueryResultRow>(
  client: Pool,
  statement: string,
  parameters?: readonly unknown[],
): Effect.Effect<QueryResult<Row>> =>
  Effect.suspend(() =>
    Effect.promise(Fn.constant(client.query<Row>(statement, [...(parameters ?? [])]))),
  );
const endPool = (pool: Pool): Effect.Effect<void> =>
  Effect.suspend(() => Effect.promise(Fn.constant(pool.end())));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const effectTest = <Value, Failure>(name: string, effect: Effect.Effect<Value, Failure>): void => {
  test(name, makeEffectTestCallback(effect));
};

effectTest(
  'durably rebuilds tenant projections with tombstones and selected-Legal-Entity filtering',
  Effect.gen(function* searchPersistenceIntegration() {
    const connections = yield* loadDatabaseConnectionPair();
    const admin = new Pool({ connectionString: connections.admin.connectionString });
    const runtimePool = new Pool({ connectionString: connections.runtime.connectionString });
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const legalEntityId = randomUUID();
    const otherLegalEntityId = randomUUID();
    const partyId = randomUUID();
    const removedPartyId = randomUUID();
    const counterpartyId = randomUUID();
    const otherCounterpartyId = randomUUID();
    const aliasRef = {
      moduleId: 'party.registry',
      resourceId: randomUUID(),
      resourceType: 'party.registry.party',
      tenantId,
    };
    const store = makePostgresCoreSearchProjectionStore({
      executor: yield* makeTestDatabaseFromPool(runtimePool, coreRelations).pipe(
        NativeScope.provide(nativeDatabaseScope),
      ),
    });
    const search = yield* createCoreSearchQueryRuntime.pipe(
      Effect.provideService(CoreSearchProjectionStore, store),
    );
    const partyDocument = (resourceId: string, projectionVersion: string, title: string) => ({
      aliases: [
        {
          kind: 'resource',
          ref: aliasRef,
          searchableText: ['Former Acme'],
          temporalSearchableText: [
            {
              validFrom: '2026-01-01T00:00:00Z',
              validTo: '2026-02-01T00:00:00Z',
              value: 'alias-private@example.test',
            },
          ],
        },
      ],
      archived: false,
      facets: [],
      metadata: [],
      projectionVersion,
      ref: {
        moduleId: 'party.registry',
        resourceId,
        resourceType: 'party.registry.party',
        tenantId,
      },
      searchableText: [title, 'private@example.test'],
      temporalSearchableText: [
        {
          validFrom: '2026-02-01T00:00:00Z',
          value: 'canonical-private@example.test',
        },
      ],
      title,
    });
    const counterpartyDocument = (resourceId: string, selectedLegalEntityId: string) => ({
      archived: false,
      facets: [],
      metadata: [],
      projectionVersion: '1',
      ref: {
        moduleId: 'party.registry',
        resourceId,
        resourceType: 'party.registry.counterparty',
        tenantId,
      },
      searchableText: ['Acme counterparty'],
      selectedLegalEntityId,
      title: 'Acme counterparty',
    });

    const cleanup = Effect.gen(function* cleanSearchPersistenceFixtures() {
      yield* queryEffect(admin, `delete from core.search_index_entries where tenant_id = $1`, [
        tenantId,
      ]);
      yield* queryEffect(
        admin,
        `delete from core.search_projection_rebuilds where tenant_id = $1`,
        [tenantId],
      );
      yield* queryEffect(admin, `delete from core.legal_entities where tenant_id = $1`, [tenantId]);
      yield* queryEffect(admin, `delete from core.tenants where tenant_id in ($1, $2)`, [
        tenantId,
        otherTenantId,
      ]);
    }).pipe(Effect.orDie);

    yield* Effect.gen(function* exerciseSearchPersistence() {
      yield* queryEffect(
        admin,
        `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Search tenant', 'active', 'en'), ($3, $4, 'Other tenant', 'active', 'en')`,
        [tenantId, `search-${tenantId}`, otherTenantId, `search-${otherTenantId}`],
      );
      yield* queryEffect(
        admin,
        `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values ($1::uuid, $2, 'Search LE', 'CZ', $1::uuid::text, 'active'), ($3::uuid, $2, 'Other LE', 'CZ', $3::uuid::text, 'active')`,
        [legalEntityId, tenantId, otherLegalEntityId],
      );

      yield* store.replace({
        documents: [
          partyDocument(partyId, '1', 'Acme'),
          partyDocument(removedPartyId, '1', 'Remove me'),
        ],
        moduleId: 'party.registry',
        rebuildVersion: '1',
        resourceType: 'party.registry.party',
        tenantId,
      });
      yield* store.replace({
        documents: [partyDocument(partyId, '2', 'Acme current')],
        moduleId: 'party.registry',
        rebuildVersion: '2',
        resourceType: 'party.registry.party',
        tenantId,
      });
      yield* store.apply({
        document: partyDocument(partyId, '1', 'Acme stale'),
        kind: 'upsert',
      });
      yield* store.apply({
        document: counterpartyDocument(counterpartyId, legalEntityId),
        kind: 'upsert',
      });
      yield* store.apply({
        document: counterpartyDocument(otherCounterpartyId, otherLegalEntityId),
        kind: 'upsert',
      });

      const partyHits = yield* search.search({
        includeArchived: false,
        moduleId: 'party.registry',
        query: 'private@example.test',
        resourceType: 'party.registry.party',
        tenantId,
      });
      assert.deepEqual(
        partyHits.map(({ title }) => title),
        ['Acme current'],
      );
      assert.doesNotMatch(yield* encodeJson(partyHits), /private@example\.test/u);
      const evidenceSearch = (query: string, effectiveAt = '2026-02-01T00:00:00Z') =>
        search.search({
          effectiveAt,
          includeArchived: false,
          moduleId: 'party.registry',
          query,
          resourceType: 'party.registry.party',
          tenantId,
        });
      const aliasHits = yield* evidenceSearch('former');
      assert.equal(aliasHits.length, 1);
      assert.deepEqual(aliasHits[0]?.matchedRef, aliasRef);
      const canonicalHits = yield* evidenceSearch('acme');
      assert.equal(canonicalHits[0]?.matchedRef, undefined);
      const historicalAliasHits = yield* evidenceSearch('alias-private', '2026-01-01T00:00:00Z');
      assert.deepEqual(historicalAliasHits[0]?.matchedRef, aliasRef);
      assert.deepEqual(yield* evidenceSearch('alias-private'), []);
      assert.deepEqual(yield* evidenceSearch('canonical-private', '2026-01-31T00:00:00Z'), []);
      const temporalHits = yield* evidenceSearch('canonical-private');
      assert.equal(temporalHits.length, 1);
      assert.equal(temporalHits[0]?.matchedRef, undefined);
      assert.doesNotMatch(
        yield* encodeJson([aliasHits, temporalHits]),
        /private@example|searchableText|aliases/u,
      );
      const floorRef = { ...aliasRef, resourceType: 'party.registry.floor-test' };
      const emptyRebuild = {
        documents: [],
        moduleId: floorRef.moduleId,
        rebuildVersion: '2',
        resourceType: floorRef.resourceType,
        tenantId,
      };
      const staleDocument = {
        ...partyDocument(floorRef.resourceId, '1', 'Unseen resource'),
        ref: floorRef,
      };
      yield* store.replace(emptyRebuild);
      // A fresh service instance must observe the durable floor, not process-local state.
      const restarted = makePostgresCoreSearchProjectionStore({
        executor: yield* makeTestDatabaseFromPool(runtimePool, coreRelations).pipe(
          NativeScope.provide(nativeDatabaseScope),
        ),
      });
      const restartedSearch = yield* createCoreSearchQueryRuntime.pipe(
        Effect.provideService(CoreSearchProjectionStore, restarted),
      );
      const floorSearch = () =>
        restartedSearch.search({
          includeArchived: false,
          moduleId: floorRef.moduleId,
          query: 'unseen',
          resourceType: floorRef.resourceType,
          tenantId,
        });
      yield* restarted.apply({ document: staleDocument, kind: 'upsert' });
      yield* restarted.replace({
        ...emptyRebuild,
        documents: [staleDocument],
        rebuildVersion: '1',
      });
      assert.deepEqual(yield* floorSearch(), []);
      yield* restarted.replace(emptyRebuild);
      const divergence = yield* Effect.flip(
        restarted.replace({ ...emptyRebuild, documents: [staleDocument] }),
      );
      assert.equal(divergence._tag, 'CoreSearchProjectionInvalid');
      yield* restarted.apply({
        document: { ...staleDocument, projectionVersion: '3' },
        kind: 'upsert',
      });
      yield* restarted.replace(emptyRebuild);
      const rebuiltFloorHits = yield* floorSearch();
      assert.equal(rebuiltFloorHits.length, 1);
      const rebuildRows = yield* queryEffect(
        runtimePool,
        `select rebuild_version from core.search_projection_rebuilds where tenant_id = $1`,
        [tenantId],
      );
      assert.equal(rebuildRows.rowCount, 0);
      const counterpartyHits = yield* search.search({
        includeArchived: false,
        moduleId: 'party.registry',
        query: 'acme',
        resourceType: 'party.registry.counterparty',
        selectedLegalEntityId: legalEntityId,
        tenantId,
      });
      assert.deepEqual(
        counterpartyHits.map(({ ref }) => ref.resourceId),
        [counterpartyId],
      );
      assert.deepEqual(
        yield* search.search({
          includeArchived: false,
          moduleId: 'party.registry',
          query: 'acme',
          resourceType: 'party.registry.counterparty',
          tenantId,
        }),
        [],
      );

      const runtimeRows = yield* queryEffect(
        runtimePool,
        `select source_resource_id from core.search_index_entries where tenant_id = $1`,
        [tenantId],
      );
      assert.equal(runtimeRows.rowCount, 0);
      const stored = yield* queryEffect<{ deleted: boolean; projection_version: string }>(
        admin,
        `select deleted, projection_version::text from core.search_index_entries where tenant_id = $1 and source_resource_id = $2`,
        [tenantId, removedPartyId],
      );
      assert.deepEqual(stored.rows, [{ deleted: true, projection_version: '2' }]);
    }).pipe(
      Effect.ensuring(cleanup),
      Effect.ensuring(
        Effect.all([endPool(admin), endPool(runtimePool)], { concurrency: 'unbounded' }).pipe(
          Effect.orDie,
        ),
      ),
    );
  }),
);
