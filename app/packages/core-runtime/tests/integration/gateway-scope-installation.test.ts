import { NodeCrypto } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { inArray, sql } from 'drizzle-orm';
import { Crypto, Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { loadDatabaseConnectionPair, loadDatabaseIdentityConnections } from '../../src/db/config.ts';

import { coreRelations, searchIndexEntries } from '../../src/db/schema.ts';
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import { makePostgresCoreSearchProjectionStore } from '../../src/search/persistence.ts';
import { CoreSearchProjectionStore, createCoreSearchQueryRuntime } from '../../src/search/projection.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import {
  addTestGatewayScopeGrantCleanup,
  registerTestGatewayScopeGrant,
} from '../../src/testing/gateway-scope-grant.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { installSearchTestAuthority } from '../support/search-authority.ts';
import {
  FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
  FIXTURE_REQUEST_IDENTITY,
  testDatabaseIdentityConnection,
} from '../support/database-identities.ts';

const compositionRevision = 'a'.repeat(64);
const audience = 'party-registry';

const principalContext = (principalId: string, tenantId: string) =>
  Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000019',
    authContextRef: 'better-auth-session:gateway-scope-installation',
    authMethod: 'session',
    principalId,
    tenantId,
  });

const sessionScope = (principalId: string, tenantId: string): OperationalScope => ({
  ...principalContext(principalId, tenantId),
  correlationId: 'gateway-scope-installation',
});

const grantScope = Effect.fn('GatewayScopeInstallationTest.grantScope')(function* grantScopeEffect(
  issuer: PgClient.PgClient,
  principalId: string,
  grantTenantId: string,
  scopeTenantId: string = grantTenantId,
) {
  const grant = yield* registerTestGatewayScopeGrant(
    issuer,
    { audience, principalId, tenantId: grantTenantId },
    FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
  );
  // Provenance is attached to the exact scope object, so the gateway marking comes last.
  const scope: OperationalScope = trustVerifiedGatewayPrincipalContext(
    sessionScope(principalId, scopeTenantId),
    compositionRevision,
    {
      assertion: grant.assertion,
      audience,
    },
  );
  return scope;
});

const partyDocument = (tenantId: string, resourceId: string, title: string) => ({
  archived: false,
  facets: [],
  metadata: [],
  projectionVersion: '1',
  ref: {
    moduleId: 'party.registry',
    resourceId,
    resourceType: 'party.registry.party',
    tenantId,
  },
  searchableText: [title],
  title,
});

const workerContext = (tenantId: string) =>
  attestOutboxWorkerHandlerContext({
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

/** Party request login (the gateway-grant identity), Shell issuer login, Party worker and admin clients. */
const gatewayScopeClients = Effect.gen(function* acquireGatewayScopeClients() {
  const party = yield* loadDatabaseConnectionPair({ identity: FIXTURE_REQUEST_IDENTITY });
  const identities = yield* loadDatabaseIdentityConnections({ enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT });
  return {
    admin: yield* makeTestPgClient(party.admin.connectionString),
    issuer: yield* makeTestPgClient(
      testDatabaseIdentityConnection(identities, 'shell_gateway_issuer').connectionString,
    ),
    party: yield* makeTestPgClient(party.runtime.connectionString),
    worker: yield* makeTestPgClient(
      testDatabaseIdentityConnection(identities, 'party_registry_worker').connectionString,
    ),
  };
});

/**
 * Inserts two active tenants and one active principal of the first, the rows grant registration
 * requires, and removes them (and their grants) when the test scope closes.
 */
const insertGrantFixture = Effect.fn('GatewayScopeInstallationTest.insertGrantFixture')(
  function* insertGrantFixtureEffect(
    admin: PgClient.PgClient,
    tenantId: string,
    otherTenantId: string,
    principalId: string,
  ) {
    const tenants = [tenantId, otherTenantId];
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* cleanGrantFixture() {
        yield* admin.unsafe('delete from core.search_index_entries where tenant_id = any($1::uuid[])', [tenants]);
        yield* admin.unsafe('delete from core.search_projection_rebuilds where tenant_id = any($1::uuid[])', [tenants]);
        yield* admin.unsafe('delete from core.principals where tenant_id = any($1::uuid[])', [tenants]);
        yield* admin.unsafe('delete from core.tenants where tenant_id = any($1::uuid[])', [tenants]);
      }).pipe(Effect.orDie),
    );
    // Finalizers run in reverse order, so grants are removed before their tenants.
    yield* addTestGatewayScopeGrantCleanup(admin, tenants);
    yield* admin.unsafe(
      `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Gateway tenant', 'active', 'en'), ($3, $4, 'Other gateway tenant', 'active', 'en')`,
      [tenantId, `gateway-${tenantId}`, otherTenantId, `gateway-${otherTenantId}`],
    );
    yield* admin.unsafe(
      `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $2, 'human', 'Gateway principal', 'active')`,
      [principalId, tenantId],
    );
  },
);

/** Installs `scope` in `transaction` and reads the tenant that the trusted database accessor reports. */
const installAndReadTrustedTenant = Effect.fn('GatewayScopeInstallationTest.installAndReadTrustedTenant')(
  function* installAndReadTrustedTenantEffect(
    transaction: Parameters<typeof installOperationalScope>[0],
    scope: OperationalScope,
  ) {
    const executor = yield* installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
    const rows = yield* transaction.execute<{ tenant_id: string | null }>(
      sql`select trust.current_tenant_id()::text as tenant_id`,
      'objects',
    );
    return { executorScope: executor.scope, trustedTenantId: rows[0]?.tenant_id ?? null };
  },
);

it.layer(NodeCrypto.layer, { excludeTestServices: true })('gateway scope installation', (suite) => {
  suite.effect('installs only the tenant scope that a registered grant names', () =>
    Effect.gen(function* gatewayScopeInstallation() {
      const { admin, issuer, party } = yield* gatewayScopeClients;
      const crypto = yield* Crypto.Crypto;
      const tenantId = yield* crypto.randomUUIDv4;
      const otherTenantId = yield* crypto.randomUUIDv4;
      const principalId = yield* crypto.randomUUIDv4;
      yield* insertGrantFixture(admin, tenantId, otherTenantId, principalId);
      const database = yield* makeTestDatabaseFromClient(party, coreRelations);
      const readTrustedTenant = (scope: OperationalScope) =>
        database.transaction((transaction) => installAndReadTrustedTenant(transaction, scope));

      const installed = yield* readTrustedTenant(yield* grantScope(issuer, principalId, tenantId));
      expect(installed).toEqual({ executorScope: { tenantId }, trustedTenantId: tenantId });

      const mismatch = yield* Effect.flip(
        readTrustedTenant(yield* grantScope(issuer, principalId, tenantId, otherTenantId)),
      );
      expect(Predicate.isTagged(mismatch, 'OperationContextUnavailable')).toBe(true);

      // The Party login is a gateway-grant identity: a scope without a redeemed assertion is refused.
      const untrusted = yield* Effect.flip(readTrustedTenant(sessionScope(principalId, tenantId)));
      expect(Predicate.isTagged(untrusted, 'OperationContextUnavailable')).toBe(true);
    }),
  );

  suite.effect('a Core Search query under a registered grant returns only that tenant party rows', () =>
    Effect.gen(function* gatewayScopedSearch() {
      const { admin, issuer, party, worker } = yield* gatewayScopeClients;
      yield* installSearchTestAuthority();
      const crypto = yield* Crypto.Crypto;
      const tenantId = yield* crypto.randomUUIDv4;
      const otherTenantId = yield* crypto.randomUUIDv4;
      const partyId = yield* crypto.randomUUIDv4;
      const otherPartyId = yield* crypto.randomUUIDv4;
      const principalId = yield* crypto.randomUUIDv4;
      const tenants = [tenantId, otherTenantId];
      yield* insertGrantFixture(admin, tenantId, otherTenantId, principalId);
      const workerStore = makePostgresCoreSearchProjectionStore(
        {
          executor: yield* makeTestDatabaseFromClient(worker, coreRelations),
        },
        FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      );
      yield* workerStore.apply(
        { document: partyDocument(tenantId, partyId, 'Acme gateway'), kind: 'upsert' },
        workerContext(tenantId),
      );
      yield* workerStore.apply(
        { document: partyDocument(otherTenantId, otherPartyId, 'Acme other'), kind: 'upsert' },
        workerContext(otherTenantId),
      );

      const partyDatabase = yield* makeTestDatabaseFromClient(party, coreRelations);
      const search = yield* createCoreSearchQueryRuntime.pipe(
        Effect.provideService(
          CoreSearchProjectionStore,
          makePostgresCoreSearchProjectionStore({ executor: partyDatabase }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
        ),
      );
      const scope = yield* grantScope(issuer, principalId, tenantId);
      const query = (queryTenantId: string) =>
        search.search(
          {
            includeArchived: false,
            moduleId: 'party.registry',
            query: 'acme',
            resourceType: 'party.registry.party',
            tenantId: queryTenantId,
          },
          scope,
        );
      const hits = yield* query(tenantId);
      expect(hits.map(({ ref }) => ref.resourceId)).toEqual([partyId]);
      const crossTenant = yield* Effect.flip(query(otherTenantId));
      expect(Predicate.isTagged(crossTenant, 'CoreSearchProjectionUnavailable')).toBe(true);

      // Row security, not the query filter, hides the other tenant: an unfiltered read sees one tenant.
      const visibleTenants = yield* partyDatabase.transaction((transaction) =>
        Effect.gen(function* readVisibleTenants() {
          const executor = yield* installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
          return yield* executor
            .select({ tenantId: searchIndexEntries.tenantId })
            .from(searchIndexEntries)
            .where(inArray(searchIndexEntries.tenantId, tenants));
        }),
      );
      expect(visibleTenants).toEqual([{ tenantId }]);
    }),
  );
});
