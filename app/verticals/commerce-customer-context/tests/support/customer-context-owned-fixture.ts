import { makeOperationalScopeRepository, makePrincipalResolver, parseDatabaseConfig } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
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
import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';

const FIXTURE_DATABASE_IDENTITY_ENROLLMENT = defineDatabaseIdentityEnrollment([]);

export interface CustomerContextOwnedFixtureInput {
  readonly adminConnectionString: Redacted.Redacted;
  readonly legalEntityId: string;
  readonly operatorPrincipalId: string;
  readonly operatorProviderUserId: string;
  readonly ownedDatabase: OwnedNativeDatabaseFixture;
  readonly tenantId: string;
}
type FixtureDatabase = Effect.Success<typeof testCoreDatabase>;
type FixtureTransaction = Parameters<Parameters<FixtureDatabase['transaction']>[0]>[0];
export class CustomerContextOwnedFixtureUnavailable extends Schema.TaggedError<CustomerContextOwnedFixtureUnavailable>()(
  'CustomerContextOwnedFixtureUnavailable',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}
const unavailable = (cause?: unknown) =>
  new CustomerContextOwnedFixtureUnavailable({
    cause: Redacted.make(cause),
    reason: 'The active owned Customer Context fixture and actual human operator are required',
  });
interface ConnectionFacts extends Record<string, unknown> {
  readonly database: string;
  readonly roleName: string;
}
/** Inspection coordinates never escape as an admitted scope or a grant. */
export const withVerifiedCustomerContextFixture = <A, E, R>(
  input: CustomerContextOwnedFixtureInput,
  work: (transaction: FixtureTransaction, database: FixtureDatabase, scope: OperationalScope) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* verifiedCustomerContextFixture() {
      const ownership = requireOwnedNativeDatabaseFixture(input.ownedDatabase, {
        adminConnectionString: input.adminConnectionString,
        purpose: 'implementation-1096-registered-workload-gateway',
      });
      yield* ownership;
      const configuration = yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(input.adminConnectionString) });
      const scope = yield* stageScopeOf({
        legalEntityId: input.legalEntityId,
        principalId: input.operatorPrincipalId,
        tenantId: input.tenantId,
      });
      const reactivity = yield* Reactivity.make;
      const client = yield* PgClient.make({ url: input.adminConnectionString }).pipe(
        Effect.provideService(Reactivity.Reactivity, reactivity),
      );
      const database = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, client));
      return yield* database.transaction(
        Effect.fn('CustomerContextOwnedFixture.transaction')(function* transaction(owned) {
          yield* ownership;
          const [connection] = yield* owned.execute<ConnectionFacts>(
            sql`select current_database()::text as database,current_user::text as "roleName"`,
            'objects',
          );
          if (connection?.database !== configuration.database || connection.roleName !== configuration.user) {
            return yield* unavailable();
          }
          yield* installOperationalScope(owned, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
          const actor = yield* makePrincipalResolver(
            { executor: database },
            { authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID },
          ).resolveBetterAuthUserForTenant(input.operatorProviderUserId, input.tenantId);
          const persisted = yield* makeOperationalScopeRepository(
            { executor: owned },
            FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
          ).load(scope);
          if (
            actor.principalId !== input.operatorPrincipalId ||
            actor.principalKind !== 'human' ||
            actor.tenantId !== input.tenantId ||
            persisted.tenantStatus !== 'active' ||
            persisted.principalStatus !== 'active' ||
            persisted.principalTenantId !== input.tenantId ||
            persisted.legalEntityStatus !== 'active' ||
            persisted.legalEntityTenantId !== input.tenantId
          ) {
            return yield* unavailable();
          }
          yield* ownership;
          return yield* work(owned, database, scope);
        }),
      );
    }),
  ).pipe(Effect.mapError(unavailable));
