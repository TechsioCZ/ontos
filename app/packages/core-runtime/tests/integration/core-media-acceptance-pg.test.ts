import { NodeCrypto } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { sha256 } from '@noble/hashes/sha2.js';
import { Cause, Crypto, DateTime, Effect, Exit, Option, Predicate, Schema, Stream } from 'effect';
import { Hex } from 'effect/encoding';
import { expect, it } from 'effect-rstest';

import { accessDecisionUnavailable } from '../../src/access/decision/errors.ts';
import type { DecisionAuthorityPort } from '../../src/access/decision/authority.ts';
import { makeDrizzleAccessPrincipalKinds } from '../../src/access/enforcement/actor.ts';
import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
import { PrincipalIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import { makeDrizzleAccessWorkloadBindings } from '../../src/access/workloads/bindings.ts';
import { writeWorkloadBindings } from '../../src/access/workloads/binding-store.ts';
import { AccessWorkloadBindingIdSchema } from '../../src/access/workloads/store.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import type { ActionRuntimeService } from '../../src/actions/runtime.ts';
import { WorkloadKeySchema } from '../../src/authorization/access-declaration.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConfig, loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { SHARED_RUNTIME_IDENTITY } from '../../src/db/database-identities.ts';
import type { CoreDatabaseExecutor } from '../../src/db/types.ts';
import { assetCurrentRead } from '../../src/generated-reads/asset-current.ts';
import type { AssetCurrentResponseSchema } from '../../src/generated-reads/asset-current.ts';
import { assetMetadataRead } from '../../src/generated-reads/asset-metadata.ts';
import type { AssetMetadataResponse } from '../../src/generated-reads/asset-metadata.ts';
import { streamMediaObject } from '../../src/media/byte-stream.ts';
import type { MediaByteHopAsset } from '../../src/media/byte-stream.ts';
import { MediaAssetIdSchema, MediaTenantIdSchema, mediaAssetRefFor } from '../../src/media/identity.ts';
import { ObjectStorage, ObjectStorageNetworkError } from '../../src/media/object-storage.ts';
import type { ObjectStorageService } from '../../src/media/object-storage.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import type { UploadAssetPayloadSchema } from '../../src/media/upload-contract.ts';
import {
  MediaStoredObjectVerificationSchema,
  StoredMediaObjectVerification,
  verifyStoredMediaObject,
} from '../../src/media/verification.ts';
import { confirmAssetAction } from '../../src/modules/actions/confirm-asset.action.ts';
import { renameDisplayFilenameAction } from '../../src/modules/actions/rename-display-filename.action.ts';
import { uploadAssetAction } from '../../src/modules/actions/upload-asset.action.ts';
import { bindAccessGate } from '../../src/operations/access-gate.ts';
import type { AccessEnforcementPorts } from '../../src/operations/access-gate.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../src/testing/access-gate.ts';
import type { TestAccessOutcome } from '../../src/testing/access-gate.ts';
import { makeInMemoryObjectStorage, withObjectStorageFaults } from '../../src/testing/media-object-storage.ts';
import type { InMemoryObjectStorageOptions } from '../../src/testing/media-object-storage.ts';
import { writeTestTenantScopes } from '../../src/testing/tenant-access.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { makeTestOperationOwner, openActionRuntimeOptions } from '../support/action-runtime-options.ts';
import { makeTestPgClient } from '../support/database.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';

/*
 * Lane 16 acceptance proofs of the D20 finishing work on real PostgreSQL, through the real Action and Read runtimes.
 * Fixtures first: a tenant with a company and two principals, the real Action and Read runtimes on real PostgreSQL, the in-memory
 * ObjectStorage double (never storage proof) and a whole upload through the real reserve, byte hop and confirm.
 * Human callers pass a scripted allow; the machine caller passes the real access seam over the real principal-kind
 * and workload-binding tables, so a binding row is the only thing that admits it.
 */

const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const digestOf = (bytes: Uint8Array) => Hex.encode(sha256(bytes));
const bytesOf = (text: string) => new TextEncoder().encode(text);
const INGEST_WORKLOAD = WorkloadKeySchema.make('core.media.ingest');
const METADATA_CAPABILITY = 'core.media.asset-metadata.read';
const CURRENT_CAPABILITY = 'core.media.asset-current.read';

const allowedPermission = { checkActionPermission: () => Effect.succeed('allowed' as const) };
const contextAccess = {
  legalEntities: () => Effect.succeed([]),
  modules: () => Effect.succeed([]),
  resources: () => Effect.succeed([]),
  tenants: () => Effect.succeed([]),
};

const PrincipalKindSchema = Schema.Literals(['human', 'system']);
type PrincipalKind = typeof PrincipalKindSchema.Type;
interface Actor {
  readonly authBindingId: string;
  readonly kind: PrincipalKind;
  readonly principalId: string;
}
interface World {
  readonly admin: PgClient.PgClient;
  readonly human: Actor;
  readonly legalEntityId: string;
  readonly system: Actor;
  readonly tenantId: string;
}

const CLEANED_TABLES = [
  'core.media_links',
  'core.media_assets',
  'core.data_access_events',
  'core.audit_events',
  'core.action_invocations',
  'core.access_workload_bindings',
  'core.principal_auth_bindings',
  'core.principals',
  'core.legal_entities',
] as const;

const cleanTenant = (admin: PgClient.PgClient, tenantId: string) =>
  Effect.forEach(CLEANED_TABLES, (table) => admin.unsafe(`delete from ${table} where tenant_id = $1`, [tenantId]), {
    discard: true,
  }).pipe(Effect.orDie);

const insertActor = (admin: PgClient.PgClient, tenantId: string, actor: Actor) =>
  Effect.gen(function* insertActorRows() {
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
        `media-acceptance-${actor.authBindingId}`,
      ],
    );
  });

/** A throwaway tenant with one company, one human and one system principal; its rows are removed with the scope. */
const makeWorld = Effect.fn('CoreMediaAcceptance.world')(function* makeWorld(
  admin: PgClient.PgClient,
  executor: CoreDatabaseExecutor,
) {
  const tenantId = yield* nextUuid;
  const legalEntityId = yield* nextUuid;
  const human = { authBindingId: yield* nextUuid, kind: 'human', principalId: yield* nextUuid } satisfies Actor;
  const system = { authBindingId: yield* nextUuid, kind: 'system', principalId: yield* nextUuid } satisfies Actor;
  yield* Effect.addFinalizer(() => cleanTenant(admin, tenantId));
  yield* admin.unsafe(
    `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Media acceptance tenant', 'active', 'en')`,
    [tenantId, `media-acceptance-${tenantId}`],
  );
  yield* admin.unsafe(
    `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values ($1, $2, 'Media company', 'CZ', $3, 'active')`,
    [legalEntityId, tenantId, legalEntityId],
  );
  yield* insertActor(admin, tenantId, human);
  yield* insertActor(admin, tenantId, system);
  // The real access fence the Action runtime pins every governed write to.
  yield* writeTestTenantScopes(executor, { principalId: human.principalId, tenantId });
  return { admin, human, legalEntityId, system, tenantId } satisfies World;
});

const principalOf = (world: World, actor: Actor, legalEntityId?: string) => {
  const principal = {
    authBindingId: actor.authBindingId,
    authContextRef: `core-media-acceptance-${actor.principalId}`,
    authMethod: actor.kind === 'human' ? ('session' as const) : ('api_key' as const),
    principalId: actor.principalId,
    tenantId: world.tenantId,
  };
  return legalEntityId === undefined ? principal : { ...principal, legalEntityId };
};

const refOf = (world: World, mediaAssetId: string) =>
  mediaAssetRefFor({
    mediaAssetId: Schema.decodeUnknownSync(MediaAssetIdSchema)(mediaAssetId),
    tenantId: Schema.decodeUnknownSync(MediaTenantIdSchema)(world.tenantId),
  });

interface AssetRow {
  readonly byte_size: bigint;
  readonly content_sha256: string | null;
  readonly created_at: Date;
  readonly display_filename: string;
  readonly external_source_ref: string | null;
  readonly ingested_by_principal_id: string | null;
  readonly ingestion_source: string;
  readonly legal_entity_id: string | null;
  readonly media_asset_id: string;
  readonly mime_type: string;
  readonly original_filename: string | null;
  readonly processing_status: string;
  readonly sealed_at: Date | null;
  readonly storage_key: string;
  readonly storage_object_version_ref: string | null;
  readonly storage_provider: string;
  readonly tenant_id: string;
  readonly updated_at: Date;
}

interface LinkRow {
  readonly deleted_at: Date | null;
  readonly media_asset_id: string;
  readonly media_link_id: string;
  readonly target_resource_id: string;
}

const unavailableAuthority: DecisionAuthorityPort = {
  readCells: () => Effect.fail(accessDecisionUnavailable('no intent in this suite')),
  readConfigureBases: () => Effect.fail(accessDecisionUnavailable('no intent in this suite')),
  readConnection: () => Effect.fail(accessDecisionUnavailable('no intent in this suite')),
  readScope: () => Effect.fail(accessDecisionUnavailable('no intent in this suite')),
  readTeamIds: () => Effect.fail(accessDecisionUnavailable('no intent in this suite')),
};

type ReservationOverrides = Partial<typeof UploadAssetPayloadSchema.Encoded>;

const reservationPayload = (bytes: Uint8Array, overrides: ReservationOverrides = {}) => ({
  declaredByteSize: bytes.byteLength,
  declaredContentSha256: digestOf(bytes),
  displayFilename: 'Brochure.pdf',
  ingestionSource: 'user',
  mimeType: 'application/pdf',
  ...overrides,
});

const transportOf = (idempotencyKey: string) => ({
  correlationId: `media-acceptance-${idempotencyKey}`,
  idempotencyKey,
});

/** Everything a test needs: the database, a runtime per carrier, the provider double and the row readers. */
const openHarness = Effect.fn('CoreMediaAcceptance.harness')(function* openHarness(
  storageOptions: InMemoryObjectStorageOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const connections = yield* loadDatabaseConnectionPair();
  const admin = yield* makeTestPgClient(connections.admin.connectionString);
  const configuration = yield* loadDatabaseConfig({ identity: SHARED_RUNTIME_IDENTITY });
  const database = yield* makeCoreDatabase(configuration);
  const storage = yield* makeInMemoryObjectStorage(storageOptions);
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
  const runtimeFor = (
    actor: Actor,
    access: TestAccessOutcome | Readonly<Record<string, TestAccessOutcome>> = 'allowed',
  ) => {
    const options = {
      ...openActionRuntimeOptions,
      accessDecision: actor.kind === 'human' ? makeScriptedBoundAccessGate(access).bound : machineGate,
    };
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
  // Like the Shell host: no owner registration, so a read must be a genuine Core operation to run at all.
  const readRuntimeFor = (access: TestAccessOutcome | Readonly<Record<string, TestAccessOutcome>>) =>
    makeReadRuntime(database, openModuleEntrypointGateway, testOperationalScopeResolver, contextAccess, {
      accessDecision: makeScriptedBoundAccessGate(access).bound,
    });
  const metadataOf = (world: World, mediaAssetId: string, storageOverride?: ObjectStorageService) =>
    readRuntimeFor({ [METADATA_CAPABILITY]: 'allowed' })
      .runRead({
        input: { mediaAssetRef: refOf(world, mediaAssetId) },
        principal: principalOf(world, world.human),
        registration: assetMetadataRead,
        transport: { correlationId: `media-acceptance-metadata-${mediaAssetId}` },
      })
      .pipe(Effect.provideService(ObjectStorage, storageOverride ?? storage.service));
  const currentOf = (
    world: World,
    [first, ...rest]: readonly [string, ...string[]],
    storageOverride?: ObjectStorageService,
  ) =>
    readRuntimeFor({ [CURRENT_CAPABILITY]: 'allowed' })
      .runRead({
        input: { mediaAssetRefs: [refOf(world, first), ...rest.map((id) => refOf(world, id))] },
        principal: principalOf(world, world.human),
        registration: assetCurrentRead,
        transport: { correlationId: `media-acceptance-current-${first}` },
      })
      .pipe(Effect.provideService(ObjectStorage, storageOverride ?? storage.service));
  const rowOf = (tenantId: string, mediaAssetId: string) =>
    admin
      .unsafe<AssetRow>(`select * from core.media_assets where tenant_id = $1 and media_asset_id = $2`, [
        tenantId,
        mediaAssetId,
      ])
      .pipe(Effect.map((rows) => rows[0]));
  const requiredRowOf = (tenantId: string, mediaAssetId: string) =>
    rowOf(tenantId, mediaAssetId).pipe(
      Effect.flatMap((row) => (row === undefined ? Effect.die('The asset row is missing') : Effect.succeed(row))),
    );
  const linksOf = (tenantId: string) =>
    admin.unsafe<LinkRow>(
      `select media_link_id, media_asset_id, target_resource_id, deleted_at from core.media_links where tenant_id = $1 order by target_resource_id`,
      [tenantId],
    );
  const countOf = (table: string, tenantId: string) =>
    admin
      .unsafe<{ count: string }>(`select count(*)::text as count from ${table} where tenant_id = $1`, [tenantId])
      .pipe(Effect.map((rows) => Number(rows[0]?.count ?? '0')));
  /** The machine principal is admitted only by an active binding to the ingest workload. */
  const bindIngestWorkload = Effect.fn('CoreMediaAcceptance.bind')(function* bind(world: World, actor: Actor) {
    const bindingId = yield* nextUuid.pipe(Effect.flatMap(Schema.decodeUnknownEffect(AccessWorkloadBindingIdSchema)));
    const incarnation = yield* nextUuid.pipe(Effect.flatMap(Schema.decodeUnknownEffect(AccessWorkloadBindingIdSchema)));
    const trusted = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(principalOf(world, actor));
    yield* writeWorkloadBindings(
      database,
      { ...trusted, correlationId: 'media-acceptance-bind' },
      {
        bindings: [
          {
            bindingId,
            createdAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
            incarnation,
            principalId: PrincipalIdSchema.make(actor.principalId),
            tenantId: TenantIdSchema.make(world.tenantId),
            workloadKey: INGEST_WORKLOAD,
          },
        ],
      },
    );
  });
  return {
    admin,
    bindIngestWorkload,
    countOf,
    currentOf,
    database,
    linksOf,
    metadataOf,
    readRuntimeFor,
    requiredRowOf,
    rowOf,
    runtimeFor,
    storage,
  };
});

type Harness = Effect.Success<ReturnType<typeof openHarness>>;

/** The reserved row as the byte hop reads it. */
const hopAssetOf = Effect.fn('CoreMediaAcceptance.hopAsset')(function* hopAssetOf(
  harness: Harness,
  tenantId: string,
  mediaAssetId: string,
) {
  const asset = yield* harness.rowOf(tenantId, mediaAssetId);
  if (asset === undefined) {
    return yield* Effect.die('The reserved asset row is missing');
  }
  return {
    byteSize: asset.byte_size,
    contentSha256: asset.content_sha256,
    ingestedByPrincipalId: asset.ingested_by_principal_id,
    mimeType: asset.mime_type,
    processingStatus: asset.processing_status,
    sealedAt: asset.sealed_at,
    storageKey: asset.storage_key,
    storageProvider: asset.storage_provider,
  } satisfies MediaByteHopAsset;
});

/** Reserve only: the asset exists as `uploaded` and holds no byte. */
const reserveAsset = Effect.fn('CoreMediaAcceptance.reserve')(function* reserveAsset(
  harness: Harness,
  world: World,
  actor: Actor,
  bytes: Uint8Array,
  options: { readonly key: string; readonly overrides?: ReservationOverrides },
) {
  return yield* harness
    .runtimeFor(actor)
    .runAction({
      payload: reservationPayload(bytes, options.overrides),
      principal: principalOf(world, actor),
      registration: uploadAssetAction,
      transport: transportOf(`${options.key}-reserve`),
    })
    .pipe(Effect.provideService(ObjectStorage, harness.storage.service));
});

/** Reserve, stream, verify, confirm: one whole upload through the real Actions and the byte hop. */
const uploadFlow = Effect.fn('CoreMediaAcceptance.flow')(function* uploadFlow(
  harness: Harness,
  world: World,
  actor: Actor,
  bytes: Uint8Array,
  options: { readonly key: string; readonly overrides?: ReservationOverrides },
) {
  const runtime = harness.runtimeFor(actor);
  const principal = principalOf(world, actor);
  const reservation = yield* reserveAsset(harness, world, actor, bytes, options);
  const hopAsset = yield* hopAssetOf(harness, world.tenantId, reservation.mediaAssetRef.resourceId);
  yield* streamMediaObject({
    asset: hopAsset,
    body: Stream.fromIterable([bytes.slice(0, 7), bytes.slice(7)]),
    principalId: actor.principalId,
  }).pipe(Effect.provideService(ObjectStorage, harness.storage.service));
  const verification = yield* verifyStoredMediaObject({
    expected: { byteSize: Number(hopAsset.byteSize), contentSha256: hopAsset.contentSha256 ?? undefined },
    storageKey: deriveMediaStorageKey({ mediaAssetId: reservation.mediaAssetRef.resourceId, tenantId: world.tenantId }),
    storageProvider: hopAsset.storageProvider,
  }).pipe(Effect.provideService(ObjectStorage, harness.storage.service));
  const confirmed = yield* runtime
    .runAction({
      payload: { mediaAssetRef: reservation.mediaAssetRef },
      principal,
      registration: confirmAssetAction,
      transport: transportOf(`${options.key}-confirm`),
    })
    .pipe(Effect.provideService(StoredMediaObjectVerification, verification));
  return { confirmed, mediaAssetId: reservation.mediaAssetRef.resourceId, reservation, verification };
});

/**
 * One row exactly as the upload Actions leave it, in any status (`scanning` included, which no Action produces).
 * It has no Action Invocation, so it cannot carry a media link; use an upload for that.
 */
const seedAsset = Effect.fn('CoreMediaAcceptance.seed')(function* seedAsset(
  world: World,
  options: {
    readonly sealedAfterReady?: boolean;
    readonly status: 'failed' | 'ready' | 'scanning' | 'uploaded';
    readonly versionRef?: string;
  },
) {
  const mediaAssetId = yield* nextUuid;
  const sealed = options.status === 'ready' || options.sealedAfterReady === true;
  yield* world.admin.unsafe(
    `insert into core.media_assets (media_asset_id, tenant_id, legal_entity_id, ingestion_source, storage_provider, storage_key, storage_object_version_ref,
       original_filename, display_filename, mime_type, byte_size, content_sha256, sealed_at, processing_status)
     values ($1, $2, null, 'integration', 'in-memory-test-double', $3, $4, null, 'Seeded.pdf', 'application/pdf', 4096, $5, $6, $7)`,
    [
      mediaAssetId,
      world.tenantId,
      deriveMediaStorageKey({ mediaAssetId, tenantId: world.tenantId }),
      options.versionRef ?? null,
      'b'.repeat(64),
      sealed ? DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-19T10:00:00Z')) : null,
      options.status,
    ],
  );
  return mediaAssetId;
});

/** A business reference written by another owner's flow: the invocation that reserved the asset anchors it. */
const insertLink = (world: World, mediaAssetId: string, targetResourceId: string) =>
  world.admin.unsafe(
    `insert into core.media_links (tenant_id, media_asset_id, action_invocation_id, link_source, target_module_key, target_resource_type, target_resource_id, link_kind)
     values ($1, $2, $2, 'user', 'catalog', 'catalog.product', $3, 'attachment')`,
    [world.tenantId, mediaAssetId, targetResourceId],
  );

/*
 * Lane 16 acceptance proofs on real PostgreSQL through the real Action and Read runtimes (the in-memory provider
 * double stands in for storage and is never storage proof). Each test names the matrix rows it lifts. What they
 * prove is Core's own behavior: the recorded type is a claim and never a check, a system file needs no original
 * name, and neither an upload, a rename, nor the removal of a business reference touches another asset, another
 * reference or the bytes.
 */

/** A value as the text a consumer could see, so a test can search it for something that must not be there. */
const textOf = (value: AssetMetadataResponse | typeof AssetCurrentResponseSchema.Type): string => JSON.stringify(value);

const failureTagOf = <Failure>(exit: Exit.Exit<unknown, Failure>): string | undefined => {
  if (!Exit.isFailure(exit)) {
    return undefined;
  }
  const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return Predicate.hasProperty(failure, '_tag') && Predicate.isString(failure._tag) ? failure._tag : undefined;
};

/** The columns a presentation rename may change; everything else of the row must stay. */
const withoutNameAndStamp = ({ display_filename: _name, updated_at: _stamp, ...rest }: AssetRow) => rest;

it.layer(NodeCrypto.layer, { excludeTestServices: true })('core media acceptance: ingest and references', (suite) => {
  // L1433-F4, L1433-BDD-07, L1430-D6, L1430-F6, L1430-H6, L1430-BDD-10
  suite.effect(
    'takes any recorded type to ready: the type is a claim, never checked against the bytes and never shown as verified',
    () =>
      Effect.gen(function* anyType() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const claims = [
          // Bytes that are plainly not a PDF under a PDF claim: the claim is recorded, the bytes are what they are.
          { bytes: bytesOf('plainly not a pdf'), mimeType: 'application/pdf' },
          { bytes: bytesOf('not a png either'), mimeType: 'image/png' },
          { bytes: bytesOf('some text under a text type'), mimeType: 'text/plain; charset=utf-8' },
          { bytes: bytesOf('a vendor type nobody listed'), mimeType: 'application/x-d20-unlisted+type' },
        ] as const;
        for (const [index, claim] of claims.entries()) {
          const { confirmed, mediaAssetId } = yield* uploadFlow(harness, world, world.human, claim.bytes, {
            key: `type-${index}`,
            overrides: { mimeType: claim.mimeType },
          });
          expect(confirmed.processingStatus).toBe('ready');
          const metadata = yield* harness.metadataOf(world, mediaAssetId);
          // The recorded type is exactly the claim; only the sealed size and digest of the stored bytes are verified.
          expect(metadata.mimeType).toBe(claim.mimeType);
          expect(metadata.contentVerified).toBe(true);
          expect(metadata.contentSha256).toBe(digestOf(claim.bytes));
          expect(metadata.byteSize).toBe(claim.bytes.byteLength);
          // There is no field that could present the type as checked.
          expect(Object.keys(metadata).toSorted()).toEqual([
            'byteSize',
            'contentSha256',
            'contentVerified',
            'displayFilename',
            'ingestionSource',
            'mediaAssetRef',
            'mimeType',
            'processingStatus',
          ]);
        }
      }).pipe(Effect.scoped),
  );

  // L1430-BDD-07
  suite.effect(
    'keeps a system file without an original name nameless: no name is invented and the origin stays as stated',
    () =>
      Effect.gen(function* nameless() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        yield* harness.bindIngestWorkload(world, world.system);
        const bytes = bytesOf('exported by a scheduled job, no name from the source');
        const { confirmed, mediaAssetId } = yield* uploadFlow(harness, world, world.system, bytes, {
          key: 'system-nameless',
          overrides: { displayFilename: 'export-2026-11-24.csv', ingestionSource: 'system', mimeType: 'text/csv' },
        });
        expect(confirmed.processingStatus).toBe('ready');
        const row = yield* harness.rowOf(world.tenantId, mediaAssetId);
        expect(row).toMatchObject({
          display_filename: 'export-2026-11-24.csv',
          ingestion_source: 'system',
          original_filename: null,
          processing_status: 'ready',
        });
        const metadata = yield* harness.metadataOf(world, mediaAssetId);
        expect(metadata).not.toHaveProperty('originalFilename');
        expect(metadata).toMatchObject({ displayFilename: 'export-2026-11-24.csv', ingestionSource: 'system' });
      }).pipe(Effect.scoped),
  );

  // L1429-D7, L1429-F8, L1429-BDD-10
  suite.effect(
    'leaves an existing business reference, its asset and every other asset alone when a new file arrives',
    () =>
      Effect.gen(function* newUploadBesideReference() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const first = yield* uploadFlow(harness, world, world.human, bytesOf('the first brochure'), { key: 'ref-a' });
        yield* insertLink(world, first.mediaAssetId, 'product-1');
        const rowBefore = yield* harness.rowOf(world.tenantId, first.mediaAssetId);
        const linksBefore = yield* harness.linksOf(world.tenantId);
        expect(linksBefore).toHaveLength(1);

        // New bytes under the very same display name: a new asset, never a replacement of the referenced one.
        const second = yield* uploadFlow(harness, world, world.human, bytesOf('the second brochure'), { key: 'ref-b' });
        expect(second.mediaAssetId).not.toBe(first.mediaAssetId);
        expect(yield* harness.rowOf(world.tenantId, first.mediaAssetId)).toEqual(rowBefore);
        // The reference is the same row, still pointing at the first asset; the new asset has none.
        expect(yield* harness.linksOf(world.tenantId)).toEqual(linksBefore);
        expect((yield* harness.linksOf(world.tenantId)).map((link) => link.media_asset_id)).toEqual([
          first.mediaAssetId,
        ]);
      }).pipe(Effect.scoped),
  );

  // L1430-D10, L1430-F11, L1430-H10, L1430-BDD-06
  suite.effect('renames an asset that has business references and changes only its display name', () =>
    Effect.gen(function* renameWithLinks() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const first = yield* uploadFlow(harness, world, world.human, bytesOf('referenced twice'), { key: 'rn-a' });
      const other = yield* uploadFlow(harness, world, world.human, bytesOf('not referenced'), { key: 'rn-b' });
      yield* insertLink(world, first.mediaAssetId, 'product-1');
      yield* insertLink(world, first.mediaAssetId, 'product-2');
      const linksBefore = yield* harness.linksOf(world.tenantId);
      const rowBefore = yield* harness.requiredRowOf(world.tenantId, first.mediaAssetId);
      const otherBefore = yield* harness.rowOf(world.tenantId, other.mediaAssetId);

      const renamed = yield* harness.runtimeFor(world.human).runAction({
        payload: { displayFilename: 'Renamed brochure.pdf', mediaAssetRef: refOf(world, first.mediaAssetId) },
        principal: principalOf(world, world.human),
        registration: renameDisplayFilenameAction,
        transport: transportOf('rename-with-links'),
      });
      expect(renamed.displayFilename).toBe('Renamed brochure.pdf');

      const rowAfter = yield* harness.requiredRowOf(world.tenantId, first.mediaAssetId);
      expect(rowAfter.display_filename).toBe('Renamed brochure.pdf');
      expect(withoutNameAndStamp(rowAfter)).toEqual(withoutNameAndStamp(rowBefore));
      // Both references are the very same rows: a rename moves, adds and removes none.
      expect(yield* harness.linksOf(world.tenantId)).toEqual(linksBefore);
      expect(yield* harness.rowOf(world.tenantId, other.mediaAssetId)).toEqual(otherBefore);
      expect(yield* harness.countOf('core.media_links', world.tenantId)).toBe(2);
    }).pipe(Effect.scoped),
  );

  // L1429-D8, L1429-F9, L1429-H9, L1434-BDD-18, L1442-BDD-26 (Core side: the asset, its bytes and the other reference)
  suite.effect('keeps the asset, its bytes and the other reference when one business reference is removed', () =>
    Effect.gen(function* detach() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const bytes = bytesOf('shared by two products');
      const shared = yield* uploadFlow(harness, world, world.human, bytes, { key: 'detach' });
      yield* insertLink(world, shared.mediaAssetId, 'product-1');
      yield* insertLink(world, shared.mediaAssetId, 'product-2');
      const key = deriveMediaStorageKey({ mediaAssetId: shared.mediaAssetId, tenantId: world.tenantId });
      const rowBefore = yield* harness.rowOf(world.tenantId, shared.mediaAssetId);
      const callsBefore = (yield* harness.storage.calls).length;

      // While it is referenced the database itself refuses to remove the asset.
      const refused = yield* Effect.exit(
        harness.admin.unsafe(`delete from core.media_assets where tenant_id = $1 and media_asset_id = $2`, [
          world.tenantId,
          shared.mediaAssetId,
        ]),
      );
      expect(Exit.isFailure(refused)).toBe(true);

      // The owner of the reference removes one of them, softly and then for good.
      yield* harness.admin.unsafe(
        `update core.media_links set deleted_at = now() where tenant_id = $1 and target_resource_id = 'product-1'`,
        [world.tenantId],
      );
      expect(yield* harness.rowOf(world.tenantId, shared.mediaAssetId)).toEqual(rowBefore);
      const afterSoft = yield* harness.linksOf(world.tenantId);
      expect(afterSoft.map((link) => [link.target_resource_id, link.deleted_at === null])).toEqual([
        ['product-1', false],
        ['product-2', true],
      ]);
      yield* harness.admin.unsafe(
        `delete from core.media_links where tenant_id = $1 and target_resource_id = 'product-1'`,
        [world.tenantId],
      );
      expect((yield* harness.linksOf(world.tenantId)).map((link) => link.target_resource_id)).toEqual(['product-2']);

      // The asset is still ready and verified, the bytes are still stored, and nothing asked the provider to delete.
      expect(yield* harness.rowOf(world.tenantId, shared.mediaAssetId)).toEqual(rowBefore);
      const metadata = yield* harness.metadataOf(world, shared.mediaAssetId);
      expect(metadata).toMatchObject({
        contentSha256: digestOf(bytes),
        contentVerified: true,
        processingStatus: 'ready',
      });
      expect(Option.getOrUndefined(yield* harness.storage.peek(key))).toEqual(bytes);
      const callsAfter = yield* harness.storage.calls;
      expect(callsAfter.length).toBe(callsBefore);
      expect(callsAfter.every(({ operation }) => ['get', 'put', 'stat'].includes(operation))).toBe(true);
    }).pipe(Effect.scoped),
  );

  // L1433-F6, L1433-BDD-10, L1433-BDD-11: a row that is not `uploaded` is never sealed by a confirm, whatever it reads back
  suite.effect(
    'never seals a scanning or failed asset: a confirm with matching bytes changes nothing and is refused',
    () =>
      Effect.gen(function* unsealable() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const run = Effect.fn('CoreMediaAcceptanceTest.confirm')(function* run(status: 'failed' | 'scanning') {
          const mediaAssetId = yield* seedAsset(world, { status });
          const before = yield* harness.rowOf(world.tenantId, mediaAssetId);
          // Evidence that fully agrees with the row: size, digest and object are exactly what the row claims.
          const evidence = yield* Schema.decodeUnknownEffect(MediaStoredObjectVerificationSchema)({
            byteSize: 4096,
            contentSha256: 'b'.repeat(64),
            outcome: 'verified',
            providerId: 'in-memory-test-double',
            storageKey: deriveMediaStorageKey({ mediaAssetId, tenantId: world.tenantId }),
          });
          const exit = yield* Effect.exit(
            harness
              .runtimeFor(world.human)
              .runAction({
                payload: { mediaAssetRef: refOf(world, mediaAssetId) },
                principal: principalOf(world, world.human),
                registration: confirmAssetAction,
                transport: transportOf(`confirm-${status}`),
              })
              .pipe(Effect.provideService(StoredMediaObjectVerification, evidence)),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          const after = yield* harness.rowOf(world.tenantId, mediaAssetId);
          expect(after).toEqual(before);
          expect(after?.processing_status).toBe(status);
          expect(after?.sealed_at).toBeNull();
          return failureTagOf(exit);
        });
        // A check still running is not a failure and not success: the answer is a retryable unavailability.
        expect(yield* run('scanning')).toBe('MediaUnavailable');
        // A closed asset stays an integrity failure and is never reopened.
        expect(yield* run('failed')).toBe('MediaIntegrityFailed');
      }).pipe(Effect.scoped),
  );

  // L1433-D13, L1443-D20 (the code side): Core imposes no product size ceiling on a reservation
  suite.effect('reserves a very large declared size without a product cap and holds no byte for it', () =>
    Effect.gen(function* noCap() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const fiveTebibytes = 5 * 1024 ** 4;
      const reserved = yield* reserveAsset(harness, world, world.human, bytesOf('declared huge, never sent'), {
        key: 'huge',
        overrides: { declaredByteSize: fiveTebibytes },
      });
      const row = yield* harness.rowOf(world.tenantId, reserved.mediaAssetRef.resourceId);
      expect(row).toMatchObject({ byte_size: BigInt(fiveTebibytes), processing_status: 'uploaded' });
      // The reservation reaches no provider: nothing was stored for it.
      expect(yield* harness.storage.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

/*
 * Lane 16 acceptance proofs for the Current V1 owner read on real PostgreSQL through the real Read runtime. The
 * provider is the in-memory double (never storage proof) and, where a test needs a provider fault, a labelled
 * fault around it. What they prove is Core's own judgement: which rows may ever be AVAILABLE, that one ref's
 * outage is its own answer and never another's, and that the provider's technical pin is never a revision.
 */

it.layer(NodeCrypto.layer, { excludeTestServices: true })('core media acceptance: Current V1', (suite) => {
  // L1446-BDD-09, L1446-BDD-31, L1433-BDD-10, L1433-BDD-11
  suite.effect(
    'answers a failed, scanning or uploaded asset as not confirmed and never reaches the provider for it',
    () =>
      Effect.gen(function* unconfirmed() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const uploaded = yield* seedAsset(world, { status: 'uploaded' });
        const scanning = yield* seedAsset(world, { status: 'scanning' });
        const failed = yield* seedAsset(world, { status: 'failed' });
        // Sealed once and proven corrupt afterwards: the old seal must not make it usable.
        const corrupt = yield* seedAsset(world, { sealedAfterReady: true, status: 'failed' });

        const answer = yield* harness.currentOf(world, [uploaded, scanning, failed, corrupt]);
        expect(answer.entries.map(({ kind }) => kind)).toEqual([
          'CURRENT_UNVERIFIED',
          'CURRENT_UNVERIFIED',
          'CURRENT_UNVERIFIED',
          'CURRENT_UNVERIFIED',
        ]);
        expect(answer.entries.map(({ resourceRef }) => resourceRef.resourceId)).toEqual([
          uploaded,
          scanning,
          failed,
          corrupt,
        ]);
        // The verdict comes from the row: no object was statted, read or written for any of them.
        expect(yield* harness.storage.calls).toEqual([]);

        // The metadata of the failed asset says so, instead of presenting its claim as verified content.
        expect(yield* harness.metadataOf(world, failed)).toMatchObject({
          contentVerified: false,
          processingStatus: 'failed',
        });
        expect(yield* harness.metadataOf(world, corrupt)).toMatchObject({
          contentVerified: false,
          processingStatus: 'failed',
        });
      }).pipe(Effect.scoped),
  );

  // L1443-BDD-29: the Core side of "missing owner proof for one of two assets"
  suite.effect(
    "keeps one ref's provider outage its own answer: not available, not absent, and no other ref is changed",
    () =>
      Effect.gen(function* oneOutage() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const outage = yield* uploadFlow(harness, world, world.human, bytesOf('first of two'), { key: 'cur-a' });
        const healthy = yield* uploadFlow(harness, world, world.human, bytesOf('second of two'), { key: 'cur-b' });
        const unknown = yield* nextUuid;
        // Exactly one stat fails: the first ref asked, in request order. The other refs are answered on their own.
        const faulty = yield* withObjectStorageFaults([
          {
            failure: new ObjectStorageNetworkError({ code: 'object_storage_network_error', reason: 'injected outage' }),
            operation: 'stat',
            times: 1,
          },
        ]).pipe(Effect.provideService(ObjectStorage, harness.storage.service));

        const answer = yield* harness.currentOf(world, [outage.mediaAssetId, healthy.mediaAssetId, unknown], faulty);
        expect(answer.entries.map(({ kind, resourceRef }) => [kind, resourceRef.resourceId])).toEqual([
          ['UNAVAILABLE', outage.mediaAssetId],
          ['AVAILABLE', healthy.mediaAssetId],
          ['ABSENT', unknown],
        ]);
        // Nothing durable changed because of the outage: both rows are still ready.
        for (const { mediaAssetId } of [outage, healthy]) {
          expect((yield* harness.rowOf(world.tenantId, mediaAssetId))?.processing_status).toBe('ready');
        }
        // The same ask, once the provider answers again, confirms the asset it could not before.
        const retried = yield* harness.currentOf(world, [outage.mediaAssetId, healthy.mediaAssetId]);
        expect(retried.entries.map(({ kind }) => kind)).toEqual(['AVAILABLE', 'AVAILABLE']);
      }).pipe(Effect.scoped),
  );

  // L1447-BDD-08: a provider version pin is integrity evidence of one stored object, never a revision
  suite.effect('answers revision 1 whatever the provider version pin, and never shows or counts the pin', () =>
    Effect.gen(function* pinIsNotRevision() {
      const harness = yield* openHarness({ versionRefs: true });
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const bytes = bytesOf('pinned by the provider');
      const { mediaAssetId } = yield* uploadFlow(harness, world, world.human, bytes, { key: 'pin' });
      expect((yield* harness.rowOf(world.tenantId, mediaAssetId))?.storage_object_version_ref).toBe('v1');

      const available = yield* harness.currentOf(world, [mediaAssetId]);
      expect(available.entries).toEqual([
        {
          current: { resourceRef: available.entries[0]?.resourceRef, revision: 1 },
          kind: 'AVAILABLE',
          resourceRef: available.entries[0]?.resourceRef,
        },
      ]);
      expect(textOf(available)).not.toContain('v1');
      expect(textOf(yield* harness.metadataOf(world, mediaAssetId))).not.toContain('v1');

      // The provider now holds another stored object under the key (its pin moved to v2): the asset is no longer
      // confirmed, and the pin did not become a second revision.
      yield* harness.storage.service.put({
        body: Stream.make(bytes),
        contentType: 'application/pdf',
        key: deriveMediaStorageKey({ mediaAssetId, tenantId: world.tenantId }),
      });
      const replaced = yield* harness.currentOf(world, [mediaAssetId]);
      expect(replaced.entries.map(({ kind }) => kind)).toEqual(['CURRENT_UNVERIFIED']);
      expect(textOf(replaced)).not.toContain('revision');
      expect(textOf(replaced)).not.toContain('v2');
      // Current repaired nothing and re-pinned nothing: the row keeps what was sealed.
      expect((yield* harness.rowOf(world.tenantId, mediaAssetId))?.storage_object_version_ref).toBe('v1');
    }).pipe(Effect.scoped),
  );
});
