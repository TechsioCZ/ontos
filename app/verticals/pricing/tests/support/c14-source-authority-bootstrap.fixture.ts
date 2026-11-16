import { makeOperationalScopeRepository, makePrincipalResolver, parseDatabaseConfig } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { stageScopeOf } from '@app/core-runtime/install/stage-context-bootstrap';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { requireOwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import type { OwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { Effect, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import {
  ExternalPriceSourceAuthorityGrantSchema,
  storeInternalC14PricingSourceGrant,
} from './c14-source-authority.fixture.ts';
import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';

const FIXTURE_DATABASE_IDENTITY_ENROLLMENT = defineDatabaseIdentityEnrollment([]);

export class InternalC14PricingSourceBootstrapUnavailable extends Schema.TaggedError<InternalC14PricingSourceBootstrapUnavailable>()(
  'InternalC14PricingSourceBootstrapUnavailable',
  {
    cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())),
    reason: Schema.String,
    stage: Schema.Literals(['bootstrap', 'owned-database', 'owned-database-purpose']),
  },
) {}
const unavailableAt = (stage: InternalC14PricingSourceBootstrapUnavailable['stage']) => (cause?: unknown) =>
  new InternalC14PricingSourceBootstrapUnavailable({
    cause: Redacted.make(cause),
    reason: 'The owned C14 Pricing source authority bootstrap could not be verified',
    stage,
  });
const unavailable = unavailableAt('bootstrap');
const fixturePurpose = 'implementation-1096-registered-workload-gateway';

export interface InternalC14PricingSourceBootstrapRequest {
  readonly grant: typeof ExternalPriceSourceAuthorityGrantSchema.Type;
  readonly legalEntityId: string;
  readonly operatorPrincipalId: string;
  readonly operatorProviderUserId: string;
  readonly ownedDatabase: OwnedNativeDatabaseFixture;
  readonly purpose: typeof fixturePurpose;
  readonly runtimeConnectionString: Redacted.Redacted;
  readonly tenantId: string;
}
interface ConnectionFacts extends Record<string, unknown> {
  readonly bypassRls: boolean;
  readonly database: string;
  readonly role: string;
  readonly sessionRole: string;
  readonly superuser: boolean;
}

/**
 * INTERNAL operator bootstrap, confined to a local owned clone and its genuine human/tenant/SLE.
 * This configures an explicit native owner fact; it creates no gateway provenance or Action grant.
 */
export const bootstrapInternalC14PricingSourceAuthority = Effect.fn('InternalC14PricingSourceAuthority.bootstrap')(
  function* bootstrapInternalC14PricingSourceAuthority(input: InternalC14PricingSourceBootstrapRequest) {
    const purpose = yield* Schema.decodeUnknownEffect(Schema.Literal(fixturePurpose))(input.purpose).pipe(
      Effect.mapError(unavailableAt('owned-database-purpose')),
    );
    const { connections } = input.ownedDatabase;
    const requireOwnership = requireOwnedNativeDatabaseFixture(input.ownedDatabase, {
      adminConnectionString: Redacted.make(connections.admin.connectionString),
      purpose,
      runtimeConnectionString: input.runtimeConnectionString,
    }).pipe(Effect.mapError(unavailableAt('owned-database')));
    yield* requireOwnership;
    const configuration = yield* parseDatabaseConfig({
      DATABASE_URL: Redacted.value(input.runtimeConnectionString),
    }).pipe(Effect.mapError(unavailable));
    if (
      !['127.0.0.1', 'localhost', '::1'].includes(configuration.host) ||
      !/^ontos_test_party_gateway_[a-z0-9_]+$/u.test(configuration.database)
    ) {
      return yield* unavailable();
    }
    const grant = yield* Schema.decodeUnknownEffect(ExternalPriceSourceAuthorityGrantSchema, {
      onExcessProperty: 'error',
    })(input.grant).pipe(Effect.mapError(unavailable));
    const scope = yield* stageScopeOf({
      legalEntityId: input.legalEntityId,
      principalId: input.operatorPrincipalId,
      tenantId: input.tenantId,
    }).pipe(Effect.mapError(unavailable));
    const reactivity = yield* Reactivity.make;
    const client = yield* PgClient.make({ url: input.runtimeConnectionString }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
      Effect.mapError(unavailable),
    );
    const database = yield* testCoreDatabase.pipe(
      Effect.provideService(PgClient.PgClient, client),
      Effect.mapError(unavailable),
    );
    return yield* database
      .transaction(
        Effect.fn('InternalC14PricingSourceAuthority.store')(function* store(transaction) {
          const [connection] = yield* transaction
            .execute<ConnectionFacts>(
              sql`select current_database()::text as database, current_user::text as role, session_user::text as "sessionRole", rolsuper as superuser, rolbypassrls as "bypassRls" from pg_roles where rolname=current_user`,
              'objects',
            )
            .pipe(Effect.mapError(unavailable));
          if (
            connection === undefined ||
            connection.database !== configuration.database ||
            connection.role !== connections.runtime.user ||
            connection.sessionRole !== connections.runtime.user ||
            connection.superuser ||
            connection.bypassRls
          ) {
            return yield* unavailable();
          }
          const scoped = yield* installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
            Effect.mapError(unavailable),
          );
          const resolver = makePrincipalResolver(
            { executor: database },
            { authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID },
          );
          const identity = yield* resolver
            .resolveBetterAuthUserForTenant(input.operatorProviderUserId, input.tenantId)
            .pipe(Effect.mapError(unavailable));
          if (
            identity.principalId !== input.operatorPrincipalId ||
            identity.principalKind !== 'human' ||
            identity.tenantId !== input.tenantId
          ) {
            return yield* unavailable();
          }
          const persisted = yield* makeOperationalScopeRepository(
            { executor: transaction },
            FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
          )
            .load(scope)
            .pipe(Effect.mapError(unavailable));
          if (
            persisted.tenantStatus !== 'active' ||
            persisted.principalStatus !== 'active' ||
            persisted.principalTenantId !== input.tenantId ||
            persisted.legalEntityStatus !== 'active' ||
            persisted.legalEntityTenantId !== input.tenantId
          ) {
            return yield* unavailable();
          }
          yield* requireOwnership;
          return yield* storeInternalC14PricingSourceGrant(scoped, scope, grant).pipe(Effect.mapError(unavailable));
        }),
      )
      .pipe(Effect.mapError(unavailable));
  },
  Effect.scoped,
);
