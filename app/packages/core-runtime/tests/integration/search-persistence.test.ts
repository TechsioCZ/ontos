import type { PgClient } from '@effect/sql-pg';
import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { loadDatabaseIdentityConnections } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import { makePostgresCoreSearchProjectionStore } from '../../src/search/persistence.ts';
import { CoreSearchProjectionStore, createCoreSearchQueryRuntime } from '../../src/search/projection.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import {
  addTestGatewayScopeGrantCleanup,
  registerTestGatewayScopeGrant,
} from '../../src/testing/gateway-scope-grant.ts';
import { makeTestDatabaseFromClient, makeTestPgClient, testDatabaseClients } from '../support/database.ts';
import { installSearchTestAuthority } from '../support/search-authority.ts';

const queryEffect = <Row extends object>(
  client: PgClient.PgClient,
  statement: string,
  parameters: readonly unknown[] = [],
) => client.unsafe<Row>(statement, parameters);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const compositionRevision = 'a'.repeat(64);

/** A Party request scope backed by a grant that a Shell issuer login registered for this tenant. */
const partyRequestScope = Effect.fn('SearchPersistenceTest.partyRequestScope')(function* partyRequestScopeEffect(
  issuer: PgClient.PgClient,
  principalId: string,
  tenantId: string,
  legalEntityId?: string,
) {
  const legalEntity = legalEntityId === undefined ? {} : { legalEntityId };
  const grant = yield* registerTestGatewayScopeGrant(issuer, {
    audience: 'party-registry',
    principalId,
    tenantId,
    ...legalEntity,
  });
  const context = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000009',
    authContextRef: 'better-auth-session:core-search-persistence',
    authMethod: 'session',
    principalId,
    tenantId,
    ...legalEntity,
  });
  // Provenance is attached to the exact scope object, so the gateway marking comes last.
  const scope: OperationalScope = trustVerifiedGatewayPrincipalContext(
    { ...context, correlationId: 'core-search-persistence' },
    compositionRevision,
    { assertion: grant.assertion, audience: 'party-registry' },
  );
  return scope;
});

it.layer(NodeCrypto.layer, { excludeTestServices: true })('search persistence', (suite) => {
  suite.effect('durably rebuilds tenant projections with tombstones and selected-Legal-Entity filtering', () =>
    Effect.gen(function* searchPersistenceIntegration() {
      const { admin, runtime } = yield* testDatabaseClients;
      // Party rows are hidden from the shared runtime: the Party worker writes them and the Party
      // request role reads them only under a registered gateway grant.
      const identities = yield* loadDatabaseIdentityConnections();
      const worker = yield* makeTestPgClient(identities.runtime.party_registry_worker.connectionString);
      const partyRequest = yield* makeTestPgClient(identities.runtime.party_registry_request.connectionString);
      const issuer = yield* makeTestPgClient(identities.runtime.shell_gateway_issuer.connectionString);
      yield* installSearchTestAuthority();
      const crypto = yield* Crypto.Crypto;
      const tenantId = yield* crypto.randomUUIDv4();
      const otherTenantId = yield* crypto.randomUUIDv4();
      const principalId = yield* crypto.randomUUIDv4();
      yield* addTestGatewayScopeGrantCleanup(admin, [tenantId, otherTenantId]);
      const context = attestOutboxWorkerHandlerContext({
        attemptNumber: 1,
        claimId: 'claim-1',
        compositionRevision,
        consumerModuleKey: 'party.registry',
        deliveryId: 'delivery-1',
        domainEventId: 'event-1',
        legalEntityScope: 'forbidden',
        messageId: 'message-1',
        producerModuleKey: 'party.registry',
        tenantId,
        tenantSequenceNo: 1n,
        topic: 'party.registry.party-updated.v1',
        workerKey: 'party.registry.project-party-updated-to-search',
      });
      const legalEntityId = yield* crypto.randomUUIDv4();
      const otherLegalEntityId = yield* crypto.randomUUIDv4();
      const partyId = yield* crypto.randomUUIDv4();
      const removedPartyId = yield* crypto.randomUUIDv4();
      const counterpartyId = yield* crypto.randomUUIDv4();
      const otherCounterpartyId = yield* crypto.randomUUIDv4();
      const aliasRef = {
        moduleId: 'party.registry',
        resourceId: yield* crypto.randomUUIDv4(),
        resourceType: 'party.registry.party',
        tenantId,
      };
      const store = makePostgresCoreSearchProjectionStore({
        executor: yield* makeTestDatabaseFromClient(worker, coreRelations),
      });
      const queryStore = makePostgresCoreSearchProjectionStore({
        executor: yield* makeTestDatabaseFromClient(partyRequest, coreRelations),
      });
      const search = yield* createCoreSearchQueryRuntime.pipe(
        Effect.provideService(CoreSearchProjectionStore, queryStore),
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
        yield* queryEffect(admin, `delete from core.search_index_entries where tenant_id = $1`, [tenantId]);
        yield* queryEffect(admin, `delete from core.search_projection_rebuilds where tenant_id = $1`, [tenantId]);
        yield* queryEffect(admin, `delete from core.legal_entities where tenant_id = $1`, [tenantId]);
        yield* queryEffect(admin, `delete from core.principals where tenant_id = $1`, [tenantId]);
        yield* queryEffect(admin, `delete from core.tenants where tenant_id in ($1, $2)`, [tenantId, otherTenantId]);
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
      yield* queryEffect(
        admin,
        `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $2, 'human', 'Search principal', 'active')`,
        [principalId, tenantId],
      );

      yield* store.replace(
        {
          documents: [partyDocument(partyId, '1', 'Acme'), partyDocument(removedPartyId, '1', 'Remove me')],
          moduleId: 'party.registry',
          rebuildVersion: '1',
          resourceType: 'party.registry.party',
          tenantId,
        },
        context,
      );
      yield* store.replace(
        {
          documents: [partyDocument(partyId, '2', 'Acme current')],
          moduleId: 'party.registry',
          rebuildVersion: '2',
          resourceType: 'party.registry.party',
          tenantId,
        },
        context,
      );
      yield* store.apply(
        {
          document: partyDocument(partyId, '1', 'Acme stale'),
          kind: 'upsert',
        },
        context,
      );
      yield* store.apply(
        {
          document: counterpartyDocument(counterpartyId, legalEntityId),
          kind: 'upsert',
        },
        context,
      );
      yield* store.apply(
        {
          document: counterpartyDocument(otherCounterpartyId, otherLegalEntityId),
          kind: 'upsert',
        },
        context,
      );

      const scope = yield* partyRequestScope(issuer, principalId, tenantId);
      const partyHits = yield* search.search(
        {
          includeArchived: false,
          moduleId: 'party.registry',
          query: 'private@example.test',
          resourceType: 'party.registry.party',
          tenantId,
        },
        scope,
      );
      expect(partyHits.map(({ title }) => title)).toEqual(['Acme current']);
      expect(yield* encodeJson(partyHits)).not.toMatch(/private@example\.test/u);
      const evidenceSearch = (query: string, effectiveAt = '2026-02-01T00:00:00Z') =>
        search.search(
          {
            effectiveAt,
            includeArchived: false,
            moduleId: 'party.registry',
            query,
            resourceType: 'party.registry.party',
            tenantId,
          },
          scope,
        );
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
      expect(yield* encodeJson([aliasHits, temporalHits])).not.toMatch(/private@example|searchableText|aliases/u);
      const floorRef = {
        ...aliasRef,
        resourceType: 'party.registry.floor-test',
      };
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
      yield* store.replace(emptyRebuild, context);
      // A fresh service instance must observe the durable floor, not process-local state.
      const restarted = makePostgresCoreSearchProjectionStore({
        executor: yield* makeTestDatabaseFromClient(worker, coreRelations),
      });
      const restartedSearch = yield* createCoreSearchQueryRuntime.pipe(
        Effect.provideService(
          CoreSearchProjectionStore,
          makePostgresCoreSearchProjectionStore({
            executor: yield* makeTestDatabaseFromClient(partyRequest, coreRelations),
          }),
        ),
      );
      const floorSearch = () =>
        restartedSearch.search(
          {
            includeArchived: false,
            moduleId: floorRef.moduleId,
            query: 'unseen',
            resourceType: floorRef.resourceType,
            tenantId,
          },
          scope,
        );
      yield* restarted.apply({ document: staleDocument, kind: 'upsert' }, context);
      yield* restarted.replace(
        {
          ...emptyRebuild,
          documents: [staleDocument],
          rebuildVersion: '1',
        },
        context,
      );
      expect(yield* floorSearch()).toEqual([]);
      yield* restarted.replace(emptyRebuild, context);
      const divergence = yield* Effect.flip(
        restarted.replace({ ...emptyRebuild, documents: [staleDocument] }, context),
      );
      expect(Predicate.isTagged(divergence, 'CoreSearchProjectionInvalid')).toBe(true);
      yield* restarted.apply(
        {
          document: { ...staleDocument, projectionVersion: '3' },
          kind: 'upsert',
        },
        context,
      );
      yield* restarted.replace(emptyRebuild, context);
      const rebuiltFloorHits = yield* floorSearch();
      expect(rebuiltFloorHits.length).toBe(1);
      const rebuildRows = yield* queryEffect(
        runtime,
        `select rebuild_version from core.search_projection_rebuilds where tenant_id = $1`,
        [tenantId],
      );
      expect(rebuildRows.length).toBe(0);
      const counterpartySearch = (selectedLegalEntityId: string, searchScope: OperationalScope) =>
        search.search(
          {
            includeArchived: false,
            moduleId: 'party.registry',
            query: 'acme',
            resourceType: 'party.registry.counterparty',
            selectedLegalEntityId,
            tenantId,
          },
          searchScope,
        );
      const legalEntityScope = yield* partyRequestScope(issuer, principalId, tenantId, legalEntityId);
      const counterpartyHits = yield* counterpartySearch(legalEntityId, legalEntityScope);
      expect(counterpartyHits.map(({ ref }) => ref.resourceId)).toEqual([counterpartyId]);
      // Tenant-wide grants may narrow to either entity. Entity grants cannot widen to another.
      expect((yield* counterpartySearch(legalEntityId, scope)).map(({ ref }) => ref.resourceId)).toEqual([
        counterpartyId,
      ]);
      expect((yield* counterpartySearch(otherLegalEntityId, scope)).map(({ ref }) => ref.resourceId)).toEqual([
        otherCounterpartyId,
      ]);
      const failure = yield* Effect.flip(counterpartySearch(otherLegalEntityId, legalEntityScope));
      expect(Predicate.isTagged(failure, 'CoreSearchProjectionUnavailable')).toBe(true);
      const selectedScopePartyHits = yield* search.search(
        {
          includeArchived: false,
          moduleId: 'party.registry',
          query: 'private@example.test',
          resourceType: 'party.registry.party',
          tenantId,
        },
        legalEntityScope,
      );
      expect(selectedScopePartyHits).toEqual(partyHits);
      expect(
        yield* search.search(
          {
            includeArchived: false,
            moduleId: 'party.registry',
            query: 'acme',
            resourceType: 'party.registry.counterparty',
            tenantId,
          },
          scope,
        ),
      ).toEqual([]);

      const runtimeRows = yield* queryEffect(
        runtime,
        `select source_resource_id from core.search_index_entries where tenant_id = $1`,
        [tenantId],
      );
      expect(runtimeRows.length).toBe(0);
      const stored = yield* queryEffect<{
        deleted: boolean;
        projection_version: string;
      }>(
        admin,
        `select deleted, projection_version::text from core.search_index_entries where tenant_id = $1 and source_resource_id = $2`,
        [tenantId, removedPartyId],
      );
      expect(stored).toEqual([{ deleted: true, projection_version: '2' }]);
    }),
  );
});
