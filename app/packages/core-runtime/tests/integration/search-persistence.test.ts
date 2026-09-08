import { expect, it } from '@app/effect-rstest';

import { Effect, Function as Fn, Schema, Predicate } from 'effect';
import { randomUUID } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import { Pool } from 'pg';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { makePostgresCoreSearchProjectionStore } from '../../src/search/persistence.ts';
import { makeCoreSearchQueryRuntime } from '../../src/search/projection.ts';
import { makeTestDatabaseFromPool } from '../support/database.ts';

const queryEffect = <Row extends QueryResultRow = QueryResultRow>(
  client: Pool,
  statement: string,
  parameters?: readonly unknown[],
): Effect.Effect<QueryResult<Row>> =>
  Effect.suspend(() =>
    Effect.promise(Fn.constant(client.query<Row>(statement, [...(parameters ?? [])]))),
  );
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.live(
  'durably rebuilds tenant projections with tombstones and selected-Legal-Entity filtering',
  () =>
    Effect.gen(function* searchPersistenceIntegration() {
      const connections = yield* loadDatabaseConnectionPair();
      const admin = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: connections.admin.connectionString })),
        (ownedPool) => Effect.promise(() => ownedPool.end()).pipe(Effect.orDie),
      );
      const runtimePool = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: connections.runtime.connectionString })),
        (ownedPool) => Effect.promise(() => ownedPool.end()).pipe(Effect.orDie),
      );
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
        executor: yield* makeTestDatabaseFromPool(runtimePool, coreRelations),
      });
      const search = makeCoreSearchQueryRuntime(store);
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
        yield* queryEffect(admin, `delete from core.legal_entities where tenant_id = $1`, [
          tenantId,
        ]);
        yield* queryEffect(admin, `delete from core.tenants where tenant_id in ($1, $2)`, [
          tenantId,
          otherTenantId,
        ]);
      }).pipe(Effect.orDie);

      yield* Effect.addFinalizer(() => cleanup);
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
      expect(partyHits.map(({ title }) => title)).toEqual(['Acme current']);
      expect(yield* encodeJson(partyHits)).not.toMatch(/private@example\.test/u);
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
      expect(aliasHits.length).toBe(1);
      expect(aliasHits[0]?.matchedRef).toEqual(aliasRef);
      const canonicalHits = yield* evidenceSearch('acme');
      expect(canonicalHits[0]?.matchedRef).toBe(undefined);
      const historicalAliasHits = yield* evidenceSearch('alias-private', '2026-01-01T00:00:00Z');
      expect(historicalAliasHits[0]?.matchedRef).toEqual(aliasRef);
      expect(yield* evidenceSearch('alias-private')).toEqual([]);
      expect(yield* evidenceSearch('canonical-private', '2026-01-31T00:00:00Z')).toEqual([]);
      const temporalHits = yield* evidenceSearch('canonical-private');
      expect(temporalHits.length).toBe(1);
      expect(temporalHits[0]?.matchedRef).toBe(undefined);
      expect(yield* encodeJson([aliasHits, temporalHits])).not.toMatch(
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
        executor: yield* makeTestDatabaseFromPool(runtimePool, coreRelations),
      });
      const floorSearch = () =>
        makeCoreSearchQueryRuntime(restarted).search({
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
      expect(yield* floorSearch()).toEqual([]);
      yield* restarted.replace(emptyRebuild);
      const divergence = yield* Effect.flip(
        restarted.replace({ ...emptyRebuild, documents: [staleDocument] }),
      );
      expect(Predicate.isTagged(divergence, 'CoreSearchProjectionInvalid')).toBe(true);
      yield* restarted.apply({
        document: { ...staleDocument, projectionVersion: '3' },
        kind: 'upsert',
      });
      yield* restarted.replace(emptyRebuild);
      const rebuiltFloorHits = yield* floorSearch();
      expect(rebuiltFloorHits.length).toBe(1);
      const rebuildRows = yield* queryEffect(
        runtimePool,
        `select rebuild_version from core.search_projection_rebuilds where tenant_id = $1`,
        [tenantId],
      );
      expect(rebuildRows.rowCount).toBe(0);
      const counterpartyHits = yield* search.search({
        includeArchived: false,
        moduleId: 'party.registry',
        query: 'acme',
        resourceType: 'party.registry.counterparty',
        selectedLegalEntityId: legalEntityId,
        tenantId,
      });
      expect(counterpartyHits.map(({ ref }) => ref.resourceId)).toEqual([counterpartyId]);
      expect(
        yield* search.search({
          includeArchived: false,
          moduleId: 'party.registry',
          query: 'acme',
          resourceType: 'party.registry.counterparty',
          tenantId,
        }),
      ).toEqual([]);

      const runtimeRows = yield* queryEffect(
        runtimePool,
        `select source_resource_id from core.search_index_entries where tenant_id = $1`,
        [tenantId],
      );
      expect(runtimeRows.rowCount).toBe(0);
      const stored = yield* queryEffect<{ deleted: boolean; projection_version: string }>(
        admin,
        `select deleted, projection_version::text from core.search_index_entries where tenant_id = $1 and source_resource_id = $2`,
        [tenantId, removedPartyId],
      );
      expect(stored.rows).toEqual([{ deleted: true, projection_version: '2' }]);
    }),
);
