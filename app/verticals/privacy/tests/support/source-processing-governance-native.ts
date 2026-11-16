import type { DatabaseConnectionPair } from '@app/core-runtime';
import { configureDatabasePool, parseDatabaseConnectionPair } from '@app/core-runtime';
import { requireOwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import type { OwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { PgClient } from '@effect/sql-pg';
import { and, eq, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, DateTime, Effect, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { ProcessingPurposeRefSchema } from '../../shared/resources/processing-purpose.ts';
import { privacyRelations, processingPurposes } from '../../src/database/schema.ts';

const Uuid = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('SourceGovernanceFixtureUuid'),
  Schema.decodeTo(Schema.String),
);
const PinsSchema = Schema.Struct({
  governancePrincipalId: Uuid,
  legalEntityId: Uuid,
  purpose: Schema.Literal('implementation-1096-registered-workload-gateway'),
  purposeRef: ProcessingPurposeRefSchema,
  tenantId: Uuid,
}).check(
  Schema.makeFilter((pins) =>
    pins.purposeRef.tenantId === pins.tenantId ? undefined : 'Purpose and trusted Tenant must match',
  ),
);
export type SourceProcessingGovernanceNativeInput = typeof PinsSchema.Type & {
  readonly connections: DatabaseConnectionPair;
  readonly ownedDatabase: OwnedNativeDatabaseFixture;
};
export class SourceProcessingGovernanceNativeError extends Schema.TaggedError<SourceProcessingGovernanceNativeError>()(
  'SourceProcessingGovernanceNativeError',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}
const unavailable = (cause?: unknown) => {
  const reason = 'The owned source-processing governance control is unavailable';
  if (cause === undefined) {
    return new SourceProcessingGovernanceNativeError({ reason });
  }
  return new SourceProcessingGovernanceNativeError({ cause: Redacted.make(cause), reason });
};
type PrivacyExecutor = Effect.Success<ReturnType<typeof makeWithDefaults<typeof privacyRelations>>>;
type PrivacyTransaction = Parameters<Parameters<PrivacyExecutor['transaction']>[0]>[0];
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
const assertIsolatedConnections = Effect.fn('PrivacySourceGovernanceNative.assertIsolatedConnections')(
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
  input: SourceProcessingGovernanceNativeInput,
  work: (transaction: PrivacyTransaction) => Effect.Effect<A, E, R>,
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
    const database = yield* makeWithDefaults({ relations: privacyRelations }).pipe(
      Effect.provideService(PgClient.PgClient, adminClient),
    );

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
        return yield* work(transaction);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(Reactivity.layer), Effect.mapError(unavailable));

/** INTERNAL test control. Retires only the exact current fixture Purpose; no basis, decision or grant is modified.
 * This opens its own clients and verifies the live fixture lease on every attempt.
 */
export const retireSourceProcessingNativePurpose = Effect.fn('PrivacySourceGovernanceNative.retirePurpose')(
  function* retireSourceProcessingNativePurpose(input: SourceProcessingGovernanceNativeInput) {
    const pins = yield* Schema.decodeUnknownEffect(PinsSchema)(input).pipe(Effect.mapError(unavailable));
    return yield* withNativeTransaction(input, (transaction) =>
      Effect.gen(function* retireExactFixturePurpose() {
        const [row] = yield* transaction
          .select({
            businessCode: processingPurposes.businessCode,
            governanceOwnerId: processingPurposes.governanceOwnerId,
            lifecycle: processingPurposes.lifecycle,
            retiredAt: processingPurposes.retiredAt,
          })
          .from(processingPurposes)
          .where(
            and(
              eq(processingPurposes.tenantId, pins.tenantId),
              eq(processingPurposes.legalEntityId, pins.legalEntityId),
              eq(processingPurposes.processingPurposeId, pins.purposeRef.resourceId),
            ),
          )
          .for('update')
          .limit(1);
        const expectedCode = `INTERNAL_${pins.purposeRef.resourceId.replaceAll('-', '').toUpperCase()}`;
        if (
          row === undefined ||
          row.businessCode !== expectedCode ||
          row.governanceOwnerId !== pins.governancePrincipalId
        ) {
          return yield* unavailable();
        }
        if (row.lifecycle === 'RETIRED' && row.retiredAt !== null) {
          return {
            changed: false,
            lifecycle: 'RETIRED' as const,
            purposeRef: pins.purposeRef,
            retiredAt: DateTime.formatIso(DateTime.fromDateUnsafe(row.retiredAt)),
          };
        }
        if (row.lifecycle !== 'ACTIVE' || row.retiredAt !== null) {
          return yield* unavailable();
        }
        const now = yield* DateTime.now;
        const [retired] = yield* transaction
          .update(processingPurposes)
          .set({ lifecycle: 'RETIRED', retiredAt: DateTime.toDateUtc(now), updatedAt: DateTime.toDateUtc(now) })
          .where(
            and(
              eq(processingPurposes.tenantId, pins.tenantId),
              eq(processingPurposes.legalEntityId, pins.legalEntityId),
              eq(processingPurposes.processingPurposeId, pins.purposeRef.resourceId),
              eq(processingPurposes.governanceOwnerId, pins.governancePrincipalId),
              eq(processingPurposes.businessCode, expectedCode),
              eq(processingPurposes.lifecycle, 'ACTIVE'),
            ),
          )
          .returning({ lifecycle: processingPurposes.lifecycle, retiredAt: processingPurposes.retiredAt });
        if (retired === undefined || retired.lifecycle !== 'RETIRED' || retired.retiredAt === null) {
          return yield* unavailable();
        }
        return {
          changed: true,
          lifecycle: 'RETIRED' as const,
          purposeRef: pins.purposeRef,
          retiredAt: DateTime.formatIso(DateTime.fromDateUnsafe(retired.retiredAt)),
        };
      }),
    );
  },
);
