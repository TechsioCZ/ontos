import {
  PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
  PARTY_REGISTRY_REQUEST_IDENTITY,
  PARTY_REGISTRY_WORKER_IDENTITY,
} from '../../shared/database-identities.ts';
import {
  DatabaseConfigError,
  findPostgresFailure,
  loadDatabaseIdentityConnections,
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from '@app/core-runtime';
import { registerTestGatewayScopeGrant } from '@app/core-runtime/testing/gateway-scope-grant';
import { PgClient } from '@effect/sql-pg';
import type { SQL } from 'drizzle-orm';
import { Context, Crypto, Effect, Layer, Option, Redacted } from 'effect';

import { establishGatewayScopeStatement } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { acquireOutlivingCleanup } from '../../../../packages/core-runtime/tests/support/database.ts';

/** A native client whose pool outlives every cleanup finalizer registered after it in the same scope. */
const acquireBoundaryPgClient = (connectionString: string, maxConnections?: number) =>
  acquireOutlivingCleanup(Layer.build(PgClient.layer({ maxConnections, url: Redacted.make(connectionString) }))).pipe(
    Effect.map(Context.get(PgClient.PgClient)),
  );

/** The gateway audience whose grants the Party request role may establish. */
export const PARTY_REGISTRY_GATEWAY_AUDIENCE = 'party-registry';

/** Asserts that PostgreSQL itself raised the expected SQLSTATE, not that a driver shape matched. */
export const hasPostgreSqlCode =
  (expected: string) =>
  (error: Parameters<typeof findPostgresFailure>[0]): boolean =>
    Option.exists(findPostgresFailure(error), ({ code }) => code === expected);

/** Binds both roles to one schema; the test scope closes databases before their owned clients. */
export const openBoundaryDatabases = <Database, E, R>(
  openDatabase: (client: PgClient.PgClient) => Effect.Effect<Database, E, R>,
  clients: { readonly admin: PgClient.PgClient; readonly runtime: PgClient.PgClient },
) => Effect.all({ admin: openDatabase(clients.admin), runtime: openDatabase(clients.runtime) });

export interface PartyBoundaryClientOptions {
  /** Pool size of the Party request client; one connection makes session state observable. */
  readonly runtimeMaxConnections?: number;
}

/**
 * Opens the admin client, the Party request client (`party_registry_runtime`) and the Shell issuer
 * client that registers gateway scope grants. Every URL comes from the CI environment.
 */
export const openPartyBoundaryClients = Effect.fn('PartyBoundary.openClients')(function* openPartyBoundaryClients(
  options: PartyBoundaryClientOptions = {},
) {
  const connections = yield* loadDatabaseIdentityConnections({
    enrollment: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
  });
  const issuerConnection = connections.runtime[SHELL_GATEWAY_ISSUER_IDENTITY.id];
  const requestConnection = connections.runtime[PARTY_REGISTRY_REQUEST_IDENTITY.id];
  if (issuerConnection === undefined || requestConnection === undefined) {
    return yield* new DatabaseConfigError({ reason: 'Party boundary database connections are unavailable' });
  }
  return {
    admin: yield* acquireBoundaryPgClient(connections.admin.connectionString),
    issuer: yield* acquireBoundaryPgClient(issuerConnection.connectionString, 1),
    runtime: yield* acquireBoundaryPgClient(requestConnection.connectionString, options.runtimeMaxConnections),
  };
});

/** Connection strings of the shared runtime and Party worker identities, for identity-separation checks. */
export const loadSeparatedIdentityConnectionStrings = loadDatabaseIdentityConnections({
  enrollment: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
}).pipe(
  Effect.flatMap((connections) => {
    const sharedConnection = connections.runtime[SHARED_RUNTIME_IDENTITY.id];
    const workerConnection = connections.runtime[PARTY_REGISTRY_WORKER_IDENTITY.id];
    return sharedConnection === undefined || workerConnection === undefined
      ? Effect.fail(new DatabaseConfigError({ reason: 'Separated Party database connections are unavailable' }))
      : Effect.succeed({
          sharedRuntime: sharedConnection.connectionString,
          worker: workerConnection.connectionString,
        });
  }),
);

export interface PartyGatewayScope {
  readonly tenantId: string;
  readonly legalEntityId?: string;
}

/**
 * Seeds an active principal of the tenant (and the tenant and legal entity, when absent) as admin, then
 * registers a Party gateway grant for it through the issuer, exactly as Shell does before issuing a token.
 * The registrar refuses principals and legal entities that do not belong to the tenant. A finalizer
 * removes the principal and every Core row this call created.
 */
export const registerPartyGatewayScope = Effect.fn('PartyBoundary.registerGatewayScope')(
  function* registerPartyGatewayScope(
    clients: { readonly admin: PgClient.PgClient; readonly issuer: PgClient.PgClient },
    scope: PartyGatewayScope,
  ) {
    const { admin, issuer } = clients;
    const principalId = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
    const createdTenants = yield* admin<{ readonly tenant_id: string }>`
      insert into core.tenants (tenant_id, slug, name, status, default_locale)
      values (${scope.tenantId}::uuid, ${`party-boundary-${scope.tenantId}`}, 'Party boundary', 'active', 'en')
      on conflict do nothing returning tenant_id::text`;
    const createdLegalEntities =
      scope.legalEntityId === undefined
        ? []
        : yield* admin<{ readonly legal_entity_id: string }>`
            insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status)
            values (${scope.legalEntityId}::uuid, ${scope.tenantId}::uuid, 'Party boundary', 'CZ', ${scope.legalEntityId}, 'active')
            on conflict do nothing returning legal_entity_id::text`;
    yield* admin`
      insert into core.principals (principal_id, tenant_id, kind, display_name, status)
      values (${principalId}::uuid, ${scope.tenantId}::uuid, 'human', 'Party boundary', 'active')`;
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* removeSeededScope() {
        yield* admin`delete from trust.gateway_scope_grants where principal_id = ${principalId}::uuid`;
        yield* admin`delete from core.principals where principal_id = ${principalId}::uuid`;
        for (const { legal_entity_id } of createdLegalEntities) {
          yield* admin`delete from core.legal_entities where legal_entity_id = ${legal_entity_id}::uuid`;
        }
        for (const { tenant_id } of createdTenants) {
          yield* admin`delete from core.tenants where tenant_id = ${tenant_id}::uuid`;
        }
      }).pipe(Effect.orDie),
    );
    const { assertion } = yield* registerTestGatewayScopeGrant(
      issuer,
      {
        audience: PARTY_REGISTRY_GATEWAY_AUDIENCE,
        principalId,
        ...scope,
      },
      PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
    );
    return assertion;
  },
);

interface ScopeEstablishingTransaction<E, R> {
  readonly execute: (statement: SQL, mode: 'objects') => Effect.Effect<unknown, E, R>;
}

/** Establishes the trusted scope of `assertion` inside the current transaction before any table access. */
export const establishPartyGatewayScope = <E, R>(
  transaction: ScopeEstablishingTransaction<E, R>,
  assertion: Redacted.Redacted<string>,
) => transaction.execute(establishGatewayScopeStatement(assertion), 'objects').pipe(Effect.asVoid);
