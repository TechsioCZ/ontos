import type { DatabaseConnectionPair } from '@app/core-runtime';
import {
  loadDatabaseConfig,
  loadDatabaseConnectionPair,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  PARTY_REGISTRY_REQUEST_IDENTITY,
  ActiveApplicationCompositionSnapshotSchema,
  canonicalizeApplicationComposition,
  OntosModuleDeploymentContractSchema,
  OntosOutboxSubscriptionContractSchema,
  OntosShellRuntimeContractSchema,
  TrustedPrincipalContextSchema,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
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
import {
  makeApplicationCompositionSnapshotFixture,
  makeModuleContractFixture,
} from '@app/core-runtime/testing/module-contract';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { CoreDatabase, testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { LegacyCompletionPublication } from '@app/core-runtime/legacy-completion-publication';
import type {
  LegacyCompletionMessageEvidence,
  LegacyCompletionOwnerVerifier,
} from '@app/core-runtime/legacy-completion-publication';
import { PgDialect } from 'drizzle-orm/pg-core';
import { runApplicationCompositionMigration } from '../../../../scripts/application-composition-authority-publication.mts';
import { privacyLegacyCompletionOwner } from '../../scripts/legacy-completion-publication.ts';
import { PgClient } from '@effect/sql-pg';
import { Reactivity } from 'effect/reactivity';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { partyRegistryApiContract } from '@app/party-registry/api';
import {
  executeExecutePrivacyMeasureWithAuthorization,
  executePrivacyMeasureExecutionWithAuthorization,
} from '@app/party-registry/api/client';
import {
  NodeChildProcessSpawner,
  NodeCrypto,
  NodeHttpServer,
  NodeServices,
  NodeSocket,
  NodeSocketServer,
} from '@effect/platform-node';
import {
  Array as EffectArray,
  Config,
  ConfigProvider,
  DateTime,
  Context,
  Crypto,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Queue,
  Redacted,
  Result,
  Schema,
  Stream,
  Scope,
} from 'effect';
import type { Cause } from 'effect';
import { ChildProcess } from 'effect/process';
import { FetchHttpClient, HttpServer, HttpServerResponse } from 'effect/http';
import { Socket } from 'effect/socket';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, decodeJwt } from 'jose';
import { Pool } from 'pg';
import { expect, it } from 'effect-rstest';

import {
  OwnerExecutionOutcomeSchema,
  PrivacyMeasureHandoffSchema,
} from '../../shared/domain/privacy-measure-handoff.ts';
import { executeDispatchPrivacyMeasureWithAuthorization } from '../../src/api/dispatch-privacy-measure-action-client.ts';
import {
  DispatchPrivacyMeasureActionAlreadyCommittedProblemSchema,
  DispatchPrivacyMeasureActionAuthenticationProblemSchema,
  DispatchPrivacyMeasureActionIneligibleProblemSchema,
  DispatchPrivacyMeasureActionForbiddenProblemSchema,
  DispatchPrivacyMeasureActionUnavailableProblemSchema,
} from '../../shared/apis/dispatch-privacy-measure-action.ts';

import { executeRecordOwnerExecutionOutcomeWithAuthorization } from '../../src/api/record-owner-execution-outcome-action-client.ts';
import {
  RecordOwnerExecutionOutcomeActionUnavailableProblemSchema,
  RecordOwnerExecutionOutcomeActionConflictProblemSchema,
} from '../../shared/apis/record-owner-execution-outcome-action.ts';

// Explicit TEST receiving/redemption and receipt-backed authority live in the Privacy child.
// Shell authentication, Party receiving/registrations, matcher, worker, and Core ACK are real.
// Ordinary fixture composition controls prove only Core phases. The dedicated publisher
// race separately calls the deployment operator with the real Privacy owner verifier.
// BUSINESS_REJECTED remains UNRESOLVED for that verifier, even after its delivery and
// exact message-derived Core debt settle.

class PrivacyCompletionTestFailure extends Schema.TaggedError<PrivacyCompletionTestFailure>()(
  'PrivacyCompletionTestFailure',
  { reason: Schema.String },
) {}
const failure = (reason: string) => new PrivacyCompletionTestFailure({ reason });
const appRoot = new URL('../../../../', import.meta.url).pathname;
const markerSchema = Schema.Struct({
  appId: Schema.Literals(['privacy', 'party-registry']),
  buildMarker: Schema.String,
});
const shellMarkerSchema = Schema.Struct({ appId: Schema.Literal('shell-super-app'), buildMarker: Schema.String });
const shellDescriptionSchema = Schema.Struct({
  marker: shellMarkerSchema,
  protocolVersion: Schema.Literal(2),
  responseSocketEnvironment: Schema.Literal('ONTOS_1258_TEST_RESPONSE_SOCKET'),
  responseTransport: Schema.Literal('private-unix-socket'),
});
const eventIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('DomainEventId'),
  Schema.decodeTo(Schema.String),
);
const actionKeySchema = Schema.String.pipe(Schema.brand('ActionKey'), Schema.decodeTo(Schema.String));
const invocationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('ActionInvocationId'),
  Schema.decodeTo(Schema.String),
);
const partyDescriptionSchema = Schema.Struct({
  marker: markerSchema,
  subscriptions: Schema.Array(OntosOutboxSubscriptionContractSchema),
});
const readySchema = Schema.Struct({ marker: markerSchema, port: Schema.Number, type: Schema.Literal('ready') });
const shellReadySchema = Schema.Struct({
  ...readySchema.fields,
  apiKey: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(1))),
  legalEntityId: Schema.requiredKey(TrustedPrincipalContextSchema.fields.legalEntityId),
  marker: shellMarkerSchema,
  port: Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1 })),
  principal: TrustedPrincipalContextSchema,
  protocolVersion: Schema.Literal(2),
  responseTransport: Schema.Literal('private-unix-socket'),
  tenantId: TrustedPrincipalContextSchema.fields.tenantId,
});
const evidenceSchema = Schema.Struct({
  events: Schema.Array(Schema.Struct({ id: Schema.String, invocationId: invocationIdSchema })),
  invocations: Schema.Array(Schema.Struct({ actionKey: actionKeySchema, id: Schema.String, status: Schema.String })),
  outbox: Schema.Array(
    Schema.Struct({
      consumer: Schema.OptionFromNullOr(Schema.String),
      eventId: eventIdSchema,
      id: Schema.String,
      payload: Schema.Unknown,
      revision: Schema.OptionFromNullOr(Schema.String),
      topic: Schema.String,
    }),
  ),
});
const cycleSchema = Schema.Struct({
  cycle: Schema.Struct({
    claimed: Schema.Number,
    dead: Schema.Number,
    failed: Schema.Number,
    retried: Schema.Number,
    succeeded: Schema.Number,
  }),
  matched: Schema.Struct({ deliveriesCreated: Schema.Int, messagesMatched: Schema.Int }),
  type: Schema.Literal('cycle'),
});
const barrierSchema = Schema.Struct({
  stage: Schema.Literals(['after-execute', 'after-report']),
  type: Schema.Literal('barrier'),
});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

const command = Effect.fn('PrivacyCompletionTest.command')(function* command(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
) {
  const child = yield* ChildProcess.make('mise', ['exec', '--', 'pnpm', ...args], {
    cwd: appRoot,
    env,
    extendEnv: true,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [code] = yield* Effect.all([child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)], {
    concurrency: 3,
  });
  if (code !== 0) {
    return yield* failure('A scoped fixture preparation command failed');
  }
  return yield* Effect.void;
});
// The public generated client treats an explicit baseUrl as the complete mounted API base.
const partyApiBaseUrl = (port: number) => new URL(partyRegistryApiContract.apiPrefix, `http://127.0.0.1:${port}`).href;
const descriptionOptions = (path: string) => ({ env: { PATH: path }, extendEnv: false as const });
// Fixed root-owned setup CLI: metadata-only request/status; credentials stay in its explicit environment.
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
    if (
      canonical.database !== source.runtime.database ||
      canonical.host !== source.runtime.host ||
      canonical.port !== source.runtime.port ||
      canonical.user !== identity.role ||
      canonical.host !== connections.admin.host ||
      canonical.port !== connections.admin.port ||
      connections.admin.host !== connections.runtime.host ||
      connections.admin.port !== connections.runtime.port ||
      connections.admin.database !== capability.databaseName ||
      connections.runtime.database !== capability.databaseName ||
      !/^ontos_test_party_gateway_[a-f0-9]{32}$/u.test(capability.databaseName) ||
      !['localhost', '127.0.0.1'].includes(canonical.host) ||
      address.search !== '' ||
      address.hash !== ''
    ) {
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
const describe = Effect.fn('PrivacyCompletionTest.describe')(function* describe(path: string) {
  const transportPath = yield* Config.String('PATH');
  const child = yield* ChildProcess.make(process.execPath, [path, '--describe'], {
    ...descriptionOptions(transportPath),
    cwd: appRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [lines, code] = yield* Effect.all(
    [
      child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runCollect),
      child.exitCode,
      Stream.runDrain(child.stderr),
    ],
    { concurrency: 3 },
  );
  if (code !== 0 || lines.length !== 1) {
    return yield* failure('An owner fixture description was unavailable');
  }
  return lines[0];
});
// Child configuration is an explicit capability; never inherit administrator/source database credentials.
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
const addressIsOwned = (address: URL, expected: { database: string; host: string; port: string; user: string }) =>
  ['postgres:', 'postgresql:'].includes(address.protocol) &&
  ['localhost', '127.0.0.1'].includes(address.hostname) &&
  address.hostname === expected.host &&
  (address.port || '5432') === expected.port &&
  address.pathname === `/${expected.database}` &&
  decodeURIComponent(address.username) === expected.user &&
  address.search === '' &&
  address.hash === '';
const identityIsRestricted = (
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
  user: string,
) =>
  row.database === database &&
  row.currentUser === user &&
  row.sessionUser === user &&
  !row.superuser &&
  !row.bypass &&
  !row.createRole &&
  !row.createDb;
// Closed current owner policy: no role mutation, wildcard objects, sequences or future grants.
// SQL DML rights retain forced RLS and do not authorize business Actions.
const fixtureRuntimeInventory = [
  {
    operations: 'select, insert, update, delete',
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
    operations: 'select, insert, update, delete',
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
    operations: 'select, insert, update, delete',
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
    operations: 'select, insert, update, delete',
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

// The public boundary exposes the transaction category, not a private SQL trigger reason.
// Exact receiver/admission causality additionally requires the paired Core-native proof.
type DispatchAttemptFailure = Effect.Error<ReturnType<Effect.Success<typeof fixture>['dispatch']>>;
const isDispatchTransactionRefusal = (candidate: DispatchAttemptFailure | Error | null) => {
  const parsed = Schema.decodeUnknownResult(DispatchPrivacyMeasureActionUnavailableProblemSchema)(candidate);
  return Result.isSuccess(parsed) && parsed.success.code === 'action_transaction_failed';
};
const privilegesMatch = (actual: Readonly<Record<string, boolean>>, allowed: readonly string[]) =>
  Object.entries(actual).every(([operation, permitted]) => permitted === allowed.includes(operation)) &&
  allowed.every((operation) => actual[operation]);
const surplusCapabilitiesSchema = Schema.Struct({
  schemaCreate: Schema.Boolean,
  schemaUsageGrant: Schema.Boolean,
  tableGrant: Schema.Boolean,
});
const surplusCapabilitiesAreAbsent = (value: typeof surplusCapabilitiesSchema.Type) =>
  !value.schemaCreate && !value.schemaUsageGrant && !value.tableGrant;
// SocketServer.run deliberately omits its enclosing Scope from connection contexts.
// The reader owns a connection-local acquisition scope and releases it after one frame.
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
    Effect.catch(() => Deferred.fail(line, failure('Private Shell readiness is unavailable'))),
  );

// Keep process failure observable without forwarding child logs or causes, which may contain secrets.
const awaitChildReadiness = (
  response: Effect.Effect<string, PrivacyCompletionTestFailure>,
  childExit: Effect.Effect<unknown, unknown>,
) =>
  Effect.raceFirst(
    response,
    Effect.exit(childExit).pipe(
      Effect.flatMap(() => Effect.fail(failure('A fixture child exited before its readiness response'))),
    ),
  );

const start = Effect.fn('PrivacyCompletionTest.start')(function* start(
  path: string,
  env: Readonly<Record<string, string>>,
  privateReply = false,
  retrySession?: {
    readonly input: Stream.Stream<Uint8Array>;
    readonly replies: Queue.Queue<string, PrivacyCompletionTestFailure>;
  },
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
  if (privateReply === true) {
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
  const child = yield* ChildProcess.make(process.execPath, [path], {
    cwd: appRoot,
    env: childEnvironment(transport, { ...env, ...responseEnvironment }),
    extendEnv: false,
    stderr: 'pipe',
    stdin: retrySession?.input,
    stdout: 'pipe',
  });
  if (privateReply === true) {
    yield* Stream.runDrain(child.stdout).pipe(Effect.forkScoped);
  }
  if (privateReply === false) {
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((value) =>
        // Worker/owner stdout contains only non-secret machine messages; Shell uses its private socket.
        value.startsWith('{')
          ? (retrySession === undefined
              ? Deferred.succeed(line, value)
              : Queue.offer(retrySession.replies, value)
            ).pipe(Effect.asVoid)
          : Effect.void,
      ),
      Effect.ensuring(
        retrySession === undefined
          ? Effect.void
          : Queue.fail(retrySession.replies, failure('The bounded worker session ended before its next result')),
      ),
      Effect.forkScoped,
    );
  }
  yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
  const response = retrySession === undefined ? Deferred.await(line) : Queue.take(retrySession.replies);
  // Shell is a persistent server. One-cycle workers may legitimately exit while their stdout is draining.
  const readiness = privateReply === true ? awaitChildReadiness(response, child.exitCode) : response;
  return {
    child,
    line: yield* readiness,
  };
});

const fixtureAuthorityLifetime = Context.Reference<'ordinary' | 'short'>('PrivacyCompletionTest.AuthorityLifetime', {
  defaultValue: () => 'ordinary',
});
interface AdditionalLegalEntityFixtureConfiguration {
  readonly additionalLegalEntity?: 'same-tenant';
}
const fixtureAdditionalLegalEntitySchema = Schema.Literals(['none', 'same-tenant']);
const fixtureAdditionalLegalEntity = Context.Reference<typeof fixtureAdditionalLegalEntitySchema.Type>(
  'PrivacyCompletionTest.AdditionalLegalEntity',
  {
    defaultValue: () => 'none',
  },
);
// One native-suite scope owns immutable bundles/descriptions only. Every database, identity,
// snapshot, server, credential and business effect remains in the individual test scope.
// This Layer is built by the native group's beforeAll and released after its child scopes close.
const prepareArtifacts = Effect.gen(function* prepareNativeArtifacts() {
  yield* Effect.logInfo('Privacy fixture artifacts: initialize');
  const crypto = yield* Crypto.Crypto;
  const suffix = yield* crypto.randomUUIDv4();
  const fs = yield* FileSystem.FileSystem;
  const roots = {
    party: `${appRoot}verticals/party-registry/node_modules/.cache/ontos-1258/${suffix}`,
    privacy: `${appRoot}verticals/privacy/node_modules/.cache/ontos-1258/${suffix}`,
    shell: `${appRoot}apps/shell-super-app/node_modules/.cache/ontos-1258/${suffix}`,
  };
  for (const root of Object.values(roots)) {
    yield* fs.makeDirectory(root, { recursive: true });
    yield* fs.chmod(root, 0o700);
    yield* Effect.addFinalizer(() => fs.remove(root, { force: true, recursive: true }).pipe(Effect.orDie));
  }
  const paths = {
    party: `${roots.party}/party.mjs`,
    privacy: `${roots.privacy}/privacy.mjs`,
    shell: `${roots.shell}/shell.mjs`,
    worker: `${roots.party}/worker.mjs`,
  };
  const entries = [
    { output: paths.shell, source: 'apps/shell-super-app/tests/support/privacy-completion-shell.ts' },
    { output: paths.privacy, source: 'verticals/privacy/tests/support/privacy-completion-http.ts' },
    { output: paths.party, source: 'verticals/party-registry/tests/support/tenant-party-http.ts' },
    { output: paths.worker, source: 'verticals/party-registry/tests/support/privacy-completion-worker.ts' },
  ];
  yield* Effect.forEach(
    entries,
    (entry) =>
      command([
        'exec',
        'esbuild',
        entry.source,
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--packages=external',
        `--outfile=${entry.output}`,
      ]),
    { concurrency: 4 },
  );
  yield* Effect.logInfo('Privacy fixture artifacts: builds done');
  const [shellDescription, privacyMarker, party] = yield* Effect.all(
    [
      describe(paths.shell).pipe(
        Effect.flatMap((line) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(shellDescriptionSchema))(line).pipe(
            Effect.mapError(() => failure('Invalid Shell marker')),
          ),
        ),
      ),
      describe(paths.privacy).pipe(
        Effect.flatMap((line) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(markerSchema))(line).pipe(
            Effect.mapError(() => failure('Invalid Privacy marker')),
          ),
        ),
      ),
      describe(paths.worker).pipe(
        Effect.flatMap((line) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(partyDescriptionSchema))(line).pipe(
            Effect.mapError(() => failure('Invalid Party worker description')),
          ),
        ),
      ),
    ],
    { concurrency: 3 },
  );
  yield* Effect.logInfo('Privacy fixture artifacts: descriptions done');
  return Object.freeze({ party, paths: Object.freeze(paths), privacyMarker, shellDescription });
});
const PreparedArtifacts = Context.Service<Effect.Success<typeof prepareArtifacts>>(
  'PrivacyCompletionTest/PreparedArtifacts',
);
const nativeFixtureServices = Layer.effect(PreparedArtifacts, prepareArtifacts).pipe(Layer.provideMerge(services));

// One observation of owned native lock state; the live test body owns polling and its real-clock bound.
const observeNativeLock = (pool: Pool, query: string) =>
  Effect.tryPromise({
    catch: () => failure('The owned native lock observation failed'),
    try: () => pool.query<{ waiting: boolean }>(query),
  }).pipe(Effect.map((result) => result.rows[0]?.waiting ?? false));

// Test-only scheduling seam AFTER the real native quiescence query, not a fabricated
// quiescence result. The publisher and Privacy lease still execute their production SQL.
const runObservedOperatorPublication = Effect.fn('PrivacyCompletionTest.nativeOperatorPublication')(
  function* runObservedOperatorPublication(
    executor: Effect.Success<typeof testCoreDatabase>,
    connections: DatabaseConnectionPair,
    operatorConfiguration: Layer.Layer<never>,
    afterObservation: Effect.Effect<void, PrivacyCompletionTestFailure>,
    onLease: Effect.Effect<void>,
  ) {
    let interleaved = false;
    const execute = (...args: Parameters<typeof executor.execute>) => {
      const [query] = args;
      const text = Schema.is(Schema.String)(query) ? query : new PgDialect().sqlToQuery(query.getSQL()).sql;
      return executor.execute(...args).pipe(
        Effect.tap(() => {
          if (interleaved || !text.includes('from pg_stat_activity')) {
            return Effect.void;
          }
          interleaved = true;
          return afterObservation;
        }),
      );
    };
    // Inherit the real native executor (prototype and session); only execute is observed.
    const observed: typeof executor = Object.create(executor, { execute: { value: execute } });
    const owner: LegacyCompletionOwnerVerifier = {
      ...privacyLegacyCompletionOwner,
      withLease: (use) => privacyLegacyCompletionOwner.withLease((lease) => onLease.pipe(Effect.andThen(use(lease)))),
    };
    const conclusions: string[] = [];
    yield* runApplicationCompositionMigration(Effect.void, Effect.void).pipe(
      Effect.provideService(CoreDatabase, { executor: observed }),
      Effect.provideService(LegacyCompletionPublication, {
        owners: [owner],
        retainEvidence: (observation) =>
          Effect.sync(() => {
            conclusions.push(observation.status);
          }),
        runtimeTarget: {
          databaseName: connections.admin.database,
          host: connections.runtime.host,
          port: connections.runtime.port,
          user: connections.runtime.user,
        },
        runtimeUser: connections.runtime.user,
      }),
      Effect.provide(operatorConfiguration),
    );
    return { conclusions, interleaved };
  },
);

const fixture = Effect.gen(function* publicCompletionFixture() {
  yield* Effect.logInfo('Privacy fixture setup: initialize');
  const additionalLegalEntity = yield* fixtureAdditionalLegalEntity;
  const additionalLegalEntityConfiguration: AdditionalLegalEntityFixtureConfiguration = {};
  if (additionalLegalEntity === 'same-tenant') {
    Object.assign(additionalLegalEntityConfiguration, { additionalLegalEntity });
  }
  const crypto = yield* Crypto.Crypto;
  const suffix = yield* crypto.randomUUIDv4();
  const { party, paths, privacyMarker, shellDescription } = yield* PreparedArtifacts;
  yield* Effect.logInfo('Privacy fixture setup: immutable artifacts available');
  const base = yield* makeApplicationCompositionSnapshotFixture([privacyMarker.appId, party.marker.appId], suffix);
  const modules = yield* Effect.forEach(
    base.composition.modules,
    Effect.fn('PrivacyCompletionTest.module')(function* module(value) {
      const isParty = value.deployment.appId === party.marker.appId;
      const marker = isParty ? party.marker : privacyMarker;
      const moduleId = isParty ? 'party.registry' : 'privacy.core';
      const contract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)(
        makeModuleContractFixture({
          appId: marker.appId,
          buildMarker: marker.buildMarker,
          moduleId,
          outboxSubscriptions: isParty ? party.subscriptions : [],
        }),
      );
      const document = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(contract);
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
  const initialSnapshot = yield* validateActiveApplicationCompositionSnapshot({
    ...base,
    composition: {
      ...composition,
      revision: digest(canonicalizeApplicationComposition({ ...composition, revision: '0'.repeat(64) })),
    },
  });
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1258-privacy-drain',
  });
  yield* Effect.logInfo('Privacy fixture setup: owned database created');
  // Capture the actual creator result inside this private scope; no structural URL/executor API escapes.
  const adminAddress = new URL(isolated.connections.admin.connectionString);
  const runtimeAddress = new URL(isolated.connections.runtime.connectionString);
  const ownedName = isolated.connections.admin.database;
  const ownedAdmin = isolated.connections.admin.user;
  const ownedRuntime = isolated.connections.runtime.user;
  const endpoint = { database: ownedName, host: adminAddress.hostname, port: adminAddress.port || '5432' };
  if (
    !ownedName.startsWith('ontos_test_party_gateway_') ||
    ownedAdmin === ownedRuntime ||
    !/^[a-z_][a-z0-9_]*$/u.test(ownedRuntime) ||
    !addressIsOwned(adminAddress, { ...endpoint, user: ownedAdmin }) ||
    !addressIsOwned(runtimeAddress, { ...endpoint, user: ownedRuntime })
  ) {
    return yield* failure('The creator-bound fixture connection identity is invalid');
  }
  const bootstrapAdmin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: isolated.connections.admin.connectionString, max: 1 })),
    (value) => Effect.promise(() => value.end()),
  );
  const bootstrapRuntime = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: isolated.connections.runtime.connectionString, max: 1 })),
    (value) => Effect.promise(() => value.end()),
  );
  const verifyNativeIdentity = Effect.tryPromise({
    catch: () => failure('The creator-bound native identity is unavailable'),
    try: async () => {
      const query = `select current_database() as database, current_user as "currentUser",
        session_user as "sessionUser", rolsuper as superuser, rolbypassrls as bypass,
        rolcreaterole as "createRole", rolcreatedb as "createDb"
        from pg_roles where rolname=current_user`;
      const adminResult = await bootstrapAdmin.query(query);
      const runtimeResult = await bootstrapRuntime.query(query);
      const [admin] = adminResult.rows;
      const [runtime] = runtimeResult.rows;
      const decodedRuntime = Schema.decodeUnknownSync(
        Schema.Struct({
          bypass: Schema.Boolean,
          createDb: Schema.Boolean,
          createRole: Schema.Boolean,
          currentUser: Schema.String,
          database: Schema.String,
          sessionUser: Schema.String,
          superuser: Schema.Boolean,
        }),
      )(runtime);
      return (
        admin?.database === ownedName &&
        admin.currentUser === ownedAdmin &&
        admin.sessionUser === ownedAdmin &&
        identityIsRestricted(decodedRuntime, ownedName, ownedRuntime)
      );
    },
  }).pipe(
    Effect.flatMap((valid) => (valid ? Effect.void : Effect.fail(failure('Native fixture identity was refused')))),
  );
  yield* verifyNativeIdentity;
  yield* isolated.migrateCoreSchema();
  yield* Effect.logInfo('Privacy fixture setup: Core migrated');
  const databaseEnv = {
    DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
    DATABASE_URL: isolated.connections.runtime.connectionString,
  };
  for (const owner of ['@app/shell-super-app', '@app/party-registry', '@app/privacy']) {
    yield* command(['--filter', owner, 'db:migrate'], databaseEnv);
    if (owner === '@app/shell-super-app') {
      yield* Effect.logInfo('Privacy fixture setup: Shell migrated');
    } else if (owner === '@app/party-registry') {
      yield* Effect.logInfo('Privacy fixture setup: Party migrated');
    } else {
      yield* Effect.logInfo('Privacy fixture setup: Privacy migrated');
    }
  }
  yield* verifyNativeIdentity;
  // Fixed current objects only. Core owns its pre-existing separate migration/grant policy.
  yield* Effect.tryPromise({
    catch: () => failure('The fixed owned fixture privilege bootstrap was refused'),
    try: async () => {
      const inventory = fixtureRuntimeInventory;
      const role = `"${ownedRuntime}"`;
      const relations = await Promise.all(
        inventory.flatMap((item) =>
          item.tables.map(async (table) => {
            const relation = await bootstrapAdmin.query(
              `select c.relkind, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as owner
           from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname=$1 and c.relname=$2`,
              [item.schema, table],
            );
            const [row] = relation.rows;
            return (
              relation.rowCount === 1 &&
              row?.relkind === 'r' &&
              row.owner === ownedAdmin &&
              (!item.rls || (row.relrowsecurity === true && row.relforcerowsecurity === true))
            );
          }),
        ),
      );
      if (relations.some((valid) => !valid)) {
        return false;
      }
      // No IF NOT EXISTS: an existing object cannot establish this creator's TEST provenance.
      await bootstrapAdmin.query('create schema privacy_completion_test');
      await bootstrapAdmin.query(
        'create table privacy_completion_test.redemptions (issuer text not null, audience text not null, jti text not null, primary key (issuer,audience,jti))',
      );
      await Promise.all(
        inventory.flatMap((item) => [
          bootstrapAdmin.query(`grant usage on schema "${item.schema}" to ${role}`),
          ...item.tables.map((table) =>
            bootstrapAdmin.query(`grant ${item.operations} on "${item.schema}"."${table}" to ${role}`),
          ),
        ]),
      );
      await bootstrapAdmin.query(`grant usage on schema privacy_completion_test to ${role}`);
      await bootstrapAdmin.query(`grant select, insert on privacy_completion_test.redemptions to ${role}`);
      const protectedTables: readonly (readonly [string, readonly string[]])[] = [
        ...inventory.flatMap((item) =>
          item.tables.map((table) => [`${item.schema}.${table}`, item.operations.toUpperCase().split(', ')] as const),
        ),
        ['privacy_completion_test.redemptions', ['SELECT', 'INSERT']],
        ['core.application_composition_durable_work', ['SELECT']],
      ];
      const capabilities = await Promise.all(
        protectedTables.map(async ([table, allowed]) => {
          const operations = await Promise.all(
            ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'].map(async (operation) => {
              const result = await bootstrapRuntime.query('select has_table_privilege(current_user,$1,$2) as allowed', [
                table,
                operation,
              ]);
              const [row] = result.rows;
              const decoded = Schema.decodeUnknownSync(Schema.Struct({ allowed: Schema.Boolean }))(row);
              return [operation, decoded.allowed] as const;
            }),
          );
          return privilegesMatch(Object.fromEntries(operations), allowed);
        }),
      );
      if (capabilities.some((valid) => !valid)) {
        return false;
      }
      // Inspect effective inherited capabilities; refuse surplus rights rather than changing a role or ACL.
      const surplus = await bootstrapRuntime.query(
        `select
          exists (select 1 from unnest($1::text[]) as schemas(schema_name)
            where has_schema_privilege(current_user,schemas.schema_name,'CREATE')) as "schemaCreate",
          exists (select 1 from unnest($1::text[]) as schemas(schema_name)
            where has_schema_privilege(current_user,schemas.schema_name,'USAGE WITH GRANT OPTION')) as "schemaUsageGrant",
          exists (select 1 from unnest($2::text[]) as relations(relation_name)
            cross join unnest($3::text[]) as operations(operation_name)
            where has_table_privilege(current_user,relations.relation_name,
              operations.operation_name || ' WITH GRANT OPTION')) as "tableGrant"`,
        [
          ['core', 'auth', 'party', 'contacts', 'privacy', 'privacy_completion_test'],
          [
            ...new Set([
              ...protectedTables.map(([table]) => table),
              ...inventory.flatMap((item) => item.tables.map((table) => `${item.schema}.${table}`)),
            ]),
          ],
          ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
        ],
      );
      const [surplusFacts] = surplus.rows;
      const decodedSurplus = Schema.decodeUnknownSync(surplusCapabilitiesSchema)(surplusFacts);
      if (!surplusCapabilitiesAreAbsent(decodedSurplus)) {
        return false;
      }
      const capability = await bootstrapRuntime.query(`select
        has_database_privilege(current_user,current_database(),'CREATE') as "createDb",
        has_schema_privilege(current_user,'privacy_completion_test','CREATE') as "createSchema",
        has_function_privilege(current_user,'core.track_application_composition_durable_work(text,text,text,boolean)','EXECUTE') as tracker`);
      return (
        capability.rows[0]?.createDb === false &&
        capability.rows[0]?.createSchema === false &&
        capability.rows[0]?.tracker === false
      );
    },
  }).pipe(
    Effect.flatMap((valid) =>
      valid ? Effect.void : Effect.fail(failure('Effective fixture privileges were refused')),
    ),
  );
  const authorityLifetime = yield* fixtureAuthorityLifetime;
  const fresh =
    authorityLifetime === 'short'
      ? yield* makeApplicationCompositionSnapshotFixture([], `${suffix}-freshness`)
      : initialSnapshot;
  const snapshot =
    authorityLifetime === 'short'
      ? yield* validateActiveApplicationCompositionSnapshot({
          ...initialSnapshot,
          observedAt: fresh.observedAt,
          validUntil: DateTime.add(fresh.observedAt, { seconds: 21 }),
        })
      : initialSnapshot;
  yield* isolated.publishInitialComposition(snapshot);
  yield* Effect.logInfo('Privacy fixture setup: publication done');
  const snapshotJson = yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
    snapshot,
  );
  const compositionContext = yield* Layer.build(NodeHttpServer.layerTest);
  const source = Context.get(compositionContext, HttpServer.HttpServer);
  yield* source.serve(Effect.succeed(HttpServerResponse.text(snapshotJson, { contentType: 'application/json' })));
  const { address } = source;
  if (!Schema.is(Schema.Struct({ port: Schema.Number }))(address)) {
    return yield* failure('A loopback composition source is required');
  }
  const pair = yield* Effect.tryPromise(() => generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }));
  const privateJwk = yield* Effect.tryPromise(() => exportJWK(pair.privateKey));
  const publicJwk = yield* Effect.tryPromise(() => exportJWK(pair.publicKey));
  const kid = `privacy-${suffix}`;
  const identityCapability = yield* Effect.tryPromise({
    catch: () => failure('Native fixture physical identity was unavailable'),
    try: async () => {
      const result = await bootstrapAdmin.query(
        `select current_database() as "databaseName",d.oid::text as "databaseOid",(pg_control_system()).system_identifier::text as "systemIdentifier" from pg_database d where d.datname=current_database()`,
      );
      return Schema.decodeUnknownSync(
        Schema.Struct({ databaseName: Schema.String, databaseOid: Schema.String, systemIdentifier: Schema.String }),
      )(result.rows[0]);
    },
  });
  const nativeIdentityUrls = yield* prepareNativeIdentities(isolated.connections, identityCapability);
  yield* Effect.logInfo('Privacy fixture setup: identity setup done');
  const environment = {
    BETTER_AUTH_SECRET: `privacy-completion-${suffix}-${suffix}`,
    BETTER_AUTH_TRUSTED_ORIGINS: 'http://localhost:3020,http://127.0.0.1:3020',
    BETTER_AUTH_URL: 'http://localhost:3020',
    DATABASE_URL: isolated.connections.runtime.connectionString,
    ONTOS_1258_TEST_ADDITIONAL_LE: additionalLegalEntity,
    ONTOS_1258_TEST_COMPOSITION: snapshotJson,
    ONTOS_1258_TEST_DATABASE: ownedName,
    ONTOS_1258_TEST_REVISION: snapshot.composition.revision,
    ONTOS_1258_TEST_RUNTIME: ownedRuntime,
    ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `http://127.0.0.1:${address.port}/composition`,
    ONTOS_GATEWAY_ISSUER: 'https://privacy-completion.example.test',
    ONTOS_GATEWAY_PRIVATE_JWK: JSON.stringify({ ...privateJwk, alg: 'EdDSA', kid, use: 'sig' }),
    ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicJwk, alg: 'EdDSA', kid, use: 'sig' }] }),
  };
  const { ONTOS_GATEWAY_PRIVATE_JWK: _shellPrivateKey, ...receivingEnvironment } = environment;
  // Register before child acquisition: creator resources outlive the child and every socket connection.
  const bootstrapScope = yield* Scope.make();
  yield* Effect.addFinalizer((exit) => Scope.close(bootstrapScope, exit));
  const preparedHandoff = yield* Deferred.make<LiveOperationFixtureRuntimeHandoff>();
  const bootstrap = yield* makeLiveOperationFixtureBootstrap((providerSubjectId) =>
    Effect.acquireRelease(
      makeLiveOperationFixture({
        ...additionalLegalEntityConfiguration,
        actionKeys: [
          'core.identity.bind-self-api-key',
          'core.modules.change-tenant-module-state',
          'privacy.core.dispatch-privacy-measure',
          'privacy.core.record-owner-execution-outcome',
          'party.registry.execute-privacy-measure',
        ],
        adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
        allowedAudiences: ['party-registry', 'privacy'],
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        compositionRevision: snapshot.composition.revision,
        // The real module-state setup Action requires tenant manage_identity.
        managerIdentityAdmin: true,
        managerProviderSubjectId: providerSubjectId,
        moduleKeys: ['party.registry', 'privacy.core'],
        runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
      }),
      (value) => value.close().pipe(Effect.orDie),
    ).pipe(
      Scope.provide(bootstrapScope),
      Effect.tap((value) => Deferred.succeed(preparedHandoff, value.runtimeHandoff)),
      Effect.map((value) => value.runtimeHandoff),
    ),
  );
  const [shellProcess, partyProcess] = yield* Effect.all(
    [
      start(
        paths.shell,
        { ...environment, SHELL_GATEWAY_ISSUER_DATABASE_URL: nativeIdentityUrls.SHELL_GATEWAY_ISSUER_DATABASE_URL },
        true,
        undefined,
        bootstrap,
      ),
      start(paths.party, {
        ...receivingEnvironment,
        PARTY_REGISTRY_DATABASE_URL: nativeIdentityUrls.PARTY_REGISTRY_DATABASE_URL,
      }),
    ],
    { concurrency: 2 },
  );
  const shell = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(shellReadySchema))(shellProcess.line).pipe(
    Effect.mapError(() => failure('Shell fixture failed to start')),
  );
  const { apiKey } = shell;
  const { secondaryLegalEntityId } = yield* Deferred.await(preparedHandoff);
  expect(shell.marker).toEqual(shellDescription.marker);
  expect(shell.principal.tenantId).toBe(shell.tenantId);
  expect(shell.principal.legalEntityId).toBe(shell.legalEntityId);
  const shellUrl = `http://127.0.0.1:${shell.port}`;

  const partyReady = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(readySchema))(partyProcess.line).pipe(
    Effect.mapError(() => failure('Party fixture failed to start')),
  );
  expect(partyReady.marker).toEqual(party.marker);
  yield* Effect.logInfo('Privacy fixture setup: Shell and Party ready');
  const ownerEnvironment = {
    ...receivingEnvironment,
    ONTOS_PARTY_REGISTRY_API_BASE_URL: partyApiBaseUrl(partyReady.port),
    ONTOS_PRIVACY_MEASURE_WORKER_API_KEY: Redacted.value(apiKey),
    ONTOS_SHELL_GATEWAY_BASE_URL: shellUrl,
  };
  yield* Effect.logInfo('Privacy fixture setup: start Privacy');
  const privacyProcess = yield* start(paths.privacy, ownerEnvironment);
  const privacy = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(readySchema))(privacyProcess.line).pipe(
    Effect.mapError(() => failure('Privacy fixture failed to start')),
  );
  expect(privacy.marker).toEqual(privacyMarker);
  yield* Effect.logInfo('Privacy fixture setup: Privacy ready');
  const privacyUrl = `http://127.0.0.1:${privacy.port}`;
  const handoff = yield* Schema.decodeUnknownEffect(PrivacyMeasureHandoffSchema)({
    contentScopeRefs: ['party.registry.counterparty.lifecycle'],
    controllerObligationRef: 'TEST:obligation',
    dispositionDecision: 'RESTRICT',
    expectedEvidenceRefs: ['party.registry.counterparty.restricted'],
    idempotencyKey: suffix,
    kind: 'RESTRICT',
    measureId: `measure:${suffix}`,
    owningCapability: 'party.registry',
    preconditionRefs: ['TEST:decision'],
    requestedAt: '2026-01-01T00:00:00.000Z',
    requestedResult: 'RESTRICTED',
    resourceRefs: [`party.registry|party.registry.counterparty|${shell.legalEntityId}|${yield* crypto.randomUUIDv4()}`],
    right: null,
    sourceDecisionRef: `decision:${suffix}`,
    sourceDecisionRevision: 1,
    subjectRef: `subject:${suffix}`,
    taskId: `task:${suffix}`,
    tenantId: shell.tenantId,
  });
  const dispatch = Effect.fn('PrivacyCompletionTest.dispatch')(function* dispatch(
    idempotencyKey: string,
    input = handoff,
    preparedCredential?: { readonly token: string },
  ) {
    const credential =
      preparedCredential ??
      (yield* issueApiKeyGatewayContext(
        {
          audience: 'privacy',
          compositionRevision: snapshot.composition.revision,
          legalEntityId: shell.legalEntityId,
        },
        { apiKey, baseUrl: shellUrl, requestCorrelation: idempotencyKey },
      ));
    return yield* executeDispatchPrivacyMeasureWithAuthorization(
      { handoff: input },
      `Bearer ${credential.token}`,
      idempotencyKey,
      { baseUrl: privacyUrl, compositionRevision: snapshot.composition.revision, idempotencyKey },
    );
  });
  // Evidence stays in the creator-owned controller; child processes retain runtime credentials only.
  const coreEvidenceServices = yield* Layer.build(
    PgClient.layer({
      startupParameters: { idle_in_transaction_session_timeout: '30000ms', statement_timeout: '30000ms' },
      url: Redacted.make(isolated.connections.admin.connectionString),
    }).pipe(Layer.provideMerge(Reactivity.layer)),
  );
  const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(coreEvidenceServices));
  const evidence = Effect.fn('PrivacyCompletionTest.evidence')(function* evidence() {
    const where = { tenantId: shell.tenantId };
    const facts = yield* Effect.all(
      {
        events: coreEvidenceExecutor.query.domainEvents.findMany({ where }),
        invocations: coreEvidenceExecutor.query.actionInvocations.findMany({ where }),
        outbox: coreEvidenceExecutor.query.outboxMessages.findMany({ where }),
      },
      { concurrency: 3 },
    );
    return yield* Schema.decodeUnknownEffect(evidenceSchema)({
      events: facts.events.map((event) => ({
        id: event.domainEventId,
        invocationId: event.actionInvocationId,
      })),
      invocations: facts.invocations.map((invocation) => ({
        actionKey: invocation.actionKey,
        id: invocation.actionInvocationId,
        status: invocation.status,
      })),
      outbox: facts.outbox.map((message) => ({
        consumer: message.completionConsumerModuleKey,
        eventId: message.domainEventId,
        id: message.outboxMessageId,
        payload: message.payloadJson,
        revision: message.completionOriginalRevision,
        topic: message.topic,
      })),
    });
  });
  const token = (
    audience: 'party-registry' | 'privacy',
    revision = snapshot.composition.revision,
    legalEntityId = shell.legalEntityId,
  ) =>
    issueApiKeyGatewayContext(
      { audience, compositionRevision: revision, legalEntityId },
      { apiKey, baseUrl: shellUrl, requestCorrelation: suffix },
    );
  const receipt = () =>
    token('party-registry').pipe(
      Effect.flatMap((credential) =>
        executePrivacyMeasureExecutionWithAuthorization(
          { idempotencyKey: handoff.idempotencyKey },
          `Bearer ${credential.token}`,
          suffix,
          {
            baseUrl: ownerEnvironment.ONTOS_PARTY_REGISTRY_API_BASE_URL,
            compositionRevision: snapshot.composition.revision,
          },
        ),
      ),
    );
  const control = (owner: 'privacy' | 'shell', path: string) =>
    Effect.tryPromise({
      catch: () => failure('A closed TEST fixture control failed'),
      try: async () => {
        const response = await fetch(`${owner === 'privacy' ? privacyUrl : shellUrl}/__1258/${path}`, {
          method: 'POST',
        });
        return response.status;
      },
    });
  const worker = (
    options: {
      readonly advanceMs?: number;
      readonly barrier?: 'after-execute' | 'after-report';
      readonly revision?: string;
    } = {},
  ) =>
    start(paths.worker, {
      ...ownerEnvironment,
      ONTOS_1258_TEST_BARRIER: options.barrier ?? 'none',
      ONTOS_1258_TEST_CLOCK_ADVANCE_MS: String(options.advanceMs ?? 0),
      ONTOS_1258_TEST_REVISION: options.revision ?? snapshot.composition.revision,
      ONTOS_PRIVACY_API_BASE_URL: privacyUrl,
    });
  const cycle = (advanceMs = 0) =>
    Effect.gen(function* actualWorkerCycle() {
      const process = yield* worker({ advanceMs });
      const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(cycleSchema))(process.line).pipe(
        Effect.mapError(() => failure('Invalid real worker cycle response')),
      );
      expect(yield* process.child.exitCode).toBe(0);
      return { ...result.cycle, matched: result.matched };
    });
  // The retry proof uses one real worker lifetime, as the production polling loop does.
  // Process-loss/restart proofs continue to use the separate one-cycle driver above.
  const retrySession = Effect.gen(function* boundedRetrySession() {
    const advances = [0, 2000, 5000, 10_000, 19_000, 36_000, 69_000, 130_000, 200_000];
    const input = yield* Queue.make<string, Cause.Done>({ capacity: 1 });
    const replies = yield* Queue.make<string, PrivacyCompletionTestFailure>({ capacity: 1 });
    yield* Effect.addFinalizer(() => Queue.shutdown(input));
    yield* Effect.addFinalizer(() => Queue.shutdown(replies));
    const process = yield* start(
      paths.worker,
      {
        ...ownerEnvironment,
        ONTOS_1258_TEST_BARRIER: 'none',
        ONTOS_1258_TEST_CLOCK_ADVANCE_MS: '0',
        ONTOS_1258_TEST_RETRY_SESSION: 'dead-letter',
        ONTOS_1258_TEST_REVISION: snapshot.composition.revision,
        ONTOS_PRIVACY_API_BASE_URL: privacyUrl,
      },
      false,
      { input: Stream.fromQueue(input).pipe(Stream.encodeText), replies },
    );
    let index = 0;
    const invalidResponse = () => failure('Invalid real worker retry cycle response');
    return {
      cycle: (advanceMs: number) =>
        Effect.gen(function* nextBoundedRetryCycle() {
          if (index >= advances.length || advances[index] !== advanceMs) {
            return yield* failure('The bounded worker retry sequence was contradicted');
          }
          let { line } = process;
          if (index > 0) {
            yield* Queue.offer(input, '{"type":"continue"}\n');
            line = yield* Queue.take(replies);
          }
          const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(cycleSchema))(line).pipe(
            Effect.mapError(invalidResponse),
          );
          index += 1;
          return result.cycle;
        }),
      finish: Effect.gen(function* finishBoundedRetrySession() {
        if (index !== advances.length) {
          return yield* failure('The bounded worker retry sequence is incomplete');
        }
        yield* Queue.end(input);
        expect(yield* process.child.exitCode).toBe(0);
        return yield* Effect.void;
      }),
    };
  });
  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: isolated.connections.runtime.connectionString, max: 1 })),
    (value) => Effect.promise(() => value.end()),
  );
  // Privacy-owned evidence only, under the same verified runtime identity and RLS scope.
  const storedHandoffs = () =>
    Effect.tryPromise({
      catch: () => failure('Scoped persisted Privacy handoffs are unavailable'),
      try: async () => {
        const client = await pool.connect();
        try {
          await client.query('begin');
          await client.query(
            "select set_config('ontos.tenant_id',$1,true),set_config('ontos.legal_entity_id',$2,true)",
            [shell.tenantId, shell.legalEntityId],
          );
          const rows = await client.query<{ handoff: unknown }>(
            'select handoff_record as handoff from privacy.privacy_measure_dispatches where tenant_id=$1 and legal_entity_id=$2 order by measure_id',
            [shell.tenantId, shell.legalEntityId],
          );
          const handoffs = Schema.decodeUnknownSync(Schema.Array(PrivacyMeasureHandoffSchema))(
            rows.rows.map((row) => row.handoff),
          );
          await client.query('commit');
          return handoffs;
        } finally {
          await client.query('rollback');
          client.release();
        }
      },
    });
  const ownerCount = () =>
    Effect.tryPromise({
      catch: () => failure('Scoped Privacy dispatch evidence is unavailable'),
      try: async () => {
        const client = await pool.connect();
        try {
          await client.query('begin');
          await client.query(
            "select set_config('ontos.tenant_id',$1,true),set_config('ontos.legal_entity_id',$2,true)",
            [shell.tenantId, shell.legalEntityId],
          );
          const count = await client.query<{ count: string }>(
            'select count(*)::text as count from privacy.privacy_measure_dispatches where tenant_id=$1 and legal_entity_id=$2',
            [shell.tenantId, shell.legalEntityId],
          );
          await client.query('commit');
          return count.rows[0]?.count;
        } finally {
          await client.query('rollback');
          client.release();
        }
      },
    });
  const outcomes = (legalEntityId = shell.legalEntityId) =>
    Effect.tryPromise({
      catch: () => failure('Scoped Privacy outcome evidence is unavailable'),
      try: async () => {
        const client = await pool.connect();
        try {
          await client.query('begin');
          await client.query(
            "select set_config('ontos.tenant_id',$1,true),set_config('ontos.legal_entity_id',$2,true)",
            [shell.tenantId, legalEntityId],
          );
          const rows = await client.query<{ outcome_record: unknown }>(
            'select outcome_record from privacy.owner_execution_outcomes where tenant_id=$1 and legal_entity_id=$2 and measure_id=$3 order by attempt',
            [shell.tenantId, legalEntityId, handoff.measureId],
          );
          await client.query('commit');
          return rows.rows.map((row) => row.outcome_record);
        } finally {
          await client.query('rollback');
          client.release();
        }
      },
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OwnerExecutionOutcomeSchema))));
  const operatorConfiguration = Layer.succeed(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown({
      DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
      DATABASE_URL: isolated.connections.runtime.connectionString,
    }),
  );

  return {
    control,
    cycle,
    dispatch,
    evidence,
    handoff,
    isolated,
    legalEntityId: shell.legalEntityId,
    operatorConfiguration,
    outcomes,
    ownerCount,
    partyUrl: ownerEnvironment.ONTOS_PARTY_REGISTRY_API_BASE_URL,
    privacyUrl,
    publishWithConcurrentWriter: (
      afterObservation: Effect.Effect<void, PrivacyCompletionTestFailure>,
      onLease: Effect.Effect<void>,
    ) =>
      runObservedOperatorPublication(
        coreEvidenceExecutor,
        isolated.connections,
        operatorConfiguration,
        afterObservation,
        onLease,
      ),
    receipt,
    retrySession,
    revision: snapshot.composition.revision,
    secondaryLegalEntityId,
    snapshot,
    storedHandoffs,
    suffix,
    token,
    worker,
  };
});

it.effect('accepts only the closed additional Legal Entity fixture option', () =>
  Effect.sync(() => {
    expect(Schema.is(fixtureAdditionalLegalEntitySchema)('none')).toBe(true);
    expect(Schema.is(fixtureAdditionalLegalEntitySchema)('same-tenant')).toBe(true);
    for (const invalid of ['foreign-tenant', 'any', '', true, undefined]) {
      expect(Schema.is(fixtureAdditionalLegalEntitySchema)(invalid)).toBe(false);
    }
  }),
);

it.effect('refuses foreign connection and elevated native identities before owned setup', () =>
  Effect.sync(() => {
    const expected = {
      database: 'ontos_test_party_gateway_test',
      host: 'localhost',
      port: '5433',
      user: 'ontos_runtime',
    };
    const valid = new URL('postgresql://ontos_runtime:test@localhost:5433/ontos_test_party_gateway_test');
    expect(addressIsOwned(valid, expected)).toBe(true);
    for (const replacement of [
      'http://ontos_runtime:test@localhost:5433/ontos_test_party_gateway_test',
      'postgresql://ontos_runtime:test@127.0.0.1:5433/ontos_test_party_gateway_test',
      'postgresql://ontos_runtime:test@localhost:5434/ontos_test_party_gateway_test',
      'postgresql://ontos_runtime:test@localhost:5433/foreign',
      'postgresql://ontos_admin:test@localhost:5433/ontos_test_party_gateway_test',
      `${valid}?options=-crole%3Dontos_admin`,
      `${valid}#route`,
    ]) {
      expect(addressIsOwned(new URL(replacement), expected)).toBe(false);
    }
    const row = {
      bypass: false,
      createDb: false,
      createRole: false,
      currentUser: expected.user,
      database: expected.database,
      sessionUser: expected.user,
      superuser: false,
    };
    expect(identityIsRestricted(row, expected.database, expected.user)).toBe(true);
    for (const flag of ['superuser', 'bypass', 'createRole', 'createDb'] as const) {
      expect(identityIsRestricted({ ...row, [flag]: true }, expected.database, expected.user)).toBe(false);
    }
    for (const key of ['database', 'currentUser', 'sessionUser'] as const) {
      expect(identityIsRestricted({ ...row, [key]: 'foreign' }, expected.database, expected.user)).toBe(false);
    }
    expect(privilegesMatch({ DELETE: false, INSERT: true, SELECT: true }, ['SELECT', 'INSERT'])).toBe(true);
    expect(privilegesMatch({ DELETE: true, INSERT: true, SELECT: true }, ['SELECT', 'INSERT'])).toBe(false);
    expect(privilegesMatch({ DELETE: false, INSERT: false, SELECT: true }, ['SELECT', 'INSERT'])).toBe(false);
    expect(privilegesMatch({ DELETE: false }, ['SELECT', 'INSERT'])).toBe(false);
    expect(descriptionOptions('/test')).toEqual({ env: { PATH: '/test' }, extendEnv: false });
    const noSurplus = { schemaCreate: false, schemaUsageGrant: false, tableGrant: false };
    expect(surplusCapabilitiesAreAbsent(noSurplus)).toBe(true);
    for (const capability of ['schemaCreate', 'schemaUsageGrant', 'tableGrant'] as const) {
      expect(surplusCapabilitiesAreAbsent({ ...noSurplus, [capability]: true })).toBe(false);
      expect(Schema.is(surplusCapabilitiesSchema)({ ...noSurplus, [capability]: null })).toBe(false);
      expect(Schema.is(surplusCapabilitiesSchema)({ ...noSurplus, [capability]: 'false' })).toBe(false);
      const missing = Object.fromEntries(Object.entries(noSurplus).filter(([key]) => key !== capability));
      expect(Schema.is(surplusCapabilitiesSchema)(missing)).toBe(false);
    }
    expect(Schema.is(surplusCapabilitiesSchema)({})).toBe(false);
    expect(Schema.is(surplusCapabilitiesSchema)(null)).toBe(false);
    expect(
      childEnvironment(
        {
          PATH: '/test',
          SPICEDB_CA_CERT: 'TEST',
          SPICEDB_ENDPOINT: 'localhost:50051',
          SPICEDB_PRESHARED_KEY: Redacted.make('TEST'),
        },
        { DATABASE_URL: 'owned-runtime' },
      ),
    ).not.toHaveProperty('DATABASE_ADMIN_URL');
  }),
);

it.layer(services, { excludeTestServices: true })('owned bootstrap source contract', (suite) => {
  suite.effect('matches closed fixture privileges to current owner inventories and immutable ledgers', () =>
    Effect.gen(function* fixtureBootstrapContract() {
      const fs = yield* FileSystem.FileSystem;
      const sources = [
        ['party', 'verticals/party-registry/src/db/schema.ts', 'PARTY_TABLE_INVENTORY'],
        ['contacts', 'verticals/party-registry/src/db/engagement-schema.ts', 'CONTACTS_TABLE_INVENTORY'],
        ['privacy', 'verticals/privacy/src/database/schema.ts', 'PRIVACY_TABLE_INVENTORY'],
      ] as const;
      for (const [schema, path, declaration] of sources) {
        const source = yield* fs.readFileString(`${appRoot}${path}`);
        const body = source.split(`const ${declaration} = [`)[1]?.split('] as const;')[0];
        expect(body).toBeDefined();
        const expected = EffectArray.sort(
          Array.from((body ?? '').matchAll(/'(?<table>[^']+)'/gu), (match) => match[1]),
          Order.String,
        );
        const actual = fixtureRuntimeInventory
          .filter((item) => item.schema === schema)
          .flatMap((item) => [...item.tables]);
        expect(EffectArray.sort(actual, Order.String)).toEqual(expected);
        expect(new Set(actual).size).toBe(actual.length);
      }
      const verifier = yield* fs.readFileString(`${appRoot}verticals/privacy/scripts/verify-db-schema.mts`);
      const immutableBody = verifier.split('const IMMUTABLE_TABLES = [')[1]?.split('] as const;')[0];
      expect(immutableBody).toBeDefined();
      const immutable = EffectArray.sort(
        Array.from((immutableBody ?? '').matchAll(/'(?<table>[^']+)'/gu), (match) => match[1]),
        Order.String,
      );
      expect(
        EffectArray.sort(
          fixtureRuntimeInventory
            .filter((item) => item.schema === 'privacy' && item.operations === 'select, insert')
            .flatMap((item) => [...item.tables]),
          Order.String,
        ),
      ).toEqual(immutable);
      for (const item of fixtureRuntimeInventory) {
        if (item.schema === 'party' || (item.schema === 'contacts' && item.rls)) {
          expect(item.operations).toBe('select, insert, update, delete');
          expect(item.rls).toBe(true);
        }
      }
      expect(
        fixtureRuntimeInventory.find((item) => item.schema === 'auth' && item.operations === 'select')?.tables,
      ).toEqual(['support_impersonation_recovery']);
    }),
  );
});

it.effect('targets the mounted public Party receipt route and decodes an absent receipt', () =>
  Effect.gen(function* publicPartyReceiptRoute() {
    const requests: { body: string; method: string; url: string }[] = [];
    const fakeFetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      return request.text().then((body) => {
        requests.push({ body, method: request.method, url: request.url });
        return new Response('null', { headers: { 'content-type': 'application/json' }, status: 200 });
      });
    };
    const receipt = yield* executePrivacyMeasureExecutionWithAuthorization(
      { idempotencyKey: 'TEST:setup-route' },
      'Bearer TEST:route-control',
      'TEST:route-correlation',
      { baseUrl: partyApiBaseUrl(43_210), compositionRevision: 'a'.repeat(64) },
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
    expect(requests).toEqual([
      {
        body: JSON.stringify({ idempotencyKey: 'TEST:setup-route' }),
        method: 'POST',
        url: 'http://127.0.0.1:43210/party-registry-api/reads/privacy-measure-execution',
      },
    ]);
    expect(Option.isNone(receipt)).toBe(true);
  }),
);

it.effect('counts only the declared dispatch transaction failure and rejects unrelated refusal categories', () =>
  Effect.sync(() => {
    const transaction = DispatchPrivacyMeasureActionUnavailableProblemSchema.make({
      code: 'action_transaction_failed',
      detail: 'The Action capability is temporarily unavailable.',
      retryable: true,
      status: 503,
      title: 'Action unavailable',
      type: 'https://ontos.dev/problems/action-unavailable',
    });
    expect(isDispatchTransactionRefusal(transaction)).toBe(true);
    for (const code of [
      'action_permission_check_failed',
      'operation_context_unavailable',
      'privacy_operation_persistence_unavailable',
    ] as const) {
      expect(isDispatchTransactionRefusal({ ...transaction, code })).toBe(false);
    }
    expect(
      isDispatchTransactionRefusal(
        DispatchPrivacyMeasureActionAuthenticationProblemSchema.make({
          detail: 'A valid audience-scoped Bearer assertion is required.',
          status: 401,
          title: 'Authentication required',
          type: 'https://ontos.dev/problems/operation-authentication-required',
        }),
      ),
    ).toBe(false);
    expect(
      isDispatchTransactionRefusal(
        DispatchPrivacyMeasureActionForbiddenProblemSchema.make({
          code: 'action_permission_denied',
          detail: 'The principal is not permitted to perform this Action.',
          status: 403,
          title: 'Action forbidden',
          type: 'https://ontos.dev/problems/action-forbidden',
        }),
      ),
    ).toBe(false);
    expect(isDispatchTransactionRefusal(new TypeError('TEST transport failed'))).toBe(false);
    expect(isDispatchTransactionRefusal(null)).toBe(false);
  }),
);

it.effect('requires the current closed Shell readiness protocol and redacts its credential on decode', () =>
  Effect.gen(function* shellReadinessProtocol() {
    const marker = { appId: 'shell-super-app', buildMarker: 'TEST:current-shell' };
    const description = {
      marker,
      protocolVersion: 2,
      responseSocketEnvironment: 'ONTOS_1258_TEST_RESPONSE_SOCKET',
      responseTransport: 'private-unix-socket',
    };
    yield* Schema.decodeUnknownEffect(shellDescriptionSchema)(description);
    for (const changed of [
      marker,
      { ...description, protocolVersion: 1 },
      { ...description, responseTransport: 'fd3' },
      { ...description, responseSocketEnvironment: 'UNRECOGNIZED_SOCKET' },
    ]) {
      expect(Result.isFailure(yield* Effect.result(Schema.decodeUnknownEffect(shellDescriptionSchema)(changed)))).toBe(
        true,
      );
    }
    const principal = {
      authBindingId: '10000000-0000-4000-8000-000000000001',
      authContextRef: 'better-auth-session:TEST',
      authMethod: 'session',
      legalEntityId: '20000000-0000-4000-8000-000000000002',
      principalId: '30000000-0000-4000-8000-000000000003',
      tenantId: '40000000-0000-4000-8000-000000000004',
    };
    const ready = {
      apiKey: 'TEST:private-parent-credential',
      legalEntityId: principal.legalEntityId,
      marker,
      port: 3020,
      principal,
      protocolVersion: 2,
      responseTransport: 'private-unix-socket',
      tenantId: principal.tenantId,
      type: 'ready',
    };
    const decoded = yield* Schema.decodeUnknownEffect(shellReadySchema)(ready);
    expect(Redacted.isRedacted(decoded.apiKey)).toBe(true);
    expect(decoded.principal.tenantId).toBe(decoded.tenantId);
    expect(decoded.principal.legalEntityId).toBe(decoded.legalEntityId);
    for (const changed of [
      { ...ready, apiKey: '' },
      Object.fromEntries(Object.entries(ready).filter(([key]) => key !== 'legalEntityId')),
      { ...ready, principal: null },
      { ...ready, protocolVersion: 1 },
      { ...ready, responseTransport: 'fd3' },
      { ...ready, port: 0 },
      { ...ready, port: 65_536 },
    ]) {
      expect(Result.isFailure(yield* Effect.result(Schema.decodeUnknownEffect(shellReadySchema)(changed)))).toBe(true);
    }
  }),
);

it.effect('preserves healthy readiness and protocol refusal while observing child exit', () =>
  Effect.gen(function* healthyStartupRace() {
    expect(yield* awaitChildReadiness(Effect.succeed('TEST:private-ready'), Effect.never)).toBe('TEST:private-ready');
    const refused = failure('Private Shell readiness must contain exactly one message');
    expect(yield* Effect.result(awaitChildReadiness(Effect.fail(refused), Effect.never))).toEqual(Result.fail(refused));
  }),
);

it.effect('fails readiness immediately on child exit without exposing child failure details', () =>
  Effect.gen(function* failedStartupRace() {
    for (const childExit of [Effect.succeed(0), Effect.succeed(1), Effect.fail('TEST:secret-child-diagnostic')]) {
      const result = yield* Effect.result(awaitChildReadiness(Effect.never, childExit));
      expect(result).toEqual(Result.fail(failure('A fixture child exited before its readiness response')));
    }
  }),
);

it.layer(services, { excludeTestServices: true })('Privacy private readiness transport', (suite) => {
  for (const valid of [true, false]) {
    suite.effect(`receives private Shell readiness with a connection-owned Scope: valid=${valid}`, () =>
      Effect.gen(function* scopedPrivateReadiness() {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const socketPath = `${directory}/response.sock`;
        const response = yield* Deferred.make<string, PrivacyCompletionTestFailure>();
        const server = yield* NodeSocketServer.make({ path: socketPath });
        yield* server.run((socket) => receivePrivateShellResponse(socket, response)).pipe(Effect.forkScoped);
        yield* Effect.scoped(
          Effect.gen(function* writePrivateReadiness() {
            const socket = yield* NodeSocket.makeNet({ path: socketPath });
            yield* socket.reader;
            const writer = yield* socket.writer;
            yield* writer.write(valid ? '{"type":"ready"}\n' : '{"type":"ready"}\n{"type":"ready"}\n');
          }),
        );
        const result = yield* Effect.result(Deferred.await(response));
        if (valid) {
          expect(result).toEqual(Result.succeed('{"type":"ready"}'));
        } else {
          expect(result).toMatchObject({ failure: { _tag: 'PrivacyCompletionTestFailure' } });
        }
      }),
    );
  }
});

const pending = (f: Effect.Success<typeof fixture>) =>
  Effect.gen(function* retainedDebt() {
    const state = yield* f.isolated.composition.observe();
    expect(state.phase).toBe('active');
    expect(state.durableWorkAdmission).toBe('closed');
    expect(state.hasMoreDurableWork).toBe(false);
    const messages = (yield* f.evidence()).outbox.filter((message) => message.topic === 'privacy.measure.dispatched');
    expect(messages).toHaveLength(1);
    const [message] = messages;
    if (message === undefined) {
      return yield* failure('The original dispatch message is absent');
    }
    expect(state.pendingDurableWork).toEqual([
      {
        originalRevision: f.revision,
        ownerModuleKey: 'privacy.core',
        workId: `outbox:${message.id}:party.registry`,
      },
    ]);
    expect(Result.isFailure(yield* Effect.result(f.isolated.composition.drain()))).toBe(true);
    return yield* Effect.void;
  });
const coreDebtSettled = (f: Effect.Success<typeof fixture>) =>
  Effect.gen(function* actualRejectedOwnerEvidenceAndCoreAck() {
    const receipt = yield* f.receipt();
    expect(Option.isSome(receipt)).toBe(true);
    if (Option.isNone(receipt)) {
      return yield* failure('The actual terminal Party receipt is absent');
    }
    expect(receipt.value.outcome.status).toBe('BUSINESS_REJECTED');
    expect(receipt.value.outcome.includedResourceRefs).toEqual([]);
    expect(receipt.value.outcome.remainingResourceRefs).toEqual(f.handoff.resourceRefs);
    expect(receipt.value.outcome.measureId).toBe(f.handoff.measureId);
    expect(receipt.value.outcome.idempotencyKey).toBe(f.handoff.idempotencyKey);
    expect(yield* f.outcomes()).toEqual([receipt.value.outcome]);
    const evidence = yield* f.evidence();
    expect(
      evidence.invocations.filter(
        (row) => row.actionKey === 'party.registry.execute-privacy-measure' && row.status === 'succeeded',
      ),
    ).toHaveLength(1);
    expect(
      evidence.invocations.filter(
        (row) => row.actionKey === 'privacy.core.record-owner-execution-outcome' && row.status === 'succeeded',
      ),
    ).toHaveLength(1);
    const state = yield* f.isolated.composition.observe();
    expect(state.revision).toBe(f.revision);
    expect(state.phase).toBe('active');
    expect(state.durableWorkAdmission).toBe('closed');
    expect(state.hasMoreDurableWork).toBe(false);
    expect(state.pendingDurableWork).toEqual([]);
    return receipt.value;
  });

it.layer(nativeFixtureServices, { excludeTestServices: true, timeout: '30 seconds' })(
  'Privacy message-bound completion admission',
  (suite) => {
    suite.effect(
      'atomically admits the actual public dispatch and preserves its exact debt through replay and admission closure',
      () =>
        Effect.gen(function* atomicProducer() {
          const f = yield* fixture;
          expect(yield* f.ownerCount()).toBe('0');
          const before = yield* f.evidence();
          const beforeState = yield* f.isolated.composition.observe();
          expect(beforeState.pendingDurableWork).toEqual([]);
          expect(yield* f.storedHandoffs()).toEqual([]);
          const unregistered = yield* Effect.result(
            f.dispatch(`${f.suffix}-unregistered`, {
              ...f.handoff,
              idempotencyKey: `${f.suffix}-unregistered`,
              measureId: `${f.handoff.measureId}-unregistered`,
              owningCapability: 'unregistered.owner',
            }),
          );
          expect(Result.isFailure(unregistered)).toBe(true);
          if (Result.isFailure(unregistered)) {
            expect(isDispatchTransactionRefusal(unregistered.failure)).toBe(true);
          }
          expect(yield* f.ownerCount()).toBe('0');
          const rolledBack = yield* f.evidence();
          expect(rolledBack.outbox).toEqual(before.outbox);
          expect(rolledBack.events).toEqual(before.events);
          expect(yield* f.storedHandoffs()).toEqual([]);
          expect((yield* f.isolated.composition.observe()).pendingDurableWork).toEqual(beforeState.pendingDurableWork);
          const accepted = yield* f.dispatch(f.suffix);
          expect(accepted).toEqual(f.handoff);
          expect(yield* f.storedHandoffs()).toEqual([f.handoff]);
          const evidence = yield* f.evidence();
          const dispatches = evidence.invocations.filter(
            (row) => row.actionKey === 'privacy.core.dispatch-privacy-measure' && row.status === 'succeeded',
          );
          expect(dispatches).toHaveLength(1);
          const messages = evidence.outbox.filter((message) => message.topic === 'privacy.measure.dispatched');
          expect(messages).toHaveLength(1);
          const [message] = messages;
          if (message === undefined) {
            return yield* failure('The committed dispatch message is absent');
          }
          expect(Option.getOrUndefined(message.consumer)).toBe('party.registry');
          expect(Option.getOrUndefined(message.revision)).toBe((yield* f.isolated.composition.observe()).revision);
          expect(message.payload).toEqual({ handoff: f.handoff });
          expect(evidence.events.find((event) => event.id === message.eventId)?.invocationId).toBe(dispatches[0]?.id);
          const state = yield* f.isolated.composition.observe();
          expect(state.pendingDurableWork).toEqual([
            {
              originalRevision: state.revision,
              ownerModuleKey: 'privacy.core',
              workId: `outbox:${message.id}:party.registry`,
            },
          ]);
          expect(yield* f.ownerCount()).toBe('1');
          const replay = yield* Effect.result(f.dispatch(f.suffix));
          expect(Result.isFailure(replay)).toBe(true);
          if (Result.isFailure(replay)) {
            expect(Schema.is(DispatchPrivacyMeasureActionAlreadyCommittedProblemSchema)(replay.failure)).toBe(true);
            expect(replay.failure).toMatchObject({ code: 'action_already_committed' });
          }
          const replayEvidence = yield* f.evidence();
          expect(replayEvidence.outbox).toEqual(evidence.outbox);
          expect(replayEvidence.events).toEqual(evidence.events);
          expect(yield* f.storedHandoffs()).toEqual([f.handoff]);
          expect((yield* f.isolated.composition.observe()).pendingDurableWork).toEqual(state.pendingDurableWork);
          yield* f.isolated.composition.closeAdmission();
          expect(Result.isFailure(yield* Effect.result(f.isolated.composition.drain()))).toBe(true);
          const closed = yield* f.isolated.composition.observe();
          expect(closed.phase).toBe('active');
          expect(closed.durableWorkAdmission).toBe('closed');
          expect(closed.pendingDurableWork).toEqual(state.pendingDurableWork);
          const denied = yield* Effect.result(
            f.dispatch(`${f.suffix}-closed`, {
              ...f.handoff,
              idempotencyKey: `${f.suffix}-closed`,
              measureId: `${f.handoff.measureId}-closed`,
            }),
          );
          expect(Result.isFailure(denied)).toBe(true);
          if (Result.isFailure(denied)) {
            expect(isDispatchTransactionRefusal(denied.failure)).toBe(true);
          }
          expect(yield* f.ownerCount()).toBe('1');
          expect(yield* f.storedHandoffs()).toEqual([f.handoff]);
          expect((yield* f.evidence()).outbox).toEqual(evidence.outbox);
          expect((yield* f.isolated.composition.observe()).pendingDurableWork).toEqual(state.pendingDurableWork);
          return yield* Effect.void;
        }),
    );

    suite.effect('atomically deduplicates concurrent transport keys for the same immutable business handoff', () =>
      Effect.gen(function* concurrentBusinessAdmission() {
        const f = yield* fixture;
        const accepted = yield* Effect.all([f.dispatch(`${f.suffix}-first`), f.dispatch(`${f.suffix}-second`)], {
          concurrency: 2,
        });
        expect(accepted).toEqual([f.handoff, f.handoff]);
        expect(yield* f.storedHandoffs()).toEqual([f.handoff]);
        expect(yield* f.ownerCount()).toBe('1');
        const evidence = yield* f.evidence();
        expect(evidence.events).toHaveLength(1);
        expect(evidence.outbox.filter((message) => message.topic === 'privacy.measure.dispatched')).toHaveLength(1);
        yield* f.isolated.composition.closeAdmission();
        yield* pending(f);
      }),
    );

    suite.effect(
      'does not create additional message-derived debt when the immutable handoff is replayed with a distinct Action transport key',
      () =>
        Effect.gen(function* businessHandoffReplay() {
          const f = yield* fixture;
          expect(yield* f.dispatch(f.suffix)).toEqual(f.handoff);
          const before = yield* f.evidence();
          const state = yield* f.isolated.composition.observe();
          const replay = yield* Effect.result(f.dispatch(`${f.suffix}-transport-replay`));
          if (Result.isSuccess(replay)) {
            expect(replay.success).toEqual(f.handoff);
          } else {
            expect(Schema.is(DispatchPrivacyMeasureActionAlreadyCommittedProblemSchema)(replay.failure)).toBe(true);
          }
          const conflict = yield* Effect.result(
            f.dispatch(`${f.suffix}-business-conflict`, {
              ...f.handoff,
              sourceDecisionRevision: f.handoff.sourceDecisionRevision + 1,
            }),
          );
          expect(Result.isFailure(conflict)).toBe(true);
          if (Result.isFailure(conflict)) {
            const problem = Schema.decodeUnknownSync(DispatchPrivacyMeasureActionUnavailableProblemSchema)(
              conflict.failure,
            );
            expect(problem.code).toBe('privacy_operation_conflict');
          }
          expect(yield* f.storedHandoffs()).toEqual([f.handoff]);
          expect(yield* f.ownerCount()).toBe('1');
          const after = yield* f.evidence();
          expect(after.outbox).toEqual(before.outbox);
          expect(after.events).toEqual(before.events);
          expect((yield* f.isolated.composition.observe()).pendingDurableWork).toEqual(state.pendingDurableWork);
          yield* f.isolated.composition.closeAdmission();
          yield* pending(f);
        }),
      120_000,
    );

    suite.effect(
      'keyset-verifies 10,001 retained native owner successes and still blocks on a later unresolved dispatch',
      () =>
        Effect.gen(function* completeRetainedOwnerPopulation() {
          const f = yield* fixture;
          const pool = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new Pool({
                  connectionString: f.isolated.connections.admin.connectionString,
                  connectionTimeoutMillis: 5000,
                  max: 1,
                  statement_timeout: 10_000,
                }),
            ),
            (value) => Effect.promise(() => value.end()),
          );
          const messages: LegacyCompletionMessageEvidence[] = [];
          const encodeRows = Schema.encodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Array(
                Schema.Struct({
                  handoff: PrivacyMeasureHandoffSchema,
                  outcome: OwnerExecutionOutcomeSchema,
                }),
              ),
            ),
          );
          // Native immutable rows are synthetic settled-history fixtures, not a claim that the
          // TEST Party producer can emit SUCCEEDED. Core message interpretation is tested separately.
          for (let offset = 0; offset < 10_001; offset += 500) {
            const rows = Array.from({ length: Math.min(500, 10_001 - offset) }, (_, index) => {
              const measureId = `history-${String(offset + index).padStart(5, '0')}`;
              const handoff = { ...f.handoff, idempotencyKey: `${measureId}:attempt`, measureId };
              messages.push({
                completionConsumerModuleKey: handoff.owningCapability,
                completionOriginalRevision: f.revision,
                deliveries: [
                  {
                    consumerModuleKey: handoff.owningCapability,
                    status: 'done',
                    workerKey: 'party.registry.apply-privacy-measure',
                  },
                ],
                outboxMessageId: `message-${measureId}`,
                payloadJson: { handoff },
                tenantId: handoff.tenantId,
              });
              return {
                handoff,
                outcome: {
                  attempt: 1,
                  evidenceRefs: ['TEST:settled-history'],
                  idempotencyKey: handoff.idempotencyKey,
                  includedResourceRefs: handoff.resourceRefs,
                  measureId,
                  occurredAt: '2026-10-21T10:00:00Z',
                  outcomeId: `outcome-${measureId}`,
                  owningCapability: handoff.owningCapability,
                  reason: 'TEST exact retained success',
                  recordedAt: '2026-10-21T10:01:00Z',
                  remainingResourceRefs: [],
                  sourceDecisionRef: handoff.sourceDecisionRef,
                  sourceDecisionRevision: handoff.sourceDecisionRevision,
                  status: 'SUCCEEDED',
                  taskId: handoff.taskId,
                },
              };
            });
            const encoded = yield* encodeRows(rows);
            yield* Effect.tryPromise(async () => {
              await pool.query(
                `insert into privacy.privacy_measure_dispatches
              (measure_id, tenant_id, legal_entity_id, handoff_record, idempotency_key, status)
              select handoff->>'measureId', $2, $3, handoff, handoff->>'idempotencyKey', 'SUCCEEDED'
              from jsonb_to_recordset($1::jsonb) as evidence(handoff jsonb, outcome jsonb)`,
                [encoded, f.handoff.tenantId, f.legalEntityId],
              );
              await pool.query(
                `insert into privacy.owner_execution_outcomes
              (outcome_id, tenant_id, legal_entity_id, attempt, measure_id, outcome_record, status)
              select outcome->>'outcomeId', $2, $3, 1, handoff->>'measureId', outcome, 'SUCCEEDED'
              from jsonb_to_recordset($1::jsonb) as evidence(handoff jsonb, outcome jsonb)`,
                [encoded, f.handoff.tenantId, f.legalEntityId],
              );
            });
          }
          const assess = () =>
            privacyLegacyCompletionOwner
              .withLease((lease) =>
                lease.verify({
                  binding: { ...lease.binding, expectedRevision: Option.some(f.revision) },
                  complete: true,
                  evidenceReference: 'TEST:retained-owner-history',
                  messages,
                }),
              )
              .pipe(Effect.provide(f.operatorConfiguration));
          expect((yield* assess()).status).toBe('VERIFIED_ABSENT');
          // Append real unresolved debt after the settled pages; never erase or rewrite successes.
          const handoff = { ...f.handoff, idempotencyKey: 'history-unsettled', measureId: 'history-zz-unsettled' };
          const encodedHandoff = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(PrivacyMeasureHandoffSchema))(
            handoff,
          );
          yield* Effect.tryPromise(() =>
            pool.query(
              `insert into privacy.privacy_measure_dispatches
          (measure_id, tenant_id, legal_entity_id, handoff_record, idempotency_key, status)
          values ($1,$2,$3,$4::jsonb,$5,'RECEIVED')`,
              [handoff.measureId, handoff.tenantId, f.legalEntityId, encodedHandoff, handoff.idempotencyKey],
            ),
          );
          messages.push({
            completionConsumerModuleKey: handoff.owningCapability,
            completionOriginalRevision: f.revision,
            deliveries: [
              {
                consumerModuleKey: handoff.owningCapability,
                status: 'pending',
                workerKey: 'party.registry.apply-privacy-measure',
              },
            ],
            outboxMessageId: 'message-unsettled',
            payloadJson: { handoff },
            tenantId: handoff.tenantId,
          });
          expect((yield* assess()).status).toBe('UNRESOLVED');
          const retained = yield* Effect.tryPromise(() =>
            pool.query<{ dispatches: number; outcomes: number }>(`select
          (select count(*)::int from privacy.privacy_measure_dispatches) as dispatches,
          (select count(*)::int from privacy.owner_execution_outcomes) as outcomes`),
          );
          expect(retained.rows).toEqual([{ dispatches: 10_002, outcomes: 10_001 }]);
        }),
      120_000,
    );

    suite.effect(
      'finishes a real public Privacy writer admitted between native quiescence and the publisher authority lock without reversing lock order',
      () =>
        Effect.scoped(
          Effect.gen(function* publicWriterPublicationOrder() {
            const f = yield* fixture;
            const credential = yield* f.token('privacy');
            const pool = yield* Effect.acquireRelease(
              Effect.sync(
                () =>
                  new Pool({
                    connectionString: f.isolated.connections.admin.connectionString,
                    connectionTimeoutMillis: 5000,
                    idle_in_transaction_session_timeout: 10_000,
                    max: 3,
                    statement_timeout: 8000,
                  }),
              ),
              (value) => Effect.promise(() => value.end()),
            );
            const gate = yield* Effect.acquireRelease(
              Effect.tryPromise(async () => {
                const client = await pool.connect();
                try {
                  await client.query('begin');
                  await client.query('lock table privacy.privacy_measure_dispatches in share mode');
                  return client;
                } catch (error) {
                  client.release(true);
                  throw error;
                }
              }),
              (client) =>
                Effect.promise(async () => {
                  try {
                    await client.query('rollback');
                  } finally {
                    client.release();
                  }
                }),
            );
            // The publisher's seam only signals and parks; every real-clock bound and lock observation
            // stays in this live test body.
            // PostgreSQL/HTTP child processes use real clocks: virtual TestClock cannot release their locks.
            const waitForNativeLock = Effect.fn('PrivacyCompletionTest.waitForNativeLock')(function* waitForNativeLock(
              query: string,
            ) {
              while (!(yield* observeNativeLock(pool, query))) {
                yield* Effect.sleep('20 millis');
              }
            });
            const lockInterleavingReached = (query: string) =>
              waitForNativeLock(query).pipe(
                Effect.timeoutOrElse({
                  duration: '5 seconds',
                  orElse: () => Effect.fail(failure('The expected native lock interleaving was not reached')),
                }),
              );
            const observed = yield* Deferred.make<boolean>();
            const proceed = yield* Deferred.make<boolean>();
            let leases = 0;
            const dispatchResult = () => Effect.result(f.dispatch(f.suffix, f.handoff, credential));
            type Publication = ReturnType<typeof f.publishWithConcurrentWriter>;
            // Deferred.into preserves the publisher's failure, defect or interruption for the bounded await.
            const published = yield* Deferred.make<Effect.Success<Publication>, Effect.Error<Publication>>();
            yield* f
              .publishWithConcurrentWriter(
                Deferred.succeed(observed, true).pipe(Effect.andThen(Deferred.await(proceed))),
                Effect.sync(() => {
                  leases += 1;
                }),
              )
              .pipe(Deferred.into(published), Effect.forkChild);
            yield* Deferred.await(observed).pipe(Effect.timeout('40 seconds'));
            const writer = yield* Deferred.make<Effect.Success<ReturnType<typeof dispatchResult>>>();
            yield* dispatchResult().pipe(Deferred.into(writer), Effect.forkChild);
            yield* lockInterleavingReached(
              `select exists(
                select 1 from pg_locks writer join pg_locks authority using(pid)
                where writer.database=(select oid from pg_database where datname=current_database())
                  and writer.relation='privacy.privacy_measure_dispatches'::regclass
                  and writer.mode='RowExclusiveLock' and not writer.granted
                  and authority.locktype='advisory' and authority.mode='ShareLock' and authority.granted
              ) as waiting`,
            );
            yield* Deferred.succeed(proceed, true);
            // The writer really holds Core's shared authority lock and is waiting to insert.
            // Publication must wait for that authority BEFORE obtaining any owner SHARE lease.
            yield* lockInterleavingReached(
              `select exists(
            select 1 from pg_locks where database=(select oid from pg_database where datname=current_database())
              and locktype='advisory' and mode='ExclusiveLock' and not granted
          ) as waiting`,
            );
            expect(leases).toBe(0);
            yield* Effect.tryPromise(() => gate.query('commit'));
            const refused = yield* Deferred.await(writer).pipe(Effect.timeout('20 seconds'));
            expect(Result.isFailure(refused)).toBe(true);
            if (Result.isFailure(refused)) {
              expect(isDispatchTransactionRefusal(refused.failure)).toBe(true);
            }
            const publication = yield* Deferred.await(published).pipe(Effect.timeout('40 seconds'));
            expect(publication.interleaved).toBe(true);
            expect(publication.conclusions).toEqual(['VERIFIED_ABSENT', 'VERIFIED_ABSENT']);
            expect(leases).toBe(2);
            expect(yield* f.storedHandoffs()).toEqual([]);
            expect((yield* f.evidence()).outbox).toEqual([]);
          }),
        ),
      120_000,
    );

    suite.effect(
      'preserves one valid serialization when a prepared public dispatch races admission closure',
      () =>
        Effect.gen(function* publicAdmissionRace() {
          const f = yield* fixture;
          const before = yield* f.evidence();
          // Acquire the real gateway credential before racing; no private transaction barrier is available.
          // This checks the observed serialization, without claiming a forced database interleaving.
          const credential = yield* f.token('privacy');
          const [dispatch] = yield* Effect.all(
            [Effect.result(f.dispatch(f.suffix, f.handoff, credential)), f.isolated.composition.closeAdmission()],
            { concurrency: 2 },
          );
          const accepted = Result.isSuccess(dispatch);
          const state = yield* f.isolated.composition.observe();
          expect(state.phase).toBe('active');
          expect(state.durableWorkAdmission).toBe('closed');
          expect(state.revision).toBe(f.revision);
          const after = yield* f.evidence();
          const messages = after.outbox.filter((message) => message.topic === 'privacy.measure.dispatched');
          expect(messages).toHaveLength(accepted ? 1 : 0);
          expect(yield* f.storedHandoffs()).toEqual(accepted ? [f.handoff] : []);
          expect(yield* f.ownerCount()).toBe(accepted ? '1' : '0');
          if (Result.isSuccess(dispatch)) {
            expect(dispatch.success).toEqual(f.handoff);
            const [message] = messages;
            if (message === undefined) {
              return yield* failure('The accepted race result lost its committed message');
            }
            expect(message.payload).toEqual({ handoff: f.handoff });
            expect(Option.getOrUndefined(message.consumer)).toBe('party.registry');
            expect(Option.getOrUndefined(message.revision)).toBe(f.revision);
            const successes = after.invocations.filter(
              (row) => row.actionKey === 'privacy.core.dispatch-privacy-measure' && row.status === 'succeeded',
            );
            expect(successes).toHaveLength(1);
            expect(after.events.find((event) => event.id === message.eventId)?.invocationId).toBe(successes[0]?.id);
            yield* pending(f);
          } else {
            expect(isDispatchTransactionRefusal(dispatch.failure)).toBe(true);
            expect(after.outbox).toEqual(before.outbox);
            expect(after.events).toEqual(before.events);
            expect(state.pendingDurableWork).toEqual([]);
          }
          const denied = yield* Effect.result(
            f.dispatch(`${f.suffix}-unrelated`, {
              ...f.handoff,
              idempotencyKey: `${f.suffix}-unrelated`,
              measureId: `${f.handoff.measureId}-unrelated`,
            }),
          );
          expect(Result.isFailure(denied)).toBe(true);
          if (Result.isFailure(denied)) {
            expect(isDispatchTransactionRefusal(denied.failure)).toBe(true);
          }
          expect((yield* f.evidence()).outbox).toEqual(after.outbox);
          expect(yield* f.storedHandoffs()).toEqual(accepted ? [f.handoff] : []);
          expect((yield* f.isolated.composition.observe()).pendingDurableWork).toEqual(state.pendingDurableWork);
          return yield* Effect.void;
        }),
      120_000,
    );

    suite.effect(
      'completes the real public BUSINESS_REJECTED receipt/execute/report before ACK permits Core-only drain and seal',
      () =>
        Effect.gen(function* rejectedPublicCompletionCorePhaseProof() {
          const f = yield* fixture;
          // The first real worker must use Execute only because no durable owner receipt exists.
          expect(Option.isNone(yield* f.receipt())).toBe(true);
          // ownerCount counts Privacy coordinator rows; coreDebtSettled checks real Party Execute invocations.
          expect(yield* f.ownerCount()).toBe('0');
          expect(yield* f.outcomes()).toEqual([]);
          yield* f.dispatch(f.suffix);
          expect(yield* f.storedHandoffs()).toEqual([f.handoff]);
          const originalMessages = (yield* f.evidence()).outbox.filter(
            (message) => message.topic === 'privacy.measure.dispatched',
          );
          expect(originalMessages).toHaveLength(1);
          const originalMessage = Option.getOrThrow(Option.fromNullishOr(originalMessages[0]));
          expect(originalMessage.consumer).toEqual(Option.some('party.registry'));
          expect(originalMessage.revision).toEqual(Option.some(f.revision));
          expect(
            yield* Schema.decodeUnknownEffect(Schema.Struct({ handoff: PrivacyMeasureHandoffSchema }))(
              originalMessage.payload,
            ),
          ).toEqual({ handoff: f.handoff });
          const canonical = yield* Schema.encodeEffect(Schema.fromJsonString(PrivacyMeasureHandoffSchema))({
            ...f.handoff,
            contentScopeRefs: EffectArray.sort(f.handoff.contentScopeRefs, Order.String),
            expectedEvidenceRefs: EffectArray.sort(f.handoff.expectedEvidenceRefs, Order.String),
            preconditionRefs: EffectArray.sort(f.handoff.preconditionRefs, Order.String),
            resourceRefs: EffectArray.sort(f.handoff.resourceRefs, Order.String),
          });
          yield* f.isolated.composition.closeAdmission();
          yield* pending(f);
          // Actual registered handler + repository.complete: succeeded is counted only after durable ACK.
          const completedCycle = yield* f.cycle();
          expect(completedCycle).toMatchObject({
            claimed: 1,
            dead: 0,
            failed: 0,
            retried: 0,
            succeeded: 1,
          });
          // Shell's real installed-catalog matcher also runs: this worker may find its delivery already matched.
          // Keep both matchers and require the same single claim/ACK and exact message-derived debt settlement.
          expect([0, 1]).toContain(completedCycle.matched.deliveriesCreated);
          expect(completedCycle.matched.messagesMatched).toBeGreaterThanOrEqual(
            completedCycle.matched.deliveriesCreated,
          );
          const original = yield* coreDebtSettled(f);
          expect(original.handoffFingerprint).toBe(digest(canonical));
          expect(original.outcome).toMatchObject({
            idempotencyKey: f.handoff.idempotencyKey,
            measureId: f.handoff.measureId,
            owningCapability: f.handoff.owningCapability,
            sourceDecisionRef: f.handoff.sourceDecisionRef,
            sourceDecisionRevision: f.handoff.sourceDecisionRevision,
            status: 'BUSINESS_REJECTED',
            taskId: f.handoff.taskId,
          });
          expect(yield* f.ownerCount()).toBe('1');
          expect(yield* f.cycle()).toMatchObject({ claimed: 0, succeeded: 0 });
          expect(yield* coreDebtSettled(f)).toEqual(original);
          expect(yield* f.ownerCount()).toBe('1');
          expect(
            (yield* f.evidence()).outbox.filter((message) => message.topic === 'privacy.measure.dispatched'),
          ).toEqual(originalMessages);
          yield* f.isolated.composition.drain();
          yield* f.isolated.composition.seal();
          const sealed = yield* f.isolated.composition.observe();
          expect(sealed.phase).toBe('sealed');
          expect(sealed.revision).toBe(f.revision);
          expect(sealed.pendingDurableWork).toEqual([]);
          expect(Result.isFailure(yield* Effect.result(f.receipt()))).toBe(true);
          expect(yield* f.storedHandoffs()).toEqual([f.handoff]);
          expect(
            (yield* f.evidence()).outbox.filter((message) => message.topic === 'privacy.measure.dispatched'),
          ).toEqual(originalMessages);
          // Core delivery completion does not turn this truthful rejected result into operator promotion.
          expect(yield* f.outcomes()).toEqual([original.outcome]);
        }),
      120_000,
    );

    for (const stage of ['after-execute', 'after-report'] as const) {
      suite.effect(
        `retains exact debt across process loss ${stage} and replays the durable receipt/report before ACK`,
        () =>
          Effect.gen(function* interruptedPublicCompletion() {
            const f = yield* fixture;
            yield* f.dispatch(f.suffix);
            yield* f.isolated.composition.closeAdmission();
            const interrupted = yield* f.worker({ barrier: stage });
            const barrier = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(barrierSchema))(interrupted.line);
            expect(barrier.stage).toBe(stage);
            yield* pending(f);
            const original = yield* f.receipt();
            expect(Option.isSome(original)).toBe(true);
            expect(yield* f.outcomes()).toHaveLength(stage === 'after-report' ? 1 : 0);
            yield* interrupted.child.kill({ killSignal: 'SIGKILL' });
            const termination = yield* Effect.result(interrupted.child.exitCode);
            expect(termination).toMatchObject({
              failure: {
                _tag: 'PlatformError',
                reason: {
                  _tag: 'Unknown',
                  cause: expect.objectContaining({
                    message: "Process interrupted due to receipt of signal: 'SIGKILL'",
                  }),
                  method: 'exitCode',
                  module: 'ChildProcess',
                },
              },
            });
            expect(yield* interrupted.child.isRunning).toBe(false);
            yield* pending(f);
            // Public Outbox test clock origin crosses the unchanged real 30s claim lease.
            expect(yield* f.cycle(31_000)).toMatchObject({ claimed: 1, failed: 0, succeeded: 1 });
            const completed = yield* coreDebtSettled(f);
            expect(Option.getOrUndefined(original)).toEqual(completed);
            yield* f.isolated.composition.drain();
            yield* f.isolated.composition.seal();
          }),
        120_000,
      );
    }

    suite.effect(
      'retains original debt and refuses preissued public credentials after real database authority expiry',
      () =>
        Effect.gen(function* expiredOriginalAuthority() {
          const f = yield* fixture.pipe(Effect.provideService(fixtureAuthorityLifetime, 'short'));
          yield* f.dispatch(f.suffix);
          yield* f.isolated.composition.closeAdmission();
          yield* pending(f);
          const before = yield* f.isolated.composition.observeRetainedOriginal();
          expect(before.unexpired).toBe(true);
          expect(before.originalRevision).toBe(f.revision);
          expect(before.currentRevision).toBe(f.revision);
          const privacyCredential = yield* f.token('privacy');
          const partyCredential = yield* f.token('party-registry');
          // Credential lifetime remains valid across the much shorter Composition lifetime.
          for (const credential of [privacyCredential, partyCredential]) {
            expect(decodeJwt(credential.token).exp).toBeGreaterThan((before.validUntilEpochMilliseconds + 5000) / 1000);
          }
          const originalMessages = (yield* f.evidence()).outbox;
          const remaining = before.validUntilEpochMilliseconds - before.observedAtEpochMilliseconds;
          expect(remaining).toBeGreaterThan(0);
          expect(remaining).toBeLessThanOrEqual(20_000);
          yield* Effect.sleep(remaining + 100);
          const expired = yield* f.isolated.composition.observeRetainedOriginal();
          expect(expired.unexpired).toBe(false);
          for (const credential of [privacyCredential, partyCredential]) {
            expect(decodeJwt(credential.token).exp).toBeGreaterThan(expired.observedAtEpochMilliseconds / 1000);
          }
          expect(expired.observedAtEpochMilliseconds).toBeGreaterThanOrEqual(expired.validUntilEpochMilliseconds);
          expect(expired.originalRevision).toBe(f.revision);
          expect(expired.currentRevision).toBe(f.revision);
          expect(expired.phase).toBe('active');
          expect(expired.durableWorkAdmission).toBe('closed');
          expect(expired.pendingDurableWork).toEqual(before.pendingDurableWork);
          expect(expired.hasMoreDurableWork).toBe(false);
          const dispatch = yield* Effect.result(
            f.dispatch(
              `${f.suffix}-expired`,
              {
                ...f.handoff,
                idempotencyKey: `${f.suffix}-expired`,
                measureId: `${f.handoff.measureId}-expired`,
              },
              privacyCredential,
            ),
          );
          expect(Result.isFailure(dispatch)).toBe(true);
          if (Result.isFailure(dispatch)) {
            expect(Schema.is(DispatchPrivacyMeasureActionUnavailableProblemSchema)(dispatch.failure)).toBe(true);
            expect(dispatch.failure).toMatchObject({ status: 503 });
          }
          const receipt = yield* Effect.result(
            executePrivacyMeasureExecutionWithAuthorization(
              { idempotencyKey: f.handoff.idempotencyKey },
              `Bearer ${partyCredential.token}`,
              f.suffix,
              { baseUrl: f.partyUrl, compositionRevision: f.revision },
            ),
          );
          expect(Result.isFailure(receipt)).toBe(true);
          if (Result.isFailure(receipt)) {
            expect(receipt.failure).toMatchObject({ status: 503 });
          }
          const refusedWorker = yield* f.worker();
          const refused = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                code: Schema.Literals(['composition-unavailable', 'worker-unavailable']),
                type: Schema.Literal('failed'),
              }),
            ),
          )(refusedWorker.line);
          expect(['composition-unavailable', 'worker-unavailable']).toContain(refused.code);
          expect(yield* refusedWorker.child.exitCode).not.toBe(0);
          for (const operation of [
            f.isolated.composition.observe,
            f.isolated.composition.drain,
            f.isolated.composition.seal,
          ]) {
            expect(Result.isFailure(yield* Effect.result(operation()))).toBe(true);
          }
          expect((yield* f.isolated.composition.observeRetainedOriginal()).pendingDurableWork).toEqual(
            before.pendingDurableWork,
          );
          expect(yield* f.storedHandoffs()).toEqual([f.handoff]);
          expect(yield* f.outcomes()).toEqual([]);
          expect((yield* f.evidence()).outbox).toEqual(originalMessages);
          return yield* Effect.void;
        }),
      60_000,
    );

    suite.effect(
      'refuses the original public revision after supported real empty-owner replacement',
      () =>
        Effect.gen(function* replacedOriginalAuthority() {
          const f = yield* fixture;
          const credential = yield* f.token('privacy');
          const partyCredential = yield* f.token('party-registry');
          const before = yield* f.evidence();
          const candidate = yield* makeApplicationCompositionSnapshotFixture(
            ['privacy', 'party-registry'],
            `${f.suffix}-replacement`,
          );
          const replacement = yield* validateActiveApplicationCompositionSnapshot({
            ...candidate,
            observedAt: DateTime.add(f.snapshot.observedAt, { milliseconds: 1 }),
            validUntil: DateTime.add(f.snapshot.validUntil, { seconds: 1 }),
          });
          yield* f.isolated.composition.closeAdmission();
          yield* f.isolated.composition.drain();
          const published = yield* f.isolated.composition.publishReplacement(replacement);
          expect(published).toEqual({
            durableWorkAdmission: 'open',
            phase: 'active',
            revision: replacement.composition.revision,
          });
          expect(published.revision).not.toBe(f.revision);
          const retained = yield* f.isolated.composition.observeRetainedOriginal();
          expect(retained.originalRevision).toBe(f.revision);
          expect(retained.currentRevision).toBe(replacement.composition.revision);
          expect(retained.pendingDurableWork).toEqual([]);
          const refused = yield* Effect.result(f.dispatch(f.suffix, f.handoff, credential));
          expect(Result.isFailure(refused)).toBe(true);
          if (Result.isFailure(refused)) {
            expect(Schema.is(DispatchPrivacyMeasureActionUnavailableProblemSchema)(refused.failure)).toBe(true);
            expect(refused.failure).toMatchObject({ status: 503 });
          }
          const receipt = yield* Effect.result(
            executePrivacyMeasureExecutionWithAuthorization(
              { idempotencyKey: f.handoff.idempotencyKey },
              `Bearer ${partyCredential.token}`,
              f.suffix,
              { baseUrl: f.partyUrl, compositionRevision: f.revision },
            ),
          );
          expect(Result.isFailure(receipt)).toBe(true);
          if (Result.isFailure(receipt)) {
            expect(receipt.failure).toMatchObject({ status: 503 });
          }
          expect(Result.isFailure(yield* Effect.result(f.isolated.composition.observe()))).toBe(true);
          expect(Result.isFailure(yield* Effect.result(f.isolated.composition.publishReplacement(replacement)))).toBe(
            true,
          );
          expect(yield* f.storedHandoffs()).toEqual([]);
          expect(yield* f.outcomes()).toEqual([]);
          expect((yield* f.evidence()).outbox).toEqual(before.outbox);
        }),
      120_000,
    );

    suite.effect(
      'retains exact debt for a genuinely committed conflicting public owner receipt',
      () =>
        Effect.gen(function* genuineConflictingOwnerReceipt() {
          const f = yield* fixture;
          const priorHandoff = { ...f.handoff, requestedResult: 'TEST:earlier-owner-intent' };
          const credential = yield* f.token('party-registry');
          const priorOutcome = yield* executeExecutePrivacyMeasureWithAuthorization(
            { handoff: priorHandoff },
            `Bearer ${credential.token}`,
            f.suffix,
            { baseUrl: f.partyUrl, compositionRevision: f.revision, idempotencyKey: `${f.suffix}-prior-owner` },
          );
          expect(priorOutcome.status).toBe('BUSINESS_REJECTED');
          const priorReceipt = yield* f.receipt();
          expect(Option.isSome(priorReceipt)).toBe(true);
          if (Option.isNone(priorReceipt)) {
            return yield* failure('The public producer did not commit its prior owner receipt');
          }
          expect(priorReceipt.value.outcome).toEqual(priorOutcome);
          expect(priorReceipt.value.handoffFingerprint).not.toBe(
            digest(
              yield* Schema.encodeEffect(Schema.fromJsonString(PrivacyMeasureHandoffSchema))({
                ...f.handoff,
                contentScopeRefs: EffectArray.sort(f.handoff.contentScopeRefs, Order.String),
                expectedEvidenceRefs: EffectArray.sort(f.handoff.expectedEvidenceRefs, Order.String),
                preconditionRefs: EffectArray.sort(f.handoff.preconditionRefs, Order.String),
                resourceRefs: EffectArray.sort(f.handoff.resourceRefs, Order.String),
              }),
            ),
          );
          // Both records are produced through their owner's actual public Actions.
          expect(yield* f.dispatch(f.suffix)).toEqual(f.handoff);
          yield* f.isolated.composition.closeAdmission();
          const originalMessages = (yield* f.evidence()).outbox;
          for (const advance of [0, 2000]) {
            expect(yield* f.cycle(advance)).toMatchObject({ claimed: 1, failed: 1, retried: 1, succeeded: 0 });
            yield* pending(f);
            expect(yield* f.receipt()).toEqual(priorReceipt);
            expect(yield* f.outcomes()).toEqual([]);
            expect(yield* f.storedHandoffs()).toEqual([f.handoff]);
            expect((yield* f.evidence()).outbox).toEqual(originalMessages);
          }
          const { invocations } = yield* f.evidence();
          expect(invocations.filter((row) => row.actionKey === 'party.registry.execute-privacy-measure')).toHaveLength(
            1,
          );
          expect(invocations.filter((row) => row.actionKey === 'privacy.core.record-owner-execution-outcome')).toEqual(
            [],
          );
          return yield* Effect.void;
        }),
      120_000,
    );

    suite.effect(
      'recovers a real committed report whose HTTP response was discarded without repeating owner effects or losing debt',
      () =>
        Effect.gen(function* lostCommittedReportResponse() {
          const f = yield* fixture;
          yield* f.dispatch(f.suffix);
          const originalMessages = (yield* f.evidence()).outbox;
          yield* f.isolated.composition.closeAdmission();
          expect(yield* f.control('privacy', 'report-response/discard-next')).toBe(204);
          expect(yield* f.control('privacy', 'report-response/discard-next')).toBe(409);
          // Unlike after-report, this worker never receives the successful response.
          expect(yield* f.cycle()).toMatchObject({ claimed: 1, failed: 1, retried: 1, succeeded: 0 });
          const response = yield* Effect.tryPromise(() => fetch(`${f.privacyUrl}/__1258/report-response/evidence`));
          expect(response.status).toBe(200);
          const suppression = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              armed: Schema.Boolean,
              committedResponseStatus: Schema.Number,
              discardedResponses: Schema.Int,
            }),
          )(yield* Effect.tryPromise(() => response.json()));
          expect(suppression).toEqual({ armed: false, committedResponseStatus: 200, discardedResponses: 1 });
          const original = yield* f.receipt();
          if (Option.isNone(original)) {
            return yield* failure('Response loss must follow the actual committed Party receipt');
          }
          expect(yield* f.outcomes()).toEqual([original.value.outcome]);
          expect(
            (yield* f.evidence()).invocations.filter(
              (row) => row.actionKey === 'privacy.core.record-owner-execution-outcome' && row.status === 'succeeded',
            ),
          ).toHaveLength(1);
          yield* pending(f);
          // A changed request cannot borrow the committed report's transport identity.
          const credential = yield* f.token('privacy');
          const conflict = yield* Effect.result(
            executeRecordOwnerExecutionOutcomeWithAuthorization(
              {
                request: {
                  attempt: original.value.outcome.attempt + 1,
                  measureId: f.handoff.measureId,
                  taskId: f.handoff.taskId,
                },
              },
              `Bearer ${credential.token}`,
              f.suffix,
              {
                baseUrl: f.privacyUrl,
                compositionRevision: f.revision,
                idempotencyKey: `owner-outcome:${f.handoff.measureId}:${original.value.outcome.attempt}`.slice(0, 200),
              },
            ),
          );
          expect(Result.isFailure(conflict)).toBe(true);
          if (Result.isFailure(conflict)) {
            expect(Schema.is(RecordOwnerExecutionOutcomeActionConflictProblemSchema)(conflict.failure)).toBe(true);
            expect(conflict.failure).toMatchObject({ code: 'action_request_hash_conflict', status: 409 });
          }
          yield* pending(f);
          expect(yield* f.outcomes()).toEqual([original.value.outcome]);
          // A fresh worker loads the real receipt and replays the exact committed report.
          expect(yield* f.cycle(2000)).toMatchObject({ claimed: 1, failed: 0, succeeded: 1 });
          expect(yield* coreDebtSettled(f)).toEqual(original.value);
          expect(yield* f.cycle(3000)).toMatchObject({ claimed: 0, succeeded: 0 });
          expect((yield* f.evidence()).outbox).toEqual(originalMessages);
          expect(yield* f.storedHandoffs()).toEqual([f.handoff]);
          expect(yield* f.outcomes()).toEqual([original.value.outcome]);
          expect(yield* f.control('privacy', 'report-response/discard-next')).toBe(409);
          yield* f.isolated.composition.drain();
          yield* f.isolated.composition.seal();
          return yield* Effect.void;
        }),
      120_000,
    );

    suite.effect('refuses new work with a preissued credential after supported empty-owner sealing', () =>
      Effect.gen(function* sealedCompletionRefusal() {
        const f = yield* fixture;
        const credential = yield* f.token('privacy');
        const before = yield* f.evidence();
        yield* f.isolated.composition.closeAdmission();
        yield* f.isolated.composition.drain();
        yield* f.isolated.composition.seal();
        const result = yield* Effect.result(f.dispatch(f.suffix, f.handoff, credential));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(Schema.is(DispatchPrivacyMeasureActionUnavailableProblemSchema)(result.failure)).toBe(true);
          expect(result.failure).toMatchObject({ status: 503 });
        }
        expect((yield* f.isolated.composition.observe()).phase).toBe('sealed');
        expect((yield* f.isolated.composition.observe()).pendingDurableWork).toEqual([]);
        expect(yield* f.storedHandoffs()).toEqual([]);
        expect(yield* f.outcomes()).toEqual([]);
        expect((yield* f.evidence()).outbox).toEqual(before.outbox);
      }),
    );

    for (const capability of ['authority', 'redemption'] as const) {
      suite.effect(
        `retains debt when real reporting encounters TEST ${capability} unavailability and reconciles after restoration`,
        () =>
          Effect.gen(function* unavailableReportCapability() {
            const f = yield* fixture;
            yield* f.dispatch(f.suffix);
            yield* f.isolated.composition.closeAdmission();
            expect(yield* f.control('privacy', `${capability}/unavailable`)).toBe(204);
            expect(yield* f.cycle()).toMatchObject({ claimed: 1, failed: 1, retried: 1, succeeded: 0 });
            yield* pending(f);
            expect(yield* f.outcomes()).toHaveLength(0);
            const original = yield* f.receipt();
            expect(Option.isSome(original)).toBe(true);
            expect(yield* f.control('privacy', `${capability}/available`)).toBe(204);
            expect(yield* f.cycle(2000)).toMatchObject({ claimed: 1, succeeded: 1 });
            expect(yield* coreDebtSettled(f)).toEqual(Option.getOrUndefined(original));
          }),
        120_000,
      );
    }

    suite.effect(
      'honors real receipt permission and module-state revocation without owner execution or false completion',
      () =>
        Effect.gen(function* revokedPublicAccess() {
          const f = yield* fixture;
          yield* f.dispatch(f.suffix);
          yield* f.isolated.composition.closeAdmission();
          expect(yield* f.control('shell', 'revoke-party-read')).toBe(204);
          expect(yield* f.cycle()).toMatchObject({ claimed: 1, failed: 1, succeeded: 0 });
          yield* pending(f);
          const deniedRead = yield* Effect.result(f.receipt());
          expect(Result.isFailure(deniedRead)).toBe(true);
          if (Result.isFailure(deniedRead)) {
            expect(deniedRead.failure).toMatchObject({ status: 403 });
          }
          expect(
            (yield* f.evidence()).invocations.filter(
              (row) => row.actionKey === 'party.registry.execute-privacy-measure',
            ),
          ).toHaveLength(0);
          expect(yield* f.control('shell', 'grant-party-read')).toBe(204);
          expect(Option.isNone(yield* f.receipt())).toBe(true);
          expect(yield* f.control('shell', 'deactivate-party')).toBe(204);
          // Consumer background eligibility prevents even claiming; no fabricated handler failure.
          expect(yield* f.cycle(2000)).toMatchObject({ claimed: 0, succeeded: 0 });
          yield* pending(f);
          expect(yield* f.control('shell', 'activate-party')).toBe(204);
          expect(yield* f.cycle(3000)).toMatchObject({ claimed: 1, succeeded: 1 });
          yield* coreDebtSettled(f);
        }),
      120_000,
    );

    suite.effect(
      'isolates public receipt and authoritative report by Legal Entity before genuine original-scope completion',
      () =>
        Effect.gen(function* directForeignLegalEntityEndpoints() {
          const f = yield* fixture.pipe(Effect.provideService(fixtureAdditionalLegalEntity, 'same-tenant'));
          const legalEntityB = f.secondaryLegalEntityId;
          if (legalEntityB === undefined) {
            return yield* failure('The supported second Legal Entity fixture was absent');
          }
          yield* f.dispatch(f.suffix);
          yield* f.isolated.composition.closeAdmission();
          const interrupted = yield* f.worker({ barrier: 'after-execute' });
          expect(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(barrierSchema))(interrupted.line)).toEqual({
            stage: 'after-execute',
            type: 'barrier',
          });
          const original = yield* f.receipt();
          if (Option.isNone(original)) {
            return yield* failure('The genuine original-scope Party receipt was absent');
          }
          expect(original.value.outcome.status).toBe('BUSINESS_REJECTED');
          const originalMessages = (yield* f.evidence()).outbox;
          const originalHandoffs = yield* f.storedHandoffs();
          expect(yield* f.outcomes()).toEqual([]);
          yield* pending(f);
          // Shell issues genuine B-scoped assertions. No token fields or owner rows are manufactured.
          const receiptCredential = yield* f.token('party-registry', f.revision, legalEntityB);
          expect(
            Schema.is(Schema.Struct({ principal: Schema.Struct({ legalEntityId: Schema.Literal(legalEntityB) }) }))(
              decodeJwt(receiptCredential.token),
            ),
          ).toBe(true);
          const foreignReceipt = yield* executePrivacyMeasureExecutionWithAuthorization(
            { idempotencyKey: f.handoff.idempotencyKey },
            `Bearer ${receiptCredential.token}`,
            `${f.suffix}-foreign-le-receipt`,
            { baseUrl: f.partyUrl, compositionRevision: f.revision },
          );
          expect(Option.isNone(foreignReceipt)).toBe(true);
          const reportCredential = yield* f.token('privacy', f.revision, legalEntityB);
          expect(
            Schema.is(Schema.Struct({ principal: Schema.Struct({ legalEntityId: Schema.Literal(legalEntityB) }) }))(
              decodeJwt(reportCredential.token),
            ),
          ).toBe(true);
          const refused = yield* Effect.result(
            executeRecordOwnerExecutionOutcomeWithAuthorization(
              {
                request: {
                  attempt: original.value.outcome.attempt,
                  measureId: f.handoff.measureId,
                  taskId: f.handoff.taskId,
                },
              },
              `Bearer ${reportCredential.token}`,
              `${f.suffix}-foreign-le-report`,
              {
                baseUrl: f.privacyUrl,
                compositionRevision: f.revision,
                idempotencyKey: `${f.suffix}-foreign-le-report`,
              },
            ),
          );
          expect(Result.isFailure(refused)).toBe(true);
          if (Result.isFailure(refused)) {
            expect(Schema.is(RecordOwnerExecutionOutcomeActionUnavailableProblemSchema)(refused.failure)).toBe(true);
            expect(refused.failure).toMatchObject({ code: 'privacy_operation_not_found', status: 503 });
          }
          expect(yield* f.receipt()).toEqual(original);
          expect(yield* f.outcomes()).toEqual([]);
          expect(yield* f.outcomes(legalEntityB)).toEqual([]);
          expect(yield* f.storedHandoffs()).toEqual(originalHandoffs);
          const afterRefusalEvidence = yield* f.evidence();
          expect(afterRefusalEvidence.outbox).toEqual(originalMessages);
          expect(
            afterRefusalEvidence.invocations.filter(
              (row) => row.actionKey === 'party.registry.execute-privacy-measure' && row.status === 'succeeded',
            ),
          ).toHaveLength(1);
          expect(
            afterRefusalEvidence.invocations.filter(
              (row) => row.actionKey === 'privacy.core.record-owner-execution-outcome' && row.status === 'succeeded',
            ),
          ).toHaveLength(0);
          yield* pending(f);
          yield* interrupted.child.kill({ killSignal: 'SIGKILL' });
          yield* Effect.result(interrupted.child.exitCode);
          expect(yield* interrupted.child.isRunning).toBe(false);
          // Recover the real claim through the existing test-clock lease control, then report and ACK in A.
          expect(yield* f.cycle(31_000)).toMatchObject({ claimed: 1, failed: 0, succeeded: 1 });
          expect(yield* coreDebtSettled(f)).toEqual(original.value);
          yield* f.isolated.composition.drain();
          yield* f.isolated.composition.seal();
          return yield* Effect.void;
        }),
    );

    suite.effect(
      'retains exact debt when the handoff names an unauthorized foreign Legal Entity',
      () =>
        Effect.gen(function* foreignLegalEntityCompletion() {
          const f = yield* fixture;
          const foreignHandoff = {
            ...f.handoff,
            resourceRefs: [
              'party.registry|party.registry.counterparty|ffffffff-ffff-4fff-8fff-ffffffffffff|eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            ],
          };
          // Public dispatch preserves the declared work; the worker must independently
          // obtain current authority for the Legal Entity in that immutable target.
          expect(yield* f.dispatch(f.suffix, foreignHandoff)).toEqual(foreignHandoff);
          yield* f.isolated.composition.closeAdmission();
          expect(yield* f.cycle()).toMatchObject({ claimed: 1, failed: 1, succeeded: 0 });
          yield* pending(f);
          expect(yield* f.outcomes()).toEqual([]);
          expect(Option.isNone(yield* f.receipt())).toBe(true);
          expect(
            (yield* f.evidence()).invocations.filter((row) =>
              ['party.registry.execute-privacy-measure', 'privacy.core.record-owner-execution-outcome'].includes(
                row.actionKey,
              ),
            ),
          ).toHaveLength(0);
        }),
      120_000,
    );

    // Includes fresh native DB/three HTTP processes plus all eight real retry attempts.
    // The logical retry clock advances, but process startup and real receiving/authz still cost wall time.
    suite.effect(
      'keeps dead-letter debt after the exact production retry policy is exhausted',
      () =>
        Effect.gen(function* deadDelivery() {
          const f = yield* fixture;
          yield* f.dispatch(f.suffix);
          yield* f.isolated.composition.closeAdmission();
          expect(yield* f.control('shell', 'revoke-party-read')).toBe(204);
          const retry = yield* f.retrySession;
          const advances = [0, 2000, 5000, 10_000, 19_000, 36_000, 69_000, 130_000];
          for (const [index, advance] of advances.entries()) {
            expect(yield* retry.cycle(advance)).toMatchObject({
              claimed: 1,
              dead: index === advances.length - 1 ? 1 : 0,
              failed: 1,
              retried: index === advances.length - 1 ? 0 : 1,
              succeeded: 0,
            });
            yield* pending(f);
          }
          expect(yield* f.control('shell', 'grant-party-read')).toBe(204);
          expect(yield* retry.cycle(200_000)).toMatchObject({ claimed: 0, succeeded: 0 });
          yield* pending(f);
          yield* retry.finish;
          expect(yield* f.outcomes()).toEqual([]);
          expect(Option.isNone(yield* f.receipt())).toBe(true);
        }),
      120_000,
    );

    suite.effect(
      'rejects wrong audience, assertion replay, foreign Tenant and foreign revision without a completion bypass',
      () =>
        Effect.gen(function* publicIdentityBoundaries() {
          const f = yield* fixture;
          const before = yield* f.evidence();
          const foreignTenant = { ...f.handoff, tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
          const credential = yield* f.token('privacy');
          const mismatch = yield* Effect.result(
            executeDispatchPrivacyMeasureWithAuthorization(
              { handoff: foreignTenant },
              `Bearer ${credential.token}`,
              f.suffix,
              { baseUrl: f.privacyUrl, compositionRevision: f.revision, idempotencyKey: `${f.suffix}-foreign` },
            ),
          );
          expect(Result.isFailure(mismatch)).toBe(true);
          if (Result.isFailure(mismatch)) {
            expect(Schema.is(DispatchPrivacyMeasureActionIneligibleProblemSchema)(mismatch.failure)).toBe(true);
            expect(mismatch.failure).toMatchObject({ status: 422 });
          }
          const replay = yield* Effect.result(
            executeDispatchPrivacyMeasureWithAuthorization(
              { handoff: f.handoff },
              `Bearer ${credential.token}`,
              f.suffix,
              { baseUrl: f.privacyUrl, compositionRevision: f.revision, idempotencyKey: `${f.suffix}-replay` },
            ),
          );
          expect(Result.isFailure(replay)).toBe(true);
          if (Result.isFailure(replay)) {
            expect(Schema.is(DispatchPrivacyMeasureActionAuthenticationProblemSchema)(replay.failure)).toBe(true);
            expect(replay.failure).toMatchObject({ status: 401 });
          }
          const wrongAudience = yield* f.token('party-registry');
          const audience = yield* Effect.result(
            executeDispatchPrivacyMeasureWithAuthorization(
              { handoff: f.handoff },
              `Bearer ${wrongAudience.token}`,
              f.suffix,
              { baseUrl: f.privacyUrl, compositionRevision: f.revision, idempotencyKey: `${f.suffix}-audience` },
            ),
          );
          expect(Result.isFailure(audience)).toBe(true);
          if (Result.isFailure(audience)) {
            expect(Schema.is(DispatchPrivacyMeasureActionAuthenticationProblemSchema)(audience.failure)).toBe(true);
            expect(audience.failure).toMatchObject({ status: 401 });
          }
          expect(yield* f.ownerCount()).toBe('0');
          expect((yield* f.evidence()).outbox).toEqual(before.outbox);
          expect((yield* f.isolated.composition.observe()).pendingDurableWork).toEqual([]);
          yield* f.dispatch(f.suffix);
          yield* f.isolated.composition.closeAdmission();
          expect(Result.isFailure(yield* Effect.result(f.token('privacy', 'f'.repeat(64))))).toBe(true);
          const wrongRevision = yield* f.worker({ revision: 'f'.repeat(64) });
          const refused = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({ code: Schema.Literal('composition-unavailable'), type: Schema.Literal('failed') }),
            ),
          )(wrongRevision.line);
          expect(refused.code).toBe('composition-unavailable');
          expect(yield* wrongRevision.child.exitCode).not.toBe(0);
          yield* pending(f);
          expect(Option.isNone(yield* f.receipt())).toBe(true);
          expect(yield* f.cycle()).toMatchObject({ claimed: 1, succeeded: 1 });
          yield* coreDebtSettled(f);
        }),
      120_000,
    );
  },
);
