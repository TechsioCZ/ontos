import { sha256 } from '@noble/hashes/sha2.js';
import { NodeCrypto } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Cause, Crypto, DateTime, Effect, Exit, Option, Predicate, Schema, Stream } from 'effect';
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
import { makeCoreDatabase } from '../../src/db/client.ts';
import type { CoreDatabaseExecutor } from '../../src/db/types.ts';
import { loadDatabaseConfig, loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { SHARED_RUNTIME_IDENTITY } from '../../src/db/database-identities.ts';
import { streamMediaObject } from '../../src/media/byte-stream.ts';
import type { MediaByteHopAsset } from '../../src/media/byte-stream.ts';
import { ObjectStorage, ObjectStorageTimeout } from '../../src/media/object-storage.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import type { UploadAssetPayloadSchema } from '../../src/media/upload-contract.ts';
import {
  MediaStoredObjectVerificationSchema,
  StoredMediaObjectVerification,
  verifyStoredMediaObject,
} from '../../src/media/verification.ts';
import { confirmAssetAction } from '../../src/modules/actions/confirm-asset.action.ts';
import { uploadAssetAction } from '../../src/modules/actions/upload-asset.action.ts';
import { bindAccessGate } from '../../src/operations/access-gate.ts';
import type { AccessEnforcementPorts } from '../../src/operations/access-gate.ts';
import { makeScriptedBoundAccessGate } from '../../src/testing/access-gate.ts';
import { makeInMemoryObjectStorage, withObjectStorageFaults } from '../../src/testing/media-object-storage.ts';
import { writeTestTenantScopes } from '../../src/testing/tenant-access.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { makeTestOperationOwner, openActionRuntimeOptions } from '../support/action-runtime-options.ts';
import { makeTestPgClient } from '../support/database.ts';

/*
 * The reserve, stream, confirm upload on real PostgreSQL through the real Action runtime, with the in-memory
 * ObjectStorage double standing in for the provider. The double is never storage proof; what these tests prove is
 * Core's own behavior: identity, idempotency, concurrency, tenant scope, truthful outcomes and the carrier split.
 * Human callers pass a scripted allow; machine callers pass the real access seam over the real principal-kind
 * and workload-binding tables, so a binding row is the only thing that admits them. The SpiceDB-backed matrix
 * is d20-08's.
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

const hasFailure = <Failure>(exit: Exit.Exit<unknown, Failure>, tag: string): boolean =>
  Exit.isFailure(exit) && Option.exists(Cause.findErrorOption(exit.cause), Predicate.isTagged(tag));

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

type Harness = Effect.Success<ReturnType<typeof openHarness>>;

const carrierOf = (actor: Actor) => (actor.kind === 'human' ? 'human' : 'machine');

/** Reserve, stream, verify, confirm: one whole upload through the real Actions and the byte hop. */
const uploadFlow = Effect.fn('CoreMediaUploadTest.flow')(function* uploadFlow(
  harness: Harness,
  world: World,
  actor: Actor,
  bytes: Uint8Array,
  options: {
    readonly key: string;
    readonly legalEntityId?: string;
    readonly overrides?: ReservationOverrides;
  },
) {
  const runtime = harness.runtimeFor(carrierOf(actor));
  const principal = principalOf(world, actor, options.legalEntityId);
  const reservation = yield* runtime
    .runAction({
      payload: reservationPayload(bytes, options.overrides),
      principal,
      registration: uploadAssetAction,
      transport: transportOf(`${options.key}-reserve`),
    })
    .pipe(Effect.provideService(ObjectStorage, harness.storage.service));
  const asset = yield* harness.rowOf(world.tenantId, reservation.mediaAssetRef.resourceId);
  if (asset === undefined) {
    return yield* Effect.die('The reserved asset row is missing');
  }
  const hopAsset = {
    byteSize: asset.byte_size,
    contentSha256: asset.content_sha256,
    ingestedByPrincipalId: asset.ingested_by_principal_id,
    mimeType: asset.mime_type,
    processingStatus: asset.processing_status,
    sealedAt: asset.sealed_at,
    storageKey: asset.storage_key,
    storageProvider: asset.storage_provider,
  } satisfies MediaByteHopAsset;
  const streamed = yield* streamMediaObject({
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
  return { confirmed, reservation, streamed, verification };
});

it.layer(NodeCrypto.layer, { excludeTestServices: true })('core media upload on PostgreSQL', (suite) => {
  suite.effect('reaches ready only after reserve, stream and confirm, sealing the stored size and digest', () =>
    Effect.gen(function* happyPath() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const { confirmed, reservation, streamed } = yield* uploadFlow(harness, world, world.human, content, {
        key: 'happy',
      });
      expect(reservation.processingStatus).toBe('uploaded');
      expect(streamed.kind).toBe('stored');
      expect(confirmed).toMatchObject({
        byteSize: content.byteLength,
        contentSha256: digestOf(content),
        processingStatus: 'ready',
      });
      const row = yield* harness.rowOf(world.tenantId, reservation.mediaAssetRef.resourceId);
      expect(row).toMatchObject({
        byte_size: BigInt(content.byteLength),
        content_sha256: digestOf(content),
        ingested_by_principal_id: world.human.principalId,
        ingestion_source: 'user',
        legal_entity_id: null,
        processing_status: 'ready',
        storage_provider: 'in-memory-test-double',
        tenant_id: world.tenantId,
      });
      expect(row?.sealed_at).not.toBeNull();
      expect(row?.storage_key).toBe(
        deriveMediaStorageKey({ mediaAssetId: reservation.mediaAssetRef.resourceId, tenantId: world.tenantId }),
      );
    }).pipe(Effect.scoped),
  );

  suite.effect(
    'anchors the asset on the reserving invocation: one invocation, one row, the invocation id is the id',
    () =>
      Effect.gen(function* anchored() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const runtime = harness.runtimeFor('human');
        const reserved = yield* runtime
          .runAction({
            payload: reservationPayload(content),
            principal: principalOf(world, world.human),
            registration: uploadAssetAction,
            transport: transportOf('anchor'),
          })
          .pipe(Effect.provideService(ObjectStorage, harness.storage.service));
        const invocations = yield* harness.admin.unsafe<{ action_invocation_id: string; status: string }>(
          `select action_invocation_id, status from core.action_invocations where tenant_id = $1 and idempotency_key = 'anchor'`,
          [world.tenantId],
        );
        expect(invocations).toHaveLength(1);
        expect(invocations[0]?.status).toBe('succeeded');
        expect(reserved.mediaAssetRef.resourceId).toBe(invocations[0]?.action_invocation_id);
        // The database itself refuses a second asset for the same invocation: the id is the primary key.
        const duplicate = yield* Effect.exit(
          harness.admin.unsafe(
            `insert into core.media_assets (media_asset_id, tenant_id, ingestion_source, storage_provider, storage_key, display_filename, mime_type, byte_size, processing_status)
           values ($1, $2, 'user', 'p', 'core-media/v1/${'0'.repeat(64)}', 'x', 'x/y', 1, 'uploaded')`,
            [reserved.mediaAssetRef.resourceId, world.tenantId],
          ),
        );
        expect(Exit.isFailure(duplicate)).toBe(true);
        expect(yield* harness.rowCount(world.tenantId)).toBe(1);
      }).pipe(Effect.scoped),
  );

  suite.effect('gives independent uploads of identical bytes and an identical name distinct ids and keys', () =>
    Effect.gen(function* distinct() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const first = yield* uploadFlow(harness, world, world.human, content, { key: 'twin-a' });
      const second = yield* uploadFlow(harness, world, world.human, content, { key: 'twin-b' });
      expect(first.reservation.mediaAssetRef.resourceId).not.toBe(second.reservation.mediaAssetRef.resourceId);
      const rows = yield* harness.admin.unsafe<{
        content_sha256: string;
        display_filename: string;
        storage_key: string;
      }>(`select content_sha256, display_filename, storage_key from core.media_assets where tenant_id = $1`, [
        world.tenantId,
      ]);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.storage_key)).size).toBe(2);
      expect(new Set(rows.map((row) => row.content_sha256)).size).toBe(1);
      expect(new Set(rows.map((row) => row.display_filename))).toEqual(new Set(['Brochure.pdf']));
      expect(first.confirmed.processingStatus).toBe('ready');
      expect(second.confirmed.processingStatus).toBe('ready');
    }).pipe(Effect.scoped),
  );

  suite.effect(
    'treats the four ingestion origins identically through their carrier and records the stated origin',
    () =>
      Effect.gen(function* origins() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        yield* harness.bind(world, world.system);
        yield* harness.bind(world, world.integration);
        const cases = [
          { actor: world.human, origin: 'user' },
          { actor: world.system, origin: 'system' },
          { actor: world.integration, origin: 'integration' },
          { actor: world.integration, origin: 'import' },
          // The origin is a label: any carrier may state any origin and nothing about the decision changes.
          { actor: world.human, origin: 'system' },
          { actor: world.system, origin: 'user' },
        ] as const;
        const outcomes = [];
        for (const [index, { actor, origin }] of cases.entries()) {
          const { confirmed, reservation } = yield* uploadFlow(harness, world, actor, content, {
            key: `origin-${index}`,
            overrides: { ingestionSource: origin },
          });
          const row = yield* harness.rowOf(world.tenantId, reservation.mediaAssetRef.resourceId);
          outcomes.push({
            ingestedBy: row?.ingested_by_principal_id,
            origin: row?.ingestion_source,
            processingStatus: confirmed.processingStatus,
            sealed: row?.sealed_at !== null,
            sha: confirmed.contentSha256,
          });
          expect(row?.ingested_by_principal_id).toBe(actor.principalId);
          expect(row?.ingestion_source).toBe(origin);
        }
        expect(
          new Set(outcomes.map(({ processingStatus, sealed, sha }) => `${processingStatus}/${sealed}/${sha}`)),
        ).toEqual(new Set([`ready/true/${digestOf(content)}`]));
      }).pipe(Effect.scoped),
  );

  suite.effect(
    'admits a machine principal only through its active workload binding, never by kind or origin label',
    () =>
      Effect.gen(function* unbound() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const runtime = harness.runtimeFor('machine');
        for (const [index, origin] of (['system', 'integration', 'import', 'user'] as const).entries()) {
          const exit = yield* Effect.exit(
            runtime
              .runAction({
                payload: reservationPayload(content, { ingestionSource: origin }),
                principal: principalOf(world, index % 2 === 0 ? world.system : world.integration),
                registration: uploadAssetAction,
                transport: transportOf(`unbound-${origin}`),
              })
              .pipe(Effect.provideService(ObjectStorage, harness.storage.service)),
          );
          expect(Exit.isFailure(exit)).toBe(true);
        }
        expect(yield* harness.rowCount(world.tenantId)).toBe(0);
        expect(yield* harness.storage.calls).toEqual([]);
      }).pipe(Effect.scoped),
  );

  suite.effect('refuses a denied or unavailable authorization before the handler: no row, no provider call', () =>
    Effect.gen(function* refused() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      for (const outcome of ['denied', 'unavailable'] as const) {
        const exit = yield* Effect.exit(
          harness
            .runtimeFor('human', outcome)
            .runAction({
              payload: reservationPayload(content),
              principal: principalOf(world, world.human),
              registration: uploadAssetAction,
              transport: transportOf(`refused-${outcome}`),
            })
            .pipe(Effect.provideService(ObjectStorage, harness.storage.service)),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }
      expect(yield* harness.rowCount(world.tenantId)).toBe(0);
      expect(yield* harness.storage.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  suite.effect('makes a replay of the same reserve a no-op: no second asset, and a changed claim is a conflict', () =>
    Effect.gen(function* replay() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const runtime = harness.runtimeFor('human');
      const run = (payload: ReturnType<typeof reservationPayload>, savedReply?: 'answer') =>
        runtime
          .runAction({
            payload,
            principal: principalOf(world, world.human),
            registration: uploadAssetAction,
            savedReply,
            transport: transportOf('replayed'),
          })
          .pipe(Effect.provideService(ObjectStorage, harness.storage.service));
      const first = yield* run(reservationPayload(content));
      expect(yield* harness.rowCount(world.tenantId)).toBe(1);
      // A transport retry that asks for the saved reply gets the same asset, with no second effect.
      const again = yield* run(reservationPayload(content), 'answer');
      expect(again.mediaAssetRef.resourceId).toBe(first.mediaAssetRef.resourceId);
      // An in-process retry is told the invocation already committed, and still adds nothing.
      const stopped = yield* Effect.exit(run(reservationPayload(content)));
      expect(hasFailure(stopped, 'ActionAlreadyCommitted')).toBe(true);
      // Other bytes under the same operation identity: a different declared digest is a hash conflict.
      const other = encoder.encode('completely different bytes of the same length!');
      const conflict = yield* Effect.exit(run(reservationPayload(other), 'answer'));
      expect(hasFailure(conflict, 'ActionRequestHashConflict')).toBe(true);
      expect(yield* harness.rowCount(world.tenantId)).toBe(1);
      const row = yield* harness.rowOf(world.tenantId, first.mediaAssetRef.resourceId);
      expect(row?.content_sha256).toBe(digestOf(content));
    }).pipe(Effect.scoped),
  );

  suite.effect('produces exactly one asset when identical reserves race on one operation identity', () =>
    Effect.gen(function* race() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const runtime = harness.runtimeFor('human');
      const attempt = () =>
        Effect.exit(
          runtime
            .runAction({
              payload: reservationPayload(content),
              principal: principalOf(world, world.human),
              registration: uploadAssetAction,
              savedReply: 'answer',
              transport: transportOf('raced'),
            })
            .pipe(Effect.provideService(ObjectStorage, harness.storage.service)),
        );
      const exits = yield* Effect.all(
        Array.from({ length: 6 }, () => attempt()),
        { concurrency: 'unbounded' },
      );
      expect(yield* harness.rowCount(world.tenantId)).toBe(1);
      const ids = new Set(exits.flatMap((exit) => (Exit.isSuccess(exit) ? [exit.value.mediaAssetRef.resourceId] : [])));
      expect(ids.size).toBe(1);
      expect(exits.some((exit) => Exit.isSuccess(exit))).toBe(true);
    }).pipe(Effect.scoped),
  );

  suite.effect('seals ready once under racing confirms and never regresses it', () =>
    Effect.gen(function* racingConfirms() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const { confirmed, reservation, verification } = yield* uploadFlow(harness, world, world.human, content, {
        key: 'confirm-race',
      });
      const sealedBefore = (yield* harness.rowOf(world.tenantId, reservation.mediaAssetRef.resourceId))?.sealed_at;
      const run = (key: string) =>
        Effect.exit(
          harness
            .runtimeFor('human')
            .runAction({
              payload: { mediaAssetRef: reservation.mediaAssetRef },
              principal: principalOf(world, world.human),
              registration: confirmAssetAction,
              transport: transportOf(key),
            })
            .pipe(Effect.provideService(StoredMediaObjectVerification, verification)),
        );
      const exits = yield* Effect.all([run('c-1'), run('c-2'), run('c-3')], { concurrency: 'unbounded' });
      for (const exit of exits) {
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(Exit.isSuccess(exit) ? exit.value : undefined).toEqual(confirmed);
      }
      const after = yield* harness.rowOf(world.tenantId, reservation.mediaAssetRef.resourceId);
      expect(after?.processing_status).toBe('ready');
      expect(after?.sealed_at).toEqual(sealedBefore);
    }).pipe(Effect.scoped),
  );

  suite.effect('closes a stored object that differs from the declaration as failed, committed, and never ready', () =>
    Effect.gen(function* mismatch() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const runtime = harness.runtimeFor('human');
      const principal = principalOf(world, world.human);
      const reservation = yield* runtime
        .runAction({
          payload: reservationPayload(content),
          principal,
          registration: uploadAssetAction,
          transport: transportOf('mismatch-reserve'),
        })
        .pipe(Effect.provideService(ObjectStorage, harness.storage.service));
      const key = deriveMediaStorageKey({
        mediaAssetId: reservation.mediaAssetRef.resourceId,
        tenantId: world.tenantId,
      });
      // Bytes of the declared length reach the provider by a path that bypasses the hop: the confirm must judge them.
      yield* harness.storage.service.put({
        body: Stream.make(encoder.encode('X'.repeat(content.byteLength))),
        contentType: 'application/pdf',
        key,
      });
      const verification = yield* verifyStoredMediaObject({
        expected: { byteSize: content.byteLength, contentSha256: digestOf(content) },
        storageKey: key,
        storageProvider: 'in-memory-test-double',
      }).pipe(Effect.provideService(ObjectStorage, harness.storage.service));
      expect(verification.outcome).toBe('mismatch');
      const exit = yield* Effect.exit(
        runtime
          .runAction({
            payload: { mediaAssetRef: reservation.mediaAssetRef },
            principal,
            registration: confirmAssetAction,
            transport: transportOf('mismatch-confirm'),
          })
          .pipe(Effect.provideService(StoredMediaObjectVerification, verification)),
      );
      expect(failureTagOf(exit)).toBe('MediaIntegrityFailed');
      const row = yield* harness.rowOf(world.tenantId, reservation.mediaAssetRef.resourceId);
      expect(row?.processing_status).toBe('failed');
      expect(row?.sealed_at).toBeNull();
      // A failed asset is final: a later confirm, even with good evidence, cannot make it ready.
      const goodEvidence = yield* Schema.decodeUnknownEffect(MediaStoredObjectVerificationSchema)({
        byteSize: content.byteLength,
        contentSha256: digestOf(content),
        outcome: 'verified',
        providerId: 'in-memory-test-double',
        storageKey: key,
      });
      const good = yield* Effect.exit(
        runtime
          .runAction({
            payload: { mediaAssetRef: reservation.mediaAssetRef },
            principal,
            registration: confirmAssetAction,
            transport: transportOf('mismatch-confirm-again'),
          })
          .pipe(Effect.provideService(StoredMediaObjectVerification, goodEvidence)),
      );
      expect(failureTagOf(good)).toBe('MediaIntegrityFailed');
      expect((yield* harness.rowOf(world.tenantId, reservation.mediaAssetRef.resourceId))?.processing_status).toBe(
        'failed',
      );
    }).pipe(Effect.scoped),
  );

  suite.effect('leaves the asset uploaded and recoverable when the object cannot be verified, then completes it', () =>
    Effect.gen(function* uncertain() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const runtime = harness.runtimeFor('human');
      const principal = principalOf(world, world.human);
      const reservation = yield* runtime
        .runAction({
          payload: reservationPayload(content),
          principal,
          registration: uploadAssetAction,
          transport: transportOf('uncertain-reserve'),
        })
        .pipe(Effect.provideService(ObjectStorage, harness.storage.service));
      const mediaAssetId = reservation.mediaAssetRef.resourceId;
      const key = deriveMediaStorageKey({ mediaAssetId, tenantId: world.tenantId });
      const target = {
        expected: { byteSize: content.byteLength, contentSha256: digestOf(content) },
        storageKey: key,
        storageProvider: 'in-memory-test-double',
      };
      const confirm = (
        verification: Effect.Success<ReturnType<typeof verifyStoredMediaObject>>,
        idempotencyKey: string,
      ) =>
        runtime
          .runAction({
            payload: { mediaAssetRef: reservation.mediaAssetRef },
            principal,
            registration: confirmAssetAction,
            transport: transportOf(idempotencyKey),
          })
          .pipe(Effect.provideService(StoredMediaObjectVerification, verification));
      // 1. Nothing was streamed yet: the object is missing, which is not a mismatch and not an absent asset.
      const missing = yield* verifyStoredMediaObject(target).pipe(
        Effect.provideService(ObjectStorage, harness.storage.service),
      );
      expect(missing).toMatchObject({ outcome: 'unverifiable', reason: 'object_missing' });
      const first = yield* Effect.exit(confirm(missing, 'uncertain-confirm'));
      expect(failureTagOf(first)).toBe('MediaIngestUncertain');
      // 2. A provider timeout during verification is uncertain too.
      const faulty = yield* withObjectStorageFaults([
        { failure: new ObjectStorageTimeout({ code: 'object_storage_timeout', reason: 'r' }), operation: 'get' },
      ]).pipe(Effect.provideService(ObjectStorage, harness.storage.service));
      const timedOut = yield* verifyStoredMediaObject(target).pipe(Effect.provideService(ObjectStorage, faulty));
      expect(failureTagOf(yield* Effect.exit(confirm(timedOut, 'uncertain-confirm')))).toBe('MediaIngestUncertain');
      const afterUncertain = yield* harness.rowOf(world.tenantId, mediaAssetId);
      expect(afterUncertain).toMatchObject({ processing_status: 'uploaded', sealed_at: null });
      // 3. The bytes arrive (the put that "failed" had in fact stored them); the same intent now completes.
      yield* harness.storage.service.put({ body: Stream.make(content), contentType: 'application/pdf', key });
      const proven = yield* verifyStoredMediaObject(target).pipe(
        Effect.provideService(ObjectStorage, harness.storage.service),
      );
      const ready = yield* confirm(proven, 'uncertain-confirm');
      expect(ready.processingStatus).toBe('ready');
      expect(yield* harness.rowCount(world.tenantId)).toBe(1);
    }).pipe(Effect.scoped),
  );

  suite.effect('keeps tenant B from confirming, touching or observing an asset of tenant A', () =>
    Effect.gen(function* tenants() {
      const harness = yield* openHarness();
      const worldA = yield* makeWorld(harness.admin, harness.database.executor);
      const worldB = yield* makeWorld(harness.admin, harness.database.executor);
      const upload = yield* uploadFlow(harness, worldA, worldA.human, content, { key: 'tenant-a' });
      const foreignRef = upload.reservation.mediaAssetRef;
      // B names A's exact ref: not found, indistinguishable from a random id, and nothing of A changes.
      const crossTenant = yield* Effect.exit(
        harness
          .runtimeFor('human')
          .runAction({
            payload: { mediaAssetRef: foreignRef },
            principal: principalOf(worldB, worldB.human),
            registration: confirmAssetAction,
            transport: transportOf('b-confirm-a'),
          })
          .pipe(Effect.provideService(StoredMediaObjectVerification, upload.verification)),
      );
      expect(failureTagOf(crossTenant)).toBe('MediaAssetNotFound');
      const sameIdInB = yield* Effect.exit(
        harness
          .runtimeFor('human')
          .runAction({
            payload: { mediaAssetRef: { ...foreignRef, tenantId: worldB.tenantId } },
            principal: principalOf(worldB, worldB.human),
            registration: confirmAssetAction,
            transport: transportOf('b-confirm-a-id'),
          })
          .pipe(Effect.provideService(StoredMediaObjectVerification, upload.verification)),
      );
      expect(failureTagOf(sameIdInB)).toBe('MediaAssetNotFound');
      expect(yield* harness.rowCount(worldB.tenantId)).toBe(0);
      expect(yield* harness.rowCount(worldA.tenantId)).toBe(1);
      // B's own reservation lands in B only.
      const own = yield* harness
        .runtimeFor('human')
        .runAction({
          payload: reservationPayload(content),
          principal: principalOf(worldB, worldB.human),
          registration: uploadAssetAction,
          transport: transportOf('b-own'),
        })
        .pipe(Effect.provideService(ObjectStorage, harness.storage.service));
      expect(own.mediaAssetRef.tenantId).toBe(worldB.tenantId);
      expect(yield* harness.rowCount(worldA.tenantId)).toBe(1);
    }).pipe(Effect.scoped),
  );

  suite.effect(
    'binds the row to the trusted company when one is selected and to none when the scope is tenant-wide',
    () =>
      Effect.gen(function* companies() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const tenantWide = yield* uploadFlow(harness, world, world.human, content, { key: 'scope-tenant' });
        const company = yield* uploadFlow(harness, world, world.humanTwo, content, {
          key: 'scope-company',
          legalEntityId: world.legalEntityId,
        });
        expect(
          (yield* harness.rowOf(world.tenantId, tenantWide.reservation.mediaAssetRef.resourceId))?.legal_entity_id,
        ).toBeNull();
        expect(
          (yield* harness.rowOf(world.tenantId, company.reservation.mediaAssetRef.resourceId))?.legal_entity_id,
        ).toBe(world.legalEntityId);
      }).pipe(Effect.scoped),
  );

  suite.effect(
    'creates no link, event, outbox message or other effect, and records no bytes or digest in evidence',
    () =>
      Effect.gen(function* noSideEffects() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        yield* uploadFlow(harness, world, world.human, content, { key: 'effects' });
        for (const table of [
          'core.media_links',
          'core.domain_events',
          'core.outbox_messages',
          'core.evidence_references',
        ]) {
          expect(yield* harness.countOf(table, world.tenantId)).toBe(0);
        }
        const evidence = yield* harness.admin.unsafe<{ text: string }>(
          `select (to_jsonb(a))::text as text from core.audit_events a where tenant_id = $1
         union all select (to_jsonb(d))::text from core.data_access_events d where tenant_id = $1`,
          [world.tenantId],
        );
        expect(evidence.length).toBeGreaterThan(0);
        for (const { text } of evidence) {
          expect(text).not.toContain(digestOf(content));
          expect(text).not.toContain('Brochure.pdf');
          expect(text).not.toContain(Buffer.from(content).toString('base64'));
        }
      }).pipe(Effect.scoped),
  );

  suite.effect('refuses verification evidence that describes another stored object', () =>
    Effect.gen(function* wrongObject() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const reserved = yield* harness
        .runtimeFor('human')
        .runAction({
          payload: reservationPayload(content),
          principal: principalOf(world, world.human),
          registration: uploadAssetAction,
          transport: transportOf('wrong-object-reserve'),
        })
        .pipe(Effect.provideService(ObjectStorage, harness.storage.service));
      const otherAssetId = yield* nextUuid;
      // A perfectly verified object, but it is another asset's: it can neither seal nor fail this one.
      const evidence = yield* Schema.decodeUnknownEffect(MediaStoredObjectVerificationSchema)({
        byteSize: content.byteLength,
        contentSha256: digestOf(content),
        outcome: 'verified',
        providerId: 'in-memory-test-double',
        storageKey: deriveMediaStorageKey({ mediaAssetId: otherAssetId, tenantId: world.tenantId }),
      });
      const exit = yield* Effect.exit(
        harness
          .runtimeFor('human')
          .runAction({
            payload: { mediaAssetRef: reserved.mediaAssetRef },
            principal: principalOf(world, world.human),
            registration: confirmAssetAction,
            transport: transportOf('wrong-object-confirm'),
          })
          .pipe(Effect.provideService(StoredMediaObjectVerification, evidence)),
      );
      expect(failureTagOf(exit)).toBe('MediaUnavailable');
      expect((yield* harness.rowOf(world.tenantId, reserved.mediaAssetRef.resourceId))?.processing_status).toBe(
        'uploaded',
      );
    }).pipe(Effect.scoped),
  );
  suite.effect('does not fail an asset on a mismatch finding that its own reservation contradicts', () =>
    Effect.gen(function* contradicted() {
      const harness = yield* openHarness();
      const world = yield* makeWorld(harness.admin, harness.database.executor);
      const reserved = yield* harness
        .runtimeFor('human')
        .runAction({
          payload: reservationPayload(content),
          principal: principalOf(world, world.human),
          registration: uploadAssetAction,
          transport: transportOf('contradicted-reserve'),
        })
        .pipe(Effect.provideService(ObjectStorage, harness.storage.service));
      const storageKey = deriveMediaStorageKey({
        mediaAssetId: reserved.mediaAssetRef.resourceId,
        tenantId: world.tenantId,
      });
      // A finding made against some other expectation: the "observed" bytes are exactly what this asset declared.
      const evidence = yield* Schema.decodeUnknownEffect(MediaStoredObjectVerificationSchema)({
        mismatch: 'sha256',
        observed: { byteSize: content.byteLength, contentSha256: digestOf(content) },
        outcome: 'mismatch',
        providerId: 'in-memory-test-double',
        storageKey,
      });
      const exit = yield* Effect.exit(
        harness
          .runtimeFor('human')
          .runAction({
            payload: { mediaAssetRef: reserved.mediaAssetRef },
            principal: principalOf(world, world.human),
            registration: confirmAssetAction,
            transport: transportOf('contradicted-confirm'),
          })
          .pipe(Effect.provideService(StoredMediaObjectVerification, evidence)),
      );
      expect(failureTagOf(exit)).toBe('MediaIngestUncertain');
      expect((yield* harness.rowOf(world.tenantId, reserved.mediaAssetRef.resourceId))?.processing_status).toBe(
        'uploaded',
      );
    }).pipe(Effect.scoped),
  );
});
