import { sha256 } from '@noble/hashes/sha2.js';
import { NodeCrypto } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Cause, Crypto, DateTime, Effect, Exit, Logger, Option, Predicate, Schema, Stream } from 'effect';
import { Hex } from 'effect/encoding';
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
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import type { CoreDatabaseExecutor } from '../../src/db/types.ts';
import { loadDatabaseConfig, loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { SHARED_RUNTIME_IDENTITY } from '../../src/db/database-identities.ts';
import { streamMediaObject } from '../../src/media/byte-stream.ts';
import type { MediaByteHopAsset } from '../../src/media/byte-stream.ts';
import { MediaAssetIdSchema, MediaTenantIdSchema } from '../../src/media/identity.ts';
import { checkTemporaryObjectCleanup } from '../../src/media/cleanup-eligibility.ts';
import { reconcileUncertainUpload, mayStartIndependentUpload } from '../../src/media/reconciliation.ts';
import { ProvenMediaIntegrityFinding } from '../../src/media/integrity-contract.ts';
import {
  ObjectStorage,
  ObjectStorageNetworkError,
  ObjectStorageServerError,
  ObjectStorageTimeout,
} from '../../src/media/object-storage.ts';
import type { ObjectStorageService } from '../../src/media/object-storage.ts';
import type { ConfirmAssetPayloadSchema, UploadAssetPayloadSchema } from '../../src/media/upload-contract.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import { StoredMediaObjectVerification, verifyStoredMediaObject } from '../../src/media/verification.ts';
import { MediaIntegrityFindingSchema, verifyReadyMediaAsset } from '../../src/media/verified-read.ts';
import type { MediaIntegrityFinding } from '../../src/media/verified-read.ts';
import type { MediaStoredObjectVerification } from '../../src/media/verification.ts';
import { confirmAssetAction } from '../../src/modules/actions/confirm-asset.action.ts';
import { recordAssetIntegrityFailureAction } from '../../src/modules/actions/record-asset-integrity-failure.action.ts';
import { uploadAssetAction } from '../../src/modules/actions/upload-asset.action.ts';
import { bindAccessGate } from '../../src/operations/access-gate.ts';
import type { AccessEnforcementPorts } from '../../src/operations/access-gate.ts';
import { makeScriptedBoundAccessGate } from '../../src/testing/access-gate.ts';
import { makeInMemoryObjectStorage, withObjectStorageFaults } from '../../src/testing/media-object-storage.ts';
import { writeTestTenantScopes } from '../../src/testing/tenant-access.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { makeTestOperationOwner, openActionRuntimeOptions } from '../support/action-runtime-options.ts';
import { SqlError, UnknownError } from 'effect/sql/SqlError';
import { makeTestPgClient } from '../support/database.ts';
import { injectStatementFaults } from '../support/database-faults.ts';

/*
 * The world of the Core Media recovery suites on real PostgreSQL: the real Action runtime, the in-memory
 * ObjectStorage double standing in for the provider (never storage proof), a human carrier passing a scripted
 * allow, and a machine carrier passing the real access seam over the real principal-kind and workload-binding
 * tables, so a binding row is the only thing that admits a machine.
 */

const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const encoder = new TextEncoder();
const digestOf = (bytes: Uint8Array) => Hex.encode(sha256(bytes));
const content = encoder.encode('the bytes of one independent upload');
const WORKLOAD = WorkloadKeySchema.make('core.media.ingest');
const allowedPermission = { checkActionPermission: () => Effect.succeed('allowed' as const) };

const AccessOverrideSchema = Schema.Literals(['denied', 'unavailable']);
type AccessOverride = typeof AccessOverrideSchema.Type | undefined;

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

const insertActor = Effect.fn('CoreMediaRecoveryHarness.insertActor')(function* insertActor(
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
      `media-recovery-${actor.authBindingId}`,
    ],
  );
});

const cleanTenant = (admin: PgClient.PgClient, tenantId: string) =>
  Effect.forEach(
    [
      'core.evidence_references',
      'core.media_links',
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

const makeWorld = Effect.fn('CoreMediaRecoveryHarness.world')(function* makeWorld(
  admin: PgClient.PgClient,
  executor: CoreDatabaseExecutor,
) {
  const tenantId = yield* nextUuid;
  const legalEntityId = yield* nextUuid;
  const actorOf = Effect.fn('CoreMediaRecoveryHarness.actor')(function* actorOf(kind: PrincipalKind) {
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
    [tenantId, `media-recovery-${tenantId}`],
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
    authContextRef: `core-media-recovery-${actor.principalId}`,
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
  readonly storage_object_version_ref: string | null;
  readonly storage_provider: string;
  readonly tenant_id: string;
  readonly updated_at: Date;
}

const unavailableAuthority: DecisionAuthorityPort = {
  readCells: () => Effect.fail(accessDecisionUnavailable('no intent in this suite')),
  readConfigureBases: () => Effect.fail(accessDecisionUnavailable('no intent in this suite')),
  readConnection: () => Effect.fail(accessDecisionUnavailable('no intent in this suite')),
  readScope: () => Effect.fail(accessDecisionUnavailable('no intent in this suite')),
  readTeamIds: () => Effect.fail(accessDecisionUnavailable('no intent in this suite')),
};

const transportOf = (idempotencyKey: string) => ({
  correlationId: `media-recovery-${idempotencyKey}`,
  idempotencyKey,
});

const failureTagOf = <Failure>(exit: Exit.Exit<unknown, Failure>): string | undefined => {
  if (!Exit.isFailure(exit)) {
    return undefined;
  }
  const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return Predicate.hasProperty(failure, '_tag') && Predicate.isString(failure._tag) ? failure._tag : undefined;
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

/** Everything a test needs: the database, a runtime per carrier, the provider double and the row readers. */
const openHarness = Effect.fn('CoreMediaRecoveryHarness.harness')(function* openHarness() {
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
  const gateFor = (carrier: 'human' | 'machine', accessOverride: AccessOverride) => {
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
  const bind = Effect.fn('CoreMediaRecoveryHarness.bind')(function* bind(
    world: World,
    actor: Actor,
    workloadKey: string = WORKLOAD,
  ) {
    const bindingId = yield* nextUuid.pipe(Effect.flatMap(Schema.decodeUnknownEffect(AccessWorkloadBindingIdSchema)));
    const incarnation = yield* nextUuid.pipe(Effect.flatMap(Schema.decodeUnknownEffect(AccessWorkloadBindingIdSchema)));
    const trusted = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(principalOf(world, actor));
    yield* writeWorkloadBindings(
      database,
      { ...trusted, correlationId: 'media-recovery-bind' },
      {
        bindings: [
          {
            bindingId,
            createdAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
            incarnation,
            principalId: PrincipalIdSchema.make(actor.principalId),
            tenantId: TenantIdSchema.make(world.tenantId),
            workloadKey: WorkloadKeySchema.make(workloadKey),
          },
        ],
      },
    );
  });
  return { admin, bind, countOf, database, rowCount, rowOf, runtimeFor, storage };
});

type Harness = Effect.Success<ReturnType<typeof openHarness>>;

const carrierOf = (actor: Actor) => (actor.kind === 'human' ? 'human' : 'machine');

/** The reserved row as the byte hop reads it. */
const hopAssetOf = Effect.fn('CoreMediaRecoveryHarness.hopAsset')(function* hopAssetOf(
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

/** The reservation leg of an upload, run through the real Action runtime under the actor's own carrier. */
const reserveAsset = Effect.fn('CoreMediaRecoveryHarness.reserve')(function* reserveAsset(
  harness: Harness,
  world: World,
  actor: Actor,
  bytes: Uint8Array,
  options: { readonly key: string; readonly overrides?: ReservationOverrides },
) {
  return yield* harness
    .runtimeFor(carrierOf(actor))
    .runAction({
      payload: reservationPayload(bytes, options.overrides),
      principal: principalOf(world, actor),
      registration: uploadAssetAction,
      transport: transportOf(`${options.key}-reserve`),
    })
    .pipe(Effect.provideService(ObjectStorage, harness.storage.service));
});

/** The byte hop of an upload: the bytes of the reserved row streamed into the provider in two chunks. */
const streamReservedBytes = Effect.fn('CoreMediaRecoveryHarness.stream')(function* streamReservedBytes(
  harness: Harness,
  world: World,
  actor: Actor,
  mediaAssetId: string,
  bytes: Uint8Array,
  storage: ObjectStorageService = harness.storage.service,
) {
  const asset = yield* hopAssetOf(harness, world.tenantId, mediaAssetId);
  return yield* streamMediaObject({
    asset,
    body: Stream.fromIterable([bytes.slice(0, 7), bytes.slice(7)]),
    principalId: actor.principalId,
  }).pipe(Effect.provideService(ObjectStorage, storage));
});

/** The confirm Action under the actor's carrier with the given verification evidence. */
const confirmReservedAsset = (
  harness: Harness,
  world: World,
  actor: Actor,
  options: {
    readonly accessOverride?: AccessOverride;
    readonly key: string;
    readonly mediaAssetRef: typeof ConfirmAssetPayloadSchema.Type.mediaAssetRef;
    readonly verification: MediaStoredObjectVerification;
  },
) =>
  harness
    .runtimeFor(carrierOf(actor), options.accessOverride)
    .runAction({
      payload: { mediaAssetRef: options.mediaAssetRef },
      principal: principalOf(world, actor),
      registration: confirmAssetAction,
      transport: transportOf(options.key),
    })
    .pipe(Effect.provideService(StoredMediaObjectVerification, options.verification));

/** Reserve, stream, verify and confirm: one whole upload, ending with a `ready` asset. */
const uploadReadyAsset = Effect.fn('CoreMediaRecoveryHarness.uploadReady')(function* uploadReadyAsset(
  harness: Harness,
  world: World,
  actor: Actor,
  bytes: Uint8Array,
  options: { readonly key: string; readonly overrides?: ReservationOverrides },
) {
  const reservation = yield* reserveAsset(harness, world, actor, bytes, options);
  const mediaAssetId = reservation.mediaAssetRef.resourceId;
  yield* streamReservedBytes(harness, world, actor, mediaAssetId, bytes);
  const asset = yield* hopAssetOf(harness, world.tenantId, mediaAssetId);
  const verification = yield* verifyStoredMediaObject({
    expected: { byteSize: Number(asset.byteSize), contentSha256: asset.contentSha256 ?? undefined },
    storageKey: deriveMediaStorageKey({ mediaAssetId, tenantId: world.tenantId }),
    storageProvider: asset.storageProvider,
  }).pipe(Effect.provideService(ObjectStorage, harness.storage.service));
  const confirmed = yield* confirmReservedAsset(harness, world, actor, {
    key: `${options.key}-confirm`,
    mediaAssetRef: reservation.mediaAssetRef,
    verification,
  });
  return { confirmed, mediaAssetId, reservation, verification };
});

/** The row of an asset as the verified read and the reconciliation read it. */
const verifiableRowOf = Effect.fn('CoreMediaRecoveryHarness.verifiableRow')(function* verifiableRowOf(
  harness: Harness,
  tenantId: string,
  mediaAssetId: string,
) {
  const row = yield* harness.rowOf(tenantId, mediaAssetId);
  if (row === undefined) {
    return yield* Effect.die('The asset row is missing');
  }
  return {
    byteSize: row.byte_size,
    contentSha256: row.content_sha256,
    processingStatus: row.processing_status,
    sealedAt: row.sealed_at,
    storageKey: row.storage_key,
    storageObjectVersionRef: row.storage_object_version_ref,
    storageProvider: row.storage_provider,
  };
});

/*
 * The integrity Action and the verified read on real PostgreSQL (#1434 H1=A): an outage never changes a ready
 * asset, proven corruption closes it as failed with the recorded identity and the evidence preserved, a failed
 * asset never returns to ready, and only a bound machine (or a granted person) records it, from a proof only
 * the verified read produces. The provider is the in-memory double and every outage is labelled fault injection.
 */

const INTEGRITY_WORKLOAD = 'core.media.integrity';
const tampered = encoder.encode('X'.repeat(content.byteLength));

const timeout = new ObjectStorageTimeout({ code: 'object_storage_timeout', reason: 'fault injection' });
const network = new ObjectStorageNetworkError({ code: 'object_storage_network_error', reason: 'fault injection' });

/** A ready asset whose stored object was then replaced by other bytes of the same length (out-of-band). */
const corruptReadyAsset = Effect.fn('CoreMediaIntegrityTest.corrupt')(function* corruptReadyAsset(
  harness: Harness,
  world: World,
  key: string,
) {
  const uploaded = yield* uploadReadyAsset(harness, world, world.human, content, { key });
  yield* harness.storage.service.put({
    body: Stream.make(tampered),
    contentType: 'application/pdf',
    key: deriveMediaStorageKey({ mediaAssetId: uploaded.mediaAssetId, tenantId: world.tenantId }),
  });
  return uploaded;
});

const findingOf = Effect.fn('CoreMediaIntegrityTest.finding')(function* findingOf(
  harness: Harness,
  world: World,
  mediaAssetId: string,
) {
  const outcome = yield* verifyReadyMediaAsset(yield* verifiableRowOf(harness, world.tenantId, mediaAssetId)).pipe(
    Effect.provideService(ObjectStorage, harness.storage.service),
  );
  if (outcome.outcome !== 'integrity_failed') {
    return yield* Effect.die(`expected a finding, got ${outcome.outcome}`);
  }
  return outcome.finding;
});

const recordIntegrity = (
  harness: Harness,
  world: World,
  actor: Actor,
  options: {
    readonly accessOverride?: AccessOverride;
    readonly finding: MediaIntegrityFinding;
    readonly key: string;
    readonly mediaAssetRef: Parameters<typeof confirmReservedAsset>[3]['mediaAssetRef'];
  },
) =>
  harness
    .runtimeFor(actor.kind === 'human' ? 'human' : 'machine', options.accessOverride)
    .runAction({
      payload: { mediaAssetRef: options.mediaAssetRef },
      principal: principalOf(world, actor),
      registration: recordAssetIntegrityFailureAction,
      transport: transportOf(options.key),
    })
    .pipe(Effect.provideService(ProvenMediaIntegrityFinding, options.finding));

it.layer(NodeCrypto.layer, { excludeTestServices: true })('core media integrity on PostgreSQL', (suite) => {
  suite.effect('closes a ready asset as failed only on proven corruption, keeping its recorded identity', () =>
    Effect.gen(function* proven() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      yield* harness.bind(world, world.system, INTEGRITY_WORKLOAD);
      const uploaded = yield* corruptReadyAsset(harness, world, 'proven');
      const before = yield* harness.rowOf(world.tenantId, uploaded.mediaAssetId);
      const finding = yield* findingOf(harness, world, uploaded.mediaAssetId);
      const result = yield* recordIntegrity(harness, world, world.system, {
        finding,
        key: 'proven-record',
        mediaAssetRef: uploaded.reservation.mediaAssetRef,
      });
      expect(result).toEqual({
        mediaAssetRef: uploaded.reservation.mediaAssetRef,
        observed: { byteSize: tampered.byteLength, contentSha256: digestOf(tampered) },
        processingStatus: 'failed',
      });
      const after = yield* harness.rowOf(world.tenantId, uploaded.mediaAssetId);
      expect(after).toMatchObject({
        byte_size: before?.byte_size,
        content_sha256: before?.content_sha256,
        processing_status: 'failed',
        storage_key: before?.storage_key,
        storage_object_version_ref: before?.storage_object_version_ref,
      });
      // The sealed identity stays on the row as evidence; the public projection withholds it (not ready).
      expect(after?.sealed_at).toEqual(before?.sealed_at);
      const evidence = yield* harness.admin.unsafe<{ text: string }>(
        `select evidence_json::text as text from core.audit_events where tenant_id = $1 and evidence_json ? 'finding'`,
        [world.tenantId],
      );
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.text).toContain(digestOf(tampered));
      expect(evidence[0]?.text).toContain(digestOf(content));
      expect(evidence[0]?.text).not.toContain(Buffer.from(tampered).toString('base64'));
      expect(evidence[0]?.text).not.toContain(before?.storage_key ?? 'x');
    }).pipe(Effect.scoped),
  );

  suite.effect('never changes a ready asset for an outage, however often it repeats, and serves it again after', () =>
    Effect.gen(function* outage() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const uploaded = yield* uploadReadyAsset(harness, world, world.human, content, { key: 'outage' });
      const before = yield* harness.rowOf(world.tenantId, uploaded.mediaAssetId);
      const row = yield* verifiableRowOf(harness, world.tenantId, uploaded.mediaAssetId);
      for (const failure of [timeout, network]) {
        const faulty = yield* withObjectStorageFaults([{ failure, operation: 'get' }]).pipe(
          Effect.provideService(ObjectStorage, harness.storage.service),
        );
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const outcome = yield* verifyReadyMediaAsset(row).pipe(Effect.provideService(ObjectStorage, faulty));
          expect(outcome.outcome).toBe('unavailable');
        }
      }
      expect(yield* harness.rowOf(world.tenantId, uploaded.mediaAssetId)).toEqual(before);
      // Controlled fault injection ends: the same bytes verify, the same asset id is usable, nothing was rewritten.
      const recovered = yield* verifyReadyMediaAsset(row).pipe(
        Effect.provideService(ObjectStorage, harness.storage.service),
      );
      expect(recovered).toMatchObject({ contentSha256: digestOf(content), outcome: 'verified' });
      expect(yield* harness.rowOf(world.tenantId, uploaded.mediaAssetId)).toEqual(before);
    }).pipe(Effect.scoped),
  );

  suite.effect('treats a missing provider object as a result of the request, leaving the asset ready and present', () =>
    Effect.gen(function* missing() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const uploaded = yield* uploadReadyAsset(harness, world, world.human, content, { key: 'missing' });
      const before = yield* harness.rowOf(world.tenantId, uploaded.mediaAssetId);
      const row = yield* verifiableRowOf(harness, world.tenantId, uploaded.mediaAssetId);
      const empty = yield* makeInMemoryObjectStorage();
      const outcome = yield* verifyReadyMediaAsset(row).pipe(Effect.provideService(ObjectStorage, empty.service));
      expect(outcome).toEqual({ outcome: 'missing_object' });
      expect(yield* harness.rowOf(world.tenantId, uploaded.mediaAssetId)).toEqual(before);
    }).pipe(Effect.scoped),
  );

  suite.effect('never returns a proven-corrupt asset to ready, however the provider answers afterwards', () =>
    Effect.gen(function* final() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      yield* harness.bind(world, world.system, INTEGRITY_WORKLOAD);
      const uploaded = yield* corruptReadyAsset(harness, world, 'final');
      const finding = yield* findingOf(harness, world, uploaded.mediaAssetId);
      yield* recordIntegrity(harness, world, world.system, {
        finding,
        key: 'final-record',
        mediaAssetRef: uploaded.reservation.mediaAssetRef,
      });
      // The provider now serves exactly the original bytes again.
      yield* harness.storage.service.put({
        body: Stream.make(content),
        contentType: 'application/pdf',
        key: deriveMediaStorageKey({ mediaAssetId: uploaded.mediaAssetId, tenantId: world.tenantId }),
      });
      const row = yield* verifiableRowOf(harness, world.tenantId, uploaded.mediaAssetId);
      const outcome = yield* verifyReadyMediaAsset(row).pipe(
        Effect.provideService(ObjectStorage, harness.storage.service),
      );
      expect(outcome).toEqual({ outcome: 'inconsistent_metadata', reason: 'not_ready' });
      // A confirm with perfect evidence is refused: failed is final, only an owner-governed remediation could change it.
      const confirm = yield* Effect.exit(
        confirmReservedAsset(harness, world, world.human, {
          key: 'final-confirm-again',
          mediaAssetRef: uploaded.reservation.mediaAssetRef,
          verification: uploaded.verification,
        }),
      );
      expect(failureTagOf(confirm)).toBe('MediaIntegrityFailed');
      expect((yield* harness.rowOf(world.tenantId, uploaded.mediaAssetId))?.processing_status).toBe('failed');
    }).pipe(Effect.scoped),
  );

  suite.effect('records one effect for a repeated finding and replays the same key without running again', () =>
    Effect.gen(function* idempotent() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      yield* harness.bind(world, world.system, INTEGRITY_WORKLOAD);
      const uploaded = yield* corruptReadyAsset(harness, world, 'idem');
      const finding = yield* findingOf(harness, world, uploaded.mediaAssetId);
      const run = (key: string) =>
        recordIntegrity(harness, world, world.system, {
          finding,
          key,
          mediaAssetRef: uploaded.reservation.mediaAssetRef,
        });
      const first = yield* run('idem-a');
      const again = yield* run('idem-b');
      expect(again).toEqual(first);
      const stopped = yield* Effect.exit(run('idem-a'));
      expect(failureTagOf(stopped)).toBe('ActionAlreadyCommitted');
      const evidence = yield* harness.admin.unsafe<{ text: string }>(
        `select evidence_json::text as text from core.audit_events where tenant_id = $1 and evidence_json ? 'finding'`,
        [world.tenantId],
      );
      expect(evidence).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  suite.effect('answers no finding of other content for an asset that is already failed', () =>
    Effect.gen(function* failedForeign() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      yield* harness.bind(world, world.system, INTEGRITY_WORKLOAD);
      const target = yield* corruptReadyAsset(harness, world, 'failed-foreign-target');
      const other = yield* corruptReadyAsset(harness, world, 'failed-foreign-other');
      const targetFinding = yield* findingOf(harness, world, target.mediaAssetId);
      const otherFinding = yield* findingOf(harness, world, other.mediaAssetId);
      yield* recordIntegrity(harness, world, world.system, {
        finding: targetFinding,
        key: 'failed-foreign-record',
        mediaAssetRef: target.reservation.mediaAssetRef,
      });
      // The identical finding is an idempotent answer; another asset's finding gets no answer at all.
      yield* recordIntegrity(harness, world, world.system, {
        finding: targetFinding,
        key: 'failed-foreign-again',
        mediaAssetRef: target.reservation.mediaAssetRef,
      });
      const foreign = yield* Effect.exit(
        recordIntegrity(harness, world, world.system, {
          finding: otherFinding,
          key: 'failed-foreign-other-finding',
          mediaAssetRef: target.reservation.mediaAssetRef,
        }),
      );
      expect(failureTagOf(foreign)).toBe('MediaContentConflict');
      expect((yield* harness.rowOf(world.tenantId, other.mediaAssetId))?.processing_status).toBe('ready');
    }).pipe(Effect.scoped),
  );

  suite.effect('refuses a finding that does not describe this asset, a non-ready asset and a stale proof', () =>
    Effect.gen(function* refusals() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      yield* harness.bind(world, world.system, INTEGRITY_WORKLOAD);
      const target = yield* corruptReadyAsset(harness, world, 'refuse-target');
      const other = yield* uploadReadyAsset(harness, world, world.human, encoder.encode('another ready asset!!'), {
        key: 'refuse-other',
      });
      const finding = yield* findingOf(harness, world, target.mediaAssetId);
      // Another asset's identity: the finding names the first one's object, so it can never close this one.
      const foreign = yield* Effect.exit(
        recordIntegrity(harness, world, world.system, {
          finding,
          key: 'refuse-foreign',
          mediaAssetRef: other.reservation.mediaAssetRef,
        }),
      );
      expect(failureTagOf(foreign)).toBe('MediaContentConflict');
      expect((yield* harness.rowOf(world.tenantId, other.mediaAssetId))?.processing_status).toBe('ready');
      // A finding measured against stale recorded content cannot close the asset either.
      const stale = yield* Schema.decodeUnknownEffect(MediaIntegrityFindingSchema)({
        ...finding,
        recorded: { ...finding.recorded, contentSha256: digestOf(encoder.encode('older content')) },
      });
      const staleExit = yield* Effect.exit(
        recordIntegrity(harness, world, world.system, {
          finding: stale,
          key: 'refuse-stale',
          mediaAssetRef: target.reservation.mediaAssetRef,
        }),
      );
      expect(failureTagOf(staleExit)).toBe('MediaContentConflict');
      expect((yield* harness.rowOf(world.tenantId, target.mediaAssetId))?.processing_status).toBe('ready');
      // An uploaded (not ready) asset takes no integrity record: the confirm Action is its own path.
      const reserved = yield* uploadReadyAsset(harness, world, world.human, content, { key: 'refuse-ready' });
      yield* harness.admin.unsafe(
        `update core.media_assets set processing_status = 'uploaded', sealed_at = null where tenant_id = $1 and media_asset_id = $2`,
        [world.tenantId, reserved.mediaAssetId],
      );
      const notReady = yield* Effect.exit(
        recordIntegrity(harness, world, world.system, {
          finding,
          key: 'refuse-not-ready',
          mediaAssetRef: reserved.reservation.mediaAssetRef,
        }),
      );
      expect(failureTagOf(notReady)).toBe('MediaNotReady');
    }).pipe(Effect.scoped),
  );

  suite.effect('admits only a bound integrity workload or a granted person, never an ingest binding or a denial', () =>
    Effect.gen(function* carriers() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      yield* harness.bind(world, world.integration, 'core.media.ingest');
      const uploaded = yield* corruptReadyAsset(harness, world, 'carrier');
      const finding = yield* findingOf(harness, world, uploaded.mediaAssetId);
      const attempt = (actor: Actor, key: string, accessOverride?: 'denied' | 'unavailable') =>
        Effect.exit(
          recordIntegrity(harness, world, actor, {
            accessOverride,
            finding,
            key,
            mediaAssetRef: uploaded.reservation.mediaAssetRef,
          }),
        );
      // The ingest binding of an uploader does not record integrity; an unbound system principal neither.
      expect(Exit.isFailure(yield* attempt(world.integration, 'carrier-ingest'))).toBe(true);
      expect(Exit.isFailure(yield* attempt(world.system, 'carrier-unbound'))).toBe(true);
      expect(Exit.isFailure(yield* attempt(world.human, 'carrier-denied', 'denied'))).toBe(true);
      expect(Exit.isFailure(yield* attempt(world.human, 'carrier-unavailable', 'unavailable'))).toBe(true);
      expect((yield* harness.rowOf(world.tenantId, uploaded.mediaAssetId))?.processing_status).toBe('ready');
      yield* harness.bind(world, world.system, INTEGRITY_WORKLOAD);
      expect(Exit.isSuccess(yield* attempt(world.system, 'carrier-bound'))).toBe(true);
      expect((yield* harness.rowOf(world.tenantId, uploaded.mediaAssetId))?.processing_status).toBe('failed');
    }).pipe(Effect.scoped),
  );

  suite.effect('keeps tenant B from recording corruption of tenant A and never exposes it', () =>
    Effect.gen(function* tenants() {
      const harness = yield* openHarness();
      const worldA = yield* makeWorld(harness.admin, harness.database.executor);
      const worldB = yield* makeWorld(harness.admin, harness.database.executor);
      yield* harness.bind(worldB, worldB.system, INTEGRITY_WORKLOAD);
      const uploaded = yield* corruptReadyAsset(harness, worldA, 'tenant');
      const finding = yield* findingOf(harness, worldA, uploaded.mediaAssetId);
      for (const mediaAssetRef of [
        uploaded.reservation.mediaAssetRef,
        { ...uploaded.reservation.mediaAssetRef, tenantId: worldB.tenantId },
      ]) {
        const exit = yield* Effect.exit(
          recordIntegrity(harness, worldB, worldB.system, {
            finding,
            key: `tenant-${mediaAssetRef.tenantId}`,
            mediaAssetRef,
          }),
        );
        expect(failureTagOf(exit)).toBe('MediaAssetNotFound');
      }
      expect((yield* harness.rowOf(worldA.tenantId, uploaded.mediaAssetId))?.processing_status).toBe('ready');
    }).pipe(Effect.scoped),
  );

  suite.effect(
    'puts no other bytes under a ready asset: a retry with different bytes is a conflict and the object stays',
    () =>
      Effect.gen(function* foreign() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const uploaded = yield* uploadReadyAsset(harness, world, world.human, content, { key: 'foreign' });
        const exit = yield* Effect.exit(
          streamReservedBytes(harness, world, world.human, uploaded.mediaAssetId, tampered),
        );
        expect(failureTagOf(exit)).toBe('MediaContentConflict');
        const outcome = yield* verifyReadyMediaAsset(
          yield* verifiableRowOf(harness, world.tenantId, uploaded.mediaAssetId),
        ).pipe(Effect.provideService(ObjectStorage, harness.storage.service));
        expect(outcome).toMatchObject({ contentSha256: digestOf(content), outcome: 'verified' });
      }).pipe(Effect.scoped),
  );
});

const reconcileAsset = (
  harness: Harness,
  world: World,
  actor: Actor,
  options: {
    readonly accessOverride?: AccessOverride;
    readonly key: string;
    readonly mediaAssetRef: Parameters<typeof confirmReservedAsset>[3]['mediaAssetRef'];
    readonly storage?: ObjectStorageService;
  },
) =>
  Effect.gen(function* reconcileOnce() {
    const asset = yield* verifiableRowOf(harness, world.tenantId, options.mediaAssetRef.resourceId);
    return yield* reconcileUncertainUpload({
      asset,
      confirm: (verification) =>
        confirmReservedAsset(harness, world, actor, {
          accessOverride: options.accessOverride,
          key: options.key,
          mediaAssetRef: options.mediaAssetRef,
          verification,
        }),
    }).pipe(Effect.provideService(ObjectStorage, options.storage ?? harness.storage.service));
  });

const confirmMustNotRun = () => Effect.die('the confirm Action must not run for a row that cannot be read');

const storedOnlyWhen = (when: 'after' | 'before', harness: Harness) =>
  withObjectStorageFaults([{ failure: timeout, operation: 'put', times: 1, when }]).pipe(
    Effect.provideService(ObjectStorage, harness.storage.service),
  );

it.layer(NodeCrypto.layer, { excludeTestServices: true })('core media reconciliation on PostgreSQL', (suite) => {
  suite.effect('completes the same asset when the provider stored the bytes but the answer was lost (order 2)', () =>
    Effect.gen(function* storedButUncertain() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const reservation = yield* reserveAsset(harness, world, world.human, content, { key: 'lost-answer' });
      const mediaAssetId = reservation.mediaAssetRef.resourceId;
      // Controlled fault injection: the put stored the object, then the caller was told it failed.
      const flaky = yield* storedOnlyWhen('after', harness);
      const streamed = yield* Effect.exit(
        streamReservedBytes(harness, world, world.human, mediaAssetId, content, flaky),
      );
      expect(failureTagOf(streamed)).toBe('MediaIngestUncertain');
      expect((yield* harness.rowOf(world.tenantId, mediaAssetId))?.processing_status).toBe('uploaded');
      const reconciled = yield* reconcileAsset(harness, world, world.human, {
        key: 'lost-answer-reconcile',
        mediaAssetRef: reservation.mediaAssetRef,
      });
      expect(reconciled).toEqual({
        byteSize: content.byteLength,
        contentSha256: digestOf(content),
        outcome: 'completed',
      });
      expect(mayStartIndependentUpload(reconciled)).toBe(false);
      expect(yield* harness.rowCount(world.tenantId)).toBe(1);
      expect((yield* harness.rowOf(world.tenantId, mediaAssetId))?.processing_status).toBe('ready');
    }).pipe(Effect.scoped),
  );

  suite.effect('stays unresolved when nothing was stored, forbids a new upload, then completes the same asset', () =>
    Effect.gen(function* nothingStored() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const reservation = yield* reserveAsset(harness, world, world.human, content, { key: 'never-stored' });
      const mediaAssetId = reservation.mediaAssetRef.resourceId;
      const flaky = yield* storedOnlyWhen('before', harness);
      const streamed = yield* Effect.exit(
        streamReservedBytes(harness, world, world.human, mediaAssetId, content, flaky),
      );
      expect(failureTagOf(streamed)).toBe('MediaIngestUncertain');
      const before = yield* harness.rowOf(world.tenantId, mediaAssetId);
      // Same idempotency key every time: the uncertain Action is retryable and never runs a second effect.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const reconciled = yield* reconcileAsset(harness, world, world.human, {
          key: 'never-stored-reconcile',
          mediaAssetRef: reservation.mediaAssetRef,
        });
        expect(reconciled).toEqual({ outcome: 'unresolved', reason: 'object_missing' });
        expect(mayStartIndependentUpload(reconciled)).toBe(false);
      }
      expect(yield* harness.rowOf(world.tenantId, mediaAssetId)).toEqual(before);
      // The same client sends the bytes to the same asset; reconciliation then completes the original intent.
      yield* streamReservedBytes(harness, world, world.human, mediaAssetId, content);
      const completed = yield* reconcileAsset(harness, world, world.human, {
        key: 'never-stored-reconcile',
        mediaAssetRef: reservation.mediaAssetRef,
      });
      expect(completed.outcome).toBe('completed');
      expect(yield* harness.rowCount(world.tenantId)).toBe(1);
    }).pipe(Effect.scoped),
  );

  suite.effect('completes an upload whose confirm never committed, including a rolled-back commit (order 1)', () =>
    Effect.gen(function* confirmLost() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const reservation = yield* reserveAsset(harness, world, world.human, content, { key: 'confirm-lost' });
      const mediaAssetId = reservation.mediaAssetRef.resourceId;
      yield* streamReservedBytes(harness, world, world.human, mediaAssetId, content);
      // The provider holds the bytes; the confirm transaction fails on its UPDATE and rolls back.
      const rolledBack = yield* Effect.exit(
        reconcileAsset(harness, world, world.human, {
          key: 'confirm-lost-reconcile',
          mediaAssetRef: reservation.mediaAssetRef,
        }).pipe(
          injectStatementFaults((statement) =>
            statement.includes('"media_assets" set')
              ? Effect.fail(
                  new SqlError({
                    reason: new UnknownError({
                      cause: new Error('Injected SQL failure'),
                      message: 'Injected write failure',
                    }),
                  }),
                )
              : Effect.void,
          ),
        ),
      );
      expect(Exit.isFailure(rolledBack)).toBe(true);
      expect((yield* harness.rowOf(world.tenantId, mediaAssetId))?.processing_status).toBe('uploaded');
      const completed = yield* reconcileAsset(harness, world, world.human, {
        key: 'confirm-lost-reconcile',
        mediaAssetRef: reservation.mediaAssetRef,
      });
      expect(completed.outcome).toBe('completed');
      expect(yield* harness.rowCount(world.tenantId)).toBe(1);
    }).pipe(Effect.scoped),
  );

  suite.effect(
    'closes the original intent as failed on proven wrong bytes and only then allows an independent upload',
    () =>
      Effect.gen(function* wrongBytes() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const reservation = yield* reserveAsset(harness, world, world.human, content, { key: 'wrong' });
        const mediaAssetId = reservation.mediaAssetRef.resourceId;
        yield* harness.storage.service.put({
          body: Stream.make(tampered),
          contentType: 'application/pdf',
          key: deriveMediaStorageKey({ mediaAssetId, tenantId: world.tenantId }),
        });
        const closed = yield* reconcileAsset(harness, world, world.human, {
          key: 'wrong-reconcile',
          mediaAssetRef: reservation.mediaAssetRef,
        });
        expect(closed).toEqual({ outcome: 'closed_failed' });
        expect(mayStartIndependentUpload(closed)).toBe(true);
        expect((yield* harness.rowOf(world.tenantId, mediaAssetId))?.processing_status).toBe('failed');
        // Reconciling again, or with good bytes at the key, never reopens it.
        yield* harness.storage.service.put({
          body: Stream.make(content),
          contentType: 'application/pdf',
          key: deriveMediaStorageKey({ mediaAssetId, tenantId: world.tenantId }),
        });
        expect(
          yield* reconcileAsset(harness, world, world.human, {
            key: 'wrong-reconcile-2',
            mediaAssetRef: reservation.mediaAssetRef,
          }),
        ).toEqual({ outcome: 'closed_failed' });
        // The independent upload is another asset with its own id; the closed one is not touched.
        const independent = yield* uploadReadyAsset(harness, world, world.human, content, { key: 'wrong-new' });
        expect(independent.mediaAssetId).not.toBe(mediaAssetId);
        expect((yield* harness.rowOf(world.tenantId, mediaAssetId))?.processing_status).toBe('failed');
        expect(yield* harness.rowCount(world.tenantId)).toBe(2);
      }).pipe(Effect.scoped),
  );

  suite.effect('leaves the intent unresolved on every doubtful read: outage, early close, a replaced object', () =>
    Effect.gen(function* doubtful() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const reservation = yield* reserveAsset(harness, world, world.human, content, { key: 'doubt' });
      const mediaAssetId = reservation.mediaAssetRef.resourceId;
      yield* streamReservedBytes(harness, world, world.human, mediaAssetId, content);
      const before = yield* harness.rowOf(world.tenantId, mediaAssetId);
      const outage = yield* withObjectStorageFaults([{ failure: network, operation: 'get' }]).pipe(
        Effect.provideService(ObjectStorage, harness.storage.service),
      );
      const shortRead: ObjectStorageService = {
        ...harness.storage.service,
        get: () => Effect.succeed({ body: Stream.make(content.slice(0, 5)), stat: { byteSize: content.byteLength } }),
      };
      // Another writer replaces the object after the read began: the read cannot be proven to be of one object.
      const replaced: ObjectStorageService = {
        ...harness.storage.service,
        get: (objectKey) =>
          harness.storage.service.get(objectKey).pipe(
            Effect.tap(() =>
              harness.storage.service.put({
                body: Stream.make(encoder.encode('replaced')),
                contentType: 'application/pdf',
                key: objectKey,
              }),
            ),
          ),
      };
      const cases = [
        [outage, 'provider_failure'],
        [shortRead, 'framing_inconsistent'],
        [replaced, 'object_changed'],
      ] as const;
      for (const [storage, reason] of cases) {
        const reconciled = yield* reconcileAsset(harness, world, world.human, {
          key: `doubt-${reason}`,
          mediaAssetRef: reservation.mediaAssetRef,
          storage,
        });
        expect(reconciled).toEqual({ outcome: 'unresolved', reason });
        expect(mayStartIndependentUpload(reconciled)).toBe(false);
      }
      expect(yield* harness.rowOf(world.tenantId, mediaAssetId)).toEqual(before);
    }).pipe(Effect.scoped),
  );

  suite.effect('leaves a row Core could not have written unresolved, without a provider call or a defect', () =>
    Effect.gen(function* inconsistentRow() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const reservation = yield* reserveAsset(harness, world, world.human, content, { key: 'inconsistent' });
      const callsBefore = (yield* harness.storage.calls).length;
      const row = yield* verifiableRowOf(harness, world.tenantId, reservation.mediaAssetRef.resourceId);
      const unreadable = [
        { ...row, storageKey: 'core-media/v1/not-a-key' },
        { ...row, contentSha256: null, processingStatus: 'ready' },
        { ...row, byteSize: -1n, processingStatus: 'ready' },
      ];
      for (const asset of unreadable) {
        const reconciled = yield* reconcileUncertainUpload({ asset, confirm: confirmMustNotRun }).pipe(
          Effect.provideService(ObjectStorage, harness.storage.service),
        );
        expect(reconciled).toEqual({ outcome: 'unresolved', reason: 'row_inconsistent' });
      }
      expect((yield* harness.storage.calls).length).toBe(callsBefore);
    }).pipe(Effect.scoped),
  );

  suite.effect('needs the original authority again: a denied or unavailable decision completes nothing', () =>
    Effect.gen(function* authority() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const reservation = yield* reserveAsset(harness, world, world.human, content, { key: 'authority' });
      const mediaAssetId = reservation.mediaAssetRef.resourceId;
      yield* streamReservedBytes(harness, world, world.human, mediaAssetId, content);
      for (const accessOverride of ['denied', 'unavailable'] as const) {
        const exit = yield* Effect.exit(
          reconcileAsset(harness, world, world.human, {
            accessOverride,
            key: `authority-${accessOverride}`,
            mediaAssetRef: reservation.mediaAssetRef,
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect((yield* harness.rowOf(world.tenantId, mediaAssetId))?.processing_status).toBe('uploaded');
      }
      // Authority restored (a fresh decision, not a remembered one): the same asset completes.
      const completed = yield* reconcileAsset(harness, world, world.human, {
        key: 'authority-restored',
        mediaAssetRef: reservation.mediaAssetRef,
      });
      expect(completed.outcome).toBe('completed');
    }).pipe(Effect.scoped),
  );

  suite.effect('answers a settled intent from its row without asking the provider or rerunning any handler', () =>
    Effect.gen(function* settled() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const ready = yield* uploadReadyAsset(harness, world, world.human, content, { key: 'settled' });
      const failed = yield* reserveAsset(harness, world, world.human, content, { key: 'settled-failed' });
      yield* harness.admin.unsafe(
        `update core.media_assets set processing_status = 'failed' where tenant_id = $1 and media_asset_id = $2`,
        [world.tenantId, failed.mediaAssetRef.resourceId],
      );
      const invocationsBefore = yield* harness.countOf('core.action_invocations', world.tenantId);
      const callsBefore = (yield* harness.storage.calls).length;
      expect(
        yield* reconcileAsset(harness, world, world.human, {
          key: 'settled-r1',
          mediaAssetRef: ready.reservation.mediaAssetRef,
        }),
      ).toEqual({ byteSize: content.byteLength, contentSha256: digestOf(content), outcome: 'completed' });
      expect(
        yield* reconcileAsset(harness, world, world.human, { key: 'settled-r2', mediaAssetRef: failed.mediaAssetRef }),
      ).toEqual({ outcome: 'closed_failed' });
      expect((yield* harness.storage.calls).length).toBe(callsBefore);
      expect(yield* harness.countOf('core.action_invocations', world.tenantId)).toBe(invocationsBefore);
      // A succeeded confirm never reruns for a retry of its key, and other content under that key is a conflict.
      const replay = yield* Effect.exit(
        confirmReservedAsset(harness, world, world.human, {
          key: 'settled-confirm',
          mediaAssetRef: ready.reservation.mediaAssetRef,
          verification: ready.verification,
        }),
      );
      expect(failureTagOf(replay)).toBe('ActionAlreadyCommitted');
      const conflicting = yield* Effect.exit(
        harness
          .runtimeFor('human')
          .runAction({
            payload: { mediaAssetRef: failed.mediaAssetRef },
            principal: principalOf(world, world.human),
            registration: confirmAssetAction,
            savedReply: 'answer',
            transport: transportOf('settled-confirm'),
          })
          .pipe(Effect.provideService(StoredMediaObjectVerification, ready.verification)),
      );
      expect(failureTagOf(conflicting)).toBe('ActionRequestHashConflict');
    }).pipe(Effect.scoped),
  );

  suite.effect('lets a bound ingest workload reconcile the same way, and a machine without the binding nothing', () =>
    Effect.gen(function* machine() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      yield* harness.bind(world, world.system);
      const reservation = yield* reserveAsset(harness, world, world.system, content, {
        key: 'machine',
        overrides: { ingestionSource: 'import' },
      });
      yield* streamReservedBytes(harness, world, world.system, reservation.mediaAssetRef.resourceId, content);
      const unbound = yield* Effect.exit(
        reconcileAsset(harness, world, world.integration, {
          key: 'machine-unbound',
          mediaAssetRef: reservation.mediaAssetRef,
        }),
      );
      expect(Exit.isFailure(unbound)).toBe(true);
      const completed = yield* reconcileAsset(harness, world, world.system, {
        key: 'machine-bound',
        mediaAssetRef: reservation.mediaAssetRef,
      });
      expect(completed.outcome).toBe('completed');
    }).pipe(Effect.scoped),
  );
});

const succeededInvocations = (harness: Harness, tenantId: string, idempotencyKey: string) =>
  harness.admin
    .unsafe<{ count: string }>(
      `select count(*)::text as count from core.action_invocations where tenant_id = $1 and idempotency_key = $2 and status = 'succeeded'`,
      [tenantId, idempotencyKey],
    )
    .pipe(Effect.map((rows) => Number(rows[0]?.count ?? '0')));

it.layer(NodeCrypto.layer, { excludeTestServices: true })(
  'core media recovery under concurrency on PostgreSQL',
  (suite) => {
    suite.effect('has many reconcilers of one asset seal it once, with one asset and no second confirming effect', () =>
      Effect.gen(function* reconcilers() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const reservation = yield* reserveAsset(harness, world, world.human, content, { key: 'many' });
        const mediaAssetId = reservation.mediaAssetRef.resourceId;
        yield* streamReservedBytes(harness, world, world.human, mediaAssetId, content);
        const outcomes = yield* Effect.all(
          Array.from({ length: 6 }, (_, index) =>
            reconcileAsset(harness, world, world.human, {
              key: `many-${index}`,
              mediaAssetRef: reservation.mediaAssetRef,
            }),
          ),
          { concurrency: 'unbounded' },
        );
        expect(new Set(outcomes.map(({ outcome }) => outcome))).toEqual(new Set(['completed']));
        const sealed = yield* harness.rowOf(world.tenantId, mediaAssetId);
        expect(sealed?.processing_status).toBe('ready');
        expect(yield* harness.rowCount(world.tenantId)).toBe(1);
        // A later reconcile finds a settled row and changes nothing, so the seal is the first one's.
        yield* reconcileAsset(harness, world, world.human, {
          key: 'many-later',
          mediaAssetRef: reservation.mediaAssetRef,
        });
        expect(yield* harness.rowOf(world.tenantId, mediaAssetId)).toEqual(sealed);
      }).pipe(Effect.scoped),
    );

    suite.effect('runs one effect when the same reconcile key is retried while it is still running', () =>
      Effect.gen(function* sameKey() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const reservation = yield* reserveAsset(harness, world, world.human, content, { key: 'same-key' });
        const mediaAssetId = reservation.mediaAssetRef.resourceId;
        yield* streamReservedBytes(harness, world, world.human, mediaAssetId, content);
        const exits = yield* Effect.all(
          Array.from({ length: 4 }, () =>
            Effect.exit(
              reconcileAsset(harness, world, world.human, {
                key: 'same-key-reconcile',
                mediaAssetRef: reservation.mediaAssetRef,
              }),
            ),
          ),
          { concurrency: 'unbounded' },
        );
        expect(exits.some((exit) => Exit.isSuccess(exit))).toBe(true);
        for (const exit of exits) {
          // The losers are told the invocation already committed: never a second effect, never another outcome.
          expect(Exit.isSuccess(exit) || failureTagOf(exit) === 'ActionAlreadyCommitted').toBe(true);
        }
        expect(yield* succeededInvocations(harness, world.tenantId, 'same-key-reconcile')).toBe(1);
        expect((yield* harness.rowOf(world.tenantId, mediaAssetId))?.processing_status).toBe('ready');
        expect(yield* harness.rowCount(world.tenantId)).toBe(1);
      }).pipe(Effect.scoped),
    );

    suite.effect('closes a wrongly stored intent once however many reconcilers race, and none makes it ready', () =>
      Effect.gen(function* racingClose() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const reservation = yield* reserveAsset(harness, world, world.human, content, { key: 'race-close' });
        const mediaAssetId = reservation.mediaAssetRef.resourceId;
        yield* harness.storage.service.put({
          body: Stream.make(tampered),
          contentType: 'application/pdf',
          key: deriveMediaStorageKey({ mediaAssetId, tenantId: world.tenantId }),
        });
        const outcomes = yield* Effect.all(
          Array.from({ length: 5 }, (_, index) =>
            reconcileAsset(harness, world, world.human, {
              key: `race-close-${index}`,
              mediaAssetRef: reservation.mediaAssetRef,
            }),
          ),
          { concurrency: 'unbounded' },
        );
        expect(new Set(outcomes.map(({ outcome }) => outcome))).toEqual(new Set(['closed_failed']));
        expect((yield* harness.rowOf(world.tenantId, mediaAssetId))?.processing_status).toBe('failed');
        expect(yield* harness.rowCount(world.tenantId)).toBe(1);
      }).pipe(Effect.scoped),
    );

    suite.effect('lets a client resend the bytes while reconcilers run: one asset, and it ends ready once', () =>
      Effect.gen(function* resend() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const reservation = yield* reserveAsset(harness, world, world.human, content, { key: 'resend' });
        const mediaAssetId = reservation.mediaAssetRef.resourceId;
        const reconcile = (key: string) =>
          reconcileAsset(harness, world, world.human, { key, mediaAssetRef: reservation.mediaAssetRef });
        const [first, , third] = yield* Effect.all(
          [
            reconcile('resend-a'),
            streamReservedBytes(harness, world, world.human, mediaAssetId, content),
            reconcile('resend-b'),
          ],
          { concurrency: 'unbounded' },
        );
        // Mid-race a reconcile may only say unresolved or completed; it never says failed, and nothing is duplicated.
        for (const outcome of [first, third]) {
          expect(['completed', 'unresolved']).toContain(outcome.outcome);
        }
        const settled = yield* reconcile('resend-final');
        expect(settled.outcome).toBe('completed');
        expect(yield* harness.rowCount(world.tenantId)).toBe(1);
        expect((yield* harness.rowOf(world.tenantId, mediaAssetId))?.processing_status).toBe('ready');
      }).pipe(Effect.scoped),
    );

    suite.effect('verifies a ready asset while it is reconciled: the read changes nothing and the answers agree', () =>
      Effect.gen(function* readDuringReconcile() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const uploaded = yield* uploadReadyAsset(harness, world, world.human, content, { key: 'during' });
        const before = yield* harness.rowOf(world.tenantId, uploaded.mediaAssetId);
        const row = yield* verifiableRowOf(harness, world.tenantId, uploaded.mediaAssetId);
        const [verified, reconciled] = yield* Effect.all(
          [
            verifyReadyMediaAsset(row).pipe(Effect.provideService(ObjectStorage, harness.storage.service)),
            reconcileAsset(harness, world, world.human, {
              key: 'during-reconcile',
              mediaAssetRef: uploaded.reservation.mediaAssetRef,
            }),
          ],
          { concurrency: 'unbounded' },
        );
        expect(verified).toMatchObject({ contentSha256: digestOf(content), outcome: 'verified' });
        expect(reconciled.outcome).toBe('completed');
        expect(yield* harness.rowOf(world.tenantId, uploaded.mediaAssetId)).toEqual(before);
      }).pipe(Effect.scoped),
    );

    suite.effect('records proven corruption once when two verifiers record it at the same time', () =>
      Effect.gen(function* racingIntegrity() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        yield* harness.bind(world, world.system, INTEGRITY_WORKLOAD);
        const uploaded = yield* corruptReadyAsset(harness, world, 'race-integrity');
        const finding = yield* findingOf(harness, world, uploaded.mediaAssetId);
        const results = yield* Effect.all(
          Array.from({ length: 4 }, (_, index) =>
            recordIntegrity(harness, world, world.system, {
              finding,
              key: `race-integrity-${index}`,
              mediaAssetRef: uploaded.reservation.mediaAssetRef,
            }),
          ),
          { concurrency: 'unbounded' },
        );
        for (const result of results) {
          expect(result.processingStatus).toBe('failed');
        }
        const evidence = yield* harness.admin.unsafe<{ text: string }>(
          `select evidence_json::text as text from core.audit_events where tenant_id = $1 and evidence_json ? 'finding'`,
          [world.tenantId],
        );
        expect(evidence).toHaveLength(1);
        expect((yield* harness.rowOf(world.tenantId, uploaded.mediaAssetId))?.processing_status).toBe('failed');
      }).pipe(Effect.scoped),
    );
  },
);

const checkCleanup = (
  harness: Harness,
  world: World,
  options: {
    readonly authority?: 'absent' | 'verified';
    readonly mediaAssetId: string;
    readonly providerProtection?: 'none_recorded' | 'recorded' | 'unknown';
    readonly tenantId?: string;
  },
) =>
  Effect.gen(function* cleanupCheck() {
    const trusted = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(principalOf(world, world.human));
    const scope = { ...trusted, correlationId: 'core-media-cleanup' };
    const target = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ mediaAssetId: MediaAssetIdSchema, tenantId: MediaTenantIdSchema }),
    )({ mediaAssetId: options.mediaAssetId, tenantId: options.tenantId ?? world.tenantId });
    return yield* harness.database.executor.transaction((transaction) =>
      installOperationalScope(transaction, scope).pipe(
        Effect.flatMap((scoped) =>
          checkTemporaryObjectCleanup(scoped, {
            authority: options.authority ?? 'verified',
            providerProtection: options.providerProtection ?? 'none_recorded',
            target: {
              ...target,
              storageKey: deriveMediaStorageKey(target),
              storageProvider: harness.storage.service.providerId,
            },
          }),
        ),
      ),
    );
  });

const refusalsOfCheck = (assessment: Effect.Success<ReturnType<typeof checkCleanup>>) =>
  assessment.eligible ? [] : [...assessment.refusals].toSorted();

it.layer(NodeCrypto.layer, { excludeTestServices: true })('core media cleanup eligibility on PostgreSQL', (suite) => {
  suite.effect('refuses a confirmed asset, an open intent and a failed one: nothing Core wrote is temporary', () =>
    Effect.gen(function* refusals() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const ready = yield* uploadReadyAsset(harness, world, world.human, content, { key: 'clean-ready' });
      const open = yield* reserveAsset(harness, world, world.human, content, { key: 'clean-open' });
      const failed = yield* reserveAsset(harness, world, world.human, content, { key: 'clean-failed' });
      yield* harness.admin.unsafe(
        `update core.media_assets set processing_status = 'failed' where tenant_id = $1 and media_asset_id = $2`,
        [world.tenantId, failed.mediaAssetRef.resourceId],
      );
      const rowsBefore = yield* harness.admin.unsafe(
        `select * from core.media_assets where tenant_id = $1 order by media_asset_id`,
        [world.tenantId],
      );
      const objectsBefore = (yield* harness.storage.calls).length;
      expect(refusalsOfCheck(yield* checkCleanup(harness, world, { mediaAssetId: ready.mediaAssetId }))).toEqual([
        'action_invocation_present',
        'confirmed_asset',
      ]);
      expect(
        refusalsOfCheck(yield* checkCleanup(harness, world, { mediaAssetId: open.mediaAssetRef.resourceId })),
      ).toEqual(['action_invocation_present', 'open_intent']);
      expect(
        refusalsOfCheck(yield* checkCleanup(harness, world, { mediaAssetId: failed.mediaAssetRef.resourceId })),
      ).toEqual(['action_invocation_present', 'failed_asset_evidence']);
      // A check deletes nothing, writes nothing and does not even call the provider.
      expect(
        yield* harness.admin.unsafe(`select * from core.media_assets where tenant_id = $1 order by media_asset_id`, [
          world.tenantId,
        ]),
      ).toEqual(rowsBefore);
      expect((yield* harness.storage.calls).length).toBe(objectsBefore);
    }).pipe(Effect.scoped),
  );

  suite.effect('refuses an asset that is linked or referenced as evidence', () =>
    Effect.gen(function* referenced() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const linked = yield* reserveAsset(harness, world, world.human, content, { key: 'clean-link' });
      const evidenced = yield* reserveAsset(harness, world, world.human, content, { key: 'clean-evidence' });
      yield* harness.admin.unsafe(
        `insert into core.media_links (tenant_id, media_asset_id, action_invocation_id, link_source, target_module_key, target_resource_type, target_resource_id, link_kind)
         values ($1, $2, $2, 'user', 'catalog', 'catalog.product', 'p-1', 'attachment')`,
        [world.tenantId, linked.mediaAssetRef.resourceId],
      );
      yield* harness.admin.unsafe(
        `insert into core.evidence_references (tenant_id, legal_entity_id, media_asset_id, source_kind, action_invocation_id, evidence_kind, evidence_policy_key, retention_policy_key, artifact_content_sha256, storage_lock_scope, storage_lock_mode, storage_lock_status, disposition_status, data_classification)
         values ($1, $3, $2, 'action', $2, 'artifact', 'p', 'r', $4, 'object', 'none', 'unlocked', 'active', 'internal')`,
        [world.tenantId, evidenced.mediaAssetRef.resourceId, world.legalEntityId, digestOf(content)],
      );
      expect(
        refusalsOfCheck(yield* checkCleanup(harness, world, { mediaAssetId: linked.mediaAssetRef.resourceId })),
      ).toContain('linked');
      expect(
        refusalsOfCheck(yield* checkCleanup(harness, world, { mediaAssetId: evidenced.mediaAssetRef.resourceId })),
      ).toContain('evidence_reference');
    }).pipe(Effect.scoped),
  );

  suite.effect('is eligible only for an object that was never part of any Core intent, with every attestation', () =>
    Effect.gen(function* eligible() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const neverReserved = yield* nextUuid;
      expect(yield* checkCleanup(harness, world, { mediaAssetId: neverReserved })).toEqual({ eligible: true });
      // The same object is refused the moment one attestation is missing, however unlikely the object looks.
      expect(
        refusalsOfCheck(yield* checkCleanup(harness, world, { authority: 'absent', mediaAssetId: neverReserved })),
      ).toEqual(['authority_unverified']);
      for (const providerProtection of ['recorded', 'unknown'] as const) {
        expect(
          refusalsOfCheck(yield* checkCleanup(harness, world, { mediaAssetId: neverReserved, providerProtection })),
        ).toEqual(['protection_unproven']);
      }
      // A target of another tenant than the trusted scope is never assessed against this tenant's facts.
      const other = yield* makeWorld(harness.admin, harness.database.executor);
      expect(
        refusalsOfCheck(yield* checkCleanup(harness, world, { mediaAssetId: neverReserved, tenantId: other.tenantId })),
      ).toEqual(['target_unverified']);
    }).pipe(Effect.scoped),
  );
});

const SECRETS = [
  'https://',
  'http://',
  'X-Amz',
  'Authorization',
  'AKIA',
  'TOKENSECRET',
  'SIGSECRET',
  'secret-brochure',
  'core-media/v1/',
] as const;

it.layer(NodeCrypto.layer, { excludeTestServices: true })('core media recovery logging on PostgreSQL', (suite) => {
  suite.effect('logs only redacted references and categories, and records no secret in logs or evidence', () =>
    Effect.gen(function* logging() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      yield* harness.bind(world, world.system, INTEGRITY_WORKLOAD);
      const emitted: { readonly annotations: string; readonly keys: readonly string[]; readonly message: string }[] =
        [];
      const logger = Logger.make((options) => {
        const { annotations, message } = Logger.formatStructured.log(options);
        emitted.push({
          annotations: JSON.stringify(annotations),
          keys: Object.keys(annotations).toSorted(),
          message: JSON.stringify(message),
        });
      });
      const captured = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
      // A provider failure whose own text carries everything that must never be logged.
      const leaky = new ObjectStorageServerError({
        code: 'object_storage_server_error',
        reason:
          'GET https://bucket.example/core-media/v1/abc?X-Amz-Signature=SIGSECRET Authorization: AWS4 Credential=AKIAXXXX token=TOKENSECRET',
      });
      const uploaded = yield* uploadReadyAsset(harness, world, world.human, content, {
        key: 'logging',
        overrides: { displayFilename: 'secret-brochure.pdf' },
      });
      const row = yield* verifiableRowOf(harness, world.tenantId, uploaded.mediaAssetId);
      const outage = yield* withObjectStorageFaults([{ failure: leaky, operation: 'get' }]).pipe(
        Effect.provideService(ObjectStorage, harness.storage.service),
      );
      yield* captured(verifyReadyMediaAsset(row).pipe(Effect.provideService(ObjectStorage, outage)));
      yield* captured(
        reconcileAsset(harness, world, world.human, {
          key: 'logging-reconcile',
          mediaAssetRef: uploaded.reservation.mediaAssetRef,
        }),
      );
      yield* captured(checkCleanup(harness, world, { mediaAssetId: uploaded.mediaAssetId }));
      const pending = yield* reserveAsset(harness, world, world.human, content, { key: 'logging-pending' });
      yield* captured(
        reconcileAsset(harness, world, world.human, {
          key: 'logging-pending-reconcile',
          mediaAssetRef: pending.mediaAssetRef,
          storage: outage,
        }),
      );
      yield* harness.storage.service.put({
        body: Stream.make(tampered),
        contentType: 'application/pdf',
        key: deriveMediaStorageKey({ mediaAssetId: uploaded.mediaAssetId, tenantId: world.tenantId }),
      });
      const finding = yield* findingOf(harness, world, uploaded.mediaAssetId);
      yield* captured(verifyReadyMediaAsset(row).pipe(Effect.provideService(ObjectStorage, harness.storage.service)));
      yield* recordIntegrity(harness, world, world.system, {
        finding,
        key: 'logging-integrity',
        mediaAssetRef: uploaded.reservation.mediaAssetRef,
      });
      const media = emitted.filter(({ message }) => message === '"core.media.recovery"');
      // verified read x2, reconcile x2, cleanup check x1: every one a closed, redacted line.
      expect(media.length).toBeGreaterThanOrEqual(5);
      const forbidden = [
        ...SECRETS,
        uploaded.mediaAssetId,
        world.tenantId,
        row.storageKey,
        digestOf(content),
        digestOf(tampered),
        Buffer.from(content).toString('base64'),
        new TextDecoder().decode(content),
      ];
      for (const line of media) {
        expect(line.keys).toEqual(['category', 'operation', 'providerFailure', 'ref']);
        for (const secret of forbidden) {
          expect(line.annotations.includes(secret), `a log line carries ${secret}`).toBe(false);
        }
      }
      expect(media.some(({ annotations }) => annotations.includes('object_storage_server_error'))).toBe(true);
      const evidence = yield* harness.admin.unsafe<{ text: string }>(
        `select (to_jsonb(a))::text as text from core.audit_events a where tenant_id = $1
         union all select (to_jsonb(d))::text from core.data_access_events d where tenant_id = $1`,
        [world.tenantId],
      );
      expect(evidence.length).toBeGreaterThan(0);
      for (const { text } of evidence) {
        for (const secret of [...SECRETS, new TextDecoder().decode(content), Buffer.from(content).toString('base64')]) {
          expect(text.includes(secret), `evidence carries ${secret}`).toBe(false);
        }
      }
    }).pipe(Effect.scoped),
  );
});
