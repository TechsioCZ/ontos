import { NodeCrypto } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { inArray, sql } from 'drizzle-orm';
import { Clock, Crypto, Effect, Predicate, Redacted, Schema } from 'effect';
import { Base64Url } from 'effect/encoding';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { loadDatabaseConnectionPair, loadDatabaseIdentityConnections } from '../../src/db/config.ts';

import { coreRelations, searchIndexEntries } from '../../src/db/schema.ts';
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import { makePostgresCoreSearchProjectionStore } from '../../src/search/persistence.ts';
import { CoreSearchProjectionStore, createCoreSearchQueryRuntime } from '../../src/search/projection.ts';
import {
  RegisteredGatewayRouteScopeSchema,
  preserveSystemPrincipalContextTrust,
  trustVerifiedGatewayPrincipalContext,
} from '../../src/auth/system-principal-context-provenance.ts';
import { LegalEntityIdSchema } from '../../src/access/ids.ts';
import { makeGatewayScopeGrantRegistrar } from '../../src/auth/gateway-scope-grant.ts';
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
    shared: yield* makeTestPgClient(testDatabaseIdentityConnection(identities, 'shared_runtime').connectionString),
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
    principalKind: 'human' | 'system' = 'human',
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
      `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $2, $3, 'Gateway principal', 'active')`,
      [principalId, tenantId, principalKind],
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

const nativeRouteFixture = Effect.fn('GatewayScopeInstallationTest.nativeRouteFixture')(function* fixture(
  admin: PgClient.PgClient,
) {
  const crypto = yield* Crypto.Crypto;
  const tenantId = yield* crypto.randomUUIDv4();
  const otherTenantId = yield* crypto.randomUUIDv4();
  const principalId = yield* crypto.randomUUIDv4();
  const originalPrincipalId = yield* crypto.randomUUIDv4();
  const selectedCompanyId = yield* crypto.randomUUIDv4();
  const enrollmentCompanyId = yield* crypto.randomUUIDv4();
  const foreignCompanyId = yield* crypto.randomUUIDv4();
  yield* insertGrantFixture(admin, tenantId, otherTenantId, principalId, 'system');
  yield* Effect.addFinalizer(() =>
    admin.unsafe('delete from core.legal_entities where tenant_id = any($1::uuid[])', [[tenantId, otherTenantId]])
      .pipe(Effect.orDie),
  );
  // LIFO cleanup: grants precede companies; the original fixture removes principals and tenants last.
  yield* addTestGatewayScopeGrantCleanup(admin, [tenantId, otherTenantId]);
  yield* admin.unsafe(
    `insert into core.principals (principal_id, tenant_id, kind, display_name, status)
     values ($1, $2, 'integration', 'Original integration', 'active')`,
    [originalPrincipalId, tenantId],
  );
  for (const company of [
    { id: selectedCompanyId, tenant: tenantId },
    { id: enrollmentCompanyId, tenant: tenantId },
    { id: foreignCompanyId, tenant: otherTenantId },
  ]) {
    yield* admin.unsafe(
      `insert into core.legal_entities
       (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status)
       values ($1, $2, 'Gateway scope company', 'CZ', $3, 'active')`,
      [company.id, company.tenant, `gateway-${company.id}`],
    );
  }
  const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authContextRef: `job:integration.symmy.route-read:run:${yield* crypto.randomUUIDv4()}`,
    authMethod: 'system',
    principalId,
    tenantId,
  });
  const routeScope = yield* Schema.decodeUnknownEffect(RegisteredGatewayRouteScopeSchema)({
    legalEntityId: selectedCompanyId,
    nativeReadReceiver: {
      bindingIncarnation: yield* crypto.randomUUIDv4(),
      enrollmentLegalEntityId: enrollmentCompanyId,
      originalPrincipalId,
      originalWorkloadBindingIncarnation: yield* crypto.randomUUIDv4(),
      originalWorkloadKey: 'integration.symmy-admit',
      workloadKey: 'party.registry.source-read',
    },
    operations: [{ entrypointKey: 'party.registry.api.source-profile-export', schemaVersion: '1' }],
    principalId,
    routeId: yield* crypto.randomUUIDv4(),
    routeKey: 'adminCustomers',
    routeRevision: 'v1',
    sourceRouteId: yield* crypto.randomUUIDv4(),
    sourceRouteRevision: 'v1',
    tenantId,
  });
  return { principal, routeScope, tenantId, otherTenantId, principalId, originalPrincipalId, selectedCompanyId, enrollmentCompanyId, foreignCompanyId };
});

const nativeRouteGrant = Effect.fn('GatewayScopeInstallationTest.nativeRouteGrant')(function* grant(
  fixture: Effect.Success<ReturnType<typeof nativeRouteFixture>>,
) {
  const jti = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
  const expiresAtEpochSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000) + 300;
  return {
    claims: {
      aud: audience,
      exp: expiresAtEpochSeconds,
      jti,
      principal: fixture.principal,
      routeScope: fixture.routeScope,
      sub: fixture.principalId,
      ver: 9,
    },
    registration: {
      audience,
      expiresAtEpochSeconds,
      jti,
      legalEntityId: fixture.selectedCompanyId,
      principalId: fixture.principalId,
      tenantId: fixture.tenantId,
    },
  };
});

/** The issuer DB role is already trusted. This exercises payload/argument matching, not JWT signature verification. */
const syntheticNativeAssertion = Effect.fn('GatewayScopeInstallationTest.syntheticNativeAssertion')(
  function* encode(claims: unknown) {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(claims);
    return Redacted.make(`${Base64Url.encode('{"alg":"none","typ":"ontos-test-gateway"}')}.${Base64Url.encode(encoded)}.${Base64Url.encode('synthetic-test-signature')}`);
  },
);

it.layer(NodeCrypto.layer, { excludeTestServices: true })('gateway scope installation', (suite) => {
  suite.effect('installs V9 selected company, not its distinct enrollment company, through the real issuer and request roles', () =>
    Effect.gen(function* nativeV9CompanyScope() {
      const { admin, issuer, party } = yield* gatewayScopeClients;
      const fixture = yield* nativeRouteFixture(admin);
      const grant = yield* nativeRouteGrant(fixture);
      const assertion = yield* syntheticNativeAssertion(grant.claims);
      yield* makeGatewayScopeGrantRegistrar(issuer, FIXTURE_DATABASE_IDENTITY_ENROLLMENT)
        .register({ ...grant.registration, assertion });
      const principal = trustVerifiedGatewayPrincipalContext(
        fixture.principal, compositionRevision, { assertion, audience }, undefined, undefined, fixture.routeScope,
      );
      const scope: OperationalScope = preserveSystemPrincipalContextTrust(principal, {
        ...principal,
        correlationId: 'native-v9-company-scope',
        legalEntityId: LegalEntityIdSchema.make(fixture.selectedCompanyId),
      });
      const database = yield* makeTestDatabaseFromClient(party, coreRelations);
      const installed = yield* database.transaction((transaction) =>
        Effect.gen(function* installNativeCompanyScope() {
          const executor = yield* installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
          const [row] = yield* transaction.execute<{ tenant_id: string; legal_entity_id: string }>(
            sql`select trust.current_tenant_id()::text as tenant_id, trust.current_legal_entity_id()::text as legal_entity_id`,
            'objects',
          );
          return { scope: executor.scope, tenantId: row?.tenant_id, companyId: row?.legal_entity_id };
        }),
      );
      expect(fixture.selectedCompanyId).not.toBe(fixture.enrollmentCompanyId);
      expect(installed).toEqual({
        scope: { tenantId: fixture.tenantId, legalEntityId: fixture.selectedCompanyId },
        tenantId: fixture.tenantId,
        companyId: fixture.selectedCompanyId,
      });
      const delegatedGrant = yield* nativeRouteGrant(fixture);
      const actor = {
        appId: 'symmy-integration',
        buildMarker: 'symmy-build',
        principalId: yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()),
      };
      const delegatedAssertion = yield* syntheticNativeAssertion({ ...delegatedGrant.claims, act: actor, ver: 10 });
      yield* makeGatewayScopeGrantRegistrar(issuer, FIXTURE_DATABASE_IDENTITY_ENROLLMENT)
        .register({ ...delegatedGrant.registration, assertion: delegatedAssertion });
      // The DB matches the issuer's selected scope; actor signature/identity validation belongs to the verifier.
      const [delegatedRow] = yield* party.withTransaction(Effect.gen(function* installDelegatedNativeScope() {
        return yield* party.unsafe<{ established_legal_entity_id: string }>(
          'select established_legal_entity_id::text from trust.establish_gateway_scope($1)',
          [Redacted.value(delegatedAssertion)],
        );
      }));
      expect(delegatedRow?.established_legal_entity_id).toBe(fixture.selectedCompanyId);
    }),
  );

  suite.effect('refuses V9 grant argument mismatches and malformed derived-company claims without creating grants', () =>
    Effect.gen(function* rejectInvalidNativeV9Grants() {
      const { admin, issuer } = yield* gatewayScopeClients;
      const fixture = yield* nativeRouteFixture(admin);
      const registrar = makeGatewayScopeGrantRegistrar(issuer, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
      const base = yield* nativeRouteGrant(fixture);
      const invalid = [
        { claims: base.claims, registration: { ...base.registration, legalEntityId: fixture.enrollmentCompanyId } },
        { claims: base.claims, registration: { ...base.registration, tenantId: fixture.otherTenantId } },
        { claims: base.claims, registration: { ...base.registration, principalId: fixture.originalPrincipalId } },
        { claims: { ...base.claims, routeScope: { ...fixture.routeScope, principalId: fixture.originalPrincipalId } }, registration: base.registration },
        { claims: { ...base.claims, routeScope: { ...fixture.routeScope, tenantId: fixture.otherTenantId } }, registration: base.registration },
        { claims: { ...base.claims, routeScope: { ...fixture.routeScope, legalEntityId: fixture.foreignCompanyId } }, registration: { ...base.registration, legalEntityId: fixture.foreignCompanyId } },
        { claims: { ...base.claims, routeScope: { ...fixture.routeScope, nativeReadReceiver: null } }, registration: base.registration },
        { claims: { ...base.claims, routeScope: { ...fixture.routeScope, legalEntityId: undefined } }, registration: base.registration },
        { claims: { ...base.claims, routeScope: { ...fixture.routeScope, legalEntityId: 'not-a-uuid' } }, registration: base.registration },
        // Other versions must not acquire V9's derived company; this is not a JWT-version whitelist test.
        ...[8, 11, 'nine'].map((ver) => ({ claims: { ...base.claims, ver }, registration: base.registration })),
      ];
      for (const attempt of invalid) {
        const assertion = yield* syntheticNativeAssertion(attempt.claims);
        const failure = yield* registrar.register({ ...attempt.registration, assertion }).pipe(Effect.flip);
        expect(Predicate.isTagged(failure, 'GatewayScopeGrantUnavailableError')).toBe(true);
      }
      const [remaining] = yield* admin.unsafe<{ count: number }>(
        'select count(*)::int as count from trust.gateway_scope_grants where tenant_id = any($1::uuid[])',
        [[fixture.tenantId, fixture.otherTenantId]],
      );
      expect(remaining?.count).toBe(0);
    }),
  );

  suite.effect('installs only the tenant scope that a registered grant names', () =>
    Effect.gen(function* gatewayScopeInstallation() {
      const { admin, issuer, party } = yield* gatewayScopeClients;
      const crypto = yield* Crypto.Crypto;
      const tenantId = yield* crypto.randomUUIDv4();
      const otherTenantId = yield* crypto.randomUUIDv4();
      const principalId = yield* crypto.randomUUIDv4();
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

  suite.effect('installs an authentic dedicated-audience bearer under the actual shared runtime authority', () =>
    Effect.gen(function* sharedRoleUsesItsOwnAuthority() {
      const { admin, issuer, party, shared } = yield* gatewayScopeClients;
      const crypto = yield* Crypto.Crypto;
      const tenantId = yield* crypto.randomUUIDv4();
      const otherTenantId = yield* crypto.randomUUIDv4();
      const principalId = yield* crypto.randomUUIDv4();
      yield* insertGrantFixture(admin, tenantId, otherTenantId, principalId);
      const scope = yield* grantScope(issuer, principalId, tenantId);
      const database = yield* makeTestDatabaseFromClient(shared, coreRelations);
      const installed = yield* database.transaction((transaction) =>
        Effect.gen(function* installSharedScope() {
          const executor = yield* installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
          const [row] = yield* transaction.execute<{ role: string; tenant_id: string }>(
            sql`select current_user::text as role, current_setting('ontos.tenant_id',true) as tenant_id`,
            'objects',
          );
          return { role: row?.role, scope: executor.scope, tenantId: row?.tenant_id };
        }),
      );
      expect(installed).toEqual({ role: 'ontos_runtime', scope: { tenantId }, tenantId });
      // The shared installation never consumes the dedicated role's grant or changes its audience.
      const partyDatabase = yield* makeTestDatabaseFromClient(party, coreRelations);
      expect(
        yield* partyDatabase.transaction((transaction) => installAndReadTrustedTenant(transaction, scope)),
      ).toEqual({ executorScope: { tenantId }, trustedTenantId: tenantId });
    }),
  );

  suite.effect('a Core Search query under a registered grant returns only that tenant party rows', () =>
    Effect.gen(function* gatewayScopedSearch() {
      const { admin, issuer, party, worker } = yield* gatewayScopeClients;
      yield* installSearchTestAuthority();
      const crypto = yield* Crypto.Crypto;
      const tenantId = yield* crypto.randomUUIDv4();
      const otherTenantId = yield* crypto.randomUUIDv4();
      const partyId = yield* crypto.randomUUIDv4();
      const otherPartyId = yield* crypto.randomUUIDv4();
      const principalId = yield* crypto.randomUUIDv4();
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
