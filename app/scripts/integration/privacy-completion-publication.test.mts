// Native operator integration only. Nothing acquires resources until an it.live callback runs.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { privacyLegacyCompletionOwner } from '@app/privacy/admin/legacy-completion';
import {
  LegacyCompletionPublication,
  LegacyCompletionPublicationError,
  LegacyCompletionRetainedObservationSchema,
} from '@app/core-runtime/legacy-completion-publication';
import type {
  LegacyCompletionOwnerLease,
  LegacyCompletionOwnerVerifier,
} from '@app/core-runtime/legacy-completion-publication';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { eq, sql } from 'drizzle-orm';
import {
  Config,
  ConfigProvider,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Match,
  Option,
  Queue,
  Redacted,
  Ref,
  Schema,
  Stream,
} from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { ChildProcess } from 'effect/process';
import type { ChildProcessSpawner } from 'effect/process';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import { CoreDatabase, makeCoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { parseDatabaseConnectionPair } from '../../packages/core-runtime/src/db/config.ts';
import {
  applicationCompositionAuthority,
  outboxMessages,
  outboxDeliveries,
} from '../../packages/core-runtime/src/db/schema.ts';
import { moduleReleaseAssetWorkerName } from '../../packages/core-runtime/src/http/module-release-identity.ts';
import { ActiveApplicationCompositionSnapshotSchema } from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { canonicalizeApplicationComposition } from '../../packages/core-runtime/src/modules/application-composition.ts';
import { runApplicationCompositionMigration } from '../application-composition-authority-publication.mts';
import { ApplicationCompositionLegacyOwnersLive } from '../application-composition-legacy-owners.mts';
import { publishSnapshot } from '../publish-active-application-composition.mts';
import {
  ActiveApplicationCompositionPublicationError,
  encodeActiveApplicationCompositionSnapshot,
} from '../active-application-composition.mts';
import { verifyInitialCutoverProviderInventory } from '../initial-composition-cutover-provider.mts';
import { ZeropsPublicApiLive } from '../zerops-public-api.mts';
import {
  makePrivacyPublicCompletionSession,
  PublicCompletionCapabilitySchema,
  PublicCompletionProducerSchema,
  frozenDispatchMatches,
  LEGACY_DISPATCH_SHA256,
} from './support/privacy-public-completion-session.mts';
import {
  closeApplicationCompositionDurableAdmission,
  drainApplicationCompositionAuthority,
  sealApplicationCompositionAuthority,
} from '../../packages/core-runtime/src/modules/application-composition-authority.ts';

const appRoot = new URL('../../', import.meta.url).pathname;
const account = 'a'.repeat(32);
const namespace = 'c'.repeat(32);
const namespacePath = `/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}`;
const pointerPath = `${namespacePath}/values/active`;
const retiredNamespace = 'd'.repeat(32);
const retiredNamespacePath = `/client/v4/accounts/${account}/storage/kv/namespaces/${retiredNamespace}`;
const providerUrl = `https://api.cloudflare.com${pointerPath}`;
const fixtureOwner = 'privacy.core';
const commands = ['describe', 'prepare-empty', 'dispatch-old', 'observe', 'hold-owner-write', 'release'] as const;
const descriptionSchema = Schema.Struct({
  commands: Schema.Array(Schema.Literals(commands)),
  historicalProducer: Schema.String,
  owner: Schema.Literal(fixtureOwner),
  protocolVersion: Schema.Literal(1),
  publicAckProducer: Schema.String,
});
const replySchema = Schema.Union([
  Schema.Struct({ databaseOid: Schema.String, type: Schema.Literal('prepared') }),
  Schema.Struct({
    dispatches: Schema.Int,
    historySha256: Schema.String,
    measureIds: Schema.Array(Schema.String.pipe(Schema.brand('PrivacyMeasureId'))),
    outcomeIds: Schema.Array(Schema.String.pipe(Schema.brand('PrivacyOutcomeId'))),
    outcomes: Schema.Int,
    type: Schema.Literal('observation'),
  }),
  Schema.Struct({
    backendXid: Schema.String,
    databaseOid: Schema.String,
    pid: Schema.Int,
    type: Schema.Literal('writer-started'),
    virtualTransaction: Schema.String,
  }),
  Schema.Struct({ pid: Schema.Int, type: Schema.Literals(['writer-held', 'released']) }),
]);
class OperatorPublicationTestFailure extends Schema.TaggedError<OperatorPublicationTestFailure>()(
  'OperatorPublicationTestFailure',
  { reason: Schema.String },
) {}
const failure = (reason: string) => new OperatorPublicationTestFailure({ reason });
const requireObservation = <Value,>(value: Value | undefined, reason: string) =>
  value === undefined ? Effect.fail(failure(reason)) : Effect.succeed(value);
const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const snapshot = Effect.fn('OperatorPublicationTest.snapshot')(function* snapshot(label: string, extension: number) {
  const now = yield* DateTime.now;
  const worker = yield* moduleReleaseAssetWorkerName('shell-super-app', 'operator-test-shell');
  const composition = {
    modules: [],
    revision: '0'.repeat(64),
    schemaVersion: '2',
    shell: {
      contributionAbi: { id: 'ontos.shell-contributions', version: '1' },
      coreCapabilities: [{ id: `publication.${label}`, version: '1' }],
      deployment: { appId: 'shell-super-app', buildMarker: 'operator-test-shell' },
      federationManifest: {
        sha256: 'a'.repeat(64),
        url: `https://${worker}.publication-test.workers.dev/mf-manifest.json`,
      },
      runtimeContract: {
        sha256: 'b'.repeat(64),
        url: `https://${worker}.publication-test.workers.dev/.well-known/ontos-shell-runtime.json`,
      },
      sharedSingletons: [],
    },
  } as const;
  return yield* Schema.decodeUnknownEffect(ActiveApplicationCompositionSnapshotSchema)({
    composition: {
      ...composition,
      revision: createHash('sha256').update(canonicalizeApplicationComposition(composition)).digest('hex'),
    },
    observedAt: DateTime.formatIso(now),
    validUntil: DateTime.formatIso(DateTime.add(now, { milliseconds: 3_600_000 + extension })),
  });
});

interface NativeTransaction extends Record<string, unknown> {
  readonly backendXid: string;
  readonly databaseOid: string;
  readonly pid: number;
  readonly virtualTransaction: string;
}
const sameNativeTransaction = (actual: NativeTransaction, expected: NativeTransaction) =>
  actual.pid === expected.pid &&
  actual.databaseOid === expected.databaseOid &&
  actual.backendXid === expected.backendXid &&
  actual.virtualTransaction === expected.virtualTransaction;
interface ProviderPut {
  readonly body: string;
  readonly bodySha256: string;
  readonly method: string;
  readonly rejected: boolean;
  readonly responseBody: { readonly success: boolean };
  readonly responseStatus: number;
  readonly url: string;
}
const isExpectedRejectedPut = (actual: ProviderPut, encoded: string) =>
  actual.method === 'PUT' &&
  actual.url === providerUrl &&
  actual.body === encoded &&
  actual.bodySha256 === createHash('sha256').update(encoded).digest('hex') &&
  actual.rejected &&
  actual.responseStatus === 200 &&
  !actual.responseBody.success;

const makeFixture = Effect.fn('OperatorPublicationTest.makeFixture')(function* makeFixture() {
  const settings = yield* Config.all({
    admin: Config.Redacted('DATABASE_ADMIN_URL'),
    mise: Config.all({
      MISE_BACKENDS_PNPM: Config.String('MISE_BACKENDS_PNPM').pipe(Config.withDefault('')),
      MISE_CACHE_DIR: Config.String('MISE_CACHE_DIR').pipe(Config.withDefault('')),
      MISE_DATA_DIR: Config.String('MISE_DATA_DIR').pipe(Config.withDefault('')),
      MISE_STATE_DIR: Config.String('MISE_STATE_DIR').pipe(Config.withDefault('')),
    }),
    path: Config.String('PATH'),
    runtime: Config.Redacted('DATABASE_URL'),
  });
  const usesTaskLocalMise = Object.values(settings.mise).some((value) => value !== '');
  const taskRoot = new URL('../../../', import.meta.url).pathname;
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
  const sourceConnections = yield* parseDatabaseConnectionPair({
    DATABASE_ADMIN_URL: Redacted.value(settings.admin),
    DATABASE_URL: Redacted.value(settings.runtime),
  });
  const owned = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1258-privacy-drain',
    sourceConnections,
  });
  yield* owned.migrateCoreSchema();
  const database = yield* makeCoreDatabase(owned.connections.admin);
  const [identity] = yield* database.executor.execute<{
    readonly databaseOid: string;
    readonly systemIdentifier: string;
  }>(
    sql`select d.oid::text as "databaseOid",(pg_control_system()).system_identifier::text as "systemIdentifier" from pg_database d where d.datname=current_database()`,
    'objects',
  );
  if (identity === undefined) {
    return yield* failure('Creator native database identity unavailable');
  }
  const fs = yield* FileSystem.FileSystem;
  const evidenceDirectory = yield* fs.makeTempDirectoryScoped({ directory: '/tmp', prefix: 'ontos-1258-operator-' });
  yield* fs.chmod(evidenceDirectory, 0o700);
  const buildDirectory = yield* fs.makeTempDirectoryScoped({
    directory: `${appRoot}verticals/privacy/node_modules`,
    prefix: '.1258-operator-',
  });
  yield* fs.chmod(buildDirectory, 0o700);
  const artifact = `${buildDirectory}/owner.mjs`;
  const build = yield* ChildProcess.make(
    'mise',
    [
      'exec',
      '--',
      'pnpm',
      'exec',
      'esbuild',
      'verticals/privacy/tests/support/privacy-legacy-publication-fixture.ts',
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--packages=external',
      `--outfile=${artifact}`,
    ],
    { cwd: appRoot, env: buildEnvironment, extendEnv: false, stderr: 'pipe', stdout: 'pipe' },
  );
  const [buildCode] = yield* Effect.all(
    [build.exitCode, Stream.runDrain(build.stdout), Stream.runDrain(build.stderr)],
    { concurrency: 3 },
  );
  if (buildCode !== 0) {
    return yield* failure('Owner fixture artifact build failed');
  }
  const environment = {
    DATABASE_ADMIN_URL: owned.connections.admin.connectionString,
    DATABASE_URL: owned.connections.runtime.connectionString,
    ONTOS_1258_OWNED_DATABASE: owned.connections.admin.database,
    ONTOS_1258_OWNED_DATABASE_OID: identity.databaseOid,
    ONTOS_1258_OWNED_SYSTEM_IDENTIFIER: identity.systemIdentifier,
    ONTOS_1258_PRIVACY_DIRECTORY: `${appRoot}verticals/privacy`,
    ...buildEnvironment,
  };
  const ownerCommand = Effect.fn('OperatorPublicationTest.ownerCommand')(function* ownerCommand(
    command: 'describe' | 'prepare-empty' | 'observe',
  ) {
    const child = yield* ChildProcess.make(process.execPath, [artifact, command], {
      cwd: appRoot,
      env: command === 'describe' ? { PATH: settings.path } : environment,
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
      return yield* failure('Closed Privacy fixture command failed');
    }
    return lines[0];
  });
  const description = yield* ownerCommand('describe').pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(descriptionSchema))),
  );
  expect(description.commands).toEqual(commands);
  yield* ownerCommand('prepare-empty').pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(replySchema))),
  );
  const observeOwner = ownerCommand('observe').pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(replySchema))),
  );
  const initialOwner = yield* observeOwner;
  expect(initialOwner).toMatchObject({ dispatches: 0, outcomes: 0, type: 'observation' });
  const configuration = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      CLOUDFLARE_API_TOKEN: 'operator-TEST-cloudflare-token',
      DATABASE_ADMIN_URL: environment.DATABASE_ADMIN_URL,
      DATABASE_URL: environment.DATABASE_URL,
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: providerUrl,
      ONTOS_LEGACY_COMPLETION_EVIDENCE_DIRECTORY: evidenceDirectory,
      ZEROPS_TOKEN: 'operator-TEST-zerops-token',
    }),
  );
  // Root assembly verifies the actual runtime endpoint before any public business child
  // can run. This unused lease establishes identity only, never operator authorization.
  const runtimeBinding = yield* privacyLegacyCompletionOwner
    .withLease((lease) => Effect.succeed(lease.binding))
    .pipe(Effect.provide(configuration));
  if (
    runtimeBinding.databaseOid !== identity.databaseOid ||
    runtimeBinding.systemIdentifier !== identity.systemIdentifier
  ) {
    return yield* failure('Public fixture runtime endpoint differs from its creator database');
  }
  const owners = ApplicationCompositionLegacyOwnersLive.pipe(Layer.provide(configuration));
  const pointer = yield* Ref.make(Option.none<string>());
  const rejectPut = yield* Ref.make(false);
  const requests = yield* Ref.make<readonly string[]>([]);
  const puts = yield* Ref.make<readonly ProviderPut[]>([]);
  const onPut = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  // Only the provider HttpClient is TEST transport. Native identities, runtime challenge,
  // all-row owner scan, retention, table locks and Core transactions are production code.
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* providerTransport() {
        yield* Ref.update(requests, (values) => [...values, `${request.method} ${url.pathname}`]);
        expect(url.origin).toBe('https://api.cloudflare.com');
        expect(request.headers.authorization).toBe('Bearer operator-TEST-cloudflare-token');
        if (url.pathname === `${retiredNamespacePath}/values/active` && request.method === 'GET') {
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }));
        }
        if (url.pathname === retiredNamespacePath && request.method === 'GET') {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ errors: [], result: { id: retiredNamespace }, success: true }),
          );
        }
        expect(url.pathname).toBe(pointerPath);
        if (request.method === 'GET') {
          return HttpClientResponse.fromWeb(
            request,
            Option.match(yield* Ref.get(pointer), {
              onNone: () => new Response(null, { status: 404 }),
              onSome: (value) => new Response(value),
            }),
          );
        }
        expect(request.method).toBe('PUT');
        const encoded = Match.value(request.body).pipe(
          Match.tag('Uint8Array', (body) => new TextDecoder().decode(body.body)),
          Match.orElse(() => ''),
        );
        expect(encoded.length).toBeGreaterThan(0);
        yield* yield* Ref.get(onPut);
        const rejected = yield* Ref.get(rejectPut);
        const responseBody = { success: !rejected };
        const response = Response.json(responseBody);
        yield* Ref.update(puts, (values) => [
          ...values,
          {
            body: encoded,
            bodySha256: createHash('sha256').update(encoded).digest('hex'),
            method: request.method,
            rejected,
            responseBody,
            responseStatus: response.status,
            url: url.href,
          },
        ]);
        if (rejected) {
          return HttpClientResponse.fromWeb(request, response);
        }
        yield* Ref.set(pointer, Option.some(encoded));
        return HttpClientResponse.fromWeb(request, response);
      }),
    ),
  );
  const provider = Layer.mergeAll(http, ZeropsPublicApiLive.pipe(Layer.provide(http), Layer.provide(configuration)));
  const proof = verifyInitialCutoverProviderInventory({
    cloudflare: {
      accountId: account,
      compositionPointer: { namespaceId: retiredNamespace, sha256: '0'.repeat(64) },
      workerNames: [],
    },
    zeropsServiceIds: [],
  });
  const publication = Layer.mergeAll(configuration, owners, provider, Layer.succeed(CoreDatabase, database));
  const observeAuthority = database.executor
    .select()
    .from(applicationCompositionAuthority)
    .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
  const startWriter = Effect.fn('OperatorPublicationTest.startWriter')(function* startWriter() {
    const replies = yield* Queue.make<string, OperatorPublicationTestFailure>();
    const input = yield* Queue.make<Uint8Array>();
    yield* Effect.addFinalizer(() => Queue.shutdown(input));
    yield* Effect.addFinalizer(() => Queue.shutdown(replies));
    const child = yield* ChildProcess.make(process.execPath, [artifact, 'hold-owner-write'], {
      cwd: appRoot,
      env: environment,
      extendEnv: false,
      stderr: 'pipe',
      stdin: Stream.fromQueue(input),
      stdout: 'pipe',
    });
    yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => Queue.offer(replies, line)),
      Effect.ensuring(Queue.fail(replies, failure('Owner writer exited before its next response'))),
      Effect.forkScoped,
    );
    const next = Queue.take(replies).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(replySchema))),
    );
    const started = yield* next;
    if (!('pid' in started) || started.type !== 'writer-started') {
      return yield* failure('Owner writer did not report its backend');
    }
    expect(started.databaseOid).toBe(identity.databaseOid);
    return {
      child,
      native: started,
      next,
      pid: started.pid,
      release: Queue.offer(input, new TextEncoder().encode('"release"\n')),
    };
  });
  const childContext = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>();
  return {
    capability: {
      creatorPid: process.pid,
      databaseName: owned.connections.admin.database,
      databaseOid: identity.databaseOid,
      systemIdentifier: identity.systemIdentifier,
    },
    configuration,
    database,
    evidenceDirectory,
    fs,
    initialOwner,
    observeAuthority,
    observeOwner,
    onPut,
    owned,
    pointer,
    proof,
    publication,
    puts,
    rejectPut,
    requests,
    startWriter: () => startWriter().pipe(Effect.provideContext(childContext)),
  };
});

it('validates only the closed operator fixture protocol', () => {
  expect(
    Schema.is(descriptionSchema)({
      commands,
      historicalProducer: 'unavailable',
      owner: fixtureOwner,
      protocolVersion: 1,
      publicAckProducer: 'unavailable',
    }),
  ).toBe(true);
  expect(Schema.is(descriptionSchema)({ commands: ['execute-sql'], owner: fixtureOwner, protocolVersion: 1 })).toBe(
    false,
  );
  const transaction = { backendXid: '789', databaseOid: '456', pid: 123, virtualTransaction: '4/5' };
  expect(sameNativeTransaction(transaction, transaction)).toBe(true);
  for (const unrelated of [
    { ...transaction, pid: 124 },
    { ...transaction, databaseOid: '457' },
    { ...transaction, backendXid: '790' },
    { ...transaction, virtualTransaction: '4/6' },
  ]) {
    expect(sameNativeTransaction(unrelated, transaction)).toBe(false);
  }
  const body = '{"composition":{"revision":"replacement"}}';
  const rejectedPut = {
    body,
    bodySha256: createHash('sha256').update(body).digest('hex'),
    method: 'PUT',
    rejected: true,
    responseBody: { success: false },
    responseStatus: 200,
    url: providerUrl,
  };
  expect(isExpectedRejectedPut(rejectedPut, body)).toBe(true);
  for (const unrelated of [
    { ...rejectedPut, method: 'GET' },
    { ...rejectedPut, url: `${providerUrl}-unrelated` },
    { ...rejectedPut, body: `${body} ` },
    { ...rejectedPut, bodySha256: '0'.repeat(64) },
    { ...rejectedPut, responseStatus: 503 },
    { ...rejectedPut, responseBody: { success: true } },
    { ...rejectedPut, rejected: false },
  ]) {
    expect(isExpectedRejectedPut(unrelated, body)).toBe(false);
  }
});

it.live('publishes only after real same-database empty-owner proof', () =>
  Effect.gen(function* emptyOwnerPublication() {
    const fixture = yield* makeFixture();
    expect(yield* fixture.observeAuthority).toEqual([]);
    const first = yield* snapshot('empty', 0);
    yield* publishSnapshot(first, Option.none(), fixture.proof).pipe(Effect.provide(fixture.publication));
    expect(yield* fixture.observeAuthority).toMatchObject([{ phase: 'active', revision: first.composition.revision }]);
    expect(yield* fixture.observeOwner).toEqual(fixture.initialOwner);
    const retained = yield* fixture.fs.readDirectory(fixture.evidenceDirectory);
    expect(retained.length).toBe(1);
    const path = `${fixture.evidenceDirectory}/${retained[0]}`;
    expect((yield* fixture.fs.stat(path)).mode % 0o1000).toBe(0o600);
    expect((yield* fixture.fs.stat(fixture.evidenceDirectory)).mode % 0o1000).toBe(0o700);
    const observation = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.toCodecJson(LegacyCompletionRetainedObservationSchema)),
    )(yield* fixture.fs.readFileString(path));
    expect(observation).toMatchObject({
      binding: { databaseName: fixture.owned.connections.admin.database },
      status: 'VERIFIED_ABSENT',
    });
    expect(Option.isSome(yield* Ref.get(fixture.pointer))).toBe(true);
  }).pipe(Effect.provide(services)),
);

it.live('refuses actual foreign runtime pairing and escaped or reused owner evidence', () =>
  Effect.gen(function* foreignAndStaleOwner() {
    const fixture = yield* makeFixture();
    const foreign = yield* makeIsolatedNativeDatabaseFixture({
      mode: 'empty',
      purpose: 'stabilization-1258-privacy-drain',
      sourceConnections: fixture.owned.connections,
    });
    // The runtime really connects to the second created database. The production native
    // advisory challenge can be acquired there and must reject the physical pairing.
    const foreignConfiguration = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        DATABASE_ADMIN_URL: fixture.owned.connections.admin.connectionString,
        DATABASE_URL: foreign.connections.runtime.connectionString,
      }),
    );
    const nativePairError = yield* privacyLegacyCompletionOwner
      .withLease(() => Effect.void)
      .pipe(Effect.provide(foreignConfiguration), Effect.flip);
    expect(nativePairError).toMatchObject({
      reason: 'Privacy requires verified runtime and administrative connections to the same native database',
    });
    const saved = yield* Ref.make(Option.none<LegacyCompletionOwnerLease>());
    yield* privacyLegacyCompletionOwner
      .withLease((lease) => Ref.set(saved, Option.some(lease)))
      .pipe(Effect.provide(fixture.configuration));
    const escaped = yield* Ref.get(saved);
    const lease = yield* Option.match(escaped, {
      onNone: () => Effect.fail(failure('Live owner lease was not obtained')),
      onSome: Effect.succeed,
    });
    const observation = {
      binding: { ...lease.binding, expectedRevision: Option.none<string>() },
      complete: true,
      evidenceReference: 'TEST:escaped',
      messages: [],
    };
    const stale = yield* lease.verify(observation).pipe(Effect.flip);
    expect(Schema.is(LegacyCompletionPublicationError)(stale)).toBe(true);
    yield* privacyLegacyCompletionOwner
      .withLease((live) =>
        Effect.gen(function* consumeLeaseOnlyOnce() {
          const current = { ...observation, binding: { ...live.binding, expectedRevision: Option.none<string>() } };
          expect((yield* live.verify(current)).status).toBe('VERIFIED_ABSENT');
          expect(Schema.is(LegacyCompletionPublicationError)(yield* live.verify(current).pipe(Effect.flip))).toBe(true);
        }),
      )
      .pipe(Effect.provide(fixture.configuration));
    expect(yield* fixture.observeAuthority).toEqual([]);
  }).pipe(Effect.provide(services)),
);

it.live('refuses publication when mandatory evidence retention fails', () =>
  Effect.gen(function* retentionRefusal() {
    const fixture = yield* makeFixture();
    // Build the actual operator layer against a valid private directory, then make its
    // exclusively owned destination unavailable. No owners/retainEvidence stub is installed.
    const context = yield* Layer.build(fixture.publication);
    yield* fixture.fs.remove(fixture.evidenceDirectory, { recursive: true });
    yield* fixture.fs.writeFileString(fixture.evidenceDirectory, 'TEST retention unavailable', {
      flag: 'wx',
      mode: 0o600,
    });
    const first = yield* snapshot('retention', 0);
    const rejected = yield* publishSnapshot(first, Option.none(), fixture.proof).pipe(
      Effect.provideContext(context),
      Effect.flip,
    );
    expect(Schema.is(LegacyCompletionPublicationError)(rejected)).toBe(true);
    expect(rejected).toMatchObject({ reason: 'The native legacy completion observation could not be retained' });
    expect(yield* fixture.observeAuthority).toEqual([]);
    expect(yield* Ref.get(fixture.pointer)).toEqual(Option.none());
    expect((yield* Ref.get(fixture.requests)).some((request) => request.startsWith('PUT'))).toBe(false);
    expect(yield* fixture.observeOwner).toEqual(fixture.initialOwner);
  }).pipe(Effect.provide(services)),
);

it.live('preserves committed drain and seal when actual provider or migration settlement fails', () =>
  Effect.gen(function* truthfulFailureSettlement() {
    const fixture = yield* makeFixture();
    const first = yield* snapshot('before-failure', 0);
    yield* publishSnapshot(first, Option.none(), fixture.proof).pipe(Effect.provide(fixture.publication));
    const previousPointer = yield* Ref.get(fixture.pointer);
    expect((yield* Ref.get(fixture.puts)).length).toBe(1);
    yield* Ref.set(fixture.puts, []);
    yield* Ref.set(fixture.requests, []);
    yield* Ref.set(fixture.rejectPut, true);
    const next = yield* snapshot('failed-replacement', 1000);
    const rejected = yield* publishSnapshot(next, Option.none(), fixture.proof).pipe(
      Effect.provide(fixture.publication),
      Effect.flip,
    );
    expect(Schema.is(ActiveApplicationCompositionPublicationError)(rejected)).toBe(true);
    expect(rejected).toMatchObject({
      message: 'composition storage rejected the write',
      reason: 'publication_failed',
    });
    const attemptedPuts = yield* Ref.get(fixture.puts);
    expect(attemptedPuts.length).toBe(1);
    const attemptedPut = yield* requireObservation(attemptedPuts[0], 'Replacement provider PUT was not observed');
    expect(isExpectedRejectedPut(attemptedPut, yield* encodeActiveApplicationCompositionSnapshot(next))).toBe(true);
    expect((yield* Ref.get(fixture.requests)).filter((request) => request.startsWith('PUT'))).toEqual([
      `PUT ${pointerPath}`,
    ]);
    yield* Effect.logInfo('Operator replacement provider rejection', attemptedPut);
    expect(yield* fixture.observeAuthority).toMatchObject([
      { durableWorkAdmission: 'closed', phase: 'draining', revision: first.composition.revision },
    ]);
    expect(yield* Ref.get(fixture.pointer)).toEqual(previousPointer);
    const migrationFailure = failure('TEST migration callback failed after committed seal');
    expect(
      yield* runApplicationCompositionMigration(Effect.fail(migrationFailure), fixture.proof).pipe(
        Effect.provide(fixture.publication),
        Effect.flip,
      ),
    ).toBe(migrationFailure);
    expect(yield* fixture.observeAuthority).toMatchObject([
      { durableWorkAdmission: 'closed', phase: 'sealed', revision: first.composition.revision },
    ]);
    expect(yield* fixture.observeOwner).toEqual(fixture.initialOwner);
  }).pipe(Effect.provide(services)),
);

it.live('holds owner proof through actual Core commit', () =>
  Effect.gen(function* nativeCommitFence() {
    const fixture = yield* makeFixture();
    const client = fixture.database.executor.$client;
    const blocker = yield* client.reserve;
    const key = '12580061023';
    yield* blocker.executeValues('select pg_advisory_lock($1::bigint)', [key]);
    yield* Effect.addFinalizer(() =>
      blocker.executeValues('select pg_advisory_unlock($1::bigint)', [key]).pipe(Effect.orDie),
    );
    // Root/Core-owned native test trigger: COMMIT is parked after the provider callback
    // returns, so a pre-COMMIT owner-lock release cannot pass this test accidentally.
    yield* fixture.database.executor.execute(
      sql`create function core.privacy_publication_test_commit_barrier() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(12580061023); return new; end $$`,
      'objects',
    );
    yield* fixture.database.executor.execute(
      sql`create constraint trigger privacy_publication_test_commit_barrier after insert on core.application_composition_authority deferrable initially deferred for each row execute function core.privacy_publication_test_commit_barrier()`,
      'objects',
    );
    const [barrier] = yield* blocker.executeValues(
      'select pg_backend_pid(), (select oid::text from pg_database where datname=current_database())',
      [],
    );
    const barrierPid = yield* Schema.decodeUnknownEffect(Schema.Int)(barrier?.[0]);
    expect(barrier?.[1]).toBe(fixture.capability.databaseOid);
    const writerReady = yield* Deferred.make<
      {
        readonly owner: NativeTransaction;
        readonly publication: NativeTransaction;
        readonly writer: Effect.Success<ReturnType<typeof fixture.startWriter>>;
      },
      OperatorPublicationTestFailure
    >();
    const relations = yield* fixture.database.executor.execute<{ readonly oid: string }>(
      sql`select c.oid::text as oid from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='privacy' and c.relname in ('privacy_measure_dispatches','owner_execution_outcomes') order by c.oid`,
      'objects',
    );
    expect(relations.length).toBe(2);
    const dispatchOrOutcome = yield* requireObservation(relations[0], 'First owner relation identity unavailable');
    const otherRelation = yield* requireObservation(relations[1], 'Second owner relation identity unavailable');
    // Match both owner SHARE relations, their retained owner transaction, and the
    // exact writer's actual blocker. Never accept another relation or another holder.
    const observeWriter = (writer: NativeTransaction, owner: NativeTransaction) =>
      fixture.database.executor.execute<{
        readonly blockerPids: readonly number[];
        readonly databaseOid: string;
        readonly ownerPid: number;
        readonly ownerVirtualTransaction: string;
        readonly ownerXid: string;
        readonly relationOid: string;
        readonly writerPid: number;
        readonly writerVirtualTransaction: string;
        readonly writerXid: string;
      }>(
        sql`select w.pid as "writerPid",w.database::text as "databaseOid",w.relation::text as "relationOid",
          w.virtualtransaction as "writerVirtualTransaction",writer_tx.transactionid::text as "writerXid",
          h.pid as "ownerPid",h.virtualtransaction as "ownerVirtualTransaction",tx.transactionid::text as "ownerXid",
          pg_blocking_pids(w.pid) as "blockerPids" from pg_locks w join pg_locks h
        on h.database=w.database and h.relation=w.relation
        join pg_locks tx on tx.pid=h.pid and tx.locktype='transactionid' and tx.granted and tx.mode='ExclusiveLock'
        join pg_locks writer_tx on writer_tx.pid=w.pid and writer_tx.locktype='transactionid' and writer_tx.granted and writer_tx.mode='ExclusiveLock'
        where w.pid=${writer.pid} and w.database=${fixture.capability.databaseOid}::oid
          and w.virtualtransaction=${writer.virtualTransaction} and writer_tx.transactionid::text=${writer.backendXid}
          and w.locktype='relation' and w.mode='RowExclusiveLock' and not w.granted
          and w.relation in (${dispatchOrOutcome.oid}::oid,${otherRelation.oid}::oid)
          and h.pid=${owner.pid} and h.locktype='relation' and h.mode='ShareLock' and h.granted
          and h.virtualtransaction=${owner.virtualTransaction} and tx.transactionid::text=${owner.backendXid}
          and ${owner.pid}=any(pg_blocking_pids(${writer.pid}))
          and (select count(*) from pg_locks held where held.pid=${owner.pid} and held.database=${owner.databaseOid}::oid
            and held.locktype='relation' and held.mode='ShareLock' and held.granted
            and held.virtualtransaction=${owner.virtualTransaction}
            and held.relation in (${dispatchOrOutcome.oid}::oid,${otherRelation.oid}::oid))=2`,
        'objects',
      );
    yield* Ref.set(
      fixture.onPut,
      Effect.gen(function* beginContendingWriter() {
        // Same PgClient transactionService as Drizzle: this query runs in the real
        // ambient Core transaction, not a newly reserved observer connection.
        const publicationRows = yield* fixture.database.executor.execute<
          NativeTransaction & { readonly transactionId: string }
        >(
          sql`select pg_backend_pid() as pid, d.oid::text as "databaseOid", pg_current_xact_id()::text as "transactionId",
            (pg_current_xact_id()::text::bigint % 4294967296)::text as "backendXid", l.virtualtransaction as "virtualTransaction"
            from pg_database d join pg_locks l on l.pid=pg_backend_pid() and l.locktype='transactionid' and l.granted
              and l.mode='ExclusiveLock' and l.transactionid::text=(pg_current_xact_id()::text::bigint % 4294967296)::text
            where d.datname=current_database()`,
          'objects',
        );
        const publication = yield* requireObservation(
          publicationRows[0],
          'Ambient publication transaction identity unavailable',
        );
        const retainedNames = yield* fixture.fs.readDirectory(fixture.evidenceDirectory);
        expect(retainedNames.length).toBe(1);
        const retained = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.toCodecJson(LegacyCompletionRetainedObservationSchema)),
        )(yield* fixture.fs.readFileString(`${fixture.evidenceDirectory}/${retainedNames[0]}`));
        expect(publication.databaseOid).toBe(fixture.capability.databaseOid);
        expect(publication.transactionId).toBe(retained.binding.transactionId);
        expect(retained.ownerBinding.databaseOid).toBe(fixture.capability.databaseOid);
        yield* Effect.logInfo('Operator COMMIT fence retained native bindings', retained);
        const ownerXid = String(BigInt(retained.ownerBinding.transactionId) % 4_294_967_296n);
        const owners = yield* fixture.database.executor.execute<NativeTransaction>(
          sql`select a.pid, a.datid::text as "databaseOid", l.transactionid::text as "backendXid", l.virtualtransaction as "virtualTransaction"
            from pg_stat_activity a join pg_locks l on l.pid=a.pid and l.locktype='transactionid' and l.granted and l.mode='ExclusiveLock'
            where a.datid=${retained.ownerBinding.databaseOid}::oid and a.usename=${retained.ownerBinding.databaseUser}
              and l.transactionid::text=${ownerXid}`,
          'objects',
        );
        expect(owners.length).toBe(1);
        const owner = yield* requireObservation(owners[0], 'Retained owner transaction backend unavailable');
        const writer = yield* fixture.startWriter();
        yield* observeWriter(writer.native, owner).pipe(
          Effect.repeat({ until: (rows) => rows.length === 1 }),
          Effect.timeout('5 seconds'),
        );
        yield* Deferred.succeed(writerReady, { owner, publication, writer });
      }).pipe(Effect.orDie),
    );
    const first = yield* snapshot('commit-fence', 0);
    const publisher = yield* publishSnapshot(first, Option.none(), fixture.proof).pipe(
      Effect.provide(fixture.publication),
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? Deferred.fail(writerReady, failure('Publication failed before the commit fence')).pipe(Effect.asVoid)
          : Effect.void,
      ),
      Effect.forkChild,
    );
    const { owner, publication, writer } = yield* Deferred.await(writerReady);
    const committing = yield* fixture.database.executor
      .execute<NativeTransaction & { readonly committing: boolean }>(
        sql`select a.pid, a.datid::text as "databaseOid", tx.transactionid::text as "backendXid", tx.virtualtransaction as "virtualTransaction",
        exists(select 1 from pg_locks w join pg_locks h on h.database=w.database and h.classid=w.classid and h.objid=w.objid and h.objsubid=w.objsubid
          where w.pid=a.pid and w.database=${fixture.capability.databaseOid}::oid and w.locktype='advisory' and w.mode='ExclusiveLock' and not w.granted
          and w.classid::text=(12580061023::bigint / 4294967296)::text and w.objid::text=(12580061023::bigint % 4294967296)::text and w.objsubid=1
          and w.virtualtransaction=${publication.virtualTransaction}
          and h.pid=${barrierPid} and h.locktype='advisory' and h.mode='ExclusiveLock' and h.granted
          and ${barrierPid}=any(pg_blocking_pids(a.pid))) as committing
        from pg_stat_activity a join pg_locks tx on tx.pid=a.pid and tx.locktype='transactionid' and tx.mode='ExclusiveLock' and tx.granted
        where a.pid=${publication.pid} and a.datid=${publication.databaseOid}::oid`,
        'objects',
      )
      .pipe(Effect.repeat({ until: (rows) => rows.length === 1 && rows[0]?.committing }), Effect.timeout('5 seconds'));
    const committedTransaction = yield* requireObservation(
      committing[0],
      'Exact publication COMMIT waiter unavailable',
    );
    expect(sameNativeTransaction(committedTransaction, publication)).toBe(true);
    const writerWaiting = yield* observeWriter(writer.native, owner);
    expect(writerWaiting.length).toBe(1);
    yield* Effect.logInfo('Operator attributed COMMIT fence', {
      advisoryKey: key,
      barrierPid,
      committing,
      owner,
      publication,
      relations,
      writer: writer.native,
      writerWaiting,
    });
    expect(yield* fixture.observeAuthority).toEqual([]);
    yield* blocker.executeValues('select pg_advisory_unlock($1::bigint)', [key]);
    yield* Fiber.join(publisher);
    expect(yield* writer.next).toMatchObject({ pid: writer.pid, type: 'writer-held' });
    expect(yield* fixture.observeAuthority).toMatchObject([{ phase: 'active', revision: first.composition.revision }]);
    yield* writer.release;
    expect(yield* writer.next).toMatchObject({ type: 'released' });
    expect(yield* writer.child.exitCode).toBe(0);
    expect(yield* fixture.observeOwner).toEqual(fixture.initialOwner);
  }).pipe(Effect.provide(services)),
);

it.live('retains committed authority when the real owner connection fails after Core commit', () =>
  Effect.gen(function* ownerConnectionFailureAfterCommit() {
    const fixture = yield* makeFixture();
    const first = yield* snapshot('owner-settlement', 0);
    const saved = yield* Ref.make(Option.none<LegacyCompletionOwnerLease>());
    const committed = yield* Ref.make(false);
    const original = yield* LegacyCompletionPublication.pipe(Effect.provide(fixture.publication));
    const terminateExactOwnerAfterCommit = (lease: LegacyCompletionOwnerLease) =>
      Effect.gen(function* terminateObservedOwner() {
        // The real nested Core transaction has returned. Observe its committed row
        // before interrupting only the still-live owner transaction on this clone.
        expect(yield* fixture.observeAuthority).toMatchObject([
          { phase: 'active', revision: first.composition.revision },
        ]);
        expect(lease.binding.databaseOid).toBe(fixture.capability.databaseOid);
        expect(lease.binding.systemIdentifier).toBe(fixture.capability.systemIdentifier);
        const xid = String(BigInt(lease.binding.transactionId) % 4_294_967_296n);
        const owners = yield* fixture.database.executor.execute<{ readonly pid: number }>(
          sql`select a.pid from pg_stat_activity a join pg_locks l on l.pid=a.pid
                    where a.datid=${fixture.capability.databaseOid}::oid
                      and a.usename=${lease.binding.databaseUser} and a.pid<>pg_backend_pid()
                      and l.locktype='transactionid' and l.granted and l.mode='ExclusiveLock'
                      and l.transactionid::text=${xid}`,
          'objects',
        );
        expect(owners.length).toBe(1);
        const [observedOwner] = owners;
        const owner = yield* requireObservation(observedOwner, 'Owner settlement transaction was not observed');
        yield* Ref.set(committed, true);
        const terminated = yield* fixture.database.executor.execute<{ readonly terminated: boolean }>(
          sql`select pg_terminate_backend(a.pid) as terminated from pg_stat_activity a
                    join pg_locks l on l.pid=a.pid
                    where a.pid=${owner.pid} and a.datid=${fixture.capability.databaseOid}::oid
                      and a.usename=${lease.binding.databaseUser} and a.pid<>pg_backend_pid()
                      and l.locktype='transactionid' and l.granted and l.mode='ExclusiveLock'
                      and l.transactionid::text=${xid}`,
          'objects',
        );
        expect(terminated).toEqual([{ terminated: true }]);
      }).pipe(
        Effect.mapError(
          (cause) => new LegacyCompletionPublicationError({ cause, reason: 'Native owner settlement probe failed' }),
        ),
      );
    const interruptedOwner: LegacyCompletionOwnerVerifier = {
      ...privacyLegacyCompletionOwner,
      withLease: <Value, Failure, Requirements>(
        use: (lease: LegacyCompletionOwnerLease) => Effect.Effect<Value, Failure, Requirements>,
      ) =>
        privacyLegacyCompletionOwner.withLease((lease) =>
          use(lease).pipe(
            Effect.tap(() => Ref.set(saved, Option.some(lease))),
            Effect.tap(() => terminateExactOwnerAfterCommit(lease)),
          ),
        ),
    };
    const error = yield* publishSnapshot(first, Option.none(), fixture.proof).pipe(
      Effect.provide(Layer.succeed(LegacyCompletionPublication, { ...original, owners: [interruptedOwner] })),
      Effect.provide(fixture.publication),
      Effect.flip,
    );
    expect(Schema.is(LegacyCompletionPublicationError)(error)).toBe(true);
    expect(error).toMatchObject({ reason: 'Privacy legacy completion evidence is unavailable' });
    expect(yield* Ref.get(committed)).toBe(true);
    expect(yield* fixture.observeAuthority).toMatchObject([{ phase: 'active', revision: first.composition.revision }]);
    const encoded = yield* encodeActiveApplicationCompositionSnapshot(first);
    expect(yield* Ref.get(fixture.pointer)).toEqual(Option.some(encoded));
    expect(yield* fixture.observeOwner).toEqual(fixture.initialOwner);
    const retainedNames = yield* fixture.fs.readDirectory(fixture.evidenceDirectory);
    expect(retainedNames.length).toBe(1);
    const retained = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.toCodecJson(LegacyCompletionRetainedObservationSchema)),
    )(yield* fixture.fs.readFileString(`${fixture.evidenceDirectory}/${retainedNames[0]}`));
    expect(retained).toMatchObject({
      ownerBinding: { databaseOid: fixture.capability.databaseOid },
      status: 'VERIFIED_ABSENT',
    });
    const lease = yield* Option.match(yield* Ref.get(saved), {
      onNone: () => Effect.fail(failure('Owner settlement probe did not retain its lease')),
      onSome: Effect.succeed,
    });
    const expired = yield* lease
      .verify({
        binding: retained.binding,
        complete: true,
        evidenceReference: retained.evidenceReference,
        messages: [],
      })
      .pipe(Effect.flip);
    expect(Schema.is(LegacyCompletionPublicationError)(expired)).toBe(true);
  }).pipe(Effect.provide(services)),
);

it('validates creator capability schema and frozen-source hash discrimination without native setup', () => {
  expect(
    Schema.is(PublicCompletionCapabilitySchema)({
      creatorPid: process.pid,
      databaseName: `ontos_test_party_gateway_${'a'.repeat(32)}`,
      databaseOid: '123',
      systemIdentifier: '456',
    }),
  ).toBe(true);
  expect(
    Schema.is(PublicCompletionCapabilitySchema)({
      creatorPid: 0,
      databaseName: 'ambient',
      databaseOid: 'x',
      systemIdentifier: '456',
    }),
  ).toBe(false);
  expect(Schema.is(PublicCompletionProducerSchema)('arbitrary-source')).toBe(false);
  const source = readFileSync(
    new URL('../../verticals/privacy/tests/support/privacy-completion-http.ts', import.meta.url),
    'utf-8',
  );
  const literal = /const legacyDispatchSource =\s*(?<source>"(?:[^"\\]|\\.)*")/u.exec(source)?.groups?.source;
  const frozen = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String))(literal);
  expect(frozenDispatchMatches(frozen)).toBe(true);
  expect(frozenDispatchMatches(`${frozen}\n`)).toBe(false);
  expect(frozenDispatchMatches('new format with metadata reset to null')).toBe(false);
  expect(LEGACY_DISPATCH_SHA256).toBe('dc8a3848294951d5f54ce8758e506ca556ce37c42911c2a693c406a02a5c8132');
});

for (const phase of ['active', 'draining', 'sealed'] as const) {
  it.live(
    `refuses genuine unmarked old-producer history at first owner-verifier publication or recovered ${phase}`,
    () =>
      Effect.gen(function* realOldProducerRefusal() {
        const fixture = yield* makeFixture();
        const session = yield* makePrivacyPublicCompletionSession({
          capability: fixture.capability,
          connections: fixture.owned.connections,
          producer: 'legacy',
        }).pipe(Effect.provideService(CoreDatabase, fixture.database));
        const produced = yield* session.run();
        expect(produced.producerSha256).toBe(LEGACY_DISPATCH_SHA256);
        expect(produced.invocationId).not.toBeNull();
        const observeCore = Effect.all([
          fixture.database.executor
            .select()
            .from(outboxMessages)
            .where(eq(outboxMessages.outboxMessageId, produced.messageId)),
          fixture.database.executor
            .select()
            .from(outboxDeliveries)
            .where(eq(outboxDeliveries.outboxMessageId, produced.messageId)),
        ]);
        const originalCoreHash = createHash('sha256')
          .update(JSON.stringify(yield* observeCore))
          .digest('hex');
        const before = yield* fixture.observeOwner;
        expect(before).toMatchObject({
          dispatches: 1,
          measureIds: [produced.measureId],
          outcomeIds: [produced.outcomeId],
          outcomes: 1,
        });
        if (phase !== 'active') {
          yield* fixture.database.executor.transaction((transaction) =>
            closeApplicationCompositionDurableAdmission(transaction, session.snapshot.composition.revision).pipe(
              Effect.andThen(drainApplicationCompositionAuthority(transaction, session.snapshot.composition.revision)),
            ),
          );
        }
        if (phase === 'sealed') {
          yield* fixture.database.executor.transaction((transaction) =>
            sealApplicationCompositionAuthority(transaction, session.snapshot.composition.revision),
          );
        }
        const calls = yield* Ref.make(0);
        const attempted =
          phase === 'sealed'
            ? runApplicationCompositionMigration(
                Ref.update(calls, (value) => value + 1),
                fixture.proof,
              )
            : publishSnapshot(yield* snapshot(`old-${phase}`, 10_000), Option.none(), fixture.proof);
        const refused = yield* attempted.pipe(Effect.provide(fixture.publication), Effect.flip);
        expect(Schema.is(LegacyCompletionPublicationError)(refused)).toBe(true);
        expect(yield* Ref.get(calls)).toBe(0);
        expect(yield* fixture.observeAuthority).toMatchObject([
          { phase, revision: session.snapshot.composition.revision },
        ]);
        expect(yield* fixture.observeOwner).toEqual(before);
        expect(
          createHash('sha256')
            .update(JSON.stringify(yield* observeCore))
            .digest('hex'),
        ).toBe(originalCoreHash);
        expect((yield* Ref.get(fixture.requests)).some((request) => request.startsWith('PUT'))).toBe(false);
        const observations = yield* fixture.fs.readDirectory(fixture.evidenceDirectory);
        expect(observations.length).toBeGreaterThan(0);
        for (const name of observations) {
          const retained = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.toCodecJson(LegacyCompletionRetainedObservationSchema)),
          )(yield* fixture.fs.readFileString(`${fixture.evidenceDirectory}/${name}`));
          expect(retained.status).toBe('UNRESOLVED');
          expect(retained.binding.expectedRevision).toEqual(Option.some(session.snapshot.composition.revision));
        }
        yield* session.close;
      }).pipe(Effect.provide(services)),
  );
}

it.live('retains BUSINESS_REJECTED owner history after public ACK and refuses operator promotion', () =>
  Effect.gen(function* actualRejectedOwnerHistory() {
    const fixture = yield* makeFixture();
    const session = yield* makePrivacyPublicCompletionSession({
      capability: fixture.capability,
      connections: fixture.owned.connections,
      producer: 'current',
    }).pipe(Effect.provideService(CoreDatabase, fixture.database));
    const actual = yield* session.run();
    expect(actual.status).toBe('BUSINESS_REJECTED');
    const observeCore = Effect.all([
      fixture.database.executor
        .select()
        .from(outboxMessages)
        .where(eq(outboxMessages.outboxMessageId, actual.messageId)),
      fixture.database.executor
        .select()
        .from(outboxDeliveries)
        .where(eq(outboxDeliveries.outboxMessageId, actual.messageId)),
    ]);
    const originalCoreHash = createHash('sha256')
      .update(JSON.stringify(yield* observeCore))
      .digest('hex');
    const before = yield* fixture.observeOwner;
    expect(before).toMatchObject({
      dispatches: 1,
      measureIds: [actual.measureId],
      outcomeIds: [actual.outcomeId],
      outcomes: 1,
    });
    const refused = yield* publishSnapshot(
      yield* snapshot('business-rejected', 10_000),
      Option.none(),
      fixture.proof,
    ).pipe(Effect.provide(fixture.publication), Effect.flip);
    expect(Schema.is(LegacyCompletionPublicationError)(refused)).toBe(true);
    expect(yield* fixture.observeAuthority).toMatchObject([
      { durableWorkAdmission: 'closed', phase: 'active', revision: session.snapshot.composition.revision },
    ]);
    expect(yield* fixture.observeOwner).toEqual(before);
    expect(
      createHash('sha256')
        .update(JSON.stringify(yield* observeCore))
        .digest('hex'),
    ).toBe(originalCoreHash);
    const retained = yield* fixture.fs.readDirectory(fixture.evidenceDirectory);
    expect(retained.length).toBeGreaterThan(0);
    for (const name of retained) {
      const observation = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.toCodecJson(LegacyCompletionRetainedObservationSchema)),
      )(yield* fixture.fs.readFileString(`${fixture.evidenceDirectory}/${name}`));
      expect(observation.status).toBe('UNRESOLVED');
    }
    yield* session.close;
  }).pipe(Effect.provide(services)),
);

// First owner-verifier publication over an existing pre-verifier active authority is
// distinct from the current===undefined branch. No authority is deleted to manufacture history.
