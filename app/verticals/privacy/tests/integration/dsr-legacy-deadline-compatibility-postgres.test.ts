import { Reactivity } from 'effect/reactivity';
import { PgClient } from '@effect/sql-pg';
import { Socket } from 'effect/socket';
import {
  ActiveApplicationCompositionSnapshotSchema,
  OntosModuleDeploymentContractSchema,
  TrustedPrincipalContextSchema,
  canonicalizeApplicationComposition,
  makeContextPermissionRelationshipMutationLive,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import {
  STAFF_AUTHENTICATION_NAMESPACE_ID,
  staffAuthenticationNamespaceRegistryLayer,
} from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import {
  NodeChildProcessSpawner,
  NodeCrypto,
  NodeHttpServer,
  NodeServices,
  NodeSocketServer,
} from '@effect/platform-node';
import {
  Clock,
  Config,
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Queue,
  Redacted,
  Ref,
  Schema,
  Scope,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/process';
import { HttpServer, HttpServerResponse } from 'effect/http';
import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { expect, it } from 'effect-rstest';
import {
  DsrCaseRequestSchema,
  DsrIntakeReceiptSchema,
  DsrDeadlinePolicySchema,
  DsrDeadlineSchema,
  LegacyDsrDeadlineSchema,
} from '../../shared/domain/privacy-dsr.ts';
import { DsrCasesResponseSchema } from '../../shared/privacy-queries.ts';
import { dsrDeadlines } from '../../src/database/schema.ts';
import { prepareDsrLegacyArtifacts, verifyDsrOwnerLaunchIdentity } from '../support/dsr-legacy-artifacts.ts';
import type { DsrLegacyOwnerArtifact } from '../support/dsr-legacy-artifacts.ts';

class DsrLegacyTestFailure extends Schema.TaggedError<DsrLegacyTestFailure>()('DsrLegacyTestFailure', {
  stage: Schema.String,
}) {}
const failure = (stage: string) => new DsrLegacyTestFailure({ stage });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const appRoot = new URL('../../../../', import.meta.url).pathname;
const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(staffAuthenticationNamespaceRegistryLayer(['privacy'])),
);
const markerSchema = Schema.Struct({ appId: Schema.Literal('privacy'), buildMarker: Schema.String });
const readySchema = Schema.Struct({
  deadlineSchemaVersion: Schema.Literals(['1', '2']),
  deliveryUnit: Schema.Struct({
    appId: Schema.Literal('privacy'),
    buildMarker: Schema.String,
    sourceRevision: Schema.Literal('workspace'),
    unitId: Schema.Literal('app/privacy'),
  }),
  marker: markerSchema,
  type: Schema.Literal('ready'),
});
const resultSchema = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal('success'), type: Schema.Literal('result'), value: Schema.Unknown }),
  Schema.Struct({ outcome: Schema.Literal('refused'), status: Schema.Number, type: Schema.Literal('result') }),
]);
const oldReadSchema = Schema.Struct({
  items: Schema.Array(Schema.Struct({ deadlines: Schema.Array(LegacyDsrDeadlineSchema) })),
});
const io = <A>(stage: string, operation: () => Promise<A>) =>
  Effect.tryPromise({ catch: () => failure(stage), try: operation });
const command = Effect.fn('DsrLegacyTest.ownedMigration')(function* command(env: Readonly<Record<string, string>>) {
  const child = yield* ChildProcess.make('mise', ['exec', '--', 'pnpm', '--filter', '@app/privacy', 'db:migrate'], {
    cwd: appRoot,
    env: { ...env, APP_ENV_PATH: '/dev/null' },
    extendEnv: true,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [code] = yield* Effect.all([child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)], {
    concurrency: 3,
  });
  if (code !== 0) {
    return yield* failure('privacy-migration');
  }
  return yield* Effect.void;
});

// Same current TEST composition seam as the accepted current Deadline native cases.
// It is not a browser/federation deployment receipt.
const makeCurrentNativeSnapshot = Effect.fn('DsrLegacyTest.currentNativeSnapshot')(function* makeCurrentNativeSnapshot(
  buildMarker: string,
  now: number,
) {
  const base = yield* makeApplicationCompositionSnapshotFixture(['privacy'], buildMarker);
  const modules = yield* Effect.forEach(
    base.composition.modules,
    Effect.fn('DsrLegacyTest.currentContract')(function* currentContract(entry) {
      const contract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
        entry.contractDocument,
      );
      const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))({
        ...contract,
        manifest: { ...contract.manifest, module: { ...contract.manifest.module, id: 'privacy.core' } },
      });
      const sha256 = digest(contractDocument);
      return {
        ...entry,
        contract: { ...entry.contract, sha256 },
        contractDocument,
        moduleId: 'privacy.core',
        publicContract: { ...entry.publicContract, id: 'privacy.core', sha256 },
      };
    }),
    { concurrency: 1 },
  );
  const composition = { ...base.composition, modules };
  return yield* validateActiveApplicationCompositionSnapshot({
    composition: {
      ...composition,
      revision: digest(canonicalizeApplicationComposition({ ...composition, revision: '0'.repeat(64) })),
    },
    observedAt: DateTime.makeUnsafe(now - 1000),
    validUntil: DateTime.makeUnsafe(now + 7_200_000),
  });
});

interface DsrLegacyLaunchContext {
  readonly database: string;
  readonly issuer: string;
  readonly key: Awaited<ReturnType<typeof generateKeyPair>>;
  readonly policy: typeof DsrDeadlinePolicySchema.Type;
  readonly principal: typeof TrustedPrincipalContextSchema.Type;
  readonly publicKey: Awaited<ReturnType<typeof exportJWK>>;
  readonly receipt: typeof DsrIntakeReceiptSchema.Type;
  readonly request: typeof DsrCaseRequestSchema.Type;
  readonly runtimeConnection: string;
  readonly runtimeUser: string;
  readonly sourcePort: number;
  readonly transport: {
    readonly PATH: string;
    readonly SPICEDB_CA_CERT: string;
    readonly SPICEDB_ENDPOINT: string;
    readonly SPICEDB_PRESHARED_KEY: Redacted.Redacted;
  };
}
const boundedDsrFrame = (state: { pending: number }) => (bytes: Uint8Array) =>
  Effect.suspend(() => {
    for (const byte of bytes) {
      state.pending = byte === 10 ? 0 : state.pending + 1;
      if (state.pending > 1024 * 1024) {
        return Effect.fail(failure('child-frame-bound'));
      }
    }
    return Effect.succeed(bytes);
  });
const retainDsrFrame = (stopped: Ref.Ref<boolean>, replies: Queue.Queue<string>) =>
  Effect.fn('DsrLegacyTest.retainFrame')(function* retain(line: string) {
    const terminal = Schema.decodeUnknownOption(
      Schema.fromJsonString(Schema.Struct({ type: Schema.Literal('STOPPED') })),
    )(line);
    if (Option.isSome(terminal)) {
      yield* Ref.set(stopped, true);
    }
    yield* Queue.offer(replies, line);
  });
const startDsrLegacyArtifact = Effect.fn('DsrLegacyTest.startOwnedArtifact')(function* start(
  input: DsrLegacyLaunchContext,
  artifact: DsrLegacyOwnerArtifact,
  snapshot: typeof ActiveApplicationCompositionSnapshotSchema.Type,
  expectedVersion: '1' | '2',
  clock: Clock.Clock,
) {
  const {
    database,
    issuer,
    key,
    policy,
    principal,
    publicKey,
    receipt,
    request,
    runtimeConnection,
    runtimeUser,
    sourcePort,
    transport,
  } = input;
  yield* verifyDsrOwnerLaunchIdentity(artifact);
  const childScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(childScope, Exit.void));
  const filesystem = yield* FileSystem.FileSystem;
  const temporary = yield* filesystem
    .makeTempDirectoryScoped({ directory: '/tmp', prefix: 'd1271-' })
    .pipe(Scope.provide(childScope));
  yield* filesystem.chmod(temporary, 0o700);
  const socketPath = `${yield* filesystem.realPath(temporary)}/dsr.sock`;
  const server = yield* NodeSocketServer.make({ path: socketPath }).pipe(Scope.provide(childScope));
  const output = yield* Deferred.make<Socket.Writer>();
  const failed = yield* Deferred.make<never, DsrLegacyTestFailure>();
  const replies = yield* Queue.unbounded<string>();
  const stopped = yield* Ref.make(false);
  const connected = yield* Ref.make(false);
  yield* server
    .run((socket) =>
      Effect.scoped(
        Effect.gen(function* receiveArtifact() {
          if (yield* Ref.getAndSet(connected, true)) {
            return yield* failure('duplicate-child');
          }
          const pull = yield* Socket.readerBytes(socket);
          yield* Deferred.succeed(output, yield* socket.writer);
          const frameState = { pending: 0 };
          yield* Stream.fromPull(Effect.succeed(pull)).pipe(
            Stream.mapEffect(boundedDsrFrame(frameState)),
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach(retainDsrFrame(stopped, replies)),
          );
          if (!(yield* Ref.get(stopped))) {
            return yield* failure('child-ended-before-ack');
          }
          return yield* Effect.void;
        }),
      ).pipe(
        Effect.catch(() =>
          Ref.get(stopped).pipe(
            Effect.flatMap((expected) =>
              expected ? Effect.void : Deferred.fail(failed, failure('child-channel-ended')),
            ),
          ),
        ),
      ),
    )
    .pipe(Effect.forkIn(childScope));
  const next = Effect.raceFirst(Queue.take(replies), Deferred.await(failed));
  const send = (line: string) =>
    Effect.raceFirst(Deferred.await(output), Deferred.await(failed)).pipe(
      Effect.flatMap((writer) => writer.write(`${line}\n`)),
    );
  const child = yield* ChildProcess.make(artifact.nodeExecutable, [artifact.bundlePath], {
    cwd: artifact.staged,
    env: {
      APP_ENV_PATH: '/dev/null',
      DATABASE_URL: runtimeConnection,
      ONTOS_1271_DATABASE: database,
      ONTOS_1271_FIXTURE: JSON.stringify({ policy, principal, receipt, request }),
      ONTOS_1271_REVISION: snapshot.composition.revision,
      ONTOS_1271_RUNTIME_USER: runtimeUser,
      ONTOS_1271_SOCKET: socketPath,
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `http://127.0.0.1:${sourcePort}/active`,
      ONTOS_GATEWAY_ISSUER: issuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
        keys: [{ ...publicKey, alg: 'EdDSA', kid: 'TEST.dsr-legacy', use: 'sig' }],
      }),
      PATH: transport.PATH,
      SPICEDB_CA_CERT: transport.SPICEDB_CA_CERT,
      SPICEDB_ENDPOINT: transport.SPICEDB_ENDPOINT,
      SPICEDB_PRESHARED_KEY: Redacted.value(transport.SPICEDB_PRESHARED_KEY),
    },
    extendEnv: false,
    stderr: 'pipe',
    stdin: 'pipe',
    stdout: 'pipe',
  }).pipe(Scope.provide(childScope));
  yield* Stream.runDrain(child.stdout).pipe(Effect.forkIn(childScope));
  yield* Stream.runDrain(child.stderr).pipe(Effect.forkIn(childScope));
  const ready = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(readySchema))(yield* next);
  expect(ready.marker).toEqual({ appId: 'privacy', buildMarker: artifact.buildMarker });
  expect(ready.deadlineSchemaVersion).toBe(expectedVersion);
  expect(ready.deliveryUnit).toEqual({
    appId: 'privacy',
    buildMarker: artifact.buildMarker,
    sourceRevision: 'workspace',
    unitId: 'app/privacy',
  });
  const call = Effect.fn('DsrLegacyTest.matchingCompiledClient')(function* call(
    operation: 'create' | 'deadline' | 'read',
    payload: Readonly<Record<string, string>> = {},
  ) {
    const seconds = Math.floor((yield* clock.currentTimeMillis) / 1000);
    const jti = yield* nextId;
    const token = yield* io('fresh-gateway-assertion', () =>
      new SignJWT({
        compositionRevision: snapshot.composition.revision,
        principal,
        targetBuildMarker: artifact.buildMarker,
        ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'TEST.dsr-legacy', typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience('privacy')
        .setSubject(principal.principalId)
        .setIssuedAt(seconds)
        .setExpirationTime(seconds + 300)
        .setJti(jti)
        .sign(key.privateKey),
    );
    yield* send(
      JSON.stringify({
        correlation: yield* nextId,
        credential: `Bearer ${token}`,
        idempotencyKey: yield* nextId,
        operation,
        payload,
      }),
    );
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(resultSchema))(yield* next);
  });
  return {
    call,
    close: () =>
      Effect.gen(function* stopArtifact() {
        yield* send(JSON.stringify({ operation: 'stop' }));
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ type: Schema.Literal('STOPPED') })))(
          yield* next,
        );
        yield* Scope.close(childScope, Exit.void);
      }),
  };
});
// Both cases build cold owner bundles in scoped setup, outside the business timeout.
const DsrVerifiedArtifacts = Context.Service<Effect.Success<ReturnType<typeof prepareDsrLegacyArtifacts>>>(
  'DsrLegacyTest/VerifiedArtifacts',
);
const artifactLayer = Layer.effect(DsrVerifiedArtifacts, prepareDsrLegacyArtifacts()).pipe(Layer.provide(services));
type DsrNativeEvidence = Effect.Success<
  ReturnType<Effect.Success<ReturnType<typeof makeLiveOperationFixture>>['evidence']>
>;
const assertRetainedDsrEvidence = (evidence: DsrNativeEvidence, finalEvidence: DsrNativeEvidence) => {
  for (const prior of evidence.invocations) {
    expect(finalEvidence.invocations.find((item) => item.actionInvocationId === prior.actionInvocationId)).toEqual(
      prior,
    );
  }
  for (const prior of evidence.audits) {
    expect(finalEvidence.audits.find((item) => item.auditEventId === prior.auditEventId)).toEqual(prior);
  }
  for (const prior of evidence.events) {
    expect(finalEvidence.events.find((item) => item.domainEventId === prior.domainEventId)).toEqual(prior);
  }
};
type DsrCompatibilityArtifacts = Effect.Success<ReturnType<typeof prepareDsrLegacyArtifacts>>;
const legacyCompatibility = Effect.fn('DsrLegacyTest.nativeCompatibility')(function* legacyCompatibility(
  clock: Clock.Clock,
  artifacts: DsrCompatibilityArtifacts,
  focused: boolean,
) {
  const oldSnapshot = yield* makeCurrentNativeSnapshot(artifacts.old.buildMarker, yield* clock.currentTimeMillis);
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1271-exact-obligation-deadline',
  });
  // Permanently capture creator-owned primitives before any caller-visible fixture may be used.
  const { database } = isolated.connections.admin;
  const adminUser = isolated.connections.admin.user;
  const runtimeUser = isolated.connections.runtime.user;
  const adminConnection = isolated.connections.admin.connectionString;
  const runtimeConnection = isolated.connections.runtime.connectionString;
  const adminAddress = new URL(adminConnection);
  const runtimeAddress = new URL(runtimeConnection);
  const addressIsOwned = (address: URL, user: string) =>
    ['postgres:', 'postgresql:'].includes(address.protocol) &&
    ['localhost', '127.0.0.1'].includes(address.hostname) &&
    address.pathname === `/${database}` &&
    decodeURIComponent(address.username) === user &&
    address.search === '' &&
    address.hash === '';
  if (
    !database.startsWith('ontos_test_party_gateway_') ||
    adminUser === runtimeUser ||
    !/^[a-z_][a-z0-9_]*$/u.test(runtimeUser) ||
    !addressIsOwned(adminAddress, adminUser) ||
    !addressIsOwned(runtimeAddress, runtimeUser) ||
    adminAddress.hostname !== runtimeAddress.hostname ||
    (adminAddress.port || '5432') !== (runtimeAddress.port || '5432')
  ) {
    return yield* failure('owned-endpoints');
  }
  // The inner owner scope is closed before the outer creator's ordinary DROP finalizer.
  yield* Effect.scoped(
    Effect.gen(function* ownerLifetime() {
      const admin = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: adminConnection, max: 1 })),
        (pool) => Effect.promise(() => pool.end()),
      );
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: runtimeConnection, max: 1 })),
        (pool) => Effect.promise(() => pool.end()),
      );
      const verifyIdentity = io('native-identity', async () => {
        const sql =
          'select current_database() as database,current_user as role,session_user as session,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user';
        const ownerResult = await admin.query(sql);
        const readerResult = await runtime.query(sql);
        const [owner] = ownerResult.rows;
        const [reader] = readerResult.rows;
        if (
          owner?.database !== database ||
          owner.role !== adminUser ||
          owner.session !== adminUser ||
          reader?.database !== database ||
          reader.role !== runtimeUser ||
          reader.session !== runtimeUser ||
          reader.rolsuper !== false ||
          reader.rolbypassrls !== false ||
          reader.rolcreatedb !== false ||
          reader.rolcreaterole !== false
        ) {
          throw failure('native-identity');
        }
      });
      yield* verifyIdentity;
      yield* isolated.migrateCoreSchema();
      yield* command({ DATABASE_ADMIN_URL: adminConnection, DATABASE_URL: runtimeConnection });
      yield* verifyIdentity;
      // Exact native owner objects only; no business rows, journal rows or Core authority SQL.
      const readTables = [
        'dsr_cases',
        'dsr_deadlines',
        'dsr_verifications',
        'dsr_resolver_assignments',
        'dsr_substantive_decisions',
        'dsr_owner_tasks',
        'dsr_responses',
        'owner_contributions',
      ];
      yield* io('privacy-acl-rls', async () => {
        await Promise.all(
          readTables.map(async (table) => {
            const result = await admin.query(
              `select c.relkind,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) as owner
              from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='privacy' and c.relname=$1`,
              [table],
            );
            const [row] = result.rows;
            if (
              result.rowCount !== 1 ||
              row?.relkind !== 'r' ||
              row.relrowsecurity !== true ||
              row.relforcerowsecurity !== true ||
              row.owner !== adminUser
            ) {
              throw failure('privacy-acl-rls');
            }
          }),
        );
        const role = `"${runtimeUser}"`;
        await admin.query(`grant usage on schema privacy to ${role}`);
        await Promise.all(
          readTables.map((table) => {
            let rights = 'select';
            if (table === 'dsr_cases') {
              rights = 'select,insert,update';
            } else if (table === 'dsr_deadlines') {
              rights = 'select,insert';
            }
            return admin.query(`grant ${rights} on privacy."${table}" to ${role}`);
          }),
        );
        await admin.query('create schema privacy_dsr_legacy_test');
        await admin.query(
          'create table privacy_dsr_legacy_test.redemptions(issuer text not null,audience text not null,jti text not null,primary key(issuer,audience,jti))',
        );
        await admin.query(`grant usage on schema privacy_dsr_legacy_test to ${role}`);
        await admin.query(`grant select,insert on privacy_dsr_legacy_test.redemptions to ${role}`);
        const tables = [...readTables.map((name) => `privacy.${name}`), 'privacy_dsr_legacy_test.redemptions'];
        const privilegeResult = await runtime.query(
          'select subject,operation,has_table_privilege(current_user,subject,operation) as allowed from unnest($1::text[]) as subject cross join unnest($2::text[]) as operation',
          [tables, ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']],
        );
        for (const row of privilegeResult.rows) {
          let allowed = ['SELECT'];
          if (row.subject === 'privacy.dsr_cases') {
            allowed = ['SELECT', 'INSERT', 'UPDATE'];
          } else if (['privacy.dsr_deadlines', 'privacy_dsr_legacy_test.redemptions'].includes(row.subject)) {
            allowed = ['SELECT', 'INSERT'];
          }
          if (row.allowed !== allowed.includes(row.operation)) {
            throw failure('privacy-acl-rls');
          }
        }
        const surplus =
          await runtime.query(`select has_database_privilege(current_user,current_database(),'CREATE') as database,
            has_schema_privilege(current_user,'privacy','CREATE') as privacy,
            has_schema_privilege(current_user,'privacy_dsr_legacy_test','CREATE') as replay`);
        const surplusFacts = Schema.decodeUnknownSync(
          Schema.Struct({ database: Schema.Boolean, privacy: Schema.Boolean, replay: Schema.Boolean }),
        )(surplus.rows[0]);
        if (surplusFacts.database || surplusFacts.privacy || surplusFacts.replay) {
          throw failure('privacy-acl-rls');
        }
      });
      yield* isolated.publishInitialComposition(oldSnapshot);
      const fixture = yield* Effect.acquireRelease(
        makeLiveOperationFixture({
          actionExecutor: 'manager-only',
          actionKeys: ['privacy.core.create-dsr-case', 'privacy.core.record-dsr-deadline'],
          adminConnectionString: Redacted.make(adminConnection),
          allowedAudiences: ['privacy'],
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: oldSnapshot.composition.revision,
          moduleAccess: 'configured-modules',
          moduleKeys: ['privacy.core'],
          runtimeConnectionString: Redacted.make(runtimeConnection),
        }),
        (value) => value.close().pipe(Effect.orDie),
      );
      const coreEvidenceServices = yield* Layer.build(
        PgClient.layer({ url: Redacted.make(adminConnection) }).pipe(Layer.provideMerge(Reactivity.layer)),
      );
      const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(coreEvidenceServices));
      // This fixture's fixed-revision ActionRuntime is deliberately never passed to a receiver.
      const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
        ...fixture.manager,
        legalEntityId: fixture.legalEntityId,
      });
      const caseRef = `TEST.dsr-legacy:${yield* nextId}`;
      const receivedAt = DateTime.formatIso(yield* DateTime.now);
      const receipts = [0, 1].map((index) => ({
        controllerRef: 'TEST.controller',
        exactScopeRefs: [`TEST.scope:${caseRef}:${index}`],
        obligationRef: `TEST.obligation:${caseRef}:${index}`,
        receiptBasisRef: `TEST.receipt:${caseRef}:${index}`,
        receivedAt,
        requestedRights: ['ACCESS'],
      }));
      const request = yield* Schema.decodeUnknownEffect(DsrCaseRequestSchema)({
        caseRef,
        controllerObligations: receipts.map(
          ({ receiptBasisRef: _basis, receivedAt: _time, ...obligation }) => obligation,
        ),
        intakeClaimRef: `TEST.intake:${caseRef}`,
        requestedRights: ['ACCESS'],
        requester: { kind: 'RESOLVED', subjectRef: `TEST.subject:${caseRef}` },
        subjectRefs: [],
        unresolvedParts: [],
      });
      const receipt = yield* Schema.decodeUnknownEffect(DsrIntakeReceiptSchema)({
        caseRef,
        controllerReceipts: receipts,
        intakeClaimRef: request.intakeClaimRef,
        originalReceivedAt: receivedAt,
        requestedRights: request.requestedRights,
      });
      const policy = yield* Schema.decodeUnknownEffect(DsrDeadlinePolicySchema)({
        calendar: 'UTC_CALENDAR_MONTH',
        months: 1,
        policyRef: 'TEST.deadline-policy',
        policyVersion: 'TEST.v1',
      });
      const permissions = yield* makeContextPermissionRelationshipMutationLive();
      const permission = {
        legalEntityId: fixture.legalEntityId,
        principal,
        target: { moduleId: 'privacy.core', permission: 'privacy.dsr.read' },
        tenantId: fixture.tenantId,
      };
      yield* permissions.mutate({ ...permission, operation: 'grant' });
      yield* Effect.addFinalizer(() => permissions.mutate({ ...permission, operation: 'revoke' }).pipe(Effect.orDie));
      const trustedSnapshot = yield* Ref.make(oldSnapshot);
      const sourceContext = yield* Layer.build(NodeHttpServer.layerTest);
      const source = Context.get(sourceContext, HttpServer.HttpServer);
      yield* source.serve(
        Effect.gen(function* trustedSource() {
          const current = yield* Ref.get(trustedSnapshot);
          const text = yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
            current,
          );
          return HttpServerResponse.text(text, { contentType: 'application/json' });
        }),
      );
      const sourceAddress = source.address;
      if (!Schema.is(Schema.Struct({ port: Schema.Number }))(sourceAddress)) {
        return yield* failure('snapshot-source');
      }
      const key = yield* io('gateway-key', () => generateKeyPair('EdDSA'));
      const publicKey = yield* io('gateway-key', () => exportJWK(key.publicKey));
      const issuer = 'https://TEST.dsr-legacy.example';
      const transport = yield* Config.all({
        PATH: Config.String('PATH'),
        SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
        SPICEDB_ENDPOINT: Config.String('SPICEDB_ENDPOINT'),
        SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
      });
      const launchContext: DsrLegacyLaunchContext = {
        database,
        issuer,
        key,
        policy,
        principal,
        publicKey,
        receipt,
        request,
        runtimeConnection,
        runtimeUser,
        sourcePort: sourceAddress.port,
        transport,
      };
      const oldStartedAt = yield* clock.currentTimeMillis;
      const old = yield* startDsrLegacyArtifact(launchContext, artifacts.old, oldSnapshot, '1', clock);
      expect((yield* old.call('create')).outcome).toBe('success');
      const oldDeadline = yield* old.call('deadline', { caseRef, controllerRef: 'TEST.controller' });
      expect(oldDeadline.outcome).toBe('success');
      if (oldDeadline.outcome !== 'success') {
        return yield* failure('old-deadline');
      }
      const original = yield* Schema.decodeUnknownEffect(LegacyDsrDeadlineSchema)(oldDeadline.value, {
        onExcessProperty: 'error',
      });
      expect(Object.hasOwn(original, 'obligationRef')).toBe(false);
      expect(Object.hasOwn(original, 'version')).toBe(false);
      const oldWorkflow = yield* old.call('read');
      if (oldWorkflow.outcome !== 'success') {
        return yield* failure('old-workflow');
      }
      expect((yield* Schema.decodeUnknownEffect(oldReadSchema)(oldWorkflow.value)).items[0]?.deadlines).toEqual([
        original,
      ]);
      const stored = () =>
        fixture.prepareOwner(
          Effect.fn('DsrLegacyTest.observeOwnerJSON')(function* observe(transaction, scope) {
            return yield* transaction
              .select({
                actionInvocationId: dsrDeadlines.actionInvocationId,
                deadlineId: dsrDeadlines.deadlineId,
                record: dsrDeadlines.deadlineRecord,
              })
              .from(dsrDeadlines)
              .where(
                and(
                  eq(dsrDeadlines.tenantId, scope.tenantId),
                  eq(dsrDeadlines.legalEntityId, fixture.legalEntityId),
                  eq(dsrDeadlines.caseRef, caseRef),
                ),
              );
          }),
          'required',
        );
      const retained = yield* stored();
      expect(retained).toHaveLength(1);
      const [legacyRow] = retained;
      if (legacyRow === undefined) {
        return yield* failure('old-native-row');
      }
      expect(legacyRow.record).toEqual(original);
      const legacyHash = digest(yield* Schema.encodeEffect(Schema.fromJsonString(LegacyDsrDeadlineSchema))(original));
      const evidence = yield* fixture.evidence(coreEvidenceExecutor);
      const invocation = evidence.invocations.find((item) => item.actionInvocationId === legacyRow.actionInvocationId);
      expect(invocation).toBeDefined();
      expect(invocation?.actionKey).toBe('privacy.core.record-dsr-deadline');
      expect(invocation?.status).toBe('succeeded');
      expect(evidence.audits.length).toBeGreaterThan(0);
      // This compatibility case creates no handoff work. Observe genuine native absence before
      // the existing publisher independently enforces its complete durable/Outbox drain contract.
      yield* io('native-no-completion-debt', async () => {
        const result = await admin.query(`select
            not exists(select 1 from core.application_composition_durable_work) as durable,
            not exists(select 1 from core.outbox_messages) as messages,
            not exists(select 1 from core.outbox_deliveries) as deliveries,
            not exists(select 1 from privacy.privacy_measure_dispatches) as dispatches,
            not exists(select 1 from privacy.owner_execution_outcomes) as outcomes`);
        const facts = Schema.decodeUnknownSync(
          Schema.Struct({
            deliveries: Schema.Boolean,
            dispatches: Schema.Boolean,
            durable: Schema.Boolean,
            messages: Schema.Boolean,
            outcomes: Schema.Boolean,
          }),
        )(result.rows[0]);
        if (!facts.durable || !facts.messages || !facts.deliveries || !facts.dispatches || !facts.outcomes) {
          throw failure('native-no-completion-debt');
        }
      });
      // Focused proof stops the authentic old producer before current-runtime admission.
      if (focused) {
        yield* old.close();
      }
      // Pause all new business requests, then exercise actual global debt/Outbox publication gates.
      yield* isolated.composition.closeAdmission();
      yield* isolated.composition.drain();
      const drained = yield* isolated.composition.observe();
      expect(drained).toMatchObject({
        durableWorkAdmission: 'closed',
        hasMoreDurableWork: false,
        pendingDurableWork: [],
        phase: 'draining',
        revision: oldSnapshot.composition.revision,
      });
      const currentSnapshot = yield* makeCurrentNativeSnapshot(
        artifacts.current.buildMarker,
        yield* clock.currentTimeMillis,
      );
      expect(currentSnapshot.composition.revision).not.toBe(oldSnapshot.composition.revision);
      const replacement = yield* isolated.composition.publishReplacement(currentSnapshot);
      expect(replacement).toEqual({
        durableWorkAdmission: 'open',
        phase: 'active',
        revision: currentSnapshot.composition.revision,
      });
      // Explicit paused-traffic test transition: no atomic production pointer rollout is claimed.
      yield* Ref.set(trustedSnapshot, currentSnapshot);
      const current = yield* startDsrLegacyArtifact(launchContext, artifacts.current, currentSnapshot, '2', clock);
      const before = yield* current.call('read');
      if (before.outcome !== 'success') {
        return yield* failure('current-legacy-read');
      }
      const beforeRead = yield* Schema.decodeUnknownEffect(DsrCasesResponseSchema)(before.value);
      expect(beforeRead.items[0]?.deadlines).toEqual([
        { ...original, identityStatus: 'LEGACY_UNRESOLVED', version: 1 },
      ]);
      const [, second] = receipts;
      if (second === undefined) {
        return yield* failure('second-obligation');
      }
      const exact = yield* current.call('deadline', {
        caseRef,
        controllerRef: second.controllerRef,
        obligationRef: second.obligationRef,
      });
      expect(exact.outcome).toBe('success');
      if (exact.outcome !== 'success') {
        return yield* failure('current-exact-write');
      }
      const exactRecord = yield* Schema.decodeUnknownEffect(DsrDeadlineSchema)(exact.value);
      expect(exactRecord).toMatchObject({
        obligationRef: second.obligationRef,
        receiptBasisRef: second.receiptBasisRef,
        receivedAt: second.receivedAt,
        version: 2,
      });
      yield* current.close();
      const restarted = yield* startDsrLegacyArtifact(launchContext, artifacts.current, currentSnapshot, '2', clock);
      const after = yield* restarted.call('read');
      if (after.outcome !== 'success') {
        return yield* failure('restarted-read');
      }
      const afterRead = yield* Schema.decodeUnknownEffect(DsrCasesResponseSchema)(after.value);
      expect(afterRead.items[0]?.deadlines).toHaveLength(2);
      expect(afterRead.items[0]?.deadlines).toContainEqual({
        ...original,
        identityStatus: 'LEGACY_UNRESOLVED',
        version: 1,
      });
      expect(afterRead.items[0]?.deadlines).toContainEqual({ ...exactRecord, identityStatus: 'EXACT' });
      const beforeStaleRows = yield* stored();
      const beforeStaleEvidence = yield* fixture.evidence(coreEvidenceExecutor);
      // Full mode keeps the old receiver alive to prove refusal after native replacement.
      if (!focused) {
        // The genuine Node source can retain its original snapshot for 30 seconds. The actual
        // native composition lock must still refuse that retired revision before owner writes.
        expect((yield* clock.currentTimeMillis) - oldStartedAt).toBeLessThan(30_000);
        const stale = yield* old.call('deadline', { caseRef, controllerRef: 'TEST.controller' });
        expect(stale).toEqual({ outcome: 'refused', status: 503, type: 'result' });
      }
      const healthy = yield* restarted.call('read');
      const healthyRead = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          outcome: Schema.Literal('success'),
          type: Schema.Literal('result'),
          value: DsrCasesResponseSchema,
        }),
      )(healthy);
      expect(healthyRead.value.items).toEqual(afterRead.items);
      expect(DateTime.toEpochMillis(DateTime.makeUnsafe(healthyRead.value.metadata.observedAt))).toBeGreaterThanOrEqual(
        DateTime.toEpochMillis(DateTime.makeUnsafe(afterRead.metadata.observedAt)),
      );
      const finalRows = yield* stored();
      expect(finalRows).toEqual(beforeStaleRows);
      expect(finalRows).toHaveLength(2);
      const unchanged = finalRows.find((item) => item.deadlineId === legacyRow.deadlineId);
      expect(unchanged).toEqual(legacyRow);
      if (unchanged === undefined) {
        return yield* failure('retained-native-row');
      }
      const finalLegacy = yield* Schema.decodeUnknownEffect(LegacyDsrDeadlineSchema)(unchanged.record, {
        onExcessProperty: 'error',
      });
      expect(digest(yield* Schema.encodeEffect(Schema.fromJsonString(LegacyDsrDeadlineSchema))(finalLegacy))).toBe(
        legacyHash,
      );
      const finalEvidence = yield* fixture.evidence(coreEvidenceExecutor);
      expect(finalEvidence.audits).toEqual(beforeStaleEvidence.audits);
      expect(finalEvidence.events).toEqual(beforeStaleEvidence.events);
      expect(finalEvidence.invocations.filter((item) => item.status === 'succeeded')).toEqual(
        beforeStaleEvidence.invocations.filter((item) => item.status === 'succeeded'),
      );
      assertRetainedDsrEvidence(evidence, finalEvidence);
      yield* restarted.close();
      if (!focused) {
        yield* old.close();
      }
      return yield* Effect.void;
    }).pipe(Effect.provideService(Clock.Clock, clock)),
  );
  return yield* Effect.void;
});
it.layer(artifactLayer, { excludeTestServices: true, timeout: 120_000 })((suite) => {
  suite.effect(
    'retains a genuine pre-1271 Deadline through actual drained replacement and a restarted exact receiver',
    () =>
      Effect.gen(function* nativeCase() {
        const clock = yield* Clock.Clock;
        return yield* legacyCompatibility(clock, yield* DsrVerifiedArtifacts, false);
      }).pipe(Effect.provide(services)),
    30_000,
  );
  suite.effect(
    'focused authentic legacy compatibility through current runtime',
    () =>
      Effect.gen(function* focusedNativeCase() {
        const clock = yield* Clock.Clock;
        return yield* legacyCompatibility(clock, yield* DsrVerifiedArtifacts, true);
      }).pipe(Effect.provide(services)),
    30_000,
  );
});
