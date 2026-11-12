import {
  configureDatabasePool,
  makeOperationalScopeRepository,
  parseDatabaseConnectionPair,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT } from '@app/party-registry-identity-contracts';
import type { DatabaseConnectionPair } from '@app/core-runtime';
import { makeDrizzleAccessPrincipalKinds } from '@app/core-runtime/access/enforcement';
import { PrincipalIdSchema, TenantIdSchema } from '@app/core-runtime/access/ids';
import { requireOwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import type { OwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { sql } from 'drizzle-orm';
import { Config, Crypto, DateTime, Effect, Option, Redacted, Schema } from 'effect';

import { CounterpartyRefSchema } from '../../shared/resources/counterparty.ts';
import { PartyOfficialIdentifierRefSchema } from '../../shared/resources/party-official-identifier.ts';
import { makePartyRef } from '../../shared/domain/identity-contracts.ts';
import {
  counterparties,
  counterpartyRolePeriods,
  parties,
  partyFactAssertions,
  partyOfficialIdentifiers,
  partyRelations,
} from '../../src/db/schema.ts';
import type { PartyTransaction } from '../../src/db/types.ts';
import { readCounterpartyOrganizationIcoFacts } from '../../src/services/counterparty-organization-ico-facts.service.ts';
import { legacyIcoAssertionRevision } from '../../src/services/legacy-ico-authority.service.ts';

const SeedSchema = Schema.Struct({
  originalInput: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('KNOWN'), digits: Schema.Literal('19') }),
    Schema.Struct({ kind: Schema.Literal('UNKNOWN') }),
  ]),
  principal: TrustedPrincipalContextSchema,
  purpose: Schema.Literal('implementation-1096-registered-workload-gateway'),
}).check(
  Schema.makeFilter(
    ({ principal }) =>
      (principal.authMethod === 'session' &&
        principal.legalEntityId !== undefined &&
        principal.authBindingId !== undefined &&
        principal.impersonatedByPrincipalId === undefined) ||
      'The exact fixture human session with a selected company is required',
  ),
);
export type OrganizationMigrationFixtureInput = typeof SeedSchema.Type & {
  readonly connections: DatabaseConnectionPair;
  readonly ownedDatabase: OwnedNativeDatabaseFixture;
};
export class OrganizationMigrationFixtureError extends Schema.TaggedError<OrganizationMigrationFixtureError>()(
  'OrganizationMigrationFixtureError',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}
const unavailable = (cause?: unknown) => {
  const reason = 'The owned isolated INTERNAL Party organization migration fixture is unavailable';
  return cause === undefined
    ? new OrganizationMigrationFixtureError({ reason })
    : new OrganizationMigrationFixtureError({ cause: Redacted.make(cause), reason });
};

const IdentitySchema = Schema.Struct({
  address: Schema.OptionFromNullOr(Schema.String),
  bypass: Schema.Boolean,
  database: Schema.String,
  databaseOid: Schema.String,
  port: Schema.OptionFromNullOr(Schema.Number),
  role: Schema.String,
  roleOid: Schema.String,
  superuser: Schema.Boolean,
});
const sameNativePair = (
  administrative: readonly (typeof IdentitySchema.Type)[],
  operational: readonly (typeof IdentitySchema.Type)[],
  connections: DatabaseConnectionPair,
) => {
  const a = administrative.at(0);
  const r = operational.at(0);
  return (
    administrative.length === 1 &&
    operational.length === 1 &&
    a !== undefined &&
    r !== undefined &&
    a.database === connections.admin.database &&
    r.database === connections.runtime.database &&
    a.databaseOid === r.databaseOid &&
    a.role === connections.admin.user &&
    r.role === connections.runtime.user &&
    a.roleOid !== r.roleOid &&
    (a.superuser || a.bypass) &&
    !r.superuser &&
    !r.bypass &&
    Option.getOrElse(a.address, () => '') === Option.getOrElse(r.address, () => '') &&
    Option.getOrElse(a.port, () => 0) === Option.getOrElse(r.port, () => 0)
  );
};
const assertIsolatedConnections = Effect.fn('PartyOrganizationMigrationFixture.assertIsolatedConnections')(
  function* assertIsolatedConnections(connections: DatabaseConnectionPair) {
    const deployment = yield* Config.option(Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'));
    const { admin, runtime } = connections;
    const parsed = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: admin.connectionString,
      DATABASE_URL: runtime.connectionString,
    }).pipe(Effect.mapError(unavailable));
    const metadataMatches = (actual: typeof admin, declared: typeof admin) =>
      actual.database === declared.database &&
      actual.host === declared.host &&
      actual.port === declared.port &&
      actual.user === declared.user;
    if (!metadataMatches(parsed.admin, admin) || !metadataMatches(parsed.runtime, runtime)) {
      return yield* unavailable();
    }
    if (
      (Option.isSome(deployment) && ['stage', 'production'].includes(deployment.value)) ||
      !/^ontos_test_party_gateway_[a-f\d]{32}$/u.test(admin.database) ||
      admin.database !== runtime.database ||
      admin.user === runtime.user ||
      admin.host !== runtime.host ||
      admin.port !== runtime.port ||
      !['localhost', '127.0.0.1'].includes(admin.host)
    ) {
      return yield* unavailable();
    }
    return yield* Effect.void;
  },
);

const withNativeTransaction = <A, E, R>(
  input: OrganizationMigrationFixtureInput,
  work: (transaction: PartyTransaction) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* verifiedTransaction() {
    const { connections } = input;
    const requireOwnership = requireOwnedNativeDatabaseFixture(input.ownedDatabase, {
      adminConnectionString: Redacted.make(connections.admin.connectionString),
      purpose: input.purpose,
      runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
    }).pipe(Effect.mapError(unavailable));
    yield* requireOwnership;
    yield* assertIsolatedConnections(connections);
    const { admin, runtime } = connections;
    const [adminConfiguration, runtimeConfiguration] = yield* Effect.all([
      configureDatabasePool(Redacted.make(admin.connectionString)),
      configureDatabasePool(Redacted.make(runtime.connectionString)),
    ]).pipe(Effect.mapError(unavailable));
    const adminClient = yield* PgClient.make({ ...adminConfiguration, maxConnections: 1 }).pipe(
      Effect.mapError(unavailable),
    );
    const runtimeClient = yield* PgClient.make({ ...runtimeConfiguration, maxConnections: 1 }).pipe(
      Effect.mapError(unavailable),
    );
    const [adminRows, runtimeRows] = yield* Effect.all([
      adminClient`select current_database() as database, current_user as role,
        d.oid::text as "databaseOid", r.oid::text as "roleOid", r.rolsuper as superuser,
        r.rolbypassrls as bypass, inet_server_addr()::text as address, inet_server_port() as port
        from pg_database d cross join pg_roles r where d.datname=current_database() and r.rolname=current_user`,
      runtimeClient`select current_database() as database, current_user as role,
        d.oid::text as "databaseOid", r.oid::text as "roleOid", r.rolsuper as superuser,
        r.rolbypassrls as bypass, inet_server_addr()::text as address, inet_server_port() as port
        from pg_database d cross join pg_roles r where d.datname=current_database() and r.rolname=current_user`,
    ]).pipe(Effect.mapError(unavailable));
    const [administrative, operational] = yield* Effect.all([
      Schema.decodeUnknownEffect(Schema.Array(IdentitySchema))(adminRows),
      Schema.decodeUnknownEffect(Schema.Array(IdentitySchema))(runtimeRows),
    ]).pipe(Effect.mapError(unavailable));
    if (!sameNativePair(administrative, operational, connections)) {
      return yield* unavailable();
    }
    const database = yield* makeWithDefaults({ relations: partyRelations }).pipe(
      Effect.provideService(PgClient.PgClient, adminClient),
    );

    const core = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, adminClient));
    const kind = yield* makeDrizzleAccessPrincipalKinds({
      enrollment: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
      executor: core,
    }).readKind({
      principalId: PrincipalIdSchema.make(input.principal.principalId),
      tenantId: TenantIdSchema.make(input.principal.tenantId),
      scope: { ...input.principal, correlationId: 'internal:organization-migration-fixture' },
    });
    if (Option.getOrUndefined(kind) !== 'human') {
      return yield* unavailable();
    }
    return yield* database.transaction((transaction) =>
      Effect.gen(function* verifiedWork() {
        const challengeRows = yield* transaction.execute(
          sql`select hashtextextended(gen_random_uuid()::text, 0)::text as key`,
          'objects',
        );
        const challenges = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ key: Schema.String.check(Schema.isPattern(/^-?\d+$/u)) })),
        )(challengeRows);
        const challenge = challenges.at(0);
        if (challenges.length !== 1 || challenge === undefined) {
          return yield* unavailable();
        }
        yield* transaction.execute(sql`select pg_advisory_xact_lock(${challenge.key}::bigint)`, 'objects');
        const response = yield* runtimeClient.withTransaction(
          runtimeClient`select pg_try_advisory_xact_lock(${challenge.key}::bigint) as acquired`,
        );
        const matched = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ acquired: Schema.Literal(false) })),
        )(response);
        if (matched.length !== 1) {
          return yield* unavailable();
        }

        yield* requireOwnership;
        const { principal } = input;
        const persisted = yield* makeOperationalScopeRepository(
          { executor: core },
          PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
        ).load(principal);
        if (
          persisted.tenantStatus !== 'active' ||
          persisted.principalStatus !== 'active' ||
          persisted.principalTenantId !== principal.tenantId ||
          persisted.legalEntityStatus !== 'active' ||
          persisted.legalEntityTenantId !== principal.tenantId ||
          persisted.bindingStatus !== 'active' ||
          persisted.bindingRevokedAt !== null ||
          persisted.bindingSubjectType !== 'user' ||
          persisted.bindingTenantId !== principal.tenantId ||
          persisted.bindingPrincipalId !== principal.principalId ||
          persisted.bindingAuthenticationNamespaceId !== principal.authenticationNamespaceId
        ) {
          return yield* unavailable();
        }
        return yield* work(transaction);
      }),
    );
  }).pipe(Effect.scoped, Effect.mapError(unavailable));

/** INTERNAL ONLY. Seeds one explicit synthetic historical ORG/customer tuple in the owned clone.
 * This is setup data, never an Action acceptance, Privacy decision, permission, source enrollment or registry proof.
 * IDs are generated inside the helper; caller-existing rows are never updated or deleted.
 */
export const seedOrganizationMigrationFixture = Effect.fn('PartyOrganizationMigrationFixture.seed')(
  function* seedOrganizationMigrationFixture(input: OrganizationMigrationFixtureInput) {
    const seed = yield* Schema.decodeUnknownEffect(SeedSchema)(input).pipe(Effect.mapError(unavailable));
    return yield* withNativeTransaction(input, (transaction) =>
      Effect.gen(function* seedPartyFacts() {
        const crypto = yield* Crypto.Crypto;
        const partyId = yield* crypto.randomUUIDv4();
        const counterpartyId = yield* crypto.randomUUIDv4();
        const typeAssertionId = yield* crypto.randomUUIDv4();
        const rolePeriodId = yield* crypto.randomUUIDv4();
        const invocationId = yield* crypto.randomUUIDv4();
        const { principal } = seed;
        const { tenantId, principalId, legalEntityId } = principal;
        if (legalEntityId === undefined) {
          return yield* unavailable();
        }
        const validFrom = DateTime.toDateUtc(DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'));
        const acceptance = {
          tenantId,
          acceptedByActionInvocationId: invocationId,
          acceptedByPrincipalId: principalId,
          policyVersion: 'INTERNAL_ORGANIZATION_MIGRATION_FIXTURE_V1',
          provenanceSource: 'INTERNAL_OWNER_SETUP',
          provenanceMethod: 'MIGRATION_REVIEW',
        };
        yield* transaction.insert(parties).values({
          tenantId,
          partyId,
          currentType: 'ORGANIZATION',
          revision: 1,
          businessName: 'INTERNAL COMPANY ICO FIXTURE',
          currentDisplayName: 'INTERNAL COMPANY ICO FIXTURE',
        });
        yield* transaction.insert(partyFactAssertions).values({
          ...acceptance,
          partyId,
          assertionId: typeAssertionId,
          factKind: 'PARTY_TYPE',
          normalizedValue: 'ORGANIZATION',
          validFrom,
        });
        yield* transaction.insert(partyFactAssertions).values({
          ...acceptance,
          partyId,
          factKind: 'BUSINESS_NAME',
          normalizedValue: 'INTERNAL COMPANY ICO FIXTURE',
          validFrom,
        });
        yield* transaction.insert(counterparties).values({
          ...acceptance,
          partyId,
          counterpartyId,
          legalEntityId,
          creationReason: 'INTERNAL ONLY synthetic historical commercial context',
          evidenceRefs: ['internal:organization-migration:commercial-context'],
          sourceRecordRefs: [],
        });
        yield* transaction.insert(counterpartyRolePeriods).values({
          ...acceptance,
          legalEntityId,
          counterpartyId,
          rolePeriodId,
          roleType: 'CUSTOMER',
          isCurrent: true,
          addReason: 'INTERNAL ONLY synthetic historical CUSTOMER role',
          addEvidenceRefs: ['internal:organization-migration:customer-context'],
          validFrom,
        });
        const [legacy] = yield* transaction
          .insert(partyOfficialIdentifiers)
          .values({
            ...acceptance,
            partyId,
            identifierTypeKey: 'ICO',
            namespace: 'CZ:ICO',
            jurisdiction: 'CZ',
            normalizedValue: '00000019',
            originalInputDigits: seed.originalInput.kind === 'KNOWN' ? seed.originalInput.digits : null,
            validFrom,
          })
          .returning();
        if (legacy === undefined) {
          return yield* unavailable();
        }
        const counterpartyRef = yield* Schema.decodeUnknownEffect(CounterpartyRefSchema)({
          moduleId: 'party.registry',
          resourceType: 'party.registry.counterparty',
          resourceId: counterpartyId,
          tenantId,
        });
        const facts = yield* readCounterpartyOrganizationIcoFacts(
          transaction,
          {
            ...principal,
            correlationId: 'internal:organization-migration-fixture',
          },
          { counterpartyRef },
        );
        if (facts.outcome !== 'CURRENT_ORGANIZATION_CUSTOMER') {
          return yield* unavailable();
        }
        return {
          partyRef: makePartyRef(tenantId, partyId),
          partyRevision: facts.partyRevision,
          typeAssertionId,
          counterpartyRef: facts.counterpartyRef,
          counterpartyRevision: facts.counterpartyRevision,
          currentCustomerRoleRef: facts.currentCustomerRoleRef,
          currentCustomerRoleRevision: facts.currentCustomerRoleRevision,
          legacyAssertionRef: yield* Schema.decodeUnknownEffect(PartyOfficialIdentifierRefSchema)({
            moduleId: 'party.registry',
            resourceType: 'party.registry.party-official-identifier',
            resourceId: legacy.officialIdentifierId,
            tenantId,
          }),
          legacyAssertionRevision: legacyIcoAssertionRevision(legacy),
        };
      }),
    );
  },
);
