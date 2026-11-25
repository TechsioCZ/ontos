import { NodeCrypto } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Cause, Crypto, DateTime, Effect, Exit, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConfig, loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { SHARED_RUNTIME_IDENTITY } from '../../src/db/database-identities.ts';
import { assetMetadataRead } from '../../src/generated-reads/asset-metadata.ts';
import type { AssetMetadataResponse } from '../../src/generated-reads/asset-metadata.ts';
import { MediaAssetIdSchema, MediaTenantIdSchema, mediaAssetRefFor } from '../../src/media/identity.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import { renameDisplayFilenameAction } from '../../src/modules/actions/rename-display-filename.action.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../src/testing/access-gate.ts';
import type { TestAccessOutcome } from '../../src/testing/access-gate.ts';
import { writeTestTenantScopes } from '../../src/testing/tenant-access.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../support/action-runtime-options.ts';
import { makeTestPgClient } from '../support/database.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';

/*
 * The metadata read and the display-name rename on real PostgreSQL through the real Read and Action runtimes.
 * Assets are inserted as rows in the exact states the upload Actions leave them in, so every processing status is
 * reachable, `scanning` included, which no Action produces. Authorization is scripted here, per capability key:
 * the SpiceDB-backed matrix is d20-08's. What is proven is Core's own behavior: the truthful projection, tenant
 * and company scope, the typed errors, and that a rename changes the display name and nothing else.
 */

const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const allowedPermission = { checkActionPermission: () => Effect.succeed('allowed' as const) };
const contextAccess = {
  legalEntities: () => Effect.succeed([]),
  modules: () => Effect.succeed([]),
  resources: () => Effect.succeed([]),
  tenants: () => Effect.succeed([]),
};
const METADATA = 'core.media.asset-metadata.read';
const RENAME = 'core.media.display-filename.rename';
const DIGEST = 'b'.repeat(64);
const STORAGE_PROVIDER = 'secret-provider';
const SECRET_VERSION = 'secret-version-ref-77';

interface Actor {
  readonly authBindingId: string;
  readonly principalId: string;
}
interface World {
  readonly actor: Actor;
  readonly admin: PgClient.PgClient;
  readonly legalEntityId: string;
  readonly otherLegalEntityId: string;
  readonly tenantId: string;
}

const cleanTenant = (admin: PgClient.PgClient, tenantId: string) =>
  Effect.forEach(
    [
      'core.media_assets',
      'core.data_access_events',
      'core.audit_events',
      'core.action_invocations',
      'core.principal_auth_bindings',
      'core.principals',
      'core.legal_entities',
    ],
    (table) => admin.unsafe(`delete from ${table} where tenant_id = $1`, [tenantId]),
    { discard: true },
  ).pipe(Effect.orDie);

const makeWorld = Effect.fn('CoreMediaMetadataTest.world')(function* makeWorld(
  admin: PgClient.PgClient,
  executor: Parameters<typeof writeTestTenantScopes>[0],
) {
  const tenantId = yield* nextUuid;
  const legalEntityId = yield* nextUuid;
  const otherLegalEntityId = yield* nextUuid;
  const actor = { authBindingId: yield* nextUuid, principalId: yield* nextUuid } satisfies Actor;
  yield* Effect.addFinalizer(() => cleanTenant(admin, tenantId));
  yield* admin.unsafe(
    `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Media metadata tenant', 'active', 'en')`,
    [tenantId, `media-metadata-${tenantId}`],
  );
  for (const [id, label] of [
    [legalEntityId, 'Media company'],
    [otherLegalEntityId, 'Other media company'],
  ] as const) {
    yield* admin.unsafe(
      `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values ($1, $2, $3, 'CZ', $4, 'active')`,
      [id, tenantId, label, id],
    );
  }
  yield* admin.unsafe(
    `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $2, 'human', 'Media reader', 'active')`,
    [actor.principalId, tenantId],
  );
  yield* admin.unsafe(
    `insert into core.principal_auth_bindings (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider, subject_type, provider_subject_id, status)
     values ($1, $2, $3, 'test.staff.better-auth.v1', 'better_auth', 'user', $4, 'active')`,
    [actor.authBindingId, tenantId, actor.principalId, `media-metadata-${actor.authBindingId}`],
  );
  yield* writeTestTenantScopes(executor, { principalId: actor.principalId, tenantId });
  return { actor, admin, legalEntityId, otherLegalEntityId, tenantId } satisfies World;
});

const principalOf = (world: World, legalEntityId?: string) => {
  const principal = {
    authBindingId: world.actor.authBindingId,
    authContextRef: `core-media-metadata-${world.actor.principalId}`,
    authMethod: 'session' as const,
    principalId: world.actor.principalId,
    tenantId: world.tenantId,
  };
  return legalEntityId === undefined ? principal : { ...principal, legalEntityId };
};

const SeedStatusSchema = Schema.Literals(['failed', 'ready', 'scanning', 'uploaded']);
type SeedStatus = typeof SeedStatusSchema.Type;

/** A row exactly as the upload Actions leave it: a claim while unsealed, a sealed identity once ready. */
const seedAsset = Effect.fn('CoreMediaMetadataTest.seed')(function* seedAsset(
  world: World,
  options: {
    readonly displayFilename?: string;
    readonly legalEntityId?: string;
    readonly originalFilename?: string;
    readonly sealedAfterReady?: boolean;
    readonly status: SeedStatus;
  },
) {
  const mediaAssetId = yield* nextUuid;
  const sealed = options.status === 'ready' || options.sealedAfterReady === true;
  yield* world.admin.unsafe(
    `insert into core.media_assets (media_asset_id, tenant_id, legal_entity_id, ingestion_source, storage_provider, storage_key, storage_object_version_ref,
       original_filename, display_filename, mime_type, byte_size, content_sha256, sealed_at, processing_status)
     values ($1, $2, $3, 'integration', $4, $5, $6, $7, $8, 'application/pdf', 4096, $9, $10, $11)`,
    [
      mediaAssetId,
      world.tenantId,
      options.legalEntityId ?? null,
      STORAGE_PROVIDER,
      deriveMediaStorageKey({ mediaAssetId, tenantId: world.tenantId }),
      SECRET_VERSION,
      options.originalFilename ?? null,
      options.displayFilename ?? 'Brochure.pdf',
      DIGEST,
      sealed ? DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-19T10:00:00Z')) : null,
      options.status,
    ],
  );
  return yield* Schema.decodeUnknownEffect(MediaAssetIdSchema)(mediaAssetId);
});

const refOf = (world: World, mediaAssetId: string) =>
  mediaAssetRefFor({
    mediaAssetId: Schema.decodeUnknownSync(MediaAssetIdSchema)(mediaAssetId),
    tenantId: Schema.decodeUnknownSync(MediaTenantIdSchema)(world.tenantId),
  });

/** The evidence a metadata read leaves, plus the whole row serialized so a test can search it for secrets. */
interface EvidenceRow {
  readonly outcome: string;
  readonly outcome_code: string;
  readonly result_count: number;
  readonly serialized: string;
}

/** Every persisted column of a Media Asset, as the database returns it. */
interface MediaAssetRow {
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

const rowOf = (world: World, mediaAssetId: string) =>
  world.admin
    .unsafe<MediaAssetRow>(`select * from core.media_assets where tenant_id = $1 and media_asset_id = $2`, [
      world.tenantId,
      mediaAssetId,
    ])
    .pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.die('The seeded asset row is missing') : Effect.succeed(rows[0]),
      ),
    );

const withoutNameAndStamp = ({ display_filename: _name, updated_at: _stamp, ...rest }: MediaAssetRow) => rest;

/** A value as the text a consumer could see, so a test can search it for something that must not be there. */
const textOf = (value: AssetMetadataResponse | Error | undefined): string => JSON.stringify(value);

const failureOf = <Failure>(exit: Exit.Exit<unknown, Failure>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
const failureTagOf = <Failure>(exit: Exit.Exit<unknown, Failure>): string | undefined => {
  const failure = failureOf(exit);
  return Predicate.hasProperty(failure, '_tag') && Predicate.isString(failure._tag) ? failure._tag : undefined;
};

type Authorization = TestAccessOutcome | Readonly<Record<string, TestAccessOutcome>>;

const openHarness = Effect.fn('CoreMediaMetadataTest.harness')(function* openHarness() {
  const crypto = yield* Crypto.Crypto;
  const connections = yield* loadDatabaseConnectionPair();
  const admin = yield* makeTestPgClient(connections.admin.connectionString);
  const configuration = yield* loadDatabaseConfig({ identity: SHARED_RUNTIME_IDENTITY });
  const database = yield* makeCoreDatabase(configuration);
  const readerFor = (access: Authorization) => {
    // Like the Shell host: no owner registration, so the read must be a genuine Core operation to run at all.
    const runtime = makeReadRuntime(
      database,
      openModuleEntrypointGateway,
      testOperationalScopeResolver,
      contextAccess,
      {
        accessDecision: makeScriptedBoundAccessGate(access).bound,
      },
    );
    return (world: World, mediaAssetRef: ReturnType<typeof refOf>, legalEntityId?: string) =>
      runtime.runRead({
        input: { mediaAssetRef },
        principal: principalOf(world, legalEntityId),
        registration: assetMetadataRead,
        transport: { correlationId: `media-metadata-${mediaAssetRef.resourceId}` },
      });
  };
  const renamerFor = (access: Authorization) => {
    const options = { ...openActionRuntimeOptions, accessDecision: makeScriptedBoundAccessGate(access).bound };
    const runtime = makeActionRuntime(
      database,
      makeActionRepository(crypto),
      allowedPermission,
      testOperationalScopeResolver,
      options,
    );
    return (
      world: World,
      input: {
        readonly displayFilename: string;
        readonly idempotencyKey: string;
        readonly mediaAssetRef: ReturnType<typeof refOf>;
        readonly savedReply?: 'answer';
      },
      legalEntityId?: string,
    ) =>
      runtime.runAction({
        payload: { displayFilename: input.displayFilename, mediaAssetRef: input.mediaAssetRef },
        principal: principalOf(world, legalEntityId),
        registration: renameDisplayFilenameAction,
        savedReply: input.savedReply,
        transport: { correlationId: `media-rename-${input.idempotencyKey}`, idempotencyKey: input.idempotencyKey },
      });
  };
  const evidenceOf = (tenantId: string) =>
    admin.unsafe<EvidenceRow>(
      `select outcome, outcome_code, result_count, to_jsonb(event)::text as serialized from core.data_access_events event
       where tenant_id = $1 and evidence_policy_key = 'core.media.api.asset-metadata.access.v1'`,
      [tenantId],
    );
  return { admin, database, evidenceOf, readerFor, renamerFor };
});

it.layer(NodeCrypto.layer, { excludeTestServices: true })(
  'core media metadata read and rename on PostgreSQL',
  (suite) => {
    suite.effect(
      'reads a ready asset with its sealed size and digest, marked verified, and nothing of its storage',
      () =>
        Effect.gen(function* readyAsset() {
          const harness = yield* openHarness();
          const world = yield* makeWorld(harness.admin, harness.database.executor);
          const id = yield* seedAsset(world, { originalFilename: 'camera-001.jpg', status: 'ready' });
          const metadata = yield* harness.readerFor({ [METADATA]: 'allowed' })(world, refOf(world, id));
          expect(metadata).toEqual({
            byteSize: 4096,
            contentSha256: DIGEST,
            contentVerified: true,
            displayFilename: 'Brochure.pdf',
            ingestionSource: 'integration',
            mediaAssetRef: refOf(world, id),
            mimeType: 'application/pdf',
            originalFilename: 'camera-001.jpg',
            processingStatus: 'ready',
          });
          const serialized = textOf(metadata);
          for (const secret of [
            STORAGE_PROVIDER,
            SECRET_VERSION,
            deriveMediaStorageKey({ mediaAssetId: id, tenantId: world.tenantId }),
            'core-media/v1',
            'storage',
            'http',
          ]) {
            expect(serialized).not.toContain(secret);
          }
        }).pipe(Effect.scoped),
    );

    suite.effect('records one metadata-only evidence row per read, without the name, digest or any storage value', () =>
      Effect.gen(function* evidence() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const id = yield* seedAsset(world, { displayFilename: 'private-name.pdf', status: 'ready' });
        yield* harness.readerFor({ [METADATA]: 'allowed' })(world, refOf(world, id));
        const rows = yield* harness.evidenceOf(world.tenantId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ outcome: 'allowed', outcome_code: 'read_allowed', result_count: 1 });
        for (const secret of ['private-name', DIGEST, STORAGE_PROVIDER, SECRET_VERSION]) {
          expect(rows[0]?.serialized).not.toContain(secret);
        }
      }).pipe(Effect.scoped),
    );

    suite.effect('tells uploaded, scanning and failed from ready without presenting a claim as verified content', () =>
      Effect.gen(function* unfinished() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const read = harness.readerFor({ [METADATA]: 'allowed' });
        for (const status of ['uploaded', 'scanning', 'failed'] as const) {
          const id = yield* seedAsset(world, { status });
          const metadata = yield* read(world, refOf(world, id));
          expect(metadata.processingStatus).toBe(status);
          expect(metadata.contentVerified).toBe(false);
          expect(metadata).not.toHaveProperty('byteSize');
          expect(metadata).not.toHaveProperty('contentSha256');
          // The asset exists: an unfinished or failed state is neither absence nor a usable asset.
          expect(metadata.mediaAssetRef).toEqual(refOf(world, id));
          expect(metadata.displayFilename).toBe('Brochure.pdf');
        }
        // Sealed once, then proven corrupt: failed, and its old seal no longer counts as verified content.
        const corrupt = yield* seedAsset(world, { sealedAfterReady: true, status: 'failed' });
        const corruptMetadata = yield* read(world, refOf(world, corrupt));
        expect(corruptMetadata).toMatchObject({ contentVerified: false, processingStatus: 'failed' });
        expect(corruptMetadata).not.toHaveProperty('contentSha256');
      }).pipe(Effect.scoped),
    );

    suite.effect('shows two assets with one display name as two identities', () =>
      Effect.gen(function* twins() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const read = harness.readerFor({ [METADATA]: 'allowed' });
        const first = yield* seedAsset(world, { displayFilename: 'manual.pdf', status: 'ready' });
        const second = yield* seedAsset(world, { displayFilename: 'manual.pdf', status: 'ready' });
        const [one, two] = [yield* read(world, refOf(world, first)), yield* read(world, refOf(world, second))];
        expect(one.displayFilename).toBe(two.displayFilename);
        expect(one.mediaAssetRef.resourceId).not.toBe(two.mediaAssetRef.resourceId);
      }).pipe(Effect.scoped),
    );

    suite.effect('answers a foreign tenant and an unknown id the same way: not found, no leak', () =>
      Effect.gen(function* foreign() {
        const harness = yield* openHarness();
        const owner = yield* makeWorld(harness.admin, harness.database.executor);
        const stranger = yield* makeWorld(harness.admin, harness.database.executor);
        const id = yield* seedAsset(owner, { status: 'ready' });
        const read = harness.readerFor({ [METADATA]: 'allowed' });
        const viaForeignRef = yield* Effect.exit(read(stranger, refOf(owner, id)));
        const viaOwnIdInStranger = yield* Effect.exit(read(stranger, refOf(stranger, id)));
        const unknown = yield* Effect.exit(read(stranger, refOf(stranger, yield* nextUuid)));
        for (const exit of [viaForeignRef, viaOwnIdInStranger, unknown]) {
          expect(failureTagOf(exit)).toBe('ReadHandlerNotFound');
        }
        expect(failureOf(viaForeignRef)).toEqual(failureOf(unknown));
        expect(failureOf(viaOwnIdInStranger)).toEqual(failureOf(unknown));
        expect(textOf(failureOf(viaForeignRef))).not.toContain(id);
      }).pipe(Effect.scoped),
    );

    suite.effect(
      'narrows to the selected company: another company is not found, a company-less asset stays visible',
      () =>
        Effect.gen(function* companies() {
          const harness = yield* openHarness();
          const world = yield* makeWorld(harness.admin, harness.database.executor);
          const read = harness.readerFor({ [METADATA]: 'allowed' });
          const mine = yield* seedAsset(world, { legalEntityId: world.legalEntityId, status: 'ready' });
          const theirs = yield* seedAsset(world, { legalEntityId: world.otherLegalEntityId, status: 'ready' });
          const shared = yield* seedAsset(world, { status: 'ready' });
          expect((yield* read(world, refOf(world, mine), world.legalEntityId)).mediaAssetRef.resourceId).toBe(mine);
          expect((yield* read(world, refOf(world, shared), world.legalEntityId)).mediaAssetRef.resourceId).toBe(shared);
          expect(failureTagOf(yield* Effect.exit(read(world, refOf(world, theirs), world.legalEntityId)))).toBe(
            'ReadHandlerNotFound',
          );
          // Tenant-wide (no company selected) sees all three.
          expect((yield* read(world, refOf(world, theirs))).mediaAssetRef.resourceId).toBe(theirs);
        }).pipe(Effect.scoped),
    );

    suite.effect('fails closed on a denied, unavailable or foreign capability and never reuses an earlier allow', () =>
      Effect.gen(function* gated() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const id = yield* seedAsset(world, { status: 'ready' });
        const ref = refOf(world, id);
        const allowed = yield* harness.readerFor({ [METADATA]: 'allowed' })(world, ref);
        expect(allowed.processingStatus).toBe('ready');
        // The same asset, the same principal, a later request after the permission is gone: refused, nothing leaks.
        const denied = yield* Effect.exit(harness.readerFor({ [METADATA]: 'denied' })(world, ref));
        expect(failureTagOf(denied)).toBe('ReadPermissionDenied');
        const unavailable = yield* Effect.exit(harness.readerFor({ [METADATA]: 'unavailable' })(world, ref));
        expect(failureTagOf(unavailable)).toBe('ReadPermissionUnavailable');
        // The rename capability and the upload capabilities open nothing here.
        const wrongCapability = yield* Effect.exit(
          harness.readerFor({ 'core.media.asset.upload': 'allowed', [RENAME]: 'allowed' })(world, ref),
        );
        expect(failureTagOf(wrongCapability)).toBe('ReadPermissionDenied');
        for (const exit of [denied, unavailable, wrongCapability]) {
          expect(textOf(failureOf(exit))).not.toContain('Brochure');
        }
      }).pipe(Effect.scoped),
    );

    suite.effect(
      'renames only the display name in every processing status and leaves every other column untouched',
      () =>
        Effect.gen(function* rename() {
          const harness = yield* openHarness();
          const world = yield* makeWorld(harness.admin, harness.database.executor);
          const renameAs = harness.renamerFor({ [RENAME]: 'allowed' });
          for (const status of ['uploaded', 'scanning', 'failed', 'ready'] as const) {
            const id = yield* seedAsset(world, { originalFilename: 'camera-001.jpg', status });
            const before = yield* rowOf(world, id);
            const result = yield* renameAs(world, {
              displayFilename: `renamed-${status}.pdf`,
              idempotencyKey: `rename-${status}`,
              mediaAssetRef: refOf(world, id),
            });
            expect(result).toEqual({ displayFilename: `renamed-${status}.pdf`, mediaAssetRef: refOf(world, id) });
            const after = yield* rowOf(world, id);
            expect(after.display_filename).toBe(`renamed-${status}.pdf`);
            expect(withoutNameAndStamp(after)).toEqual(withoutNameAndStamp(before));
            expect(after.original_filename).toBe('camera-001.jpg');
          }
          // No second asset, no link, no outbox or event: the table holds exactly the four seeded rows.
          const count = yield* harness.admin.unsafe<{ count: string }>(
            `select count(*)::text as count from core.media_assets where tenant_id = $1`,
            [world.tenantId],
          );
          expect(Number(count[0]?.count)).toBe(4);
        }).pipe(Effect.scoped),
    );

    suite.effect('renames one of two same-named assets without touching the other and shows the new name on read', () =>
      Effect.gen(function* twinRename() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const first = yield* seedAsset(world, { displayFilename: 'manual.pdf', status: 'ready' });
        const second = yield* seedAsset(world, { displayFilename: 'manual.pdf', status: 'ready' });
        yield* harness.renamerFor({ [RENAME]: 'allowed' })(world, {
          displayFilename: 'manual-v2.pdf',
          idempotencyKey: 'twin',
          mediaAssetRef: refOf(world, first),
        });
        const read = harness.readerFor({ [METADATA]: 'allowed' });
        expect((yield* read(world, refOf(world, first))).displayFilename).toBe('manual-v2.pdf');
        expect((yield* read(world, refOf(world, second))).displayFilename).toBe('manual.pdf');
        // Renaming onto another asset's name is fine: a name is never identity.
        yield* harness.renamerFor({ [RENAME]: 'allowed' })(world, {
          displayFilename: 'manual.pdf',
          idempotencyKey: 'twin-back',
          mediaAssetRef: refOf(world, first),
        });
        expect((yield* read(world, refOf(world, first))).displayFilename).toBe('manual.pdf');
      }).pipe(Effect.scoped),
    );

    suite.effect('is idempotent through the Action invocation and refuses a changed request under the same key', () =>
      Effect.gen(function* idempotent() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const id = yield* seedAsset(world, { status: 'ready' });
        const renameAs = harness.renamerFor({ [RENAME]: 'allowed' });
        const input = { displayFilename: 'once.pdf', idempotencyKey: 'once', mediaAssetRef: refOf(world, id) };
        const first = yield* renameAs(world, input);
        const stamp = (yield* rowOf(world, id)).updated_at;
        // A transport retry that asks for the saved reply gets the same answer and runs no second update.
        const again = yield* renameAs(world, { ...input, savedReply: 'answer' });
        expect(again).toEqual(first);
        expect((yield* rowOf(world, id)).updated_at).toEqual(stamp);
        const changed = yield* Effect.exit(
          renameAs(world, { ...input, displayFilename: 'other.pdf', savedReply: 'answer' }),
        );
        expect(failureTagOf(changed)).toBe('ActionRequestHashConflict');
        expect((yield* rowOf(world, id)).display_filename).toBe('once.pdf');
        const invocations = yield* harness.admin.unsafe<{ status: string }>(
          `select status from core.action_invocations where tenant_id = $1 and idempotency_key = 'once'`,
          [world.tenantId],
        );
        expect(invocations).toHaveLength(1);
        expect(invocations[0]?.status).toBe('succeeded');
      }).pipe(Effect.scoped),
    );

    suite.effect('rejects an unsafe name before any write', () =>
      Effect.gen(function* unsafe() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const id = yield* seedAsset(world, { status: 'ready' });
        for (const [index, name] of ['', '   ', '../escape.pdf', 'bad\u0000name', 'rtl\u202Etxt.exe'].entries()) {
          const exit = yield* Effect.exit(
            harness.renamerFor({ [RENAME]: 'allowed' })(world, {
              displayFilename: name,
              idempotencyKey: `unsafe-${index}`,
              mediaAssetRef: refOf(world, id),
            }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
        }
        expect((yield* rowOf(world, id)).display_filename).toBe('Brochure.pdf');
      }).pipe(Effect.scoped),
    );

    suite.effect('refuses a denied, approval-gated or unavailable rename before the handler and changes nothing', () =>
      Effect.gen(function* refusedRename() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const id = yield* seedAsset(world, { status: 'ready' });
        const before = yield* rowOf(world, id);
        const attempt = (access: Authorization, key: string) =>
          Effect.exit(
            harness.renamerFor(access)(world, {
              displayFilename: 'x.pdf',
              idempotencyKey: key,
              mediaAssetRef: refOf(world, id),
            }),
          );
        const denied = yield* attempt({ [RENAME]: 'denied' }, 'denied');
        const approval = yield* attempt({ [RENAME]: 'needs_approval' }, 'approval');
        const unavailable = yield* attempt({ [RENAME]: 'unavailable' }, 'unavailable');
        // Holding the metadata capability alone is not the right to rename.
        const metadataOnly = yield* attempt({ [METADATA]: 'allowed' }, 'metadata-only');
        expect(failureTagOf(denied)).toBe('ActionPermissionDenied');
        expect(failureTagOf(metadataOnly)).toBe('ActionPermissionDenied');
        expect(failureTagOf(approval)).toBe('ActionPermissionDenied');
        expect(failureOf(approval)).toMatchObject({ code: 'action_approval_required' });
        expect(failureTagOf(unavailable)).toBe('ActionPermissionCheckError');
        expect(yield* rowOf(world, id)).toEqual(before);
      }).pipe(Effect.scoped),
    );

    suite.effect('keeps tenant B from renaming or observing an asset of tenant A', () =>
      Effect.gen(function* tenants() {
        const harness = yield* openHarness();
        const worldA = yield* makeWorld(harness.admin, harness.database.executor);
        const worldB = yield* makeWorld(harness.admin, harness.database.executor);
        const id = yield* seedAsset(worldA, { status: 'ready' });
        const before = yield* rowOf(worldA, id);
        const renameAs = harness.renamerFor({ [RENAME]: 'allowed' });
        const viaForeignRef = yield* Effect.exit(
          renameAs(worldB, { displayFilename: 'stolen.pdf', idempotencyKey: 'b-a', mediaAssetRef: refOf(worldA, id) }),
        );
        const viaOwnRef = yield* Effect.exit(
          renameAs(worldB, {
            displayFilename: 'stolen.pdf',
            idempotencyKey: 'b-a-id',
            mediaAssetRef: refOf(worldB, id),
          }),
        );
        expect(failureTagOf(viaForeignRef)).toBe('MediaAssetNotFound');
        expect(failureTagOf(viaOwnRef)).toBe('MediaAssetNotFound');
        expect(yield* rowOf(worldA, id)).toEqual(before);
      }).pipe(Effect.scoped),
    );

    suite.effect('lands the last of two racing renames whole, never a mix, and keeps the rest of the row', () =>
      Effect.gen(function* racing() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const id = yield* seedAsset(world, { status: 'uploaded' });
        const before = yield* rowOf(world, id);
        const renameAs = harness.renamerFor({ [RENAME]: 'allowed' });
        const names = ['alpha.pdf', 'beta.pdf', 'gamma.pdf', 'delta.pdf'];
        yield* Effect.all(
          names.map((displayFilename) =>
            renameAs(world, {
              displayFilename,
              idempotencyKey: `race-${displayFilename}`,
              mediaAssetRef: refOf(world, id),
            }),
          ),
          { concurrency: 'unbounded' },
        );
        const after = yield* rowOf(world, id);
        expect(names).toContain(after.display_filename);
        expect(withoutNameAndStamp(after)).toEqual(withoutNameAndStamp(before));
      }).pipe(Effect.scoped),
    );

    suite.effect(
      'renames only inside the selected company: another company is not found, a company-less asset is renamable',
      () =>
        Effect.gen(function* renameCompanies() {
          const harness = yield* openHarness();
          const world = yield* makeWorld(harness.admin, harness.database.executor);
          const renameAs = harness.renamerFor({ [RENAME]: 'allowed' });
          const theirs = yield* seedAsset(world, { legalEntityId: world.otherLegalEntityId, status: 'ready' });
          const shared = yield* seedAsset(world, { status: 'ready' });
          const before = yield* rowOf(world, theirs);
          const refused = yield* Effect.exit(
            renameAs(
              world,
              { displayFilename: 'other.pdf', idempotencyKey: 'company-theirs', mediaAssetRef: refOf(world, theirs) },
              world.legalEntityId,
            ),
          );
          expect(failureTagOf(refused)).toBe('MediaAssetNotFound');
          expect(yield* rowOf(world, theirs)).toEqual(before);
          yield* renameAs(
            world,
            { displayFilename: 'shared.pdf', idempotencyKey: 'company-shared', mediaAssetRef: refOf(world, shared) },
            world.legalEntityId,
          );
          expect((yield* rowOf(world, shared)).display_filename).toBe('shared.pdf');
        }).pipe(Effect.scoped),
    );

    suite.effect('does not disturb a status change racing the rename: both land', () =>
      Effect.gen(function* racingStatus() {
        const harness = yield* openHarness();
        const world = yield* makeWorld(harness.admin, harness.database.executor);
        const id = yield* seedAsset(world, { status: 'uploaded' });
        const renameAs = harness.renamerFor({ [RENAME]: 'allowed' });
        const seal = world.admin.unsafe(
          `update core.media_assets set processing_status = 'ready', sealed_at = now() where tenant_id = $1 and media_asset_id = $2`,
          [world.tenantId, id],
        );
        yield* Effect.all(
          [
            seal,
            renameAs(world, {
              displayFilename: 'sealed.pdf',
              idempotencyKey: 'race-seal',
              mediaAssetRef: refOf(world, id),
            }),
          ],
          { concurrency: 'unbounded' },
        );
        const after = yield* rowOf(world, id);
        expect(after).toMatchObject({ display_filename: 'sealed.pdf', processing_status: 'ready' });
      }).pipe(Effect.scoped),
    );
  },
);
