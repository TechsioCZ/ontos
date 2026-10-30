/// <reference types="node" />

// Fixed creator-owned TEST setup boundary. Invoke with one metadata JSON argument;
// canonical restricted URLs and the clone admin URL travel only in the setup process environment.
// No SQL, role selection, passwords, executors or credentials are accepted/returned by the protocol.
import { NodeServices } from '@effect/platform-node';
import { Console, Effect, Exit, Redacted, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';
import { Reactivity } from 'effect/reactivity';
import { pathToFileURL } from 'node:url';
import { loadDatabaseConnectionPair, loadDatabaseConfig } from '../../../packages/core-runtime/src/db/config.ts';
import {
  SHELL_GATEWAY_ISSUER_IDENTITY,
  PARTY_REGISTRY_REQUEST_IDENTITY,
  PARTY_REGISTRY_WORKER_IDENTITY,
  SHARED_RUNTIME_IDENTITY,
} from '../../../packages/core-runtime/src/db/database-identities.ts';
import { quoteIdentifier } from '../../postgres/database-login-roles.mts';
import { manifestEntryForRole } from '../../postgres/database-role-manifest.mts';
import {
  assertExplicitRole,
  assertLoginRole,
  connectAdmin,
  grantExplicitRole,
  grantTrustAuthority,
} from '../../postgres/runtime-role-bootstrap.mts';

export const IdentitySetupRequestSchema = Schema.Struct({
  creatorPid: Schema.Int.check(Schema.isGreaterThan(0)),
  databaseName: Schema.String.check(Schema.isPattern(/^ontos_test_party_gateway_[a-f0-9]{32}$/u)),
  databaseOid: Schema.String.check(Schema.isPattern(/^\d+$/u)),
  systemIdentifier: Schema.String.check(Schema.isPattern(/^\d+$/u)),
  type: Schema.Literal('prepare-privacy-native-identities'),
});
export const IdentitySetupStatusSchema = Schema.Struct({
  databaseName: IdentitySetupRequestSchema.fields.databaseName,
  databaseOid: IdentitySetupRequestSchema.fields.databaseOid,
  systemIdentifier: IdentitySetupRequestSchema.fields.systemIdentifier,
  type: Schema.Literal('privacy-native-identities-prepared'),
});
const identities = [SHELL_GATEWAY_ISSUER_IDENTITY, PARTY_REGISTRY_REQUEST_IDENTITY] as const;
// Rebuilt owner schemata also need the fixed worker manifest; no worker credential or pool is acquired.
const manifestIdentities = [...identities, PARTY_REGISTRY_WORKER_IDENTITY] as const;
const refused = () => new Error('Fixed native identity setup refused');
export const setupAddressMatches = (
  address: URL,
  expected: { database: string; host: string; port: number; user: string },
) =>
  ['postgres:', 'postgresql:'].includes(address.protocol) &&
  ['localhost', '127.0.0.1'].includes(address.hostname) &&
  address.hostname === expected.host &&
  Number(address.port || '5432') === expected.port &&
  address.pathname === `/${expected.database}` &&
  decodeURIComponent(address.username) === expected.user &&
  address.search === '' &&
  address.hash === '';
export const restrictedNativeIdentityMatches = (
  row: {
    bypass: boolean;
    createDb: boolean;
    createRole: boolean;
    currentUser: string;
    database: string;
    sessionUser: string;
    superuser: boolean;
  },
  database: string,
  role: string,
) =>
  row.database === database &&
  row.currentUser === role &&
  row.sessionUser === role &&
  !row.superuser &&
  !row.bypass &&
  !row.createRole &&
  !row.createDb;

const prepare = Effect.fn('PrivacyNativeIdentities.prepare')(function* prepare(
  value: typeof IdentitySetupRequestSchema.Type,
) {
  const request = yield* Schema.decodeUnknownEffect(IdentitySetupRequestSchema)(value, { onExcessProperty: 'error' });
  if (request.creatorPid !== process.ppid) {
    return yield* Effect.fail(refused());
  }
  // Never read an ambient file or substitute a runtime URL for administrative authority.
  const pair = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const endpoint = { database: request.databaseName, host: pair.admin.host, port: pair.admin.port };
  if (
    pair.admin.user === pair.runtime.user ||
    ![pair.admin, pair.runtime].every((config) =>
      setupAddressMatches(new URL(config.connectionString), { ...endpoint, user: config.user }),
    )
  ) {
    return yield* Effect.fail(refused());
  }
  const configs = [];
  for (const identity of identities) {
    configs.push(yield* loadDatabaseConfig({ envPath: '/dev/null', identity }));
  }
  for (const [index, config] of configs.entries()) {
    const identity = identities[index];
    if (
      identity === undefined ||
      !setupAddressMatches(new URL(config.connectionString), { ...endpoint, user: identity.role })
    ) {
      return yield* Effect.fail(refused());
    }
  }
  const admin = yield* connectAdmin(Redacted.make(pair.admin.connectionString));
  const [physical] = yield* admin.unsafe<{
    database: string;
    databaseOid: string;
    owned: boolean;
    systemIdentifier: string;
  }>(
    `select current_database() as database,d.oid::text as "databaseOid",(pg_control_system()).system_identifier::text as "systemIdentifier",pg_get_userbyid(d.datdba)=current_user and current_user=session_user as owned from pg_database d where d.datname=current_database()`,
  );
  if (
    physical?.database !== request.databaseName ||
    physical.databaseOid !== request.databaseOid ||
    physical.systemIdentifier !== request.systemIdentifier ||
    !physical.owned
  ) {
    return yield* Effect.fail(refused());
  }
  yield* Effect.gen(function* fixedManifestSetup() {
    // Same database TEMPORARY policy as bootstrapRuntimeRoles; no global role/login mutation.
    yield* admin.unsafe(`revoke temporary on database ${quoteIdentifier(request.databaseName)} from public`);
    const shared = manifestEntryForRole(SHARED_RUNTIME_IDENTITY.role);
    if (shared?.kind !== 'legacy_shared' || !shared.databaseTemporary) {
      return yield* Effect.fail(refused());
    }
    yield* admin.unsafe(
      `grant temporary on database ${quoteIdentifier(request.databaseName)} to ${quoteIdentifier(shared.identity.role)}`,
    );
    for (const identity of manifestIdentities) {
      const entry = manifestEntryForRole(identity.role);
      if (entry?.kind !== 'explicit') {
        return yield* Effect.fail(refused());
      }
      yield* admin.unsafe(
        `revoke temporary, create on database ${quoteIdentifier(request.databaseName)} from ${quoteIdentifier(identity.role)}`,
      );
      yield* grantExplicitRole(admin, entry);
    }
    yield* grantTrustAuthority(admin);
    for (const identity of manifestIdentities) {
      const entry = manifestEntryForRole(identity.role);
      if (entry?.kind !== 'explicit') {
        return yield* Effect.fail(refused());
      }
      yield* assertLoginRole(admin, entry);
      yield* assertExplicitRole(admin, entry);
    }
    return yield* Effect.void;
  }).pipe(admin.withTransaction);
  for (const config of [pair.runtime, ...configs]) {
    const native = yield* connectAdmin(Redacted.make(config.connectionString));
    const [row] = yield* native.unsafe<{
      bypass: boolean;
      createDb: boolean;
      createRole: boolean;
      currentUser: string;
      database: string;
      databaseOid: string;
      sessionUser: string;
      superuser: boolean;
    }>(
      `select current_database() as database,(select oid::text from pg_database where datname=current_database()) as "databaseOid",current_user as "currentUser",session_user as "sessionUser",rolsuper as superuser,rolbypassrls as bypass,rolcreaterole as "createRole",rolcreatedb as "createDb" from pg_roles where rolname=current_user`,
    );
    if (
      row === undefined ||
      row.databaseOid !== request.databaseOid ||
      !restrictedNativeIdentityMatches(row, request.databaseName, config.user)
    ) {
      return yield* Effect.fail(refused());
    }
  }
  return {
    databaseName: request.databaseName,
    databaseOid: request.databaseOid,
    systemIdentifier: request.systemIdentifier,
    type: 'privacy-native-identities-prepared' as const,
  };
});

const cli = Command.make(
  'privacy-native-database-identities',
  {
    request: Argument.String('request'),
  },
  ({ request: frame }) =>
    Effect.gen(function* setupCli() {
      const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(IdentitySetupRequestSchema))(frame, {
        onExcessProperty: 'error',
      });
      const status = yield* prepare(request);
      const line = yield* Schema.encodeEffect(Schema.fromJsonString(IdentitySetupStatusSchema))(status);
      yield* Console.log(line);
    }),
);
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exit = await Effect.runPromiseExit(
    Command.run(cli, { version: '1.0.0' }).pipe(
      Effect.scoped,
      Effect.provide(Reactivity.layer),
      Effect.provide(NodeServices.layer),
      Effect.tapCause(() => Console.error('Fixed native identity setup refused')),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
