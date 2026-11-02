import {
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  GatewayAssertionRedemptionUnavailableError,
} from '@app/core-runtime';
import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { Clock, Effect, Layer, Schema } from 'effect';
import { Pool } from 'pg';

class DsrTestRedemptionSetupFailure extends Schema.TaggedError<DsrTestRedemptionSetupFailure>()(
  'DsrTestRedemptionSetupFailure',
  { reason: Schema.String },
) {}
const setupFailure = () => new DsrTestRedemptionSetupFailure({ reason: 'Exact owned TEST replay storage is required' });
const nativeIdentity = Schema.Struct({
  bypass: Schema.Boolean,
  database: Schema.String,
  effectiveRole: Schema.String,
  sessionRole: Schema.String,
  superuser: Schema.Boolean,
});
const privileges = Schema.Struct({
  delete: Schema.Boolean,
  insert: Schema.Boolean,
  references: Schema.Boolean,
  select: Schema.Boolean,
  trigger: Schema.Boolean,
  truncate: Schema.Boolean,
  update: Schema.Boolean,
});
const loopback = (host: string): boolean => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
const postgresProtocol = (protocol: string): boolean => protocol === 'postgres:' || protocol === 'postgresql:';

interface EndpointMetadata {
  readonly hash: string;
  readonly hostname: string;
  readonly pathname: string;
  readonly port: string;
  readonly protocol: string;
  readonly queryKeys: readonly string[];
  readonly username: string;
}
const endpointMetadata = (url: URL): EndpointMetadata => ({
  hash: url.hash,
  hostname: url.hostname,
  pathname: url.pathname,
  port: url.port,
  protocol: url.protocol,
  queryKeys: [...url.searchParams.keys()],
  username: url.username,
});

/** Pure TEST guard controls. These metadata predicates never accept I/O or configure the factory. */
export const dsrTestStorageGuards = {
  endpoints: (admin: EndpointMetadata, runtime: EndpointMetadata, database: string): boolean =>
    postgresProtocol(admin.protocol) &&
    admin.protocol === runtime.protocol &&
    loopback(admin.hostname) &&
    admin.hostname === runtime.hostname &&
    (admin.port || '5432') === (runtime.port || '5432') &&
    database.startsWith('ontos_test_party_gateway_') &&
    admin.pathname === `/${database}` &&
    runtime.pathname === `/${database}` &&
    /^[a-z_][a-z0-9_]*$/u.test(runtime.username) &&
    admin.username !== runtime.username &&
    [...admin.queryKeys, ...runtime.queryKeys].every((key) => key === 'sslmode') &&
    admin.hash === '' &&
    runtime.hash === '',
  privileges: (allowed: typeof privileges.Type): boolean =>
    allowed.select &&
    allowed.insert &&
    !allowed.update &&
    !allowed.delete &&
    !allowed.truncate &&
    !allowed.references &&
    !allowed.trigger,
  roles: (
    admin: typeof nativeIdentity.Type,
    runtime: typeof nativeIdentity.Type,
    database: string,
    adminRole: string,
    runtimeRole: string,
  ): boolean =>
    admin.database === database &&
    admin.effectiveRole === adminRole &&
    admin.sessionRole === adminRole &&
    runtime.database === database &&
    runtime.effectiveRole === runtimeRole &&
    runtime.sessionRole === runtimeRole &&
    !runtime.superuser &&
    !runtime.bypass,
};

/** TEST-only authority bound to a database this factory itself creates. No caller-selected connections or SQL. */
export const makeDsrObligationNative = Effect.fn('DsrObligation.TEST.native')(function* makeDsrObligationNative(
  compositionSnapshot: ActiveApplicationCompositionSnapshot,
  purpose:
    | 'stabilization-1265-dsr-multi-owner'
    | 'stabilization-1261-retained-purpose-withdrawal'
    | 'stabilization-1271-exact-obligation-deadline' = 'stabilization-1265-dsr-multi-owner',
) {
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot,
    mode: 'schema-only',
    purpose,
  });
  // Capture primitives from the actual creator result before exposing its public fixture object.
  const { database } = isolated.connections.admin;
  const adminConnection = isolated.connections.admin.connectionString;
  const runtimeConnection = isolated.connections.runtime.connectionString;
  const adminUrl = new URL(adminConnection);
  const runtimeUrl = new URL(runtimeConnection);
  const runtimeRole = runtimeUrl.username;
  if (
    database !== isolated.connections.runtime.database ||
    !dsrTestStorageGuards.endpoints(endpointMetadata(adminUrl), endpointMetadata(runtimeUrl), database)
  ) {
    return yield* setupFailure();
  }
  const makeRedemption = Effect.fn('DsrObligation.TEST.boundRedemption')(function* makeRedemption() {
    const admin = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: adminConnection, max: 1 })),
      (pool) => Effect.promise(async () => await pool.end()),
    );
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: runtimeConnection, max: 2 })),
      (pool) => Effect.promise(async () => await pool.end()),
    );
    // Both probes precede TEST schema/grant writes. Ownership comes from creation above,
    // not the prefix. Effective role checks independently reject elevated runtime clients.
    const identities = yield* Effect.tryPromise({
      catch: setupFailure,
      try: async () => {
        const query =
          'select current_database() as database,current_user as "effectiveRole",session_user as "sessionRole",rolsuper as superuser,rolbypassrls as bypass from pg_catalog.pg_roles where rolname=current_user';
        const adminRows = await admin.query(query);
        const runtimeRows = await runtime.query(query);
        return { admin: adminRows.rows[0], runtime: runtimeRows.rows[0] };
      },
    });
    const adminIdentity = yield* Schema.decodeUnknownEffect(nativeIdentity)(identities.admin).pipe(
      Effect.mapError(setupFailure),
    );
    const runtimeIdentity = yield* Schema.decodeUnknownEffect(nativeIdentity)(identities.runtime).pipe(
      Effect.mapError(setupFailure),
    );
    if (!dsrTestStorageGuards.roles(adminIdentity, runtimeIdentity, database, adminUrl.username, runtimeRole)) {
      return yield* setupFailure();
    }
    yield* Effect.tryPromise({
      catch: setupFailure,
      try: async () => {
        await admin.query('create schema if not exists privacy_dsr_obligation_test');
        await admin.query(
          'create table if not exists privacy_dsr_obligation_test.redemptions (issuer text not null, audience text not null, jti text not null, primary key (issuer,audience,jti))',
        );
        await admin.query(`grant usage on schema privacy_dsr_obligation_test to "${runtimeRole}"`);
        await admin.query(`grant insert, select on privacy_dsr_obligation_test.redemptions to "${runtimeRole}"`);
      },
    });
    const effectivePrivileges = yield* Effect.tryPromise({
      catch: setupFailure,
      try: async () => {
        const result = await runtime.query(
          `select has_table_privilege(current_user,'privacy_dsr_obligation_test.redemptions','SELECT') as "select",has_table_privilege(current_user,'privacy_dsr_obligation_test.redemptions','INSERT') as "insert",has_table_privilege(current_user,'privacy_dsr_obligation_test.redemptions','UPDATE') as "update",has_table_privilege(current_user,'privacy_dsr_obligation_test.redemptions','DELETE') as "delete",has_table_privilege(current_user,'privacy_dsr_obligation_test.redemptions','TRUNCATE') as "truncate",has_table_privilege(current_user,'privacy_dsr_obligation_test.redemptions','REFERENCES') as "references",has_table_privilege(current_user,'privacy_dsr_obligation_test.redemptions','TRIGGER') as "trigger"`,
        );
        return result.rows[0];
      },
    });
    const allowed = yield* Schema.decodeUnknownEffect(privileges)(effectivePrivileges).pipe(
      Effect.mapError(setupFailure),
    );
    if (!dsrTestStorageGuards.privileges(allowed)) {
      return yield* setupFailure();
    }
    return Layer.succeed(GatewayAssertionRedemptionService, {
      consume: Effect.fn('DsrObligation.TEST.consume')(function* consume(input) {
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        if (input.expiresAtEpochSeconds + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS <= now) {
          return yield* new GatewayAssertionReplayError({ reason: 'The Bearer assertion is no longer usable' });
        }
        const inserted = yield* Effect.tryPromise({
          catch: () =>
            new GatewayAssertionRedemptionUnavailableError({ reason: 'TEST native replay storage is unavailable' }),
          try: async () =>
            await runtime.query(
              'insert into privacy_dsr_obligation_test.redemptions (issuer,audience,jti) values ($1,$2,$3) on conflict do nothing returning jti',
              [input.issuer, input.audience, input.jti],
            ),
        });
        return inserted.rowCount === 1
          ? yield* Effect.void
          : yield* new GatewayAssertionReplayError({ reason: 'The Bearer assertion is no longer usable' });
      }),
    });
  });
  return { isolated, makeRedemption };
});
