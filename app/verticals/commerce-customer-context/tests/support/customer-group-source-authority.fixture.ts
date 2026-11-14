import { makeOperationalScopeRepository, makePrincipalResolver, parseDatabaseConfig } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { TenantIdSchema, LegalEntityIdSchema, PrincipalIdSchema } from '@app/core-runtime/access/ids';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { stageScopeOf } from '@app/core-runtime/install/stage-context-bootstrap';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { requireOwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import type { OwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { PgClient } from '@effect/sql-pg';
import { and, eq, sql } from 'drizzle-orm';
import { Effect, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';

import { CustomerGroupDefinitionSourceSchema } from '../../shared/domain/group-contract.ts';
import { customerGroupDefinitionSourceRoutes } from '../../src/database/schema.ts';
import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';

const FIXTURE_DATABASE_IDENTITY_ENROLLMENT = defineDatabaseIdentityEnrollment([]);

export const CustomerGroupSourceAuthorityFixtureRouteSchema = Schema.Struct({
  active: Schema.Boolean,
  issuer: CustomerGroupDefinitionSourceSchema.fields.issuer,
  legalEntityId: Schema.toEncoded(LegalEntityIdSchema),
  mappingRevision: CustomerGroupDefinitionSourceSchema.fields.mappingRevision,
  namespace: CustomerGroupDefinitionSourceSchema.fields.namespace,
  principalId: Schema.toEncoded(PrincipalIdSchema),
  routeId: CustomerGroupDefinitionSourceSchema.fields.route.fields.id,
  routeRevision: CustomerGroupDefinitionSourceSchema.fields.route.fields.revision,
  tenantId: Schema.toEncoded(TenantIdSchema),
});
export type CustomerGroupSourceAuthorityFixtureRoute = typeof CustomerGroupSourceAuthorityFixtureRouteSchema.Type;
export interface CustomerGroupSourceAuthorityFixtureInput {
  readonly adminConnectionString: Redacted.Redacted;
  readonly fixture: OwnedNativeDatabaseFixture;
  readonly operatorPrincipalId: string;
  readonly operatorProviderUserId: string;
  readonly route: CustomerGroupSourceAuthorityFixtureRoute;
}
export class CustomerGroupSourceAuthorityFixtureUnavailable extends Schema.TaggedError<CustomerGroupSourceAuthorityFixtureUnavailable>()(
  'CustomerGroupSourceAuthorityFixtureUnavailable',
  {
    cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())),
    reason: Schema.String,
  },
) {}
const unavailable = (cause?: unknown) =>
  new CustomerGroupSourceAuthorityFixtureUnavailable({
    cause: Redacted.make(cause),
    reason: 'The owned Group source route fixture authority could not be verified',
  });
interface ConnectionFacts extends Record<string, unknown> {
  readonly database: string;
  readonly roleName: string;
}
type FixtureDatabase = Effect.Success<typeof testCoreDatabase>;
type FixtureTransaction = Parameters<Parameters<FixtureDatabase['transaction']>[0]>[0];

const inspectRuntimeScope = Effect.fn('CustomerGroupSourceAuthorityFixture.inspectRuntimeScope')(
  function* inspectRuntimeScope(
    inspection: FixtureTransaction,
    input: {
      readonly operatorPrincipalId: string;
      readonly operatorProviderUserId: string;
      readonly operatorScope: OperationalScope;
      readonly targetScope: OperationalScope;
      readonly tenantId: string;
    },
  ) {
    yield* installOperationalScope(inspection, input.operatorScope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
    const identity = yield* makePrincipalResolver(
      { executor: inspection },
      { authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID },
    ).resolveBetterAuthUserForTenant(input.operatorProviderUserId, input.tenantId);
    if (
      identity.principalId !== input.operatorPrincipalId ||
      identity.principalKind !== 'human' ||
      identity.tenantId !== input.tenantId
    ) {
      return yield* unavailable();
    }
    const repository = makeOperationalScopeRepository({ executor: inspection }, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
    return yield* Effect.forEach(
      [input.operatorScope, input.targetScope],
      Effect.fn('CustomerGroupSourceAuthorityFixture.verifyScope')(function* verifyScope(inspectionScope) {
        const persisted = yield* repository.load(inspectionScope);
        if (
          persisted.tenantStatus !== 'active' ||
          persisted.principalStatus !== 'active' ||
          persisted.principalTenantId !== input.tenantId ||
          persisted.legalEntityStatus !== 'active' ||
          persisted.legalEntityTenantId !== input.tenantId
        ) {
          return yield* unavailable();
        }
        return yield* Effect.void;
      }),
      { concurrency: 1, discard: true },
    );
  },
);

/** Configures one explicit route in an active owned clone after verifying its actual human operator.
 * It creates no Group, definition, credentials, grants, or execution proof. */
export const seedCustomerGroupSourceAuthority = Effect.fn('CustomerGroupSourceAuthorityFixture.seed')(
  function* seedCustomerGroupSourceAuthority(input: CustomerGroupSourceAuthorityFixtureInput) {
    yield* requireOwnedNativeDatabaseFixture(input.fixture, {
      adminConnectionString: input.adminConnectionString,
      purpose: 'implementation-1096-registered-workload-gateway',
      runtimeConnectionString: Redacted.make(input.fixture.connections.runtime.connectionString),
    }).pipe(Effect.mapError(unavailable));
    const route = yield* Schema.decodeUnknownEffect(CustomerGroupSourceAuthorityFixtureRouteSchema, {
      onExcessProperty: 'error',
    })(input.route).pipe(Effect.mapError(unavailable));
    const [configuration, operatorScope, targetScope] = yield* Effect.all(
      [
        parseDatabaseConfig({ DATABASE_URL: Redacted.value(input.adminConnectionString) }),
        stageScopeOf({
          legalEntityId: route.legalEntityId,
          principalId: input.operatorPrincipalId,
          tenantId: route.tenantId,
        }),
        stageScopeOf({ legalEntityId: route.legalEntityId, principalId: route.principalId, tenantId: route.tenantId }),
      ],
      { concurrency: 3 },
    ).pipe(Effect.mapError(unavailable));
    // Installer inspection scopes supply RLS coordinates; no admitted scope escapes this fixture.
    const reactivity = yield* Reactivity.make;
    const client = yield* PgClient.make({ url: input.adminConnectionString }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
      Effect.mapError(unavailable),
    );
    const database = yield* testCoreDatabase.pipe(
      Effect.provideService(PgClient.PgClient, client),
      Effect.mapError(unavailable),
    );
    const runtimeClient = yield* PgClient.make({
      url: Redacted.make(input.fixture.connections.runtime.connectionString),
    }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity), Effect.mapError(unavailable));
    const runtimeDatabase = yield* testCoreDatabase.pipe(
      Effect.provideService(PgClient.PgClient, runtimeClient),
      Effect.mapError(unavailable),
    );
    return yield* database
      .transaction(
        Effect.fn('CustomerGroupSourceAuthorityFixture.store')(function* storeRoute(transaction) {
          const [connection] = yield* transaction.execute<ConnectionFacts>(
            sql`select current_database()::text as database, current_user::text as "roleName"`,
            'objects',
          );
          if (
            connection === undefined ||
            connection.database !== configuration.database ||
            connection.roleName !== configuration.user
          ) {
            return yield* unavailable();
          }
          yield* runtimeDatabase.transaction((inspection) =>
            inspectRuntimeScope(inspection, {
              operatorPrincipalId: input.operatorPrincipalId,
              operatorProviderUserId: input.operatorProviderUserId,
              operatorScope,
              targetScope,
              tenantId: route.tenantId,
            }),
          );
          yield* requireOwnedNativeDatabaseFixture(input.fixture, {
            adminConnectionString: input.adminConnectionString,
            purpose: 'implementation-1096-registered-workload-gateway',
          });
          yield* transaction.insert(customerGroupDefinitionSourceRoutes).values(route).onConflictDoNothing();
          const [stored] = yield* transaction
            .select({ routeId: customerGroupDefinitionSourceRoutes.routeId })
            .from(customerGroupDefinitionSourceRoutes)
            .where(
              and(
                eq(customerGroupDefinitionSourceRoutes.tenantId, route.tenantId),
                eq(customerGroupDefinitionSourceRoutes.legalEntityId, route.legalEntityId),
                eq(customerGroupDefinitionSourceRoutes.routeId, route.routeId),
                eq(customerGroupDefinitionSourceRoutes.routeRevision, route.routeRevision),
                eq(customerGroupDefinitionSourceRoutes.mappingRevision, route.mappingRevision),
                eq(customerGroupDefinitionSourceRoutes.principalId, route.principalId),
                eq(customerGroupDefinitionSourceRoutes.issuer, route.issuer),
                eq(customerGroupDefinitionSourceRoutes.namespace, route.namespace),
                eq(customerGroupDefinitionSourceRoutes.active, route.active),
              ),
            );
          if (stored === undefined) {
            return yield* unavailable();
          }
          return yield* Effect.void;
        }),
      )
      .pipe(Effect.mapError(unavailable));
  },
  Effect.scoped,
);
