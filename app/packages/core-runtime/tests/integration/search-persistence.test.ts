/* oxlint-disable typescript/return-await */
// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
/* eslint-disable unicorn/no-await-expression-member -- Direct assertions keep durable queries next to their expected transaction state. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect } from 'effect';
import { Pool } from 'pg';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreDatabaseSchema } from '../../src/db/schema.ts';
import { makePostgresCoreSearchProjectionStore } from '../../src/search/persistence.ts';
import { makeCoreSearchQueryRuntime } from '../../src/search/projection.ts';

test('durably rebuilds tenant projections with tombstones and selected-Legal-Entity filtering', async () => {
  const connections = await Effect.runPromise(loadDatabaseConnectionPair());
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
    executor: drizzle({ client: runtimePool, schema: coreDatabaseSchema }),
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

  try {
    await admin.query(
      `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Search tenant', 'active', 'en'), ($3, $4, 'Other tenant', 'active', 'en')`,
      [tenantId, `search-${tenantId}`, otherTenantId, `search-${otherTenantId}`],
    );
    await admin.query(
      `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values ($1, $2, 'Search LE', 'CZ', $1, 'active'), ($3, $2, 'Other LE', 'CZ', $3, 'active')`,
      [legalEntityId, tenantId, otherLegalEntityId],
    );

    await Effect.runPromise(
      store.replace({
        documents: [
          partyDocument(partyId, '1', 'Acme'),
          partyDocument(removedPartyId, '1', 'Remove me'),
        ],
        moduleId: 'party.registry',
        rebuildVersion: '1',
        resourceType: 'party.registry.party',
        tenantId,
      }),
    );
    await Effect.runPromise(
      store.replace({
        documents: [partyDocument(partyId, '2', 'Acme current')],
        moduleId: 'party.registry',
        rebuildVersion: '2',
        resourceType: 'party.registry.party',
        tenantId,
      }),
    );
    await Effect.runPromise(
      store.apply({
        document: partyDocument(partyId, '1', 'Acme stale'),
        kind: 'upsert',
      }),
    );
    await Effect.runPromise(
      store.apply({
        document: counterpartyDocument(counterpartyId, legalEntityId),
        kind: 'upsert',
      }),
    );
    await Effect.runPromise(
      store.apply({
        document: counterpartyDocument(otherCounterpartyId, otherLegalEntityId),
        kind: 'upsert',
      }),
    );

    const partyHits = await Effect.runPromise(
      search.search({
        includeArchived: false,
        moduleId: 'party.registry',
        query: 'private@example.test',
        resourceType: 'party.registry.party',
        tenantId,
      }),
    );
    assert.deepEqual(
      partyHits.map(({ title }) => title),
      ['Acme current'],
    );
    assert.doesNotMatch(JSON.stringify(partyHits), /private@example\.test/u);
    const evidenceSearch = async (query: string, effectiveAt = '2026-02-01T00:00:00Z') =>
      Effect.runPromise(
        search.search({
          effectiveAt,
          includeArchived: false,
          moduleId: 'party.registry',
          query,
          resourceType: 'party.registry.party',
          tenantId,
        }),
      );
    const aliasHits = await evidenceSearch('former');
    assert.equal(aliasHits.length, 1);
    assert.deepEqual(aliasHits[0]?.matchedRef, aliasRef);
    assert.equal((await evidenceSearch('acme'))[0]?.matchedRef, undefined);
    assert.deepEqual(
      (await evidenceSearch('alias-private', '2026-01-01T00:00:00Z'))[0]?.matchedRef,
      aliasRef,
    );
    assert.deepEqual(await evidenceSearch('alias-private'), []);
    assert.deepEqual(await evidenceSearch('canonical-private', '2026-01-31T00:00:00Z'), []);
    const temporalHits = await evidenceSearch('canonical-private');
    assert.equal(temporalHits.length, 1);
    assert.equal(temporalHits[0]?.matchedRef, undefined);
    assert.doesNotMatch(
      JSON.stringify([aliasHits, temporalHits]),
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
    await Effect.runPromise(store.replace(emptyRebuild));
    // A fresh service instance must observe the durable floor, not process-local state.
    const restarted = makePostgresCoreSearchProjectionStore({
      executor: drizzle({ client: runtimePool, schema: coreDatabaseSchema }),
    });
    const floorSearch = async () =>
      Effect.runPromise(
        makeCoreSearchQueryRuntime(restarted).search({
          includeArchived: false,
          moduleId: floorRef.moduleId,
          query: 'unseen',
          resourceType: floorRef.resourceType,
          tenantId,
        }),
      );
    await Effect.runPromise(restarted.apply({ document: staleDocument, kind: 'upsert' }));
    await Effect.runPromise(
      restarted.replace({ ...emptyRebuild, documents: [staleDocument], rebuildVersion: '1' }),
    );
    assert.deepEqual(await floorSearch(), []);
    await Effect.runPromise(restarted.replace(emptyRebuild));
    const divergence = await Effect.runPromise(
      Effect.flip(restarted.replace({ ...emptyRebuild, documents: [staleDocument] })),
    );
    assert.equal(divergence._tag, 'CoreSearchProjectionInvalid');
    await Effect.runPromise(
      restarted.apply({ document: { ...staleDocument, projectionVersion: '3' }, kind: 'upsert' }),
    );
    await Effect.runPromise(restarted.replace(emptyRebuild));
    assert.equal((await floorSearch()).length, 1);
    assert.equal(
      (
        await runtimePool.query(
          `select rebuild_version from core.search_projection_rebuilds where tenant_id = $1`,
          [tenantId],
        )
      ).rowCount,
      0,
    );
    const counterpartyHits = await Effect.runPromise(
      search.search({
        includeArchived: false,
        moduleId: 'party.registry',
        query: 'acme',
        resourceType: 'party.registry.counterparty',
        selectedLegalEntityId: legalEntityId,
        tenantId,
      }),
    );
    assert.deepEqual(
      counterpartyHits.map(({ ref }) => ref.resourceId),
      [counterpartyId],
    );
    assert.deepEqual(
      await Effect.runPromise(
        search.search({
          includeArchived: false,
          moduleId: 'party.registry',
          query: 'acme',
          resourceType: 'party.registry.counterparty',
          tenantId,
        }),
      ),
      [],
    );

    assert.equal(
      (
        await runtimePool.query(
          `select source_resource_id from core.search_index_entries where tenant_id = $1`,
          [tenantId],
        )
      ).rowCount,
      0,
    );
    const stored = await admin.query<{ deleted: boolean; projection_version: string }>(
      `select deleted, projection_version::text from core.search_index_entries where tenant_id = $1 and source_resource_id = $2`,
      [tenantId, removedPartyId],
    );
    assert.deepEqual(stored.rows, [{ deleted: true, projection_version: '2' }]);
  } finally {
    await admin.query(`delete from core.search_index_entries where tenant_id = $1`, [tenantId]);
    await admin.query(`delete from core.search_projection_rebuilds where tenant_id = $1`, [
      tenantId,
    ]);
    await admin.query(`delete from core.legal_entities where tenant_id = $1`, [tenantId]);
    await admin.query(`delete from core.tenants where tenant_id in ($1, $2)`, [
      tenantId,
      otherTenantId,
    ]);
    await Promise.all([admin.end(), runtimePool.end()]);
  }
});
