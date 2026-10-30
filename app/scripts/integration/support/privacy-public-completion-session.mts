import {
  loadDatabaseConfig,
  loadDatabaseConnectionPair,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  ActiveApplicationCompositionSnapshotSchema,
  canonicalizeApplicationComposition,
  OntosModuleDeploymentContractSchema,
  OntosOutboxSubscriptionContractSchema,
  OntosShellRuntimeContractSchema,
  TrustedPrincipalContextSchema,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { PARTY_REGISTRY_REQUEST_IDENTITY } from '@app/party-registry-identity-contracts';
import {
  makeLiveOperationFixture,
  makeLiveOperationFixtureBootstrap,
  LiveOperationFixtureBootstrapResponseSchema,
  LiveOperationFixtureBootstrapRequestSchema,
} from '@app/core-runtime/testing/actions';
import type {
  LiveOperationFixtureRuntimeHandoff,
  LiveOperationFixtureBootstrapRequest,
} from '@app/core-runtime/testing/actions';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
// Root-owned TEST supervisor. Only published owner contracts/clients are imported.
// Owner programs execute in their own processes; module discovery allocates nothing.
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK } from 'jose';
import { executeDispatchPrivacyMeasureWithAuthorization } from '@app/privacy/api/client';
import { PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import { partyRegistryApiContract } from '@app/party-registry/api';
import { executePrivacyMeasureExecutionWithAuthorization } from '@app/party-registry/api/client';
import { issueApiKeyGatewayContext } from '../../../packages/shared-contracts/src/gateway-context-api-key.ts';
import type { DatabaseConnectionPair } from '@app/core-runtime';
import {
  makeApplicationCompositionSnapshotFixture,
  makeModuleContractFixture,
} from '@app/core-runtime/testing/module-contract';
import { NodeHttpServer, NodeSocketServer } from '@effect/platform-node';
import {
  Config,
  Context,
  Crypto,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schema,
  Stream,
  Scope,
  Exit,
  Ref,
  Result,
} from 'effect';
import { ChildProcess } from 'effect/process';
import { HttpServer, HttpServerResponse } from 'effect/http';
import { Socket } from 'effect/socket';
import { sql, eq, and } from 'drizzle-orm';
import { CoreDatabase } from '../../../packages/core-runtime/src/db/client.ts';
import {
  applicationCompositionAuthority,
  applicationCompositionDurableWork,
  domainEvents,
  outboxDeliveries,
  outboxMessages,
} from '../../../packages/core-runtime/src/db/schema.ts';
import {
  lockApplicationCompositionPublication,
  publishApplicationCompositionAuthority,
} from '../../../packages/core-runtime/src/modules/application-composition-authority.ts';

const partyModuleKey = 'party.registry';
const partyAppId = 'party-registry';
const privacyModuleKey = 'privacy.core';
const appRoot = new URL('../../../', import.meta.url).pathname;
class PrivacyCompletionTestFailure extends Schema.TaggedError<PrivacyCompletionTestFailure>()(
  'PrivacyCompletionTestFailure',
  { reason: Schema.String },
) {}
const failure = (reason: string) => new PrivacyCompletionTestFailure({ reason });
export const PUBLIC_COMPLETION_COMMAND = 'dispatch-business-rejected-and-ack';
export const LEGACY_DISPATCH_SHA256 = 'dc8a3848294951d5f54ce8758e506ca556ce37c42911c2a693c406a02a5c8132';
export const PublicCompletionProducerSchema = Schema.Literals(['current', 'legacy']);
export const PublicCompletionCapabilitySchema = Schema.Struct({
  creatorPid: Schema.Int.check(Schema.isGreaterThan(0)),
  databaseName: Schema.String.check(Schema.isPattern(/^ontos_test_party_gateway_[a-f\d]{32}$/u)),
  databaseOid: Schema.String.check(Schema.isPattern(/^\d+$/u)),
  systemIdentifier: Schema.String.check(Schema.isPattern(/^\d+$/u)),
});
export const frozenDispatchMatches = (source: string) =>
  createHash('sha256').update(source).digest('hex') === LEGACY_DISPATCH_SHA256;
const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const markerSchema = Schema.Struct({
  appId: Schema.Literals(['privacy', partyAppId]),
  buildMarker: Schema.String,
});
const readySchema = Schema.Struct({
  legacy: Schema.optionalKey(
    Schema.Struct({
      producerRevision: Schema.Literal('0325cbf9ffdb36a2e3781b8292df25d67d564f10'),
      producerSha256: Schema.Literal(LEGACY_DISPATCH_SHA256),
      runtimePid: Schema.Int,
      wrapperPid: Schema.Int,
    }),
  ),
  marker: markerSchema,
  port: Schema.Number,
  type: Schema.Literal('ready'),
});
const shellMarkerSchema = Schema.Struct({ appId: Schema.Literal('shell-super-app'), buildMarker: Schema.String });
const shellDescriptionSchema = Schema.Struct({
  marker: shellMarkerSchema,
  protocolVersion: Schema.Literal(2),
  responseSocketEnvironment: Schema.Literal('ONTOS_1258_TEST_RESPONSE_SOCKET'),
  responseTransport: Schema.Literal('private-unix-socket'),
});
const shellReadySchema = Schema.Struct({
  ...readySchema.fields,
  apiKey: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(1))),
  legalEntityId: Schema.requiredKey(TrustedPrincipalContextSchema.fields.legalEntityId),
  marker: shellMarkerSchema,
  principal: TrustedPrincipalContextSchema,
  protocolVersion: Schema.Literal(2),
  responseTransport: Schema.Literal('private-unix-socket'),
  tenantId: TrustedPrincipalContextSchema.fields.tenantId,
});
const partyDescriptionSchema = Schema.Struct({
  marker: markerSchema,
  subscriptions: Schema.Array(OntosOutboxSubscriptionContractSchema),
});
const cycleSchema = Schema.Struct({
  cycle: Schema.Struct({
    claimed: Schema.Int,
    dead: Schema.Int,
    failed: Schema.Int,
    retried: Schema.Int,
    succeeded: Schema.Int,
  }),
  matched: Schema.Struct({ deliveriesCreated: Schema.Int, messagesMatched: Schema.Int }),
  type: Schema.Literal('cycle'),
});
const childEnvironment = (
  transport: {
    readonly PATH: string;
    readonly SPICEDB_CA_CERT: string;
    readonly SPICEDB_ENDPOINT: string;
    readonly SPICEDB_PRESHARED_KEY: Redacted.Redacted;
  },
  values: Readonly<Record<string, string>>,
) => ({
  PATH: transport.PATH,
  SPICEDB_CA_CERT: transport.SPICEDB_CA_CERT,
  SPICEDB_ENDPOINT: transport.SPICEDB_ENDPOINT,
  SPICEDB_PRESHARED_KEY: Redacted.value(transport.SPICEDB_PRESHARED_KEY),
  ...values,
});
const command = Effect.fn('PrivacyPublicSession.command')(function* command(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) {
  const settings = yield* Config.all({
    mise: Config.all({
      MISE_BACKENDS_PNPM: Config.String('MISE_BACKENDS_PNPM').pipe(Config.withDefault('')),
      MISE_CACHE_DIR: Config.String('MISE_CACHE_DIR').pipe(Config.withDefault('')),
      MISE_DATA_DIR: Config.String('MISE_DATA_DIR').pipe(Config.withDefault('')),
      MISE_STATE_DIR: Config.String('MISE_STATE_DIR').pipe(Config.withDefault('')),
    }),
    path: Config.String('PATH'),
  });
  const usesTaskLocalMise = Object.values(settings.mise).some((value) => value !== '');
  const taskRoot = new URL('../../../../', import.meta.url).pathname;
  if (
    usesTaskLocalMise &&
    (settings.mise.MISE_BACKENDS_PNPM !== 'npm:pnpm' ||
      settings.mise.MISE_DATA_DIR !== `${taskRoot}.native-toolchain` ||
      settings.mise.MISE_CACHE_DIR !== `${taskRoot}.native-cache` ||
      settings.mise.MISE_STATE_DIR !== `${taskRoot}.native-state`)
  ) {
    return yield* failure('Invalid task-local Mise environment');
  }
  const buildEnvironment = usesTaskLocalMise ? { PATH: settings.path, ...settings.mise } : { PATH: settings.path };
  const child = yield* ChildProcess.make('mise', ['exec', '--', 'pnpm', ...args], {
    cwd: appRoot,
    env: { ...env, ...buildEnvironment },
    extendEnv: false,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [code] = yield* Effect.all([child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)], {
    concurrency: 3,
  });
  if (code !== 0) {
    return yield* failure('A fixed scoped preparation command failed');
  }
  return yield* Effect.void;
});
// Fixed root-owned setup CLI: metadata-only request/status; credentials stay in its explicit environment.
/** A runtime identity carries only its URL and expected role; its target is the URL's own address. */
const isCanonicalFixtureTarget = (
  address: URL,
  expectedRole: string,
  role: string,
  source: DatabaseConnectionPair,
  connections: DatabaseConnectionPair,
  capability: { readonly databaseName: string },
): boolean => {
  const host = address.hostname;
  const port = Number(address.port === '' ? '5432' : address.port);
  return (
    decodeURIComponent(address.pathname.slice(1)) === source.runtime.database &&
    host === source.runtime.host &&
    port === source.runtime.port &&
    expectedRole === role &&
    decodeURIComponent(address.username) === role &&
    host === connections.admin.host &&
    port === connections.admin.port &&
    connections.admin.host === connections.runtime.host &&
    connections.admin.port === connections.runtime.port &&
    connections.admin.database === capability.databaseName &&
    connections.runtime.database === capability.databaseName &&
    /^ontos_test_party_gateway_[a-f0-9]{32}$/u.test(capability.databaseName) &&
    ['localhost', '127.0.0.1'].includes(host) &&
    address.search === '' &&
    address.hash === ''
  );
};

const prepareNativeIdentities = Effect.fn('PrivacyFixture.prepareNativeIdentities')(function* prepareNativeIdentities(
  connections: DatabaseConnectionPair,
  capability: { readonly databaseName: string; readonly databaseOid: string; readonly systemIdentifier: string },
) {
  const source = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' }).pipe(
    Effect.mapError(() => failure('Canonical fixture database configuration was unavailable')),
  );
  const urls: Record<string, string> = {};
  for (const identity of [SHELL_GATEWAY_ISSUER_IDENTITY, PARTY_REGISTRY_REQUEST_IDENTITY]) {
    const canonical = yield* loadDatabaseConfig({ envPath: '/dev/null', identity }).pipe(
      Effect.mapError(() => failure('Canonical fixture identity configuration was unavailable')),
    );
    const address = new URL(canonical.connectionString);
    if (!isCanonicalFixtureTarget(address, canonical.expectedRole, identity.role, source, connections, capability)) {
      return yield* failure('Canonical native fixture identity target was refused');
    }
    address.pathname = `/${capability.databaseName}`;
    urls[identity.urlKey] = address.href;
  }
  const issuerUrl = urls.SHELL_GATEWAY_ISSUER_DATABASE_URL;
  const requestUrl = urls.PARTY_REGISTRY_DATABASE_URL;
  if (issuerUrl === undefined || requestUrl === undefined) {
    return yield* failure('Canonical native fixture identities were incomplete');
  }
  const child = yield* ChildProcess.make(
    process.execPath,
    [
      `${appRoot}/scripts/integration/support/privacy-native-database-identities.mts`,
      yield* Schema.encodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            creatorPid: Schema.Int,
            databaseName: Schema.String,
            databaseOid: Schema.String,
            systemIdentifier: Schema.String,
            type: Schema.Literal('prepare-privacy-native-identities'),
          }),
        ),
      )({ ...capability, creatorPid: process.pid, type: 'prepare-privacy-native-identities' }),
    ],
    {
      cwd: appRoot,
      env: {
        DATABASE_ADMIN_URL: connections.admin.connectionString,
        DATABASE_URL: connections.runtime.connectionString,
        ...urls,
      },
      extendEnv: false,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [lines, code] = yield* Effect.all(
    [
      child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runCollect),
      child.exitCode,
      Stream.runDrain(child.stderr),
    ],
    { concurrency: 3 },
  );
  if (code !== 0 || lines.length !== 1) {
    return yield* failure('Fixed native fixture identity setup failed');
  }
  yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        databaseName: Schema.Literal(capability.databaseName),
        databaseOid: Schema.Literal(capability.databaseOid),
        systemIdentifier: Schema.Literal(capability.systemIdentifier),
        type: Schema.Literal('privacy-native-identities-prepared'),
      }),
    ),
  )(lines[0], { onExcessProperty: 'error' }).pipe(
    Effect.mapError(() => failure('Fixed native fixture identity proof was refused')),
  );
  return { PARTY_REGISTRY_DATABASE_URL: requestUrl, SHELL_GATEWAY_ISSUER_DATABASE_URL: issuerUrl };
});
const describe = Effect.fn('PrivacyPublicSession.describe')(function* describe(path: string) {
  const transportPath = yield* Config.String('PATH');
  const child = yield* ChildProcess.make(process.execPath, [path, '--describe'], {
    cwd: appRoot,
    env: { PATH: transportPath },
    extendEnv: false,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [code, lines] = yield* Effect.all(
    [
      child.exitCode,
      child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runCollect),
      Stream.runDrain(child.stderr),
    ],
    { concurrency: 3 },
  );
  if (code !== 0 || lines.length !== 1) {
    return yield* failure('Closed owner description failed');
  }
  return lines[0];
});
const fullOwnerDml = 'select, insert, update, delete';
const sessionDirectoryPrefix = '.1258-session-';
const fixtureRuntimeInventory = [
  {
    operations: fullOwnerDml,
    rls: false,
    schema: 'auth',
    tables: ['user', 'session', 'account', 'verification', 'apikey'],
  },
  {
    operations: 'select',
    rls: false,
    schema: 'auth',
    tables: ['support_impersonation_recovery'],
  },
  {
    operations: fullOwnerDml,
    rls: true,
    schema: 'party',
    tables: [
      'counterparties',
      'counterparty_admin_read_models',
      'counterparty_role_admin_read_models',
      'counterparty_role_periods',
      'duplicate_candidate_case_parties',
      'duplicate_candidate_cases',
      'parties',
      'party_aliases',
      'party_contact_point_purposes',
      'party_contact_points',
      'party_corrections',
      'party_fact_assertions',
      'party_identifier_claims',
      'party_match_decisions',
      'party_merges',
      'party_official_identifiers',
      'party_relationships',
      'privacy_measure_executions',
    ],
  },
  {
    operations: fullOwnerDml,
    rls: true,
    schema: 'contacts',
    tables: ['organization_engagement_profiles', 'person_engagement_profiles'],
  },
  {
    operations: 'select, insert, delete',
    rls: false,
    schema: 'contacts',
    tables: ['gateway_assertion_redemptions'],
  },
  {
    operations: 'select, insert',
    rls: true,
    schema: 'privacy',
    tables: [
      'anti_resurrection_protections',
      'applicability_decisions',
      'applicability_policies',
      'consent_decisions',
      'consent_scope_bindings',
      'disposition_decisions',
      'dsr_deadlines',
      'dsr_delivery_evidence',
      'dsr_resolver_assignments',
      'dsr_responses',
      'dsr_substantive_decisions',
      'dsr_verifications',
      'eligibility_evidence',
      'legal_basis_assignments',
      'legal_holds',
      'notice_acknowledgements',
      'notice_provisions',
      'notice_versions',
      'owner_contributions',
      'owner_execution_outcomes',
      'processing_activity_lifecycle_events',
      'processing_interventions',
      'purpose_versions',
      'privacy_representations',
      'responsibility_assignments',
      'retention_exceptions',
      'retention_rules',
    ],
  },
  {
    operations: fullOwnerDml,
    rls: true,
    schema: 'privacy',
    tables: [
      'dsr_cases',
      'dsr_delivery_access',
      'dsr_owner_tasks',
      'external_obligations',
      'privacy_measure_dispatches',
      'privacy_subjects',
      'processing_activities',
      'processing_purposes',
      'retention_evaluation_work',
      'temporary_dsr_exports',
    ],
  },
] as const;

const receivePrivateShellResponse = (
  socket: Socket.Socket,
  line: Deferred.Deferred<string, PrivacyCompletionTestFailure>,
  bootstrap?: (
    request: LiveOperationFixtureBootstrapRequest,
  ) => Effect.Effect<
    { readonly handoff: LiveOperationFixtureRuntimeHandoff; readonly type: 'fixture-prepared' },
    Effect.Error<ReturnType<typeof makeLiveOperationFixture>>,
    Crypto.Crypto
  >,
) =>
  Effect.gen(function* privateShellResponse() {
    const pull = yield* Socket.readerString(socket);
    let response = '';
    while (!response.includes('\n')) {
      response += (yield* pull).join('');
      if (new TextEncoder().encode(response).length > 65_536) {
        return yield* failure('Private Shell readiness exceeds its protocol bound');
      }
    }
    if (!response.endsWith('\n') || response.indexOf('\n') !== response.length - 1) {
      return yield* failure('Private Shell readiness must contain exactly one message');
    }
    if (bootstrap !== undefined) {
      const message = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ type: Schema.String })))(
        response.trimEnd(),
      );
      if (message.type !== 'ready') {
        const request = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(LiveOperationFixtureBootstrapRequestSchema),
          { onExcessProperty: 'error' },
        )(response.trimEnd());
        const reply = yield* bootstrap(request);
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(LiveOperationFixtureBootstrapResponseSchema))(
          reply,
        );
        const writer = yield* socket.writer;
        yield* writer.write(`${encoded}\n`);
        return true;
      }
    }
    return yield* Deferred.succeed(line, response.trimEnd());
  }).pipe(
    Effect.scoped,
    Effect.matchEffect({
      onFailure: () => Deferred.fail(line, failure('Private Shell readiness is unavailable')),
      onSuccess: Effect.succeed,
    }),
  );

const start = Effect.fn('PrivacyCompletionTest.start')(function* start(
  path: string,
  env: Readonly<Record<string, string>>,
  privateReply: boolean,
  legacy: boolean,
  ownedPids: number[],
  bootstrap?: Parameters<typeof receivePrivateShellResponse>[2],
) {
  const transport = yield* Config.all({
    PATH: Config.String('PATH'),
    SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
    SPICEDB_ENDPOINT: Config.String('SPICEDB_ENDPOINT'),
    SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
  });
  const line = yield* Deferred.make<string, PrivacyCompletionTestFailure>();
  let responseEnvironment = {};
  if (privateReply) {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs.makeTempDirectoryScoped({ directory: '/tmp', prefix: 'ontos-1258-' });
    const directory = yield* fs.realPath(temporary);
    yield* fs.chmod(directory, 0o700);
    const socketPath = `${directory}/response.sock`;
    const server = yield* NodeSocketServer.make({ path: socketPath });
    responseEnvironment = { ONTOS_1258_TEST_RESPONSE_SOCKET: socketPath };
    yield* server
      .run((socket) => receivePrivateShellResponse(socket, line, bootstrap))
      .pipe(
        Effect.catch(() => Deferred.fail(line, failure('Private Shell listener is unavailable'))),
        Effect.forkScoped,
      );
  }
  const child = yield* ChildProcess.make(process.execPath, legacy ? [path, '--serve-legacy-dispatch'] : [path], {
    cwd: appRoot,
    env: childEnvironment(transport, { ...env, ...responseEnvironment }),
    extendEnv: false,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  ownedPids.push(child.pid);
  if (privateReply) {
    yield* Stream.runDrain(child.stdout).pipe(Effect.forkScoped);
  }
  if (!privateReply) {
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((value) =>
        // Worker/owner stdout contains only non-secret machine messages; Shell uses its private socket.
        value.startsWith('{') ? Deferred.succeed(line, value).pipe(Effect.asVoid) : Effect.void,
      ),
      Effect.ensuring(Deferred.fail(line, failure('Owner process ended before readiness'))),
      Effect.forkScoped,
    );
  }
  yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
  return {
    child,
    line: yield* privateReply
      ? Effect.raceFirst(
          Deferred.await(line),
          Effect.exit(child.exitCode).pipe(
            Effect.flatMap(() => Effect.fail(failure('A fixture child exited before its readiness response'))),
          ),
        )
      : Deferred.await(line),
  };
});

const bootstrapOwnerCapabilities = Effect.fn('PrivacyPublicSession.bootstrapOwnerCapabilities')(
  function* bootstrapOwnerCapabilities(runtimeUser: string) {
    const database = yield* CoreDatabase;
    const role = sql.identifier(runtimeUser);
    // Closed current table inventory copied from the public test recipe. No role/schema-wide,
    // future-object, grant-option or wildcard grants. All owner data is produced by public calls.
    for (const item of fixtureRuntimeInventory) {
      yield* database.executor.execute(sql`grant usage on schema ${sql.identifier(item.schema)} to ${role}`, 'objects');
      for (const table of item.tables) {
        const [relation] = yield* database.executor.execute<{ readonly owned: boolean; readonly rls: boolean }>(
          sql`select pg_get_userbyid(c.relowner)=current_user as owned,(c.relrowsecurity and c.relforcerowsecurity) as rls from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=${item.schema} and c.relname=${table} and c.relkind='r'`,
          'objects',
        );
        if (!relation?.owned || (item.rls && !relation.rls)) {
          return yield* failure('Owner relation capability was refused');
        }
        if (item.operations === 'select') {
          yield* database.executor.execute(
            sql`grant select on ${sql.identifier(item.schema)}.${sql.identifier(table)} to ${role}`,
            'objects',
          );
        } else if (item.operations === 'select, insert') {
          yield* database.executor.execute(
            sql`grant select,insert on ${sql.identifier(item.schema)}.${sql.identifier(table)} to ${role}`,
            'objects',
          );
        } else if (item.operations === 'select, insert, delete') {
          yield* database.executor.execute(
            sql`grant select,insert,delete on ${sql.identifier(item.schema)}.${sql.identifier(table)} to ${role}`,
            'objects',
          );
        } else {
          yield* database.executor.execute(
            sql`grant select,insert,update,delete on ${sql.identifier(item.schema)}.${sql.identifier(table)} to ${role}`,
            'objects',
          );
        }
        for (const operation of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          const grantOperation = `${operation} WITH GRANT OPTION`;
          const [rights] = yield* database.executor.execute<{ readonly allowed: boolean; readonly grantable: boolean }>(
            sql`select has_table_privilege(${runtimeUser},format('%I.%I',${item.schema}::text,${table}::text),${operation}) as allowed,has_table_privilege(${runtimeUser},format('%I.%I',${item.schema}::text,${table}::text),${grantOperation}) as grantable`,
            'objects',
          );
          if (
            rights === undefined ||
            rights.grantable ||
            rights.allowed !== item.operations.toUpperCase().split(', ').includes(operation)
          ) {
            return yield* failure('Effective runtime table capabilities do not match the fixed test policy');
          }
        }
      }
      const [schemaRights] = yield* database.executor.execute<{
        readonly create: boolean;
        readonly grantable: boolean;
      }>(
        sql`select has_schema_privilege(${runtimeUser},${item.schema},'CREATE') as create,has_schema_privilege(${runtimeUser},${item.schema},'USAGE WITH GRANT OPTION') as grantable`,
        'objects',
      );
      if (schemaRights === undefined || schemaRights.create || schemaRights.grantable) {
        return yield* failure('Effective runtime schema capabilities exceed the fixed test policy');
      }
    }
    yield* database.executor.execute(sql`create schema privacy_completion_test`, 'objects');
    yield* database.executor.execute(
      sql`create table privacy_completion_test.redemptions (issuer text not null,audience text not null,jti text not null,primary key(issuer,audience,jti))`,
      'objects',
    );
    yield* database.executor.execute(sql`grant usage on schema privacy_completion_test to ${role}`, 'objects');
    yield* database.executor.execute(
      sql`grant select,insert on privacy_completion_test.redemptions to ${role}`,
      'objects',
    );

    return yield* Effect.void;
  },
);

const hasExactCurrentDebt = (
  message: typeof outboxMessages.$inferSelect,
  debt: readonly (typeof applicationCompositionDurableWork.$inferSelect)[],
  revision: string,
) =>
  debt.length === 1 &&
  debt[0]?.originalRevision === revision &&
  debt[0]?.ownerModuleKey === privacyModuleKey &&
  message.completionOriginalRevision === revision &&
  message.completionConsumerModuleKey === partyModuleKey;

interface PublicCompletionSessionInput {
  readonly capability: typeof PublicCompletionCapabilitySchema.Type;
  readonly connections: DatabaseConnectionPair;
  readonly producer: typeof PublicCompletionProducerSchema.Type;
}
const openPrivacyPublicCompletionSession = Effect.fn('PrivacyPublicSession.open')(
  function* openPrivacyPublicCompletionSession(input: PublicCompletionSessionInput, ownedPids: number[]) {
    const capability = yield* Schema.decodeUnknownEffect(PublicCompletionCapabilitySchema)(input.capability);
    yield* Schema.decodeUnknownEffect(PublicCompletionProducerSchema)(input.producer);
    if (
      capability.creatorPid !== process.pid ||
      ![input.connections.admin, input.connections.runtime].every(
        (value) => value.database === capability.databaseName && ['localhost', '127.0.0.1'].includes(value.host),
      )
    ) {
      return yield* failure('Public supervisor requires its creator-bound local database');
    }
    const database = yield* CoreDatabase;
    const [identity] = yield* database.executor.execute<{
      readonly oid: string;
      readonly owned: boolean;
      readonly systemIdentifier: string;
    }>(
      sql`select d.oid::text as oid,(pg_control_system()).system_identifier::text as "systemIdentifier",pg_get_userbyid(d.datdba)=current_user as owned from pg_database d where d.datname=current_database()`,
      'objects',
    );
    if (
      identity?.oid !== capability.databaseOid ||
      identity.systemIdentifier !== capability.systemIdentifier ||
      !identity.owned
    ) {
      return yield* failure('Public supervisor physical creator capability was refused');
    }
    const crypto = yield* Crypto.Crypto;
    const suffix = yield* crypto.randomUUIDv4();
    const fs = yield* FileSystem.FileSystem;
    const directories = {
      party: yield* fs.makeTempDirectoryScoped({
        directory: `${appRoot}verticals/party-registry/node_modules`,
        prefix: sessionDirectoryPrefix,
      }),
      privacy: yield* fs.makeTempDirectoryScoped({
        directory: `${appRoot}verticals/privacy/node_modules`,
        prefix: sessionDirectoryPrefix,
      }),
      shell: yield* fs.makeTempDirectoryScoped({
        directory: `${appRoot}apps/shell-super-app/node_modules`,
        prefix: sessionDirectoryPrefix,
      }),
    };
    for (const directory of Object.values(directories)) {
      yield* fs.chmod(directory, 0o700);
    }
    const paths = {
      party: `${directories.party}/party.mjs`,
      privacy: `${directories.privacy}/privacy.mjs`,
      shell: `${directories.shell}/shell.mjs`,
      worker: `${directories.party}/worker.mjs`,
    };
    for (const entry of [
      { output: paths.party, source: 'verticals/party-registry/tests/support/tenant-party-http.ts' },
      { output: paths.privacy, source: 'verticals/privacy/tests/support/privacy-completion-http.ts' },
      { output: paths.shell, source: 'apps/shell-super-app/tests/support/privacy-completion-shell.ts' },
      { output: paths.worker, source: 'verticals/party-registry/tests/support/privacy-completion-worker.ts' },
    ]) {
      yield* command(
        [
          'exec',
          'esbuild',
          entry.source,
          '--bundle',
          '--platform=node',
          '--format=esm',
          '--packages=external',
          `--outfile=${entry.output}`,
        ],
        {},
      );
    }
    const shellDescription = yield* describe(paths.shell).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(shellDescriptionSchema))),
    );
    const privacyMarker = yield* describe(paths.privacy).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(markerSchema))),
    );
    const party = yield* describe(paths.worker).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(partyDescriptionSchema))),
    );
    const base = yield* makeApplicationCompositionSnapshotFixture([privacyMarker.appId, party.marker.appId], suffix);
    const modules = yield* Effect.forEach(
      base.composition.modules,
      Effect.fn('PrivacyCompletionTest.module')(function* module(value) {
        const isParty = value.deployment.appId === party.marker.appId;
        const marker = isParty ? party.marker : privacyMarker;
        const moduleId = isParty ? partyModuleKey : privacyModuleKey;
        const contract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)(
          makeModuleContractFixture({
            appId: marker.appId,
            buildMarker: marker.buildMarker,
            moduleId,
            outboxSubscriptions: isParty ? party.subscriptions : [],
          }),
        );
        const document = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
          contract,
        );
        const hash = digest(document);
        return {
          ...value,
          backend: { baseUrl: `https://${marker.appId}.fixture.example.test/`, transport: 'node-http' as const },
          contract: { ...value.contract, sha256: hash },
          contractDocument: document,
          deployment: marker,
          moduleId,
          publicContract: { ...value.publicContract, id: moduleId, sha256: hash },
        };
      }),
      { concurrency: 2 },
    );
    const shellDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))({
      contributionAbi: base.composition.shell.contributionAbi,
      coreCapabilities: base.composition.shell.coreCapabilities,
      deployment: shellDescription.marker,
      schemaVersion: '2',
    });
    const composition = {
      ...base.composition,
      modules,
      shell: {
        ...base.composition.shell,
        deployment: shellDescription.marker,
        runtimeContract: { ...base.composition.shell.runtimeContract, sha256: digest(shellDocument) },
      },
    };
    const snapshot = yield* validateActiveApplicationCompositionSnapshot({
      ...base,
      composition: {
        ...composition,
        revision: digest(canonicalizeApplicationComposition({ ...composition, revision: '0'.repeat(64) })),
      },
    });
    const environment = {
      DATABASE_ADMIN_URL: input.connections.admin.connectionString,
      DATABASE_URL: input.connections.runtime.connectionString,
    };
    // Supported owner migration entrypoints, never foreign migration/source imports.
    for (const owner of ['@app/shell-super-app', '@app/party-registry']) {
      yield* command(['--filter', owner, 'db:migrate'], environment);
    }
    yield* bootstrapOwnerCapabilities(input.connections.runtime.user);
    // Creator-bound Core-only test setup reproduces the pre-owner-verifier active authority.
    // It never deletes authority, touches owner history, or substitutes for operator acceptance.
    yield* database.executor.transaction((transaction) =>
      Effect.gen(function* initializeNativeAuthority() {
        yield* lockApplicationCompositionPublication(transaction);
        if ((yield* transaction.select().from(applicationCompositionAuthority)).length !== 0) {
          return yield* failure('Public session requires no existing authority');
        }
        return yield* publishApplicationCompositionAuthority(transaction, snapshot);
      }),
    );
    const snapshotJson = yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
      snapshot,
    );
    const sourceContext = yield* Layer.build(NodeHttpServer.layerTest);
    const source = Context.get(sourceContext, HttpServer.HttpServer);
    yield* source.serve(Effect.succeed(HttpServerResponse.text(snapshotJson, { contentType: 'application/json' })));
    const { address } = source;
    if (!Schema.is(Schema.Struct({ port: Schema.Number }))(address)) {
      return yield* failure('Composition source requires loopback TCP');
    }
    const keys = yield* Effect.tryPromise(
      async () => await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }),
    );
    const privateJwk = yield* Effect.tryPromise(async () => await exportJWK(keys.privateKey));
    const publicJwk = yield* Effect.tryPromise(async () => await exportJWK(keys.publicKey));
    const kid = `privacy-${suffix}`;
    const nativeIdentityUrls = yield* prepareNativeIdentities(input.connections, capability);
    const childConfig = {
      BETTER_AUTH_SECRET: `privacy-completion-${suffix}-${suffix}`,
      BETTER_AUTH_TRUSTED_ORIGINS: 'http://localhost:3020,http://127.0.0.1:3020',
      BETTER_AUTH_URL: 'http://localhost:3020',
      DATABASE_URL: input.connections.runtime.connectionString,
      // This caller retains the single-LE configuration; Shell validates the closed option.
      ONTOS_1258_CREATOR_PID: String(process.pid),
      ONTOS_1258_OWNED_DATABASE_OID: capability.databaseOid,
      ONTOS_1258_PRIVACY_DIRECTORY: `${appRoot}verticals/privacy`,
      ONTOS_1258_TEST_ADDITIONAL_LE: 'none',
      ONTOS_1258_TEST_COMPOSITION: snapshotJson,
      ONTOS_1258_TEST_DATABASE: capability.databaseName,
      ONTOS_1258_TEST_REVISION: snapshot.composition.revision,
      ONTOS_1258_TEST_RUNTIME: input.connections.runtime.user,
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `http://127.0.0.1:${address.port}/composition`,
      ONTOS_GATEWAY_ISSUER: 'https://privacy-completion.example.test',
      ONTOS_GATEWAY_PRIVATE_JWK: yield* Schema.encodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            alg: Schema.Literal('EdDSA'),
            crv: Schema.Literal('Ed25519'),
            d: Schema.String,
            kid: Schema.String,
            kty: Schema.Literal('OKP'),
            use: Schema.Literal('sig'),
            x: Schema.String,
          }),
        ),
      )({ ...privateJwk, alg: 'EdDSA', kid, use: 'sig' }),
      ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            keys: Schema.Array(
              Schema.Struct({
                alg: Schema.Literal('EdDSA'),
                crv: Schema.Literal('Ed25519'),
                kid: Schema.String,
                kty: Schema.Literal('OKP'),
                use: Schema.Literal('sig'),
                x: Schema.String,
              }),
            ),
          }),
        ),
      )({ keys: [{ ...publicJwk, alg: 'EdDSA', kid, use: 'sig' }] }),
    };
    const { ONTOS_GATEWAY_PRIVATE_JWK: _privateKey, ...receiving } = childConfig;
    // Register before child acquisition: creator resources outlive the child and every socket connection.
    const bootstrapScope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(bootstrapScope, exit));
    const bootstrap = yield* makeLiveOperationFixtureBootstrap((providerSubjectId) =>
      Effect.acquireRelease(
        makeLiveOperationFixture({
          actionKeys: [
            'core.identity.bind-self-api-key',
            'core.modules.change-tenant-module-state',
            'privacy.core.dispatch-privacy-measure',
            'privacy.core.record-owner-execution-outcome',
            'party.registry.execute-privacy-measure',
          ],
          adminConnectionString: Redacted.make(input.connections.admin.connectionString),
          allowedAudiences: [partyAppId, 'privacy'],
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: snapshot.composition.revision,
          // The real module-state setup Action requires tenant manage_identity.
          managerIdentityAdmin: true,
          managerProviderSubjectId: providerSubjectId,
          moduleKeys: [partyModuleKey, privacyModuleKey],
          runtimeConnectionString: Redacted.make(input.connections.runtime.connectionString),
        }),
        (value) => value.close().pipe(Effect.orDie),
      ).pipe(
        Scope.provide(bootstrapScope),
        Effect.map((value) => value.runtimeHandoff),
      ),
    );
    const shellProcess = yield* start(
      paths.shell,
      { ...childConfig, SHELL_GATEWAY_ISSUER_DATABASE_URL: nativeIdentityUrls.SHELL_GATEWAY_ISSUER_DATABASE_URL },
      true,
      false,
      ownedPids,
      bootstrap,
    );
    const shell = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(shellReadySchema))(shellProcess.line);
    if (shell.principal.tenantId !== shell.tenantId || shell.principal.legalEntityId !== shell.legalEntityId) {
      return yield* failure('Shell legal entity identity contradicted its principal');
    }
    const shellUrl = `http://127.0.0.1:${shell.port}`;
    const partyProcess = yield* start(
      paths.party,
      { ...receiving, PARTY_REGISTRY_DATABASE_URL: nativeIdentityUrls.PARTY_REGISTRY_DATABASE_URL },
      false,
      false,
      ownedPids,
    );
    const partyReady = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(readySchema))(partyProcess.line);
    const ownerEnvironment = {
      ...receiving,
      ONTOS_PARTY_REGISTRY_API_BASE_URL: new URL(
        partyRegistryApiContract.apiPrefix,
        `http://127.0.0.1:${partyReady.port}`,
      ).href,
      ONTOS_PRIVACY_MEASURE_WORKER_API_KEY: Redacted.value(shell.apiKey),
      ONTOS_SHELL_GATEWAY_BASE_URL: shellUrl,
    };
    const privacyProcess = yield* start(paths.privacy, ownerEnvironment, false, input.producer === 'legacy', ownedPids);
    const privacy = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(readySchema))(privacyProcess.line);
    if (input.producer === 'legacy' && privacy.legacy?.producerSha256 !== LEGACY_DISPATCH_SHA256) {
      return yield* failure('Legacy process did not describe the frozen producer');
    }
    if (privacy.legacy !== undefined) {
      ownedPids.push(privacy.legacy.runtimePid);
    }
    const privacyUrl = `http://127.0.0.1:${privacy.port}`;
    let used = false;
    const run = Effect.fn('PrivacyPublicSession.dispatchBusinessRejectedAndAck')(
      function* dispatchBusinessRejectedAndAck() {
        if (used) {
          return yield* failure('Public session fixed command is single-use');
        }
        used = true;
        const handoff = yield* Schema.decodeUnknownEffect(PrivacyMeasureHandoffSchema)({
          contentScopeRefs: ['party.registry.counterparty.lifecycle'],
          controllerObligationRef: 'TEST:obligation',
          dispositionDecision: 'RESTRICT',
          expectedEvidenceRefs: ['party.registry.counterparty.restricted'],
          idempotencyKey: suffix,
          kind: 'RESTRICT',
          measureId: `measure:${suffix}`,
          owningCapability: partyModuleKey,
          preconditionRefs: ['TEST:decision'],
          requestedAt: '2026-01-01T00:00:00.000Z',
          requestedResult: 'RESTRICTED',
          resourceRefs: [
            `party.registry|party.registry.counterparty|${shell.legalEntityId}|${yield* crypto.randomUUIDv4()}`,
          ],
          right: null,
          sourceDecisionRef: `decision:${suffix}`,
          sourceDecisionRevision: 1,
          subjectRef: `subject:${suffix}`,
          taskId: `task:${suffix}`,
          tenantId: shell.tenantId,
        });
        const credential = yield* issueApiKeyGatewayContext(
          {
            audience: 'privacy',
            compositionRevision: snapshot.composition.revision,
            legalEntityId: shell.legalEntityId,
          },
          { apiKey: shell.apiKey, baseUrl: shellUrl, requestCorrelation: suffix },
        );
        yield* executeDispatchPrivacyMeasureWithAuthorization({ handoff }, `Bearer ${credential.token}`, suffix, {
          baseUrl: privacyUrl,
          compositionRevision: snapshot.composition.revision,
          idempotencyKey: suffix,
        });
        const [message] = yield* database.executor
          .select()
          .from(outboxMessages)
          .where(
            and(eq(outboxMessages.tenantId, shell.tenantId), eq(outboxMessages.topic, 'privacy.measure.dispatched')),
          );
        if (message === undefined) {
          return yield* failure('Actual public dispatch did not create a message');
        }
        const debtId = `outbox:${message.outboxMessageId}:party.registry`;
        const beforeDebt = yield* database.executor
          .select()
          .from(applicationCompositionDurableWork)
          .where(eq(applicationCompositionDurableWork.workId, debtId));
        if (input.producer === 'current' && !hasExactCurrentDebt(message, beforeDebt, snapshot.composition.revision)) {
          return yield* failure('Current public producer did not enroll exact debt');
        }
        if (
          input.producer === 'legacy' &&
          (message.completionOriginalRevision !== null ||
            message.completionConsumerModuleKey !== null ||
            beforeDebt.length !== 0)
        ) {
          return yield* failure('Frozen old producer unexpectedly enrolled current metadata');
        }
        const worker = yield* start(
          paths.worker,
          {
            ...ownerEnvironment,
            ONTOS_1258_TEST_BARRIER: 'none',
            ONTOS_1258_TEST_CLOCK_ADVANCE_MS: '0',
            ONTOS_1258_TEST_RETRY_SESSION: 'single',
            ONTOS_PRIVACY_API_BASE_URL: privacyUrl,
          },
          false,
          false,
          ownedPids,
        );
        const cycle = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(cycleSchema))(worker.line);
        if ((yield* worker.child.exitCode) !== 0 || cycle.cycle.succeeded !== 1) {
          return yield* failure('Real Party public completion cycle failed');
        }
        const receiptCredential = yield* issueApiKeyGatewayContext(
          {
            audience: partyAppId,
            compositionRevision: snapshot.composition.revision,
            legalEntityId: shell.legalEntityId,
          },
          { apiKey: shell.apiKey, baseUrl: shellUrl, requestCorrelation: suffix },
        );
        const receipt = yield* executePrivacyMeasureExecutionWithAuthorization(
          { idempotencyKey: handoff.idempotencyKey },
          `Bearer ${receiptCredential.token}`,
          suffix,
          {
            baseUrl: ownerEnvironment.ONTOS_PARTY_REGISTRY_API_BASE_URL,
            compositionRevision: snapshot.composition.revision,
          },
        );
        if (Option.isNone(receipt) || receipt.value.outcome.status !== 'BUSINESS_REJECTED') {
          return yield* failure('Actual public Party receipt is not BUSINESS_REJECTED');
        }
        const deliveries = yield* database.executor
          .select()
          .from(outboxDeliveries)
          .where(eq(outboxDeliveries.outboxMessageId, message.outboxMessageId));
        const remaining = yield* database.executor
          .select()
          .from(applicationCompositionDurableWork)
          .where(eq(applicationCompositionDurableWork.workId, debtId));
        if (deliveries.length !== 1 || deliveries[0]?.status !== 'done' || remaining.length !== 0) {
          return yield* failure('Public ACK did not settle exact Core delivery debt');
        }
        const [event] = yield* database.executor
          .select()
          .from(domainEvents)
          .where(eq(domainEvents.domainEventId, message.domainEventId));
        if (event === undefined || event.actionInvocationId === null) {
          return yield* failure('Producer invocation evidence is unavailable');
        }
        return Object.freeze({
          acknowledgedDebtCount: remaining.length,
          admittedDebtCount: beforeDebt.length,
          command: PUBLIC_COMPLETION_COMMAND,
          creatorPid: process.pid,
          databaseOid: capability.databaseOid,
          debtId,
          deliveryId: deliveries[0].outboxDeliveryId,
          domainEventId: message.domainEventId,
          invocationId: event.actionInvocationId,
          measureId: handoff.measureId,
          messageId: message.outboxMessageId,
          messageSha256: digest(
            yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json))(message.payloadJson),
          ),
          originalRevision: message.completionOriginalRevision,
          outcomeId: receipt.value.outcome.outcomeId,
          producer: input.producer,
          producerSha256: input.producer === 'legacy' ? LEGACY_DISPATCH_SHA256 : null,
          revision: snapshot.composition.revision,
          status: receipt.value.outcome.status,
          tenantId: shell.tenantId,
        });
      },
    );
    // Scoped children remain alive until the caller's operator refusal and evidence check finish.
    return { run, snapshot };
  },
);

export const makePrivacyPublicCompletionSession = Effect.fn('PrivacyPublicSession.make')(
  function* makePrivacyPublicCompletionSession(input: PublicCompletionSessionInput) {
    const database = yield* CoreDatabase;
    const sessionScope = yield* Scope.make();
    const ownedPids: number[] = [];
    const closed = yield* Ref.make(false);
    const observeRuntimeBackends = database.executor.execute<{ readonly pid: number }>(
      sql`select pid from pg_stat_activity where datname=current_database() and usename=${input.connections.runtime.user} order by pid`,
      'objects',
    );
    const baselineBackends = yield* observeRuntimeBackends;
    const close = Effect.gen(function* closeOwnedPublicSession() {
      if (yield* Ref.get(closed)) {
        return yield* Effect.void;
      }
      yield* Scope.close(sessionScope, Exit.void);
      for (const pid of ownedPids) {
        // Signal zero observes liveness only. Any reused/foreign live PID is HOLD, never killed.
        const observed = yield* Effect.try({ catch: (cause) => cause, try: () => process.kill(pid, 0) }).pipe(
          Effect.result,
        );
        if (Result.isSuccess(observed)) {
          return yield* failure('An attributed public child remains live after scoped cleanup');
        }
        yield* Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.Literal('ESRCH') }))(observed.failure);
      }
      const remaining = yield* observeRuntimeBackends;
      if (
        remaining.length !== baselineBackends.length ||
        remaining.some((row, index) => row.pid !== baselineBackends[index]?.pid)
      ) {
        return yield* failure('Public child runtime backends did not return to the exact baseline');
      }
      return yield* Ref.set(closed, true);
    });
    yield* Effect.addFinalizer(() => close.pipe(Effect.orDie));
    const session = yield* openPrivacyPublicCompletionSession(input, ownedPids).pipe(Scope.provide(sessionScope));
    return {
      close,
      run: () =>
        Ref.get(closed).pipe(
          Effect.flatMap((alreadyClosed) =>
            alreadyClosed
              ? Effect.fail(failure('A closed public session cannot run'))
              : session.run().pipe(Scope.provide(sessionScope)),
          ),
        ),
      snapshot: session.snapshot,
    };
  },
);
