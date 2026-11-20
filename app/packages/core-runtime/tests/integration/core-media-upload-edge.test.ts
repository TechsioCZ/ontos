import { NodeCrypto, NodeHttpServer } from '@effect/platform-node';
import { sha256 } from '@noble/hashes/sha2.js';
import type { PgClient } from '@effect/sql-pg';
import {
  Cause,
  Crypto,
  DateTime,
  Effect,
  Exit,
  Layer,
  Logger,
  Match,
  Option,
  Predicate,
  Ref,
  Schema,
  Stream,
} from 'effect';
import { Hex } from 'effect/encoding';
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { NetAddress } from 'effect/net';
import { expect, it } from 'effect-rstest';

import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
import { makeDrizzleAccessPrincipalKinds } from '../../src/access/enforcement/actor.ts';
import { PrincipalIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import { makeDrizzleAccessWorkloadBindings } from '../../src/access/workloads/bindings.ts';
import { writeWorkloadBindings } from '../../src/access/workloads/binding-store.ts';
import { AccessWorkloadBindingIdSchema } from '../../src/access/workloads/store.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import type { ActionRuntimeService } from '../../src/actions/runtime.ts';
import { accessDecisionUnavailable } from '../../src/access/decision/errors.ts';
import type { DecisionAuthorityPort } from '../../src/access/decision/authority.ts';
import { WorkloadKeySchema } from '../../src/authorization/access-declaration.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import type { CoreDatabaseExecutor } from '../../src/db/types.ts';
import { loadDatabaseConfig, loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { SHARED_RUNTIME_IDENTITY } from '../../src/db/database-identities.ts';
import { assetByteSourceRead } from '../../src/generated-reads/asset-byte-source.ts';
import { assetDownloadRead } from '../../src/generated-reads/asset-download.ts';
import { assetMetadataRead } from '../../src/generated-reads/asset-metadata.ts';
import { MediaByteSource } from '../../src/media/byte-source-contract.ts';
import type { MediaByteSourceOffer } from '../../src/media/byte-source-contract.ts';
import { MediaDownloadSource } from '../../src/media/download-contract.ts';
import { streamConfirmedBytes } from '../../src/media/download.ts';
import { isMediaFailure, mediaFailureStatus } from '../../src/media/errors.ts';
import {
  confirmAssetRequest,
  ingestMediaBytes,
  parseContentLength,
  uploadResponseHeaders,
} from '../../src/media/ingest.ts';
import { MediaIntegrityRecorder } from '../../src/media/integrity-recorder.ts';
import { ObjectStorage, ObjectStorageNetworkError } from '../../src/media/object-storage.ts';
import type { ObjectStorageService } from '../../src/media/object-storage.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import type { UploadAssetPayloadSchema } from '../../src/media/upload-contract.ts';
import { StoredMediaObjectVerification } from '../../src/media/verification.ts';
import type { MediaVerifiableAsset } from '../../src/media/verified-read.ts';
import { confirmAssetAction } from '../../src/modules/actions/confirm-asset.action.ts';
import { uploadAssetAction } from '../../src/modules/actions/upload-asset.action.ts';
import { bindAccessGate } from '../../src/operations/access-gate.ts';
import type { AccessEnforcementPorts } from '../../src/operations/access-gate.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../src/testing/access-gate.ts';
import { makeInMemoryObjectStorage, withObjectStorageFaults } from '../../src/testing/media-object-storage.ts';
import type { InMemoryObjectStorage } from '../../src/testing/media-object-storage.ts';
import { writeTestTenantScopes } from '../../src/testing/tenant-access.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { makeTestOperationOwner, openActionRuntimeOptions } from '../support/action-runtime-options.ts';
import { makeTestPgClient } from '../support/database.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';

/*
 * The byte-ingress edge of an upload on real PostgreSQL through the real Action and Read runtimes (#1433, #1430):
 * reserve (Action), a real HTTP PUT of the raw bytes to a real loopback server that runs the SAME composition the
 * Shell handler runs (the byte-source Read, `ingestMediaBytes`, the confirm Action under the caller's principal),
 * then the metadata read and the download of the same asset. The provider is the in-memory double: never storage
 * proof. The S3-compatible emulator run of the same edge is core-media-upload-edge-s3.test.ts.
 */
const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const encoder = new TextEncoder();
const digestOf = (bytes: Uint8Array) => Hex.encode(sha256(bytes));
const content = encoder.encode('the bytes of one independent upload');
const WORKLOAD = WorkloadKeySchema.make('core.media.ingest');
const allowedPermission = { checkActionPermission: () => Effect.succeed('allowed' as const) };

const PrincipalKindSchema = Schema.Literals(['human', 'integration', 'service', 'system']);
type PrincipalKind = typeof PrincipalKindSchema.Type;
interface Actor {
  readonly authBindingId: string;
  readonly kind: PrincipalKind;
  readonly principalId: string;
}
interface World {
  readonly admin: PgClient.PgClient;
  readonly human: Actor;
  readonly humanTwo: Actor;
  readonly integration: Actor;
  readonly legalEntityId: string;
  readonly system: Actor;
  readonly tenantId: string;
}

const insertActor = Effect.fn('CoreMediaUploadTest.insertActor')(function* insertActor(
  admin: PgClient.PgClient,
  tenantId: string,
  actor: Actor,
) {
  yield* admin.unsafe(
    `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $2, $3, 'Media actor', 'active')`,
    [actor.principalId, tenantId, actor.kind],
  );
  yield* admin.unsafe(
    `insert into core.principal_auth_bindings (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider, subject_type, provider_subject_id, status)
     values ($1, $2, $3, 'test.staff.better-auth.v1', 'better_auth', $4, $5, 'active')`,
    [
      actor.authBindingId,
      tenantId,
      actor.principalId,
      actor.kind === 'human' ? 'user' : 'api_key',
      `media-upload-${actor.authBindingId}`,
    ],
  );
});

const cleanTenant = (admin: PgClient.PgClient, tenantId: string) =>
  Effect.forEach(
    [
      'core.media_assets',
      'core.data_access_events',
      'core.audit_events',
      'core.action_invocations',
      'core.access_workload_bindings',
      'core.principal_auth_bindings',
      'core.principals',
      'core.legal_entities',
    ],
    (table) => admin.unsafe(`delete from ${table} where tenant_id = $1`, [tenantId]),
    { discard: true },
  ).pipe(Effect.orDie);

const makeWorld = Effect.fn('CoreMediaUploadTest.world')(function* makeWorld(
  admin: PgClient.PgClient,
  executor: CoreDatabaseExecutor,
) {
  const tenantId = yield* nextUuid;
  const legalEntityId = yield* nextUuid;
  const actorOf = Effect.fn('CoreMediaUploadTest.actor')(function* actorOf(kind: PrincipalKind) {
    return { authBindingId: yield* nextUuid, kind, principalId: yield* nextUuid } satisfies Actor;
  });
  const actors = {
    human: yield* actorOf('human'),
    humanTwo: yield* actorOf('human'),
    integration: yield* actorOf('integration'),
    system: yield* actorOf('system'),
  };
  yield* Effect.addFinalizer(() => cleanTenant(admin, tenantId));
  yield* admin.unsafe(
    `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Media upload tenant', 'active', 'en')`,
    [tenantId, `media-upload-${tenantId}`],
  );
  yield* admin.unsafe(
    `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values ($1, $2, 'Media company', 'CZ', $3, 'active')`,
    [legalEntityId, tenantId, legalEntityId],
  );
  for (const actor of Object.values(actors)) {
    yield* insertActor(admin, tenantId, actor);
  }
  // The real access fence the Action runtime pins every governed write to. Core retains it, so the tenant stays.
  yield* writeTestTenantScopes(executor, { principalId: actors.human.principalId, tenantId });
  return { admin, ...actors, legalEntityId, tenantId } satisfies World;
});

const principalOf = (world: World, actor: Actor, legalEntityId?: string) => {
  const principal = {
    authBindingId: actor.authBindingId,
    authContextRef: `core-media-upload-${actor.principalId}`,
    authMethod: actor.kind === 'human' ? 'session' : 'api_key',
    principalId: actor.principalId,
    tenantId: world.tenantId,
  };
  return legalEntityId === undefined ? principal : { ...principal, legalEntityId };
};

interface AssetRow {
  readonly byte_size: bigint;
  readonly content_sha256: string | null;
  readonly ingested_by_principal_id: string | null;
  readonly ingestion_source: string;
  readonly legal_entity_id: string | null;
  readonly mime_type: string;
  readonly processing_status: string;
  readonly sealed_at: Date | null;
  readonly storage_key: string;
  readonly storage_provider: string;
  readonly tenant_id: string;
}

const unavailableAuthority: DecisionAuthorityPort = {
  readCells: () => Effect.fail(accessDecisionUnavailable('no intent in this suite')),
  readConfigureBases: () => Effect.fail(accessDecisionUnavailable('no intent in this suite')),
  readConnection: () => Effect.fail(accessDecisionUnavailable('no intent in this suite')),
  readScope: () => Effect.fail(accessDecisionUnavailable('no intent in this suite')),
  readTeamIds: () => Effect.fail(accessDecisionUnavailable('no intent in this suite')),
};

const transportOf = (idempotencyKey: string) => ({ correlationId: `media-upload-${idempotencyKey}`, idempotencyKey });

type ReservationOverrides = Partial<typeof UploadAssetPayloadSchema.Encoded>;

const reservationPayload = (bytes: Uint8Array, overrides: ReservationOverrides = {}) => ({
  declaredByteSize: bytes.byteLength,
  declaredContentSha256: digestOf(bytes),
  displayFilename: 'Brochure.pdf',
  ingestionSource: 'user',
  mimeType: 'application/pdf',
  ...overrides,
});

/** Everything a test needs: the database, a runtime per carrier, the provider double and the row readers. */
const openHarness = Effect.fn('CoreMediaUploadTest.harness')(function* openHarness() {
  const crypto = yield* Crypto.Crypto;
  const connections = yield* loadDatabaseConnectionPair();
  const admin = yield* makeTestPgClient(connections.admin.connectionString);
  const configuration = yield* loadDatabaseConfig({ identity: SHARED_RUNTIME_IDENTITY });
  const database = yield* makeCoreDatabase(configuration);
  const storage = yield* makeInMemoryObjectStorage();
  // The machine path of the real seam over the real principal-kind and workload-binding tables. Only the
  // identity and registry reads are live here: no access intent exists, and the workload path never asks for any.
  const workloadBindings = makeDrizzleAccessWorkloadBindings({ executor: database.executor });
  const privacyDispatchLiveness = { read: () => Effect.succeed(false) };
  const enforcementPorts: AccessEnforcementPorts = {
    candidates: { listCandidateIds: () => Effect.succeed([]) },
    check: { checkBulk: () => Effect.fail(accessDecisionUnavailable('no engine in this suite')) },
    decisionLog: { record: () => Effect.void },
    intent: { authorityFor: () => unavailableAuthority },
    principalKinds: makeDrizzleAccessPrincipalKinds({ executor: database.executor }),
    privacyDispatchLiveness,
    workloadBindings,
  };
  const machineGate = bindAccessGate(
    makeAccessDecisionService({
      authorityFor: enforcementPorts.intent.authorityFor,
      check: enforcementPorts.check,
      decisionLog: enforcementPorts.decisionLog,
      legalEntities: enforcementPorts.candidates,
      principalKinds: enforcementPorts.principalKinds,
      privacyDispatchLiveness,
      workloadBindings,
    }),
    enforcementPorts,
  );
  const gateFor = (carrier: 'human' | 'machine', accessOverride: 'denied' | 'unavailable' | undefined) => {
    if (accessOverride !== undefined) {
      return makeScriptedBoundAccessGate(accessOverride).bound;
    }
    return carrier === 'human' ? makeScriptedBoundAccessGate('allowed').bound : machineGate;
  };
  const runtimeFor = (carrier: 'human' | 'machine', accessOverride?: 'denied' | 'unavailable') => {
    const options = { ...openActionRuntimeOptions, accessDecision: gateFor(carrier, accessOverride) };
    const repository = makeActionRepository(crypto);
    const runAction: ActionRuntimeService['runAction'] = (input) =>
      makeActionRuntime(database, repository, allowedPermission, testOperationalScopeResolver, {
        ...options,
        ownerRegistration: makeTestOperationOwner({
          actions: [input.registration],
          moduleId: input.registration.descriptor.owningModuleKey,
        }).ownerRegistration,
      }).runAction(input);
    return { runAction };
  };
  const rowOf = (tenantId: string, mediaAssetId: string) =>
    admin
      .unsafe<AssetRow>(`select * from core.media_assets where tenant_id = $1 and media_asset_id = $2`, [
        tenantId,
        mediaAssetId,
      ])
      .pipe(Effect.map((rows) => rows[0]));
  const rowCount = (tenantId: string) =>
    admin
      .unsafe<{ count: string }>(`select count(*)::text as count from core.media_assets where tenant_id = $1`, [
        tenantId,
      ])
      .pipe(Effect.map((rows) => Number(rows[0]?.count ?? '0')));
  const countOf = (table: string, tenantId: string) =>
    admin
      .unsafe<{ count: string }>(`select count(*)::text as count from ${table} where tenant_id = $1`, [tenantId])
      .pipe(Effect.map((rows) => Number(rows[0]?.count ?? '0')));
  const bind = Effect.fn('CoreMediaUploadTest.bind')(function* bind(world: World, actor: Actor) {
    const bindingId = yield* nextUuid.pipe(Effect.flatMap(Schema.decodeUnknownEffect(AccessWorkloadBindingIdSchema)));
    const incarnation = yield* nextUuid.pipe(Effect.flatMap(Schema.decodeUnknownEffect(AccessWorkloadBindingIdSchema)));
    const trusted = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(principalOf(world, actor));
    yield* writeWorkloadBindings(
      database,
      { ...trusted, correlationId: 'media-upload-bind' },
      {
        bindings: [
          {
            bindingId,
            createdAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
            incarnation,
            principalId: PrincipalIdSchema.make(actor.principalId),
            tenantId: TenantIdSchema.make(world.tenantId),
            workloadKey: WORKLOAD,
          },
        ],
      },
    );
  });
  return { admin, bind, countOf, database, rowCount, rowOf, runtimeFor, storage };
});

const contextAccessNeverAsked = {
  legalEntities: () => Effect.die('The legacy permission engine must not be consulted'),
  modules: () => Effect.die('The legacy permission engine must not be consulted'),
  resources: () => Effect.die('The legacy permission engine must not be consulted'),
  tenants: () => Effect.die('The legacy permission engine must not be consulted'),
};

/** The harness plus a Read runtime like the Shell's: no owner registration and a legacy permission engine that must stay silent. */
const openEdgeHarness = Effect.fn('CoreMediaUploadEdgeTest.harness')(function* openEdgeHarness() {
  const harness = yield* openHarness();
  const reads = makeReadRuntime(
    harness.database,
    openModuleEntrypointGateway,
    testOperationalScopeResolver,
    contextAccessNeverAsked,
    { accessDecision: makeScriptedBoundAccessGate('allowed').bound },
  );
  const attempts = yield* Ref.make(0);
  return { ...harness, attempts, reads };
});
type EdgeHarness = Effect.Success<ReturnType<typeof openEdgeHarness>>;

const PRINCIPAL_HEADER = 'x-test-principal';

interface Persona {
  readonly accessOverride?: 'denied' | 'unavailable';
  readonly actor: Actor;
  readonly legalEntityId?: string;
  readonly world: World;
}

/** The answer a client sees: the status the failure keeps at the edge and a body of the safe vocabulary only. */
const statusOfFailure = (failure: EdgeFailure | undefined): number => {
  if (isMediaFailure(failure)) {
    return mediaFailureStatus(failure);
  }
  if (Predicate.isTagged(failure, 'ActionPermissionDenied')) {
    return 403;
  }
  return Predicate.isTagged(failure, 'ReadHandlerNotFound') ? 404 : 500;
};

const JsonText = Schema.fromJsonString(Schema.Json);
const jsonText = (value: typeof Schema.Json.Type): string => Schema.encodeSync(JsonText)(value);
const jsonValue = (text: string): typeof Schema.Json.Type => Schema.decodeUnknownSync(JsonText)(text);

/** What the edge's answer is built from: any tagged failure, with the safe code and reason when it has them. */
interface EdgeFailure {
  readonly _tag: string;
  readonly code?: string;
  readonly reason?: string;
}

const failureText = (failure: EdgeFailure | undefined): string =>
  jsonText({ _tag: failure?._tag ?? 'Unknown', code: failure?.code ?? null, reason: failure?.reason ?? null });

/** The Shell handler's composition, step for step, over the harness runtimes. */
const receive = Effect.fn('CoreMediaUploadEdgeTest.receive')(function* receive(
  harness: EdgeHarness,
  personas: ReadonlyMap<string, Persona>,
  storage: ObjectStorageService,
  request: HttpServerRequest.HttpServerRequest,
) {
  const persona = personas.get(request.headers[PRINCIPAL_HEADER] ?? '');
  if (persona === undefined) {
    return HttpServerResponse.text('{"_tag":"Unauthenticated"}', { status: 401 });
  }
  const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(
    principalOf(persona.world, persona.actor, persona.legalEntityId),
  ).pipe(Effect.orDie);
  const mediaAssetId = new URL(request.url, 'http://edge.test').pathname.split('/').at(4) ?? '';
  const mediaAssetRef = {
    moduleId: 'core.media',
    resourceId: mediaAssetId,
    resourceType: 'core.media.asset',
    tenantId: principal.tenantId,
  } as const;
  const correlationId = `upload-edge-${mediaAssetId}`;
  const compose = Effect.gen(function* compose() {
    let offered = Option.none<MediaByteSourceOffer>();
    const { legalEntityId: _selected, ...tenantWide } = principal;
    yield* harness.reads
      .runRead({
        input: { mediaAssetRef },
        principal: tenantWide,
        registration: assetByteSourceRead,
        transport: { correlationId },
      })
      .pipe(
        Effect.provideService(MediaByteSource, {
          offer: (asset) =>
            Effect.sync(() => {
              offered = Option.some(asset);
            }),
        }),
      );
    if (Option.isNone(offered)) {
      return yield* Effect.die('The byte-source Read offered no row');
    }
    const runtime = harness.runtimeFor(persona.actor.kind === 'human' ? 'human' : 'machine', persona.accessOverride);
    return yield* ingestMediaBytes({
      asset: offered.value,
      body: request.stream,
      confirm: (verification) =>
        Ref.updateAndGet(harness.attempts, (count) => count + 1).pipe(
          Effect.flatMap((attempt) => {
            const confirmation = confirmAssetRequest(mediaAssetRef, `${correlationId}\0${attempt}`);
            return runtime.runAction({
              payload: confirmation.payload,
              principal,
              registration: confirmAssetAction,
              transport: { correlationId, idempotencyKey: confirmation.idempotencyKey },
            });
          }),
          Effect.provideService(StoredMediaObjectVerification, verification),
        ),
      contentLength: parseContentLength(request.headers['content-length']),
      mediaAssetRef,
      principalId: principal.principalId,
      selectedLegalEntityId: principal.legalEntityId,
    });
  }).pipe(Effect.provideService(ObjectStorage, storage));
  const exit = yield* Effect.exit(compose);
  if (Exit.isSuccess(exit)) {
    return HttpServerResponse.text(jsonText(exit.value), { headers: uploadResponseHeaders, status: 200 });
  }
  const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return HttpServerResponse.text(failureText(failure), {
    headers: uploadResponseHeaders,
    status: statusOfFailure(failure),
  });
});

/** Serves the edge on a real loopback port for one provider and one set of callers. */
const serveEdge = Effect.fn('CoreMediaUploadEdgeTest.serve')(function* serveEdge(
  harness: EdgeHarness,
  personas: ReadonlyMap<string, Persona>,
  storage: ObjectStorageService,
) {
  const server = yield* NodeHttpServer.make(() => process.getBuiltinModule('http').createServer(), {
    host: '127.0.0.1',
    port: 0,
  });
  yield* server.serve(
    Effect.gen(function* handle() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      return yield* receive(harness, personas, storage, request);
    }),
  );
  const address = yield* Match.value(server.address).pipe(
    Match.when(NetAddress.isInetAddress, (inet) => Effect.succeed(inet)),
    Match.orElse(() => Effect.die('The edge fixture did not bind to TCP')),
  );
  return { host: '127.0.0.1', port: address.port };
});

interface Answer {
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
  readonly text: string;
}

/** Every answer text seen by a test, so a final check can search all of them for what must never be there. */
const seen: string[] = [];

const putBytes = Effect.fn('CoreMediaUploadEdgeTest.put')(function* putBytes(
  edge: { readonly host: string; readonly port: number },
  mediaAssetId: string,
  options: {
    readonly body: Uint8Array | Stream.Stream<Uint8Array>;
    readonly persona: string;
  },
) {
  const client = yield* HttpClient.HttpClient;
  const base = HttpClientRequest.put(`http://${edge.host}:${edge.port}/core/media/assets/${mediaAssetId}/bytes`).pipe(
    HttpClientRequest.setHeader(PRINCIPAL_HEADER, options.persona),
  );
  const request = Predicate.isUint8Array(options.body)
    ? HttpClientRequest.bodyUint8Array(base, options.body, 'application/octet-stream')
    : HttpClientRequest.bodyStream(base, options.body, { contentType: 'application/octet-stream' });
  const response = yield* client.execute(request);
  const text = yield* response.text;
  seen.push(text, jsonText(response.headers));
  return { headers: response.headers, status: response.status, text } satisfies Answer;
});

const reserve = Effect.fn('CoreMediaUploadEdgeTest.reserve')(function* reserve(
  harness: EdgeHarness,
  persona: Persona,
  bytes: Uint8Array,
  key: string,
  storage: ObjectStorageService,
) {
  const reservation = yield* harness
    .runtimeFor(persona.actor.kind === 'human' ? 'human' : 'machine')
    .runAction({
      payload: reservationPayload(bytes),
      principal: principalOf(persona.world, persona.actor, persona.legalEntityId),
      registration: uploadAssetAction,
      transport: transportOf(`${key}-reserve`),
    })
    .pipe(Effect.provideService(ObjectStorage, storage));
  return reservation.mediaAssetRef.resourceId;
});

/** Every log line the edge, the hop and the reconciliation emitted. */
const logged: string[] = [];
const captureLogs = Logger.layer([
  Logger.make(({ message }) => {
    logged.push(Array.isArray(message) ? message.map(String).join(' ') : String(message));
  }),
]);
/** Every storage key an edge test touched: none of them may ever appear in an answer or a log line. */
const keysTouched: string[] = [];

const storedBytes = (storage: InMemoryObjectStorage, tenantId: string, mediaAssetId: string) => {
  const key = deriveMediaStorageKey({ mediaAssetId, tenantId });
  keysTouched.push(key);
  return storage.peek(key).pipe(Effect.map(Option.getOrUndefined));
};

const statusOfRow = (harness: EdgeHarness, tenantId: string, mediaAssetId: string) =>
  harness.rowOf(tenantId, mediaAssetId).pipe(Effect.map((row) => row?.processing_status));

const personaNamed = (personas: ReadonlyMap<string, Persona>, name: string) =>
  Option.match(Option.fromUndefinedOr(personas.get(name)), {
    onNone: () => Effect.die(`The persona ${name} is not part of this fixture`),
    onSome: (persona) => Effect.succeed(persona),
  });

const edgeWorld = Effect.fn('CoreMediaUploadEdgeTest.world')(function* edgeWorld(harness: EdgeHarness) {
  const world = yield* makeWorld(harness.admin, harness.database.executor);
  const foreign = yield* makeWorld(harness.admin, harness.database.executor);
  yield* harness.bind(world, world.integration);
  yield* harness.bind(world, world.system);
  const personas = new Map<string, Persona>([
    ['human', { actor: world.human, world }],
    ['humanTwo', { actor: world.humanTwo, world }],
    ['integration', { actor: world.integration, world }],
    ['foreign', { actor: foreign.human, world: foreign }],
    ['humanDenied', { accessOverride: 'denied', actor: world.human, world }],
    ['humanInCompany', { actor: world.human, legalEntityId: world.legalEntityId, world }],
  ]);
  return { foreign, personas, world };
});

/** A client that declares a whole body, sends part of it and drops the connection. */
const rawPartialPut = Effect.fn('CoreMediaUploadEdgeTest.rawPartialPut')(function* rawPartialPut(
  edgeAddress: { readonly host: string; readonly port: number },
  mediaAssetId: string,
  persona: string,
  declaredLength: number,
  partial: Uint8Array,
) {
  const head = `PUT /core/media/assets/${mediaAssetId}/bytes HTTP/1.1\r\nhost: edge.test\r\n${PRINCIPAL_HEADER}: ${persona}\r\ncontent-length: ${declaredLength}\r\n\r\n`;
  const socket = yield* Effect.callback<ReturnType<ReturnType<typeof process.getBuiltinModule<'net'>>['connect']>>(
    (resume) => {
      const created = process.getBuiltinModule('net').connect(edgeAddress.port, edgeAddress.host);
      created.on('error', () => resume(Effect.die('The raw client could not connect')));
      created.on('connect', () => {
        created.write(head);
        created.write(partial, () => resume(Effect.succeed(created)));
      });
    },
  );
  yield* Effect.sleep('50 millis');
  socket.destroy();
});

it.layer(Layer.mergeAll(NodeCrypto.layer, FetchHttpClient.layer, captureLogs), { excludeTestServices: true })(
  'core media upload edge on PostgreSQL over HTTP',
  (suite) => {
    const edge = Effect.fn('CoreMediaUploadEdgeTest.edge')(function* edge(
      options: {
        readonly faults?: Parameters<typeof withObjectStorageFaults>[0];
      } = {},
    ) {
      const harness = yield* openEdgeHarness();
      const { foreign, personas, world } = yield* edgeWorld(harness);
      const base = harness.storage;
      const storage =
        options.faults === undefined
          ? base.service
          : yield* withObjectStorageFaults(options.faults).pipe(Effect.provideService(ObjectStorage, base.service));
      const address = yield* serveEdge(harness, personas, storage);
      return { address, base, foreign, harness, personas, storage, world };
    });

    suite.effect('roundtrips reserve, PUT, confirm, metadata read and download, and seals ready only at the end', () =>
      Effect.scoped(
        Effect.gen(function* roundtrip() {
          const { address, base, harness, personas, storage, world } = yield* edge();
          const human = yield* personaNamed(personas, 'human');
          const mediaAssetId = yield* reserve(harness, human, content, 'roundtrip', storage);
          expect(yield* statusOfRow(harness, world.tenantId, mediaAssetId)).toBe('uploaded');

          const answer = yield* putBytes(address, mediaAssetId, { body: content, persona: 'human' });
          expect(answer.status).toBe(200);
          expect(jsonValue(answer.text)).toEqual({
            byteSize: content.byteLength,
            contentSha256: digestOf(content),
            mediaAssetRef: {
              moduleId: 'core.media',
              resourceId: mediaAssetId,
              resourceType: 'core.media.asset',
              tenantId: world.tenantId,
            },
            processingStatus: 'ready',
          });
          expect(answer.headers['cache-control']).toBe('private, no-store');
          expect(answer.headers['x-content-type-options']).toBe('nosniff');
          const row = yield* harness.rowOf(world.tenantId, mediaAssetId);
          expect(row).toMatchObject({ content_sha256: digestOf(content), processing_status: 'ready' });
          expect(row?.sealed_at).not.toBeNull();
          expect(yield* storedBytes(base, world.tenantId, mediaAssetId)).toEqual(content);

          // The metadata read now says verified, and the download delivers exactly the stored bytes.
          const principal = principalOf(world, world.human);
          const mediaAssetRef = {
            moduleId: 'core.media',
            resourceId: mediaAssetId,
            resourceType: 'core.media.asset',
            tenantId: world.tenantId,
          } as const;
          const metadata = yield* harness.reads.runRead({
            input: { mediaAssetRef },
            principal,
            registration: assetMetadataRead,
            transport: { correlationId: 'edge-metadata' },
          });
          expect(metadata).toMatchObject({
            byteSize: content.byteLength,
            contentSha256: digestOf(content),
            contentVerified: true,
            processingStatus: 'ready',
          });
          let offered = Option.none<MediaVerifiableAsset>();
          const authorization = yield* harness.reads
            .runRead({
              input: { mediaAssetRef },
              principal,
              registration: assetDownloadRead,
              transport: { correlationId: 'edge-download' },
            })
            .pipe(
              Effect.provideService(MediaDownloadSource, {
                offer: (asset) =>
                  Effect.sync(() => {
                    offered = Option.some(asset);
                  }),
              }),
            );
          const object = yield* Option.match(offered, {
            onNone: () => Effect.die('The download Read offered no object'),
            onSome: (asset) => Effect.succeed(asset),
          });
          const download = yield* streamConfirmedBytes(object, authorization).pipe(
            Effect.provideService(ObjectStorage, storage),
            Effect.provideService(MediaIntegrityRecorder, { record: () => Effect.void }),
          );
          const chunks = yield* Stream.runCollect(download.body);
          expect(new Uint8Array(chunks.flatMap((chunk) => [...chunk]))).toEqual(content);
        }),
      ),
    );

    suite.effect('refuses another principal, another tenant and a caller without the confirm capability', () =>
      Effect.scoped(
        Effect.gen(function* principals() {
          const { address, base, harness, personas, storage, world } = yield* edge();
          const human = yield* personaNamed(personas, 'human');
          const mediaAssetId = yield* reserve(harness, human, content, 'principals', storage);
          // Another person of the same tenant: refused before a byte is read, and nothing is stored.
          expect((yield* putBytes(address, mediaAssetId, { body: content, persona: 'humanTwo' })).status).toBe(403);
          // Another tenant: the very answer of an absent asset.
          const foreign = yield* putBytes(address, mediaAssetId, { body: content, persona: 'foreign' });
          expect(foreign.status).toBe(404);
          const absent = yield* putBytes(address, '00000000-0000-4000-8000-0000000000ff', {
            body: content,
            persona: 'human',
          });
          expect(absent.status).toBe(404);
          expect(yield* storedBytes(base, world.tenantId, mediaAssetId)).toBeUndefined();
          expect(yield* statusOfRow(harness, world.tenantId, mediaAssetId)).toBe('uploaded');
          // The reserving principal without the confirm capability may move the bytes but cannot seal them.
          const denied = yield* putBytes(address, mediaAssetId, { body: content, persona: 'humanDenied' });
          expect(denied.status).toBe(403);
          expect(yield* statusOfRow(harness, world.tenantId, mediaAssetId)).toBe('uploaded');
          // The same asset is then completed by the same intent: nothing was lost and no second asset exists.
          expect((yield* putBytes(address, mediaAssetId, { body: content, persona: 'human' })).status).toBe(200);
          expect(yield* statusOfRow(harness, world.tenantId, mediaAssetId)).toBe('ready');
          expect(yield* harness.rowCount(world.tenantId)).toBe(1);
        }),
      ),
    );

    suite.effect(
      'answers a replay of the same bytes as the sealed identity without a second effect, other bytes as 409',
      () =>
        Effect.scoped(
          Effect.gen(function* replay() {
            const { address, base, harness, personas, storage, world } = yield* edge();
            const human = yield* personaNamed(personas, 'human');
            const mediaAssetId = yield* reserve(harness, human, content, 'replay', storage);
            const first = yield* putBytes(address, mediaAssetId, { body: content, persona: 'human' });
            expect(first.status).toBe(200);
            const before = yield* base.calls;
            const sealedRow = yield* harness.rowOf(world.tenantId, mediaAssetId);
            const again = yield* putBytes(address, mediaAssetId, { body: content, persona: 'human' });
            expect(again).toMatchObject({ status: 200, text: first.text });
            // No provider call and no row change: the body was only compared with the sealed digest.
            expect((yield* base.calls).length).toBe(before.length);
            expect(yield* harness.rowOf(world.tenantId, mediaAssetId)).toEqual(sealedRow);
            const other = encoder.encode('Z'.repeat(content.byteLength));
            expect((yield* putBytes(address, mediaAssetId, { body: other, persona: 'human' })).status).toBe(409);
            expect(yield* storedBytes(base, world.tenantId, mediaAssetId)).toEqual(content);
            expect(yield* harness.rowOf(world.tenantId, mediaAssetId)).toEqual(sealedRow);
          }),
        ),
    );

    suite.effect('refuses bytes for a failed or scanning asset with its own status', () =>
      Effect.scoped(
        Effect.gen(function* statuses() {
          const { address, base, harness, personas, storage, world } = yield* edge();
          const human = yield* personaNamed(personas, 'human');
          const failed = yield* reserve(harness, human, content, 'status-failed', storage);
          const scanning = yield* reserve(harness, human, content, 'status-scanning', storage);
          yield* harness.admin.unsafe(
            `update core.media_assets set processing_status = 'failed' where tenant_id = $1 and media_asset_id = $2`,
            [world.tenantId, failed],
          );
          yield* harness.admin.unsafe(
            `update core.media_assets set processing_status = 'scanning' where tenant_id = $1 and media_asset_id = $2`,
            [world.tenantId, scanning],
          );
          expect((yield* putBytes(address, failed, { body: content, persona: 'human' })).status).toBe(422);
          expect((yield* putBytes(address, scanning, { body: content, persona: 'human' })).status).toBe(409);
          expect(yield* storedBytes(base, world.tenantId, failed)).toBeUndefined();
          expect(yield* storedBytes(base, world.tenantId, scanning)).toBeUndefined();
        }),
      ),
    );

    suite.effect('requires the exact Content-Length: 411 without one, 409 for another, 409 for other bytes', () =>
      Effect.scoped(
        Effect.gen(function* lengths() {
          const { address, base, harness, personas, storage, world } = yield* edge();
          const human = yield* personaNamed(personas, 'human');
          const mediaAssetId = yield* reserve(harness, human, content, 'lengths', storage);
          // A chunked body states no length: typed 411, and nothing is read or stored.
          const chunked = yield* putBytes(address, mediaAssetId, {
            body: Stream.fromIterable([content.slice(0, 10), content.slice(10)]),
            persona: 'human',
          });
          expect(chunked.status).toBe(411);
          expect(chunked.text).toContain('media_length_required');
          // A body of another length than the reservation fixed.
          expect(
            (yield* putBytes(address, mediaAssetId, { body: content.slice(0, 10), persona: 'human' })).status,
          ).toBe(409);
          expect(
            (yield* putBytes(address, mediaAssetId, { body: encoder.encode('x'.repeat(200)), persona: 'human' }))
              .status,
          ).toBe(409);
          // The right length with other bytes: a conflict that leaves nothing readable and does not close the asset.
          const other = encoder.encode('Q'.repeat(content.byteLength));
          expect((yield* putBytes(address, mediaAssetId, { body: other, persona: 'human' })).status).toBe(409);
          expect(yield* storedBytes(base, world.tenantId, mediaAssetId)).toBeUndefined();
          expect(yield* statusOfRow(harness, world.tenantId, mediaAssetId)).toBe('uploaded');
          // The same asset still completes with the right bytes.
          expect((yield* putBytes(address, mediaAssetId, { body: content, persona: 'human' })).status).toBe(200);
        }),
      ),
    );

    suite.effect('leaves nothing readable and the asset recoverable when the connection drops mid-body', () =>
      Effect.scoped(
        Effect.gen(function* dropped() {
          const { address, base, harness, personas, storage, world } = yield* edge();
          const human = yield* personaNamed(personas, 'human');
          const mediaAssetId = yield* reserve(harness, human, content, 'dropped', storage);
          yield* rawPartialPut(address, mediaAssetId, 'human', content.byteLength, content.slice(0, 12));
          // The server settles the aborted transfer on its own time.
          yield* Effect.sleep('200 millis');
          expect(yield* storedBytes(base, world.tenantId, mediaAssetId)).toBeUndefined();
          expect(yield* statusOfRow(harness, world.tenantId, mediaAssetId)).toBe('uploaded');
          expect((yield* putBytes(address, mediaAssetId, { body: content, persona: 'human' })).status).toBe(200);
          expect(yield* storedBytes(base, world.tenantId, mediaAssetId)).toEqual(content);
        }),
      ),
    );

    suite.effect('is a retryable 503 and no success while the provider is down, then completes the same asset', () =>
      Effect.scoped(
        Effect.gen(function* outage() {
          const { address, harness, personas, storage, world } = yield* edge({
            faults: [
              {
                failure: new ObjectStorageNetworkError({
                  code: 'object_storage_network_error',
                  reason: 'provider down',
                }),
                operation: 'put',
                times: 1,
              },
            ],
          });
          const human = yield* personaNamed(personas, 'human');
          const mediaAssetId = yield* reserve(harness, human, content, 'outage', storage);
          const down = yield* putBytes(address, mediaAssetId, { body: content, persona: 'human' });
          expect(down.status).toBe(503);
          expect(yield* statusOfRow(harness, world.tenantId, mediaAssetId)).toBe('uploaded');
          const retry = yield* putBytes(address, mediaAssetId, { body: content, persona: 'human' });
          expect(retry.status).toBe(200);
          expect(yield* statusOfRow(harness, world.tenantId, mediaAssetId)).toBe('ready');
          expect(yield* harness.rowCount(world.tenantId)).toBe(1);
        }),
      ),
    );

    suite.effect('completes the original asset when the provider stored the bytes but reported a failure', () =>
      Effect.scoped(
        Effect.gen(function* storedButReported() {
          const { address, harness, personas, storage, world } = yield* edge({
            faults: [
              {
                failure: new ObjectStorageNetworkError({ code: 'object_storage_network_error', reason: 'reset' }),
                operation: 'put',
                times: 1,
                when: 'after',
              },
            ],
          });
          const human = yield* personaNamed(personas, 'human');
          const mediaAssetId = yield* reserve(harness, human, content, 'reported', storage);
          expect((yield* putBytes(address, mediaAssetId, { body: content, persona: 'human' })).status).toBe(200);
          expect(yield* statusOfRow(harness, world.tenantId, mediaAssetId)).toBe('ready');
          expect(yield* harness.rowCount(world.tenantId)).toBe(1);
        }),
      ),
    );

    suite.effect('carries a machine principal through its workload binding with the same rule', () =>
      Effect.scoped(
        Effect.gen(function* machine() {
          const { address, harness, personas, storage, world } = yield* edge();
          const integration = yield* personaNamed(personas, 'integration');
          const mediaAssetId = yield* reserve(harness, integration, content, 'machine', storage);
          // A human of the same tenant is not the reserving principal, whatever they may hold.
          expect((yield* putBytes(address, mediaAssetId, { body: content, persona: 'human' })).status).toBe(403);
          expect((yield* putBytes(address, mediaAssetId, { body: content, persona: 'integration' })).status).toBe(200);
          expect(yield* statusOfRow(harness, world.tenantId, mediaAssetId)).toBe('ready');
          expect((yield* harness.rowOf(world.tenantId, mediaAssetId))?.ingestion_source).toBe('user');
        }),
      ),
    );

    suite.effect('applies the selected company: the reserving company completes, the tenant-wide caller too', () =>
      Effect.scoped(
        Effect.gen(function* company() {
          const { address, harness, personas, storage, world } = yield* edge();
          const inCompany = yield* personaNamed(personas, 'humanInCompany');
          const mediaAssetId = yield* reserve(harness, inCompany, content, 'company', storage);
          expect((yield* harness.rowOf(world.tenantId, mediaAssetId))?.legal_entity_id).toBe(world.legalEntityId);
          expect((yield* putBytes(address, mediaAssetId, { body: content, persona: 'humanInCompany' })).status).toBe(
            200,
          );
        }),
      ),
    );

    suite.effect('puts no storage key, provider, version reference or credential into any answer or log line', () =>
      Effect.gen(function* noLocator() {
        expect(seen.length).toBeGreaterThan(0);
        const everything = [...seen, ...logged].join('\n');
        for (const key of keysTouched) {
          expect(everything).not.toContain(key);
        }
        expect(everything).not.toMatch(/in-memory-test-double|core-media\/v1\/|x-amz|secret|credential|signature/iu);
        yield* Effect.void;
      }),
    );
  },
);
