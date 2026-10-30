import { fileURLToPath } from 'node:url';
import type { TrustedPrincipalContextSchema } from '@app/core-runtime';
import {
  canonicalizeApplicationComposition,
  makeContextPermissionRelationshipMutationLive,
  OntosModuleDeploymentContractSchema,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import {
  makeApplicationCompositionSnapshotFixture,
  makeModuleContractFixture,
} from '@app/core-runtime/testing/module-contract';
import {
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
  decodeSupportedGatewayContextClaims,
  SupportedGatewayContextClaimsSchema,
} from '@app/shared-contracts';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import {
  Cause,
  Config,
  Context,
  Crypto,
  DateTime,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Redacted,
  Result,
  Schema,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/process';
import { SqlError, UniqueViolation } from 'effect/sql/SqlError';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';
import { executeCreateProductWithAuthorization } from '../../src/api/create-product-action-client.ts';
import { executeAssignCatalogMediaWithAuthorization } from '../../src/api/assign-catalog-media-action-client.ts';
import { executeReorderCatalogMediaRecoveryWithAuthorization } from '../../src/api/reorder-catalog-media-recovery-client.ts';
import { ProductActionInvocationIdSchema } from '../../shared/domain/product.ts';
import { CatalogMediaAssignmentIdSchema } from '../../shared/domain/catalog-media-assignment.ts';
import { executeRemoveCatalogMediaWithAuthorization } from '../../src/api/remove-catalog-media-action-client.ts';
import { executeReorderCatalogMediaWithAuthorization } from '../../src/api/reorder-catalog-media-action-client.ts';
import { executeCatalogMediaCurrentWithAuthorization } from '../../src/api/catalog-media-current-client.ts';
import {
  AssignCatalogMediaPayloadSchema,
  ReorderCatalogMediaPayloadSchema,
  RemoveCatalogMediaPayloadSchema,
} from '../../shared/actions/catalog-media.ts';
import {
  ReorderCatalogMediaActionAlreadyCommittedProblemSchema,
  ReorderCatalogMediaActionAuthenticationProblemSchema,
  ReorderCatalogMediaActionConflictProblemSchema,
  ReorderCatalogMediaActionForbiddenProblemSchema,
  ReorderCatalogMediaActionNotFoundProblemSchema,
  ReorderCatalogMediaActionUnavailableProblemSchema,
} from '../../shared/apis/reorder-catalog-media-action.ts';
import { VariantRefSchema } from '../../shared/resources/variant.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import {
  MediaOwnedDatabaseCertificateSchema,
  MediaOrderingBootstrapSchema,
  MediaOrderingCommandSchema,
  MediaOrderingResponseSchema,
  guardMediaOwnedDatabase,
  mediaOrderingClosedEnvironment,
  mediaOrderingProtocol,
} from '../support/catalog-media-ordering-receiver.fixture.ts';

const appRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const services = NodeServices.layer.pipe(
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
class MediaOrderingNativeFailure extends Schema.TaggedError<MediaOrderingNativeFailure>()(
  'MediaOrderingNativeFailure',
  { stage: Schema.String },
) {}
const fail = (stage: string) => new MediaOrderingNativeFailure({ stage });
const IdentityProtectionMessageSchema = Schema.Literals([
  'catalog descriptive identity or revision is invalid',
  'catalog descriptive identity is immutable',
]);
const requireCondition = (condition: boolean, stage: string) => (condition ? Effect.void : Effect.fail(fail(stage)));
const PublicKeySchema = Schema.Struct({ crv: Schema.Literal('Ed25519'), kty: Schema.Literal('OKP'), x: Schema.String });
const PublicKeysSchema = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      ...PublicKeySchema.fields,
      alg: Schema.Literal('EdDSA'),
      kid: Schema.String,
      use: Schema.Literal('sig'),
    }),
  ),
});
const bundleReceiver = Effect.fn('MediaOrderingNative.bundleReceiver')(function* bundleReceiver() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(appRoot, 'verticals/catalog');
  const cache = path.join(directory, 'node_modules/.cache/ontos-1274');
  yield* fs.makeDirectory(cache, { recursive: true });
  const artifact = path.join(cache, `${yield* nextId}.mjs`);
  yield* Effect.addFinalizer(() => fs.remove(artifact, { force: true }).pipe(Effect.orDie));
  const child = yield* ChildProcess.make(
    path.join(appRoot, 'node_modules/esbuild/bin/esbuild'),
    [
      path.join(directory, 'tests/support/catalog-media-ordering-receiver.fixture.ts'),
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--packages=external',
      `--outfile=${artifact}`,
    ],
    {
      cwd: directory,
      env: { APP_ENV_PATH: '/dev/null' },
      extendEnv: false,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    },
  );
  const [code] = yield* Effect.all([child.exitCode, Stream.runDrain(child.stderr), Stream.runDrain(child.stdout)], {
    concurrency: 3,
  });
  yield* requireCondition(code === 0, 'receiver-bundle');
  return { artifact, directory };
});
const captureOwnedCertificate = Effect.fn('MediaOrderingNative.captureOwnedCertificate')(
  function* captureOwnedCertificate(isolated: Effect.Success<ReturnType<typeof makeIsolatedNativeDatabaseFixture>>) {
    const { admin, runtime } = isolated.connections;
    yield* requireCondition(
      /^ontos_test_party_gateway_[a-f0-9]{32}$/u.test(admin.database) &&
        admin.database === runtime.database &&
        admin.host === runtime.host &&
        admin.port === runtime.port &&
        ['localhost', '127.0.0.1'].includes(admin.host) &&
        admin.user !== runtime.user,
      'core-owned-address',
    );
    const context = yield* Layer.build(
      PgClient.layer({ maxConnections: 1, url: Redacted.make(admin.connectionString) }),
    );
    const client = Context.get(context, PgClient.PgClient);
    const [actual] = yield* client<{
      database_name: string;
      database_oid: number;
      database_owner: string;
      effective_role: string;
      server_address: string;
      server_port: number;
      session_role: string;
    }>`select current_database() as database_name, d.oid::int as database_oid, pg_get_userbyid(d.datdba) as database_owner,
      inet_server_addr()::text as server_address, inet_server_port() as server_port,
      session_user::text as session_role, current_user::text as effective_role from pg_database d where d.datname=current_database()`;
    yield* requireCondition(
      actual !== undefined &&
        actual.database_name === admin.database &&
        actual.database_owner === admin.user &&
        actual.session_role === admin.user &&
        actual.effective_role === admin.user,
      'core-owned-identity',
    );
    if (actual === undefined) {
      return yield* fail('core-owned-identity');
    }
    const certificate = yield* Schema.decodeUnknownEffect(MediaOwnedDatabaseCertificateSchema)({
      adminRole: admin.user,
      adminUrl: admin.connectionString,
      name: admin.database,
      oid: actual.database_oid,
      owner: actual.database_owner,
      runtimeRole: runtime.user,
      runtimeUrl: runtime.connectionString,
      serverAddress: actual.server_address,
      serverPort: actual.server_port,
    });
    // Recheck both actual credentials, roles, server identity, OID and runtime RLS attributes before any receiving child.
    yield* guardMediaOwnedDatabase(certificate);
    return { certificate, client };
  },
);

const makeAuthority = Effect.fn('MediaOrderingNative.makeAuthority')(function* makeAuthority(
  actor: typeof TrustedPrincipalContextSchema.Type,
  compositionRevision: string,
  buildMarker: string,
) {
  const generated = yield* Effect.tryPromise({
    catch: () => fail('issuer-key'),
    try: async () => {
      const keys = await globalThis.crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
      if (!('privateKey' in keys)) {
        throw new Error('Ed25519 key pair required');
      }
      return keys;
    },
  });
  const kid = yield* nextId;
  const exported = yield* Effect.tryPromise({
    catch: () => fail('issuer-public-key'),
    try: async () => await globalThis.crypto.subtle.exportKey('jwk', generated.publicKey),
  });
  const publicKey = yield* Schema.decodeUnknownEffect(PublicKeySchema)(exported);
  const issuer = 'https://catalog-media-parent.test';
  const jwks = yield* Schema.encodeEffect(Schema.fromJsonString(PublicKeysSchema))({
    keys: [{ ...publicKey, alg: 'EdDSA', kid, use: 'sig' }],
  });
  const issue = Effect.fn('MediaOrderingNative.issueAssertion')(function* issueAssertion(
    sampledAt: DateTime.Utc,
    subject = actor,
  ) {
    const now = Math.floor(DateTime.toEpochMillis(sampledAt) / 1000);
    const header = Buffer.from(
      yield* Schema.encodeEffect(
        Schema.fromJsonString(
          Schema.Struct({ alg: Schema.Literal('EdDSA'), kid: Schema.String, typ: Schema.Literal('JWT') }),
        ),
      )({ alg: 'EdDSA', kid, typ: 'JWT' }),
    ).toString('base64url');
    const claims = yield* decodeSupportedGatewayContextClaims({
      aud: 'catalog',
      compositionRevision,
      exp: now + GATEWAY_ASSERTION_TTL_SECONDS,
      iat: now,
      iss: issuer,
      jti: yield* nextId,
      principal: subject,
      sub: subject.principalId,
      targetBuildMarker: buildMarker,
      ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
    });
    const payload = Buffer.from(
      yield* Schema.encodeEffect(Schema.fromJsonString(SupportedGatewayContextClaimsSchema))(claims),
    ).toString('base64url');
    const content = `${header}.${payload}`;
    const signature = yield* Effect.tryPromise({
      catch: () => fail('issuer-signature'),
      try: async () =>
        await globalThis.crypto.subtle.sign('Ed25519', generated.privateKey, new TextEncoder().encode(content)),
    });
    return `Bearer ${content}.${Buffer.from(signature).toString('base64url')}`;
  });
  return { issue, issuer, jwks };
});

const startReceiver = Effect.fn('MediaOrderingNative.startReceiver')(function* startReceiver(
  bundle: Effect.Success<ReturnType<typeof bundleReceiver>>,
  bootstrap: typeof MediaOrderingBootstrapSchema.Type,
) {
  // Trusted parent composition: certificate captured from the still-live Core-created handle.
  // It is not a cryptographically unforgeable serialized handle. Recheck before every launch.
  yield* guardMediaOwnedDatabase(bootstrap.database);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const diagnostics = `${bundle.artifact}.diagnostics`;
  yield* fs.makeDirectory(diagnostics, { mode: 0o700 });
  const stderr = yield* fs.open(path.join(diagnostics, 'receiver.stderr.log'), { flag: 'wx', mode: 0o600 });
  const commands = yield* Queue.bounded<Uint8Array>(4);
  const responses = yield* Queue.bounded<typeof MediaOrderingResponseSchema.Type | MediaOrderingNativeFailure>(4);
  const child = yield* ChildProcess.make(process.execPath, [bundle.artifact, '--serve-media-ordering'], {
    additionalFds: { fd3: { type: 'output' }, fd4: { stream: Stream.fromQueue(commands), type: 'input' } },
    cwd: bundle.directory,
    env: mediaOrderingClosedEnvironment(bootstrap),
    extendEnv: false,
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  let stderrBytes = 0;
  let retainedStderrBytes = 0;
  const captureStderr = yield* child.stderr.pipe(
    Stream.runForEach((chunk) => {
      stderrBytes += chunk.byteLength;
      const retained = chunk.subarray(0, Math.max(0, 65_536 - retainedStderrBytes));
      retainedStderrBytes += retained.byteLength;
      return retained.byteLength === 0 ? Effect.void : stderr.writeAll(retained);
    }),
    Effect.andThen(
      Effect.suspend(() =>
        fs.writeFileString(
          path.join(diagnostics, 'receiver.stderr.metadata.json'),
          JSON.stringify({
            retainedBytes: retainedStderrBytes,
            totalBytes: stderrBytes,
            truncated: stderrBytes > retainedStderrBytes,
          }),
          { flag: 'wx', mode: 0o600 },
        ),
      ),
    ),
    Effect.andThen(stderr.sync),
    Effect.forkScoped,
  );
  yield* Stream.runDrain(child.stdout).pipe(Effect.forkScoped);
  yield* child.getOutputFd(3).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.mapEffect((line) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(MediaOrderingResponseSchema), { onExcessProperty: 'error' })(
        line,
      ),
    ),
    Stream.runForEach((response) => Queue.offer(responses, response)),
    Effect.andThen(Fiber.join(captureStderr)),
    Effect.andThen(Queue.offer(responses, fail('receiver-eof'))),
    Effect.catch(() => Queue.offer(responses, fail('receiver-protocol'))),
    Effect.forkScoped,
  );
  const receive = Queue.take(responses).pipe(
    Effect.flatMap((value) =>
      Schema.is(MediaOrderingNativeFailure)(value) ? Effect.fail(value) : Effect.succeed(value),
    ),
  );
  const send = (command: typeof MediaOrderingCommandSchema.Type) =>
    Schema.encodeEffect(Schema.fromJsonString(MediaOrderingCommandSchema))(command).pipe(
      Effect.flatMap((line) => Queue.offer(commands, new TextEncoder().encode(`${line}\n`))),
    );
  yield* send(bootstrap);
  const ready = yield* receive;
  if (ready.type !== 'BOOTED') {
    return yield* fail('receiver-ready-order');
  }
  yield* requireCondition(
    ready.buildMarker === ultramodernApiMarker.buildMarker &&
      ready.compositionRevision === bootstrap.composition.composition.revision,
    'receiver-ready-identity',
  );
  return {
    baseUrl: `http://127.0.0.1:${ready.port}`,
    stop: send({
      type: 'stop',
      version: mediaOrderingProtocol,
    }).pipe(
      Effect.andThen(receive),
      Effect.flatMap((response) => requireCondition(response.type === 'STOPPED', 'receiver-stop')),
    ),
  };
});
const makeCatalogComposition = Effect.fn('MediaOrderingNative.makeCatalogComposition')(
  function* makeCatalogComposition() {
    const initial = yield* makeApplicationCompositionSnapshotFixture(['catalog'], ultramodernApiMarker.buildMarker);
    const [module] = initial.composition.modules;
    if (module === undefined) {
      return yield* fail('catalog-composition-module');
    }
    const moduleId = 'commerce.catalog';
    const contract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)(
      makeModuleContractFixture({ appId: 'catalog', buildMarker: ultramodernApiMarker.buildMarker, moduleId }),
    );
    const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
      contract,
    );
    const crypto = yield* Crypto.Crypto;
    const sha256 = Buffer.from(yield* crypto.digest('SHA-256', new TextEncoder().encode(contractDocument))).toString(
      'hex',
    );
    const composition = {
      ...initial.composition,
      modules: [
        {
          ...module,
          contract: { ...module.contract, sha256 },
          contractDocument,
          moduleId,
          publicContract: { id: moduleId, sha256, version: contract.schemaVersion },
        },
      ],
      revision: '0'.repeat(64),
    };
    const revision = Buffer.from(
      yield* crypto.digest('SHA-256', new TextEncoder().encode(canonicalizeApplicationComposition(composition))),
    ).toString('hex');
    return yield* validateActiveApplicationCompositionSnapshot({
      ...initial,
      composition: { ...composition, revision },
    });
  },
);
const makeNative = Effect.fn('MediaOrderingNative.make')(function* makeNative() {
  yield* requireCondition((yield* Config.String('APP_ENV_PATH')) === '/dev/null', 'closed-parent-environment');
  const bundle = yield* bundleReceiver();
  const composition = yield* makeCatalogComposition();
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1274-media-ordering',
  });
  yield* isolated.migrateCoreSchema();
  yield* isolated.publishInitialComposition(composition);
  const owned = yield* captureOwnedCertificate(isolated);
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionExecutor: 'manager-only',
      actionKeys: [
        'commerce.catalog.create-product',
        'commerce.catalog.assign-catalog-media',
        'commerce.catalog.reorder-catalog-media',
        'commerce.catalog.remove-catalog-media',
      ],
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      allowedAudiences: ['catalog'],
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: composition.composition.revision,
      moduleKeys: ['commerce.catalog'],
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    }),
    (value) => value.close().pipe(Effect.orDie),
  );
  const authority = yield* makeAuthority(
    fixture.manager,
    composition.composition.revision,
    ultramodernApiMarker.buildMarker,
  );
  const ca = yield* Config.String('SPICEDB_CA_CERT').pipe(Config.option);
  const fixed = {
    endpoint: yield* Config.String('SPICEDB_ENDPOINT'),
    token: yield* Config.Redacted('SPICEDB_PRESHARED_KEY'),
  };
  const spiceDb = Option.match(ca.pipe(Option.filter((value) => value.length > 0)), {
    onNone: () => fixed,
    onSome: (caCertificate) => ({ ...fixed, caCertificate }),
  });
  const bootstrap = yield* Schema.decodeUnknownEffect(Schema.toType(MediaOrderingBootstrapSchema))({
    actor: fixture.manager,
    composition,
    database: owned.certificate,
    issuer: authority.issuer,
    jwks: authority.jwks,
    spiceDb,
    type: 'bootstrap',
    version: mediaOrderingProtocol,
  });
  const receiver = yield* startReceiver(bundle, bootstrap);
  const options = Effect.fn('MediaOrderingNative.options')(function* options() {
    return {
      baseUrl: receiver.baseUrl,
      compositionRevision: composition.composition.revision,
      idempotencyKey: yield* nextId,
    };
  });
  return { authority, bootstrap, composition, fixture, isolated, options, owned, receiver };
});
const observeMedia = Effect.fn('MediaOrderingNative.observeMedia')(function* observeMedia(
  native: Effect.Success<ReturnType<typeof makeNative>>,
) {
  yield* guardMediaOwnedDatabase(native.bootstrap.database);
  const tenant = native.fixture.tenantId;
  const { client } = native.owned;
  const sets =
    yield* client`select * from catalog.catalog_media_assignment_sets where tenant_id=${tenant} order by assignment_set_id`;
  const setRevisions =
    yield* client`select * from catalog.catalog_media_assignment_set_revisions where tenant_id=${tenant} order by assignment_set_id,revision`;
  const assignments =
    yield* client`select * from catalog.catalog_media_assignments where tenant_id=${tenant} order by assignment_id`;
  const revisions =
    yield* client`select * from catalog.catalog_media_assignment_revisions where tenant_id=${tenant} order by assignment_id,revision`;
  const results =
    yield* client`select * from catalog.catalog_result_snapshots where tenant_id=${tenant} order by action_invocation_id`;
  const successfulAudit =
    yield* client`select * from core.audit_events where tenant_id=${tenant} and outcome='succeeded' order by audit_event_id`;
  const events = yield* client`select * from core.domain_events where tenant_id=${tenant} order by domain_event_id`;
  const outbox = yield* client`select * from core.outbox_messages where tenant_id=${tenant} order by outbox_message_id`;
  return { assignments, events, outbox, results, revisions, setRevisions, sets, successfulAudit };
});
const observeOriginalProtection = Effect.fn('MediaOrderingNative.originalProtection')(function* originalProtection(
  native: Effect.Success<ReturnType<typeof makeNative>>,
) {
  yield* guardMediaOwnedDatabase(native.bootstrap.database);
  const { client } = native.owned;
  const triggers = yield* client<{
    acl: string | null;
    definition: string;
    enabled: string;
    function_body: string;
    function_oid: string;
    name: string;
    owner_oid: string;
    security_definer: boolean;
    settings: string[];
  }>`
    select t.tgname as name, t.tgenabled as enabled, pg_get_triggerdef(t.oid) as definition,
      p.prosrc as function_body, p.oid::text as function_oid, p.proowner::text as owner_oid,
      p.proacl::text as acl, p.prosecdef as security_definer, p.proconfig as settings from pg_trigger t
    join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    join pg_proc p on p.oid=t.tgfoid
    where n.nspname='catalog' and c.relname in ('catalog_media_assignments','catalog_media_assignment_sets','product_localized_facts','variant_localized_facts')
      and t.tgname in ('catalog_media_assignments_identity_immutable','catalog_media_assignment_sets_identity_immutable','catalog_product_localized_facts_identity_immutable','catalog_variant_localized_facts_identity_immutable')
      and not t.tgisinternal order by t.tgname`;
  expect(triggers).toHaveLength(4);
  expect(new Set(triggers.map((trigger) => trigger.function_oid)).size).toBe(1);
  expect(new Set(triggers.map((trigger) => trigger.owner_oid)).size).toBe(1);
  expect(new Set(triggers.map((trigger) => trigger.acl)).size).toBe(1);
  for (const trigger of triggers) {
    expect(trigger.enabled).toBe('O');
    expect(trigger.security_definer).toBe(true);
    expect(trigger.settings).toEqual(['search_path=pg_catalog, pg_temp']);
    expect(trigger.definition).toContain('BEFORE DELETE OR UPDATE');
    expect(trigger.definition).toContain('catalog.protect_410_identity()');
    expect(trigger.function_body).toContain('NEW.current_revision <= OLD.current_revision');
    expect(trigger.function_body).toContain("ERRCODE = '55000'");
  }
  const guards = yield* client<{
    columns: string[];
    deferred: boolean;
    initially_deferred: boolean;
    validated: boolean;
  }>`
    select k.condeferrable as deferred, k.condeferred as initially_deferred, k.convalidated as validated,
      (select array_agg(a.attname::text order by key.ordinality)
       from unnest(k.conkey) with ordinality key(attnum,ordinality)
       join pg_attribute a on a.attrelid=k.conrelid and a.attnum=key.attnum) as columns
    from pg_constraint k where k.conrelid='catalog.catalog_media_assignments'::regclass
      and k.conname='catalog_media_assignments_active_position_commit_uk'`;
  expect(guards).toEqual([
    {
      columns: ['tenant_id', 'assignment_set_id', 'resource_kind', 'active_position'],
      deferred: true,
      initially_deferred: true,
      validated: true,
    },
  ]);
  const oldIndexes =
    yield* client`select oid from pg_class where oid=to_regclass('catalog.catalog_media_assignments_active_position_uk')`;
  expect(oldIndexes).toEqual([]);
  return { guards, triggers };
});
const produceSubjects = Effect.fn('MediaOrderingNative.produceSubjects')(function* produceSubjects(
  native: Effect.Success<ReturnType<typeof makeNative>>,
) {
  const created = yield* executeCreateProductWithAuthorization(
    {
      name: 'Observed media-ordering sample',
      reason: 'Observe actual Product and its initial Variant for media ordering',
    },
    yield* native.authority.issue(yield* DateTime.now),
    yield* nextId,
    yield* native.options(),
  );
  const { productRef } = created.product;
  const variantRef = yield* Schema.decodeUnknownEffect(VariantRefSchema)({
    moduleId: 'commerce.catalog',
    resourceId: created.variantId,
    resourceType: 'commerce.catalog.variant',
    tenantId: native.fixture.tenantId,
  });
  // Opaque owner-qualified identities are genuinely issued by Catalog. This fixture does not
  // assert Documents ownership, bytes or Current availability (the public contract says UNVERIFIED).
  const owner = yield* executeCreateProductWithAuthorization(
    { name: 'Observed resource owner identity', reason: 'Issue an owner-qualified opaque resource reference' },
    yield* native.authority.issue(yield* DateTime.now),
    yield* nextId,
    yield* native.options(),
  );
  const permissions = yield* makeContextPermissionRelationshipMutationLive();
  const principal = { principalId: native.fixture.manager.principalId, tenantId: native.fixture.tenantId };
  for (const permission of [
    'module.access',
    'commerce.catalog.read.media',
    'commerce.catalog.read.reorder-catalog-media-recovery',
  ] as const) {
    const input = {
      principal,
      target: { moduleId: 'commerce.catalog', permission },
      tenantId: native.fixture.tenantId,
    };
    yield* permissions.mutate({ ...input, operation: 'grant' });
    yield* Effect.addFinalizer(() => permissions.mutate({ ...input, operation: 'revoke' }).pipe(Effect.orDie));
  }
  const mediaReadContext = {
    legalEntityId: native.fixture.legalEntityId,
    principal,
    target: { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.media' },
    tenantId: native.fixture.tenantId,
  };
  yield* permissions.mutate({ ...mediaReadContext, operation: 'grant' });
  yield* Effect.addFinalizer(() => permissions.mutate({ ...mediaReadContext, operation: 'revoke' }).pipe(Effect.orDie));
  for (const resource of [productRef, variantRef]) {
    yield* native.fixture.grantResourceAccess(resource, principal.principalId, 'reader');
    yield* Effect.addFinalizer(() =>
      native.fixture.revokeResourceAccess(resource, principal.principalId, 'reader').pipe(Effect.orDie),
    );
  }
  return { productRef, resourceRef: owner.product.productRef, variantRef };
});
const installRollbackFault = Effect.fn('MediaOrderingNative.installRollbackFault')(function* installRollbackFault(
  native: Effect.Success<ReturnType<typeof makeNative>>,
  assignmentId: string,
) {
  yield* guardMediaOwnedDatabase(native.bootstrap.database);
  const { client } = native.owned;
  const { tenantId } = native.fixture;
  yield* requireCondition(
    [assignmentId, tenantId].every((value) =>
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value),
    ),
    'fault-fixed-identities',
  );
  const existing = yield* client`select to_regclass('catalog.test_1274_rollback_reached') as sequence,
    to_regprocedure('catalog.test_1274_rollback()') as function`;
  expect(existing).toEqual([{ function: null, sequence: null }]);
  const cleanup = guardMediaOwnedDatabase(native.bootstrap.database).pipe(
    Effect.andThen(
      client.unsafe('DROP TRIGGER IF EXISTS test_1274_rollback ON catalog.catalog_media_assignment_revisions;'),
    ),
    Effect.andThen(client.unsafe('DROP FUNCTION IF EXISTS catalog.test_1274_rollback();')),
    Effect.andThen(client.unsafe('DROP SEQUENCE IF EXISTS catalog.test_1274_rollback_reached;')),
    Effect.asVoid,
    Effect.scoped,
  );
  yield* Effect.addFinalizer(() => cleanup.pipe(Effect.orDie));
  // This sequence is solely a nontransactional reached sentinel, never business or historical evidence.
  // SECURITY DEFINER is restricted to the isolated test database and exact trigger arguments;
  // runtime roles and grants remain unchanged. Its only successful effect is nextval before forced failure.
  yield* client.unsafe('CREATE SEQUENCE catalog.test_1274_rollback_reached;');
  yield* client.unsafe(`
    CREATE FUNCTION catalog.test_1274_rollback() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,catalog AS $fault$
    BEGIN
      IF NEW.reason = 'TEST:1274:forced-rollback'
        AND NEW.assignment_id::text = TG_ARGV[0] AND NEW.tenant_id::text = TG_ARGV[1] THEN
        IF NOT EXISTS (SELECT 1 FROM catalog.catalog_media_assignments a
          JOIN catalog.catalog_media_assignment_sets s
            ON s.tenant_id=a.tenant_id AND s.assignment_set_id=a.assignment_set_id
          WHERE a.tenant_id=NEW.tenant_id AND a.assignment_id=NEW.assignment_id
            AND a.current_revision=NEW.revision AND a.position=NEW.position
            AND s.current_revision=NEW.set_revision AND NEW.revision > 1
            AND EXISTS (SELECT 1 FROM catalog.catalog_media_assignment_set_revisions r
              WHERE r.tenant_id=s.tenant_id AND r.assignment_set_id=s.assignment_set_id
                AND r.revision=s.current_revision AND r.reason=NEW.reason)) THEN
          RAISE EXCEPTION '1274 fault prerequisite not reached' USING ERRCODE='55000';
        END IF;
        PERFORM nextval('catalog.test_1274_rollback_reached');
        RAISE EXCEPTION '1274 forced rollback after actual current and set history writes' USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END $fault$;
  `);
  yield* client.unsafe(`
    CREATE TRIGGER test_1274_rollback BEFORE INSERT ON catalog.catalog_media_assignment_revisions
      FOR EACH ROW EXECUTE FUNCTION catalog.test_1274_rollback('${assignmentId}','${tenantId}');
  `);
  return cleanup;
});
const verifyIdentityDispatch = Effect.fn('MediaOrderingNative.verifyIdentityDispatch')(function* verifyIdentityDispatch(
  native: Effect.Success<ReturnType<typeof makeNative>>,
  subjects: Effect.Success<ReturnType<typeof produceSubjects>>,
  assignmentId: string,
) {
  yield* guardMediaOwnedDatabase(native.bootstrap.database);
  const { client } = native.owned;
  const { tenantId } = native.fixture;
  const productId = subjects.productRef.resourceId;
  const variantId = subjects.variantRef.resourceId;
  const replacementId = yield* nextId;
  const beforeMedia = yield* observeMedia(native);
  const beforeProductFacts =
    yield* client`select * from catalog.product_localized_facts where tenant_id=${tenantId} and product_id=${productId} order by locale`;
  const beforeVariantFacts =
    yield* client`select * from catalog.variant_localized_facts where tenant_id=${tenantId} and variant_id=${variantId} order by locale`;
  const rollback = fail('identity-proof-rollback');
  const probe = yield* client
    .withTransaction(
      Effect.gen(function* exerciseIdentityGuards() {
        // TEST-only current-row guard fixtures. They do not claim a public localized-fact Action or history.
        yield* client`insert into catalog.product_localized_facts(tenant_id,product_id,locale,current_revision,state,name)
        values(${tenantId},${productId},'qaa-1274',1,'SET','Product identity guard')`;
        yield* client`insert into catalog.variant_localized_facts(tenant_id,product_id,variant_id,locale,current_revision,state,name)
        values(${tenantId},${productId},${variantId},'qaa-1274',1,'SET','Variant identity guard')`;
        const [assignment] = yield* client<{
          assignment_set_id: string;
        }>`select assignment_set_id from catalog.catalog_media_assignments where tenant_id=${tenantId} and assignment_id=${assignmentId}`;
        if (assignment === undefined) {
          return yield* fail('identity-proof-assignment');
        }
        const setId = assignment.assignment_set_id;
        const cases = [
          {
            current: client`select * from catalog.product_localized_facts where tenant_id=${tenantId} and product_id=${productId} and locale='qaa-1274'`,
            invalid: [
              client`update catalog.product_localized_facts set product_id=${replacementId},current_revision=current_revision+1 where tenant_id=${tenantId} and product_id=${productId} and locale='qaa-1274'`,
              client`update catalog.product_localized_facts set locale='qaa-1274-other',current_revision=current_revision+1 where tenant_id=${tenantId} and product_id=${productId} and locale='qaa-1274'`,
              client`update catalog.product_localized_facts set tenant_id=${replacementId},current_revision=current_revision+1 where tenant_id=${tenantId} and product_id=${productId} and locale='qaa-1274'`,
              client`update catalog.product_localized_facts set current_revision=current_revision where tenant_id=${tenantId} and product_id=${productId} and locale='qaa-1274'`,
              client`delete from catalog.product_localized_facts where tenant_id=${tenantId} and product_id=${productId} and locale='qaa-1274'`,
            ],

            valid: client`update catalog.product_localized_facts set name='Updated product guard',current_revision=current_revision+1 where tenant_id=${tenantId} and product_id=${productId} and locale='qaa-1274' returning current_revision`,
          },
          {
            current: client`select * from catalog.variant_localized_facts where tenant_id=${tenantId} and variant_id=${variantId} and locale='qaa-1274'`,
            invalid: [
              client`update catalog.variant_localized_facts set product_id=${replacementId},current_revision=current_revision+1 where tenant_id=${tenantId} and variant_id=${variantId} and locale='qaa-1274'`,
              client`update catalog.variant_localized_facts set variant_id=${replacementId},current_revision=current_revision+1 where tenant_id=${tenantId} and variant_id=${variantId} and locale='qaa-1274'`,
              client`update catalog.variant_localized_facts set locale='qaa-1274-other',current_revision=current_revision+1 where tenant_id=${tenantId} and variant_id=${variantId} and locale='qaa-1274'`,
              client`update catalog.variant_localized_facts set tenant_id=${replacementId},current_revision=current_revision+1 where tenant_id=${tenantId} and variant_id=${variantId} and locale='qaa-1274'`,
              client`update catalog.variant_localized_facts set current_revision=current_revision where tenant_id=${tenantId} and variant_id=${variantId} and locale='qaa-1274'`,
              client`delete from catalog.variant_localized_facts where tenant_id=${tenantId} and variant_id=${variantId} and locale='qaa-1274'`,
            ],

            valid: client`update catalog.variant_localized_facts set name='Updated variant guard',current_revision=current_revision+1 where tenant_id=${tenantId} and variant_id=${variantId} and locale='qaa-1274' returning current_revision`,
          },
          {
            current: client`select * from catalog.catalog_media_assignment_sets where tenant_id=${tenantId} and assignment_set_id=${setId}`,
            invalid: [
              client`update catalog.catalog_media_assignment_sets set assignment_set_id=${replacementId},current_revision=current_revision+1 where tenant_id=${tenantId} and assignment_set_id=${setId}`,
              client`update catalog.catalog_media_assignment_sets set product_id=${replacementId},current_revision=current_revision+1 where tenant_id=${tenantId} and assignment_set_id=${setId}`,
              client`update catalog.catalog_media_assignment_sets set variant_id=${replacementId},current_revision=current_revision+1 where tenant_id=${tenantId} and assignment_set_id=${setId}`,
              client`update catalog.catalog_media_assignment_sets set tenant_id=${replacementId},current_revision=current_revision+1 where tenant_id=${tenantId} and assignment_set_id=${setId}`,
              client`update catalog.catalog_media_assignment_sets set current_revision=current_revision where tenant_id=${tenantId} and assignment_set_id=${setId}`,
              client`delete from catalog.catalog_media_assignment_sets where tenant_id=${tenantId} and assignment_set_id=${setId}`,
            ],

            valid: client`update catalog.catalog_media_assignment_sets set updated_at=clock_timestamp(),current_revision=current_revision+1 where tenant_id=${tenantId} and assignment_set_id=${setId} returning current_revision`,
          },
          {
            current: client`select * from catalog.catalog_media_assignments where tenant_id=${tenantId} and assignment_id=${assignmentId}`,
            invalid: [
              client`update catalog.catalog_media_assignments set assignment_id=${replacementId},current_revision=current_revision+1 where tenant_id=${tenantId} and assignment_id=${assignmentId}`,
              client`update catalog.catalog_media_assignments set assignment_set_id=${replacementId},current_revision=current_revision+1 where tenant_id=${tenantId} and assignment_id=${assignmentId}`,
              client`update catalog.catalog_media_assignments set tenant_id=${replacementId},current_revision=current_revision+1 where tenant_id=${tenantId} and assignment_id=${assignmentId}`,
              client`update catalog.catalog_media_assignments set current_revision=current_revision where tenant_id=${tenantId} and assignment_id=${assignmentId}`,
              client`delete from catalog.catalog_media_assignments where tenant_id=${tenantId} and assignment_id=${assignmentId}`,
            ],

            valid: client`update catalog.catalog_media_assignments set purpose='identity-guard-probe',current_revision=current_revision+1 where tenant_id=${tenantId} and assignment_id=${assignmentId} returning current_revision`,
          },
        ];
        for (const control of cases) {
          const before = yield* control.current;
          const [original] = before;
          expect(original).toBeDefined();
          const updated = yield* control.valid;
          expect(updated).toHaveLength(1);
          expect(updated[0]?.current_revision).toBe(Number(original?.current_revision) + 1);
          const retained = yield* control.current;
          for (const mutation of control.invalid) {
            const rejected = yield* client.withTransaction(mutation).pipe(Effect.exit);
            expect(Exit.isFailure(rejected)).toBe(true);
            if (Exit.isFailure(rejected)) {
              const failure = yield* Schema.decodeUnknownEffect(Schema.toType(SqlError))(Cause.squash(rejected.cause));
              expect(
                Schema.is(
                  Schema.Struct({
                    code: Schema.Literal('55000'),
                    message: IdentityProtectionMessageSchema,
                  }),
                )(failure.reason.cause),
              ).toBe(true);
            }
            expect(yield* control.current).toEqual(retained);
          }
        }
        return yield* rollback;
      }),
    )
    .pipe(Effect.exit);
  expect(Exit.isFailure(probe)).toBe(true);
  if (Exit.isFailure(probe)) {
    expect(Cause.squash(probe.cause)).toBe(rollback);
  }
  expect(yield* observeMedia(native)).toEqual(beforeMedia);
  expect(
    yield* client`select * from catalog.product_localized_facts where tenant_id=${tenantId} and product_id=${productId} order by locale`,
  ).toEqual(beforeProductFacts);
  expect(
    yield* client`select * from catalog.variant_localized_facts where tenant_id=${tenantId} and variant_id=${variantId} order by locale`,
  ).toEqual(beforeVariantFacts);
});
it.live(
  'commits reorder and middle insertion through real Catalog media Actions with truthful revisions',
  () =>
    Effect.gen(function* nativeOrderingRegression() {
      const native = yield* makeNative();
      const subjects = yield* produceSubjects(native);
      const protection = yield* observeOriginalProtection(native);
      const firstId = yield* nextId;
      const secondId = yield* nextId;
      const thirdId = yield* nextId;
      const reason = 'Observe requested media order without technical removal history';
      const evidenceRefs = ['TEST:1274:observed-media-order'];
      const subjectRef = subjects.productRef;
      for (const [assignmentId, order, expectedSetRevision] of [
        [firstId, 1, 0],
        [secondId, 2, 1],
      ] as const) {
        const payload = yield* Schema.decodeUnknownEffect(AssignCatalogMediaPayloadSchema)({
          assignmentId,
          evidenceRefs,
          expectedSetRevision,
          order,
          purpose: 'photo',
          reason,
          resourceKind: 'MEDIA',
          resourceRef: subjects.resourceRef,
          subjectRef,
        });
        expect(
          yield* executeAssignCatalogMediaWithAuthorization(
            payload,
            yield* native.authority.issue(yield* DateTime.now),
            yield* nextId,
            yield* native.options(),
          ),
        ).toEqual({
          assignmentId,
          setRevision: expectedSetRevision + 1,
        });
      }
      const read = Effect.fn('MediaOrderingNative.publicCurrent')(function* publicCurrent(
        target: typeof subjects.productRef | typeof subjects.variantRef = subjectRef,
      ) {
        return yield* executeCatalogMediaCurrentWithAuthorization(
          { target },
          yield* native.authority.issue(yield* DateTime.now, {
            ...native.fixture.manager,
            legalEntityId: native.fixture.legalEntityId,
          }),
          yield* nextId,
          { baseUrl: native.receiver.baseUrl, compositionRevision: native.composition.composition.revision },
        );
      });
      const current = yield* read();
      expect(current.ordered.map(({ assignment }) => assignment.assignmentId)).toEqual([firstId, secondId]);
      expect(current.ordered.map(({ ownerAvailability }) => ownerAvailability)).toEqual(['UNVERIFIED', 'UNVERIFIED']);
      const variantFallback = yield* read(subjects.variantRef);
      expect(variantFallback).toMatchObject({ illustrativeFallback: true, source: 'PRODUCT' });
      expect(variantFallback.ordered.map(({ assignment }) => assignment.assignmentId)).toEqual([firstId, secondId]);
      const before = yield* observeMedia(native);
      const reorder = yield* Schema.decodeUnknownEffect(ReorderCatalogMediaPayloadSchema)({
        assignmentId: secondId,
        evidenceRefs,
        expectedSetRevision: 2,
        order: 1,
        reason,
        subjectRef,
      });
      const replayOptions = yield* native.options();
      const moved = yield* executeReorderCatalogMediaWithAuthorization(
        reorder,
        yield* native.authority.issue(yield* DateTime.now),
        yield* nextId,
        replayOptions,
      );
      expect(moved).toEqual({ assignmentId: secondId, setRevision: 3 });
      expect((yield* read()).ordered.map(({ assignment }) => assignment.assignmentId)).toEqual([secondId, firstId]);
      const afterReorder = yield* observeMedia(native);
      expect(afterReorder.revisions).toHaveLength(before.revisions.length + 2);
      expect(afterReorder.revisions.filter((row) => row.state === 'REMOVED')).toEqual([]);
      for (const assignmentId of [firstId, secondId]) {
        expect(
          afterReorder.revisions.filter((row) => row.assignment_id === assignmentId).map((row) => row.revision),
        ).toEqual([1, 2]);
      }
      const insertion = yield* Schema.decodeUnknownEffect(AssignCatalogMediaPayloadSchema)({
        assignmentId: thirdId,
        evidenceRefs,
        expectedSetRevision: 3,
        order: 2,
        purpose: 'detail',
        reason,
        resourceKind: 'MEDIA',
        resourceRef: subjects.resourceRef,
        subjectRef,
      });
      expect(
        yield* executeAssignCatalogMediaWithAuthorization(
          insertion,
          yield* native.authority.issue(yield* DateTime.now),
          yield* nextId,
          yield* native.options(),
        ),
      ).toEqual({ assignmentId: thirdId, setRevision: 4 });
      expect((yield* read()).ordered.map(({ assignment }) => assignment.assignmentId)).toEqual([
        secondId,
        thirdId,
        firstId,
      ]);
      const remove = yield* Schema.decodeUnknownEffect(RemoveCatalogMediaPayloadSchema)({
        assignmentId: thirdId,
        evidenceRefs,
        expectedSetRevision: 4,
        reason,
        subjectRef,
      });
      expect(
        yield* executeRemoveCatalogMediaWithAuthorization(
          remove,
          yield* native.authority.issue(yield* DateTime.now),
          yield* nextId,
          yield* native.options(),
        ),
      ).toEqual({ assignmentId: thirdId, setRevision: 5 });
      expect((yield* read()).ordered.map(({ assignment }) => assignment.assignmentId)).toEqual([secondId, firstId]);
      const beforeNoOp = yield* observeMedia(native);
      const noOp = { ...reorder, expectedSetRevision: 5 };
      expect(
        yield* executeReorderCatalogMediaWithAuthorization(
          noOp,
          yield* native.authority.issue(yield* DateTime.now),
          yield* nextId,
          yield* native.options(),
        ),
      ).toEqual({ assignmentId: secondId, setRevision: 6 });
      const afterNoOp = yield* observeMedia(native);
      expect(afterNoOp.assignments).toEqual(beforeNoOp.assignments);
      expect(afterNoOp.revisions).toEqual(beforeNoOp.revisions);
      expect(afterNoOp.setRevisions).toHaveLength(beforeNoOp.setRevisions.length + 1);
      const originalResult = afterReorder.results.find(
        (row) => row.action_key === 'commerce.catalog.reorder-catalog-media',
      );
      const invocationId = yield* Schema.decodeUnknownEffect(ProductActionInvocationIdSchema)(
        originalResult?.action_invocation_id,
      );
      expect(
        yield* executeReorderCatalogMediaRecoveryWithAuthorization(
          { invocationId },
          yield* native.authority.issue(yield* DateTime.now),
          yield* nextId,
          { baseUrl: native.receiver.baseUrl, compositionRevision: native.composition.composition.revision },
        ),
      ).toEqual(moved);
      // A committed replay advertises recovery of its original invocation after subsequent mutations.
      const replayFailure = yield* executeReorderCatalogMediaWithAuthorization(
        reorder,
        yield* native.authority.issue(yield* DateTime.now),
        yield* nextId,
        replayOptions,
      ).pipe(Effect.flip);
      const alreadyCommitted = yield* Schema.decodeUnknownEffect(
        ReorderCatalogMediaActionAlreadyCommittedProblemSchema,
      )(replayFailure);
      expect(alreadyCommitted).toMatchObject({
        code: 'action_already_committed',
        invocationId,
        resolution: 'RECOVER_REORDER_CATALOG_MEDIA',
        retryCommand: false,
        status: 409,
      });
      const recoveryInvocationId = yield* Schema.decodeUnknownEffect(ProductActionInvocationIdSchema)(
        alreadyCommitted.invocationId,
      );
      expect(
        yield* executeReorderCatalogMediaRecoveryWithAuthorization(
          { invocationId: recoveryInvocationId },
          yield* native.authority.issue(yield* DateTime.now),
          yield* nextId,
          { baseUrl: native.receiver.baseUrl, compositionRevision: native.composition.composition.revision },
        ),
      ).toEqual(moved);
      expect(yield* observeMedia(native)).toEqual(afterNoOp);
      const changedIntent = yield* executeReorderCatalogMediaWithAuthorization(
        { ...reorder, order: 2 },
        yield* native.authority.issue(yield* DateTime.now),
        yield* nextId,
        replayOptions,
      ).pipe(Effect.result);
      expect(Result.isFailure(changedIntent)).toBe(true);
      if (Result.isFailure(changedIntent)) {
        expect(Schema.is(ReorderCatalogMediaActionConflictProblemSchema)(changedIntent.failure)).toBe(true);
      }
      const stale = yield* executeReorderCatalogMediaWithAuthorization(
        reorder,
        yield* native.authority.issue(yield* DateTime.now),
        yield* nextId,
        yield* native.options(),
      ).pipe(Effect.result);
      expect(Result.isFailure(stale)).toBe(true);
      if (Result.isFailure(stale)) {
        expect(Schema.is(ReorderCatalogMediaActionConflictProblemSchema)(stale.failure)).toBe(true);
      }
      expect(yield* observeMedia(native)).toEqual(afterNoOp);
      // Two separately authenticated requests compete for the same complete-set CAS.
      const race = yield* Effect.forEach(
        [1, 2],
        (order) =>
          Effect.gen(function* raceAttempt() {
            const payload = { ...reorder, expectedSetRevision: 6, order };
            return yield* executeReorderCatalogMediaWithAuthorization(
              payload,
              yield* native.authority.issue(yield* DateTime.now),
              yield* nextId,
              yield* native.options(),
            ).pipe(Effect.result);
          }),
        { concurrency: 2 },
      );
      expect(race.filter(Result.isSuccess)).toHaveLength(1);
      const failures = race.filter(Result.isFailure);
      expect(failures).toHaveLength(1);
      expect(Schema.is(ReorderCatalogMediaActionConflictProblemSchema)(failures[0]?.failure)).toBe(true);
      const afterRace = yield* observeMedia(native);
      yield* verifyIdentityDispatch(native, subjects, firstId);
      expect(afterRace.setRevisions).toHaveLength(afterNoOp.setRevisions.length + 1);
      expect((yield* read()).ordered.map(({ assignment }) => assignment.order)).toEqual([1, 2]);
      // A deferred guard accepts transient overlap in the real reorder above but refuses an invalid final state.
      let duplicateStatementsCompleted = false;
      const invalidFinal = yield* native.owned.client
        .withTransaction(
          Effect.gen(function* duplicateAtCommit() {
            yield* native.owned.client`update catalog.catalog_media_assignments
        set position=1,current_revision=current_revision+1 where assignment_id=${firstId}`;
            yield* native.owned.client`update catalog.catalog_media_assignments
        set position=1,current_revision=current_revision+1 where assignment_id=${secondId}`;
            yield* Effect.sync(() => {
              duplicateStatementsCompleted = true;
            });
          }),
        )
        .pipe(Effect.exit);
      expect(duplicateStatementsCompleted).toBe(true);
      expect(Exit.isFailure(invalidFinal)).toBe(true);
      if (Exit.isFailure(invalidFinal)) {
        const sqlFailure = yield* Schema.decodeUnknownEffect(Schema.toType(SqlError))(Cause.squash(invalidFinal.cause));
        expect(Schema.is(UniqueViolation)(sqlFailure.reason)).toBe(true);
        expect(
          Schema.is(
            Schema.Struct({
              code: Schema.Literal('23505'),
              constraint: Schema.Literal('catalog_media_assignments_active_position_commit_uk'),
            }),
          )(sqlFailure.reason.cause),
        ).toBe(true);
      }
      expect(yield* observeMedia(native)).toEqual(afterRace);
      for (const mutation of [
        native.owned
          .client`update catalog.catalog_media_assignments set position=position where assignment_id=${firstId}`,
        native.owned
          .client`update catalog.catalog_media_assignments set assignment_id=${yield* nextId},current_revision=current_revision+1 where assignment_id=${firstId}`,
        native.owned.client`delete from catalog.catalog_media_assignments where assignment_id=${firstId}`,
      ]) {
        const protectedExit = yield* mutation.pipe(Effect.exit);
        expect(Exit.isFailure(protectedExit)).toBe(true);
        if (Exit.isFailure(protectedExit)) {
          const sqlFailure = yield* Schema.decodeUnknownEffect(Schema.toType(SqlError))(
            Cause.squash(protectedExit.cause),
          );
          expect(
            Schema.is(
              Schema.Struct({
                code: Schema.Literal('55000'),
                message: IdentityProtectionMessageSchema,
              }),
            )(sqlFailure.reason.cause),
          ).toBe(true);
        }
        expect(yield* observeMedia(native)).toEqual(afterRace);
      }
      // The fixed negative path fails inside the actual receiving Action transaction after real writes.
      const currentOrder = (yield* read()).ordered;
      const target = yield* Schema.decodeUnknownEffect(CatalogMediaAssignmentIdSchema)(
        currentOrder[1]?.assignment.assignmentId,
      );
      const cleanupFault = yield* installRollbackFault(native, target);
      const forced = yield* executeReorderCatalogMediaWithAuthorization(
        { ...reorder, assignmentId: target, expectedSetRevision: 7, order: 1, reason: 'TEST:1274:forced-rollback' },
        yield* native.authority.issue(yield* DateTime.now),
        yield* nextId,
        yield* native.options(),
      ).pipe(Effect.result);
      expect(Result.isFailure(forced)).toBe(true);
      if (Result.isFailure(forced)) {
        expect(Schema.is(ReorderCatalogMediaActionUnavailableProblemSchema)(forced.failure)).toBe(true);
      }
      const reached = yield* native.owned.client<{ called: boolean; value: string }>`
      select is_called as called,last_value::text as value from catalog.test_1274_rollback_reached`;
      expect(reached).toEqual([{ called: true, value: '1' }]);
      expect(yield* observeMedia(native)).toEqual(afterRace);
      expect((yield* read()).ordered).toEqual(currentOrder);
      expect(
        yield* executeReorderCatalogMediaWithAuthorization(
          { ...reorder, assignmentId: target, expectedSetRevision: 7, order: 1 },
          yield* native.authority.issue(yield* DateTime.now),
          yield* nextId,
          yield* native.options(),
        ),
      ).toEqual({ assignmentId: target, setRevision: 8 });
      yield* cleanupFault;
      expect(yield* observeOriginalProtection(native)).toEqual(protection);
      yield* native.receiver.stop;
    }).pipe(Effect.scoped, Effect.provide(services)),
  120_000,
);

for (const subjectKind of ['PRODUCT', 'VARIANT'] as const) {
  for (const resourceKind of ['MEDIA', 'DOCUMENT'] as const) {
    it.live(
      `preserves truthful ${subjectKind} ${resourceKind} lifecycle and first-item semantics`,
      () =>
        Effect.gen(function* completeLifecycle() {
          const native = yield* makeNative();
          const subjects = yield* produceSubjects(native);
          const subjectRef = subjectKind === 'PRODUCT' ? subjects.productRef : subjects.variantRef;
          const reason = 'Verified native media lifecycle';
          const evidenceRefs = ['TEST:1274:complete-lifecycle'];
          const assign = Effect.fn('MediaOrderingLifecycle.assign')(function* assign(
            assignmentId: string,
            expectedSetRevision: number,
            order: number,
            kind: 'MEDIA' | 'DOCUMENT' = resourceKind,
            target: typeof subjectRef = subjectRef,
          ) {
            const payload = yield* Schema.decodeUnknownEffect(AssignCatalogMediaPayloadSchema)({
              assignmentId,
              evidenceRefs,
              expectedSetRevision,
              order,
              purpose: 'detail',
              reason,
              resourceKind: kind,
              resourceRef: subjects.resourceRef,
              subjectRef: target,
            });
            return yield* executeAssignCatalogMediaWithAuthorization(
              payload,
              yield* native.authority.issue(yield* DateTime.now),
              yield* nextId,
              yield* native.options(),
            );
          });
          const read = Effect.fn('MediaOrderingLifecycle.read')(function* read() {
            return yield* executeCatalogMediaCurrentWithAuthorization(
              { target: subjectRef },
              yield* native.authority.issue(yield* DateTime.now, {
                ...native.fixture.manager,
                legalEntityId: native.fixture.legalEntityId,
              }),
              yield* nextId,
              { baseUrl: native.receiver.baseUrl, compositionRevision: native.composition.composition.revision },
            );
          });
          // A real Product media set proves Variant fallback before and after Variant-owned MEDIA.
          const fallbackId = yield* nextId;
          if (subjectKind === 'VARIANT' && resourceKind === 'MEDIA') {
            yield* assign(fallbackId, 0, 1, 'MEDIA', subjects.productRef);
            expect(yield* read()).toMatchObject({ illustrativeFallback: true, source: 'PRODUCT' });
          }
          // DOCUMENT ordering shares a set CAS with MEDIA while retaining an independent dense position key.
          const otherKindId = yield* nextId;
          const offset = resourceKind === 'DOCUMENT' ? 1 : 0;
          if (resourceKind === 'DOCUMENT') {
            yield* assign(otherKindId, 0, 1, 'MEDIA');
          }
          const firstId = yield* nextId;
          const secondId = yield* nextId;
          const thirdId = yield* nextId;
          const insertedId = yield* nextId;
          yield* assign(firstId, offset, 1);
          yield* assign(secondId, offset + 1, 2);
          yield* assign(thirdId, offset + 2, 3);
          const reorder = yield* Schema.decodeUnknownEffect(ReorderCatalogMediaPayloadSchema)({
            assignmentId: thirdId,
            evidenceRefs,
            expectedSetRevision: offset + 3,
            order: 1,
            reason,
            subjectRef,
          });
          expect(
            yield* executeReorderCatalogMediaWithAuthorization(
              reorder,
              yield* native.authority.issue(yield* DateTime.now),
              yield* nextId,
              yield* native.options(),
            ),
          ).toEqual({ assignmentId: thirdId, setRevision: offset + 4 });
          if (resourceKind === 'MEDIA') {
            const current = yield* read();
            expect(current.ordered.map(({ assignment }) => assignment.assignmentId)).toEqual([
              thirdId,
              firstId,
              secondId,
            ]);
            expect(Option.getOrUndefined(current.main)?.assignment.assignmentId).toBe(thirdId);
            expect(current).toMatchObject({ illustrativeFallback: false, source: subjectKind });
          }
          yield* assign(insertedId, offset + 4, 2);
          const remove = Effect.fn('MediaOrderingLifecycle.remove')(function* remove(
            assignmentId: string,
            revision: number,
          ) {
            const payload = yield* Schema.decodeUnknownEffect(RemoveCatalogMediaPayloadSchema)({
              assignmentId,
              evidenceRefs,
              expectedSetRevision: revision,
              reason,
              subjectRef,
            });
            return yield* executeRemoveCatalogMediaWithAuthorization(
              payload,
              yield* native.authority.issue(yield* DateTime.now),
              yield* nextId,
              yield* native.options(),
            );
          });
          yield* remove(insertedId, offset + 5);
          const beforeNoOp = yield* observeMedia(native);
          yield* executeReorderCatalogMediaWithAuthorization(
            { ...reorder, expectedSetRevision: offset + 6 },
            yield* native.authority.issue(yield* DateTime.now),
            yield* nextId,
            yield* native.options(),
          );
          const afterNoOp = yield* observeMedia(native);
          expect(afterNoOp.assignments).toEqual(beforeNoOp.assignments);
          expect(afterNoOp.revisions).toEqual(beforeNoOp.revisions);
          yield* remove(secondId, offset + 7);
          yield* remove(thirdId, offset + 8);
          if (resourceKind === 'MEDIA') {
            const current = yield* read();
            expect(current.ordered.map(({ assignment }) => assignment.assignmentId)).toEqual([firstId]);
            expect(Option.getOrUndefined(current.main)?.assignment.assignmentId).toBe(firstId);
          }
          yield* remove(firstId, offset + 9);
          const final = yield* observeMedia(native);
          for (const [assignmentId, expectedRevisions] of [
            [firstId, [1, 2, 3, 4, 5, 6]],
            [secondId, [1, 2, 3, 4, 5]],
            [thirdId, [1, 2, 3]],
            [insertedId, [1, 2]],
          ] as const) {
            const history = final.revisions.filter((row) => row.assignment_id === assignmentId);
            expect(history.map((row) => row.revision)).toEqual(expectedRevisions);
            expect(history.slice(0, -1).every((row) => row.state === 'ACTIVE')).toBe(true);
            expect(history.at(-1)?.state).toBe('REMOVED');
            for (const revision of history) {
              expect(revision.acting_principal_id).toBe(native.fixture.manager.principalId);
              expect(revision.reason).toBe(reason);
              expect(revision.evidence_refs).toEqual(evidenceRefs);
              expect(Schema.is(ProductActionInvocationIdSchema)(revision.action_invocation_id)).toBe(true);
            }
            const head = final.assignments.find((row) => row.assignment_id === assignmentId);
            expect(head?.current_revision).toBe(expectedRevisions.at(-1));
            expect(head?.position).toBe(history.at(-1)?.position);
            expect(head?.state).toBe('REMOVED');
          }
          if (resourceKind === 'DOCUMENT') {
            expect(final.revisions.filter((row) => row.assignment_id === otherKindId)).toHaveLength(1);
            expect(final.assignments.find((row) => row.assignment_id === otherKindId)).toMatchObject({
              current_revision: 1,
              position: 1,
              state: 'ACTIVE',
            });
          } else {
            const current = yield* read();
            if (subjectKind === 'VARIANT') {
              expect(current).toMatchObject({ illustrativeFallback: true, source: 'PRODUCT' });
              expect(current.ordered.map(({ assignment }) => assignment.assignmentId)).toEqual([fallbackId]);
            } else {
              expect(current.ordered).toEqual([]);
              expect(Option.isNone(current.main)).toBe(true);
            }
          }
          yield* native.receiver.stop;
        }).pipe(Effect.scoped, Effect.provide(services)),
      120_000,
    );
  }
}

it.live(
  'denies forged, ungranted and foreign-tenant writes and serializes cross-kind set changes',
  () =>
    Effect.gen(function* authorizationAndCrossKind() {
      const native = yield* makeNative();
      const subjects = yield* produceSubjects(native);
      const mediaId = yield* nextId;
      const documentId = yield* nextId;
      const reason = 'Verify media and document authorization and shared set CAS';
      const evidenceRefs = ['TEST:1274:authorization-cross-kind'];
      for (const [assignmentId, resourceKind, expectedSetRevision] of [
        [mediaId, 'MEDIA', 0],
        [documentId, 'DOCUMENT', 1],
      ] as const) {
        const payload = yield* Schema.decodeUnknownEffect(AssignCatalogMediaPayloadSchema)({
          assignmentId,
          evidenceRefs,
          expectedSetRevision,
          order: 1,
          purpose: 'detail',
          reason,
          resourceKind,
          resourceRef: subjects.resourceRef,
          subjectRef: subjects.productRef,
        });
        yield* executeAssignCatalogMediaWithAuthorization(
          payload,
          yield* native.authority.issue(yield* DateTime.now),
          yield* nextId,
          yield* native.options(),
        );
      }
      const payload = yield* Schema.decodeUnknownEffect(ReorderCatalogMediaPayloadSchema)({
        assignmentId: mediaId,
        evidenceRefs,
        expectedSetRevision: 2,
        order: 1,
        reason,
        subjectRef: subjects.productRef,
      });
      const before = yield* observeMedia(native);
      const denied = yield* executeReorderCatalogMediaWithAuthorization(
        payload,
        yield* native.authority.issue(yield* DateTime.now, native.fixture.denied),
        yield* nextId,
        yield* native.options(),
      ).pipe(Effect.result);
      expect(Result.isFailure(denied)).toBe(true);
      if (Result.isFailure(denied)) {
        expect(Schema.is(ReorderCatalogMediaActionForbiddenProblemSchema)(denied.failure)).toBe(true);
      }
      expect(yield* observeMedia(native)).toEqual(before);
      const credential = yield* native.authority.issue(yield* DateTime.now);
      const signatureOffset = credential.lastIndexOf('.') + 1;
      const forged =
        credential.slice(0, signatureOffset) +
        (credential[signatureOffset] === 'A' ? 'B' : 'A') +
        credential.slice(signatureOffset + 1);
      const forgedResult = yield* executeReorderCatalogMediaWithAuthorization(
        payload,
        forged,
        yield* nextId,
        yield* native.options(),
      ).pipe(Effect.result);
      expect(Result.isFailure(forgedResult)).toBe(true);
      if (Result.isFailure(forgedResult)) {
        expect(Schema.is(ReorderCatalogMediaActionAuthenticationProblemSchema)(forgedResult.failure)).toBe(true);
      }
      expect(yield* observeMedia(native)).toEqual(before);
      const other = yield* Effect.acquireRelease(
        makeLiveOperationFixture({
          actionExecutor: 'manager-only',
          actionKeys: ['commerce.catalog.reorder-catalog-media'],
          adminConnectionString: Redacted.make(native.isolated.connections.admin.connectionString),
          allowedAudiences: ['catalog'],
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: native.composition.composition.revision,
          moduleKeys: ['commerce.catalog'],
          runtimeConnectionString: Redacted.make(native.isolated.connections.runtime.connectionString),
        }),
        (fixture) => fixture.close().pipe(Effect.orDie),
      );
      const foreign = yield* executeReorderCatalogMediaWithAuthorization(
        payload,
        yield* native.authority.issue(yield* DateTime.now, other.manager),
        yield* nextId,
        yield* native.options(),
      ).pipe(Effect.result);
      expect(Result.isFailure(foreign)).toBe(true);
      if (Result.isFailure(foreign)) {
        expect(Schema.is(ReorderCatalogMediaActionNotFoundProblemSchema)(foreign.failure)).toBe(true);
      }
      expect(yield* observeMedia(native)).toEqual(before);
      const invalidOrder = yield* executeReorderCatalogMediaWithAuthorization(
        { ...payload, order: 2 },
        yield* native.authority.issue(yield* DateTime.now),
        yield* nextId,
        yield* native.options(),
      ).pipe(Effect.result);
      expect(Result.isFailure(invalidOrder)).toBe(true);
      if (Result.isFailure(invalidOrder)) {
        expect(Schema.is(ReorderCatalogMediaActionConflictProblemSchema)(invalidOrder.failure)).toBe(true);
      }
      expect(yield* observeMedia(native)).toEqual(before);
      const race = yield* Effect.forEach(
        [mediaId, documentId],
        (assignmentId) =>
          Effect.gen(function* crossKindAttempt() {
            const input = yield* Schema.decodeUnknownEffect(ReorderCatalogMediaPayloadSchema)({
              ...payload,
              assignmentId,
            });
            return yield* executeReorderCatalogMediaWithAuthorization(
              input,
              yield* native.authority.issue(yield* DateTime.now),
              yield* nextId,
              yield* native.options(),
            ).pipe(Effect.result);
          }),
        { concurrency: 2 },
      );
      expect(race.filter(Result.isSuccess)).toHaveLength(1);
      const rejected = race.filter(Result.isFailure);
      expect(rejected).toHaveLength(1);
      expect(Schema.is(ReorderCatalogMediaActionConflictProblemSchema)(rejected[0]?.failure)).toBe(true);
      const after = yield* observeMedia(native);
      expect(after.assignments).toEqual(before.assignments);
      expect(after.revisions).toEqual(before.revisions);
      expect(after.setRevisions).toHaveLength(before.setRevisions.length + 1);
      yield* native.receiver.stop;
    }).pipe(Effect.scoped, Effect.provide(services)),
  120_000,
);
