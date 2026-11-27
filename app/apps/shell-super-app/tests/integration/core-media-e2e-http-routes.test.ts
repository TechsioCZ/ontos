import { Effect, Schema, Stream } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeShellAuthenticationApiRuntime } from '../../api/index.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { MediaAssetRefSchema } from '../../../../packages/core-runtime/src/resources/media-asset.ts';
import { deriveMediaStorageKey } from '../../../../packages/core-runtime/src/media/storage-key.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { templateDatabaseLayer } from '../support/access-admin-real-gate-fixture.ts';
import { MEDIA_CAPABILITIES, withMediaE2eWorld } from '../support/core-media-e2e-fixture.ts';
import type { E2eActor, MediaE2eWorld } from '../support/core-media-e2e-fixture.ts';
import {
  bytesOf,
  confirmOverHttp,
  digestOf,
  downloadOf,
  metadataOf,
  patternBytes,
  putBytes,
  refOf,
  rowOf,
  rowsOf,
  renameOverHttp,
  reserveOverHttp,
  textOf,
} from '../support/core-media-e2e-steps.ts';

/*
 * EVIDENCE: INTEGRATION EXECUTED on the real composition (#1446, the client route of #1430/#1433): the whole flow
 * runs through REAL HTTP routes of the production Shell, with no in-process Action run. A client reserves
 * (`POST /core/actions/upload-asset`), learns the asset id from the answer, sends the bytes to the existing edge
 * (`PUT /core/media/assets/:id/bytes`), confirms (`POST /core/actions/confirm-asset`), reads the metadata, renames
 * (`POST /core/actions/rename-display-filename`) and downloads. Every route requires the Idempotency-Key header, as the
 * other Shell operations do.
 *
 * Authentication is the one substitute (a header names the seeded principal); every authorization answer is
 * SpiceDB's. Object store: the real S3 adapter on an S3-compatible EMULATOR (MinIO), NOT R2. The `object stored out of
 * band` steps write the emulator directly, standing for a client whose PUT answer was lost after the write. No
 * product code enters `scanning` (no scanner exists), so that one status is written to the row directly.
 */

const platform = {
  makeActionRepository,
  makeActionRuntime,
  makeCompositionSnapshot,
  makeReadRuntime,
  makeShellAuthenticationApiRuntime,
};

const uploaderCapabilities = [MEDIA_CAPABILITIES.upload, MEDIA_CAPABILITIES.confirm];
const readerCapabilities = [MEDIA_CAPABILITIES.metadata, MEDIA_CAPABILITIES.download];
const MEDIA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const person = (world: MediaE2eWorld, name: string): E2eActor => {
  const actor = world.people.get(name);
  if (actor === undefined) {
    throw new Error(`The world has no ${name}`);
  }
  return actor;
};

/** What a reservation answers: the reference whose id the client sends its bytes to. */
const ReservationAnswerSchema = Schema.Struct({
  mediaAssetRef: MediaAssetRefSchema,
  processingStatus: Schema.Literal('uploaded'),
});
const reservationOf = (answer: { readonly json: typeof Schema.Json.Type }) =>
  Schema.decodeUnknownSync(ReservationAnswerSchema)(answer.json);
const assetIdOf = (answer: { readonly json: typeof Schema.Json.Type }): string =>
  reservationOf(answer).mediaAssetRef.resourceId;

/** The object a client's PUT would have stored, written straight to the provider (the answer was lost after it). */
const storeObjectOutOfBand = (world: MediaE2eWorld, mediaAssetId: string, bytes: Uint8Array) =>
  world.storage
    .put({
      body: Stream.make(bytes),
      contentType: 'application/pdf',
      key: deriveMediaStorageKey({ mediaAssetId, tenantId: world.tenantId }),
    })
    .pipe(Effect.orDie);

it.layer(templateDatabaseLayer, { excludeTestServices: true, timeout: '600 seconds' })(
  'Core Media end to end over the real HTTP routes: reserve, bytes, confirm, metadata, rename, download',
  (suite) => {
    suite.effect(
      'a client runs the whole flow through the routes; the reserve answer carries the asset id the bytes are sent to',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* wholeFlow() {
              const uploader = person(world, 'uploader');
              const reader = person(world, 'downloader');
              const owner = person(world, 'owner');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(reader, readerCapabilities);
              const edge = yield* world.shell;
              const bytes = patternBytes(70_001);

              // RESERVE over HTTP: the invocation id is the asset id, and the client learns it from the answer.
              const reserved = yield* reserveOverHttp(edge, uploader, bytes, {
                displayFilename: 'Brochure.pdf',
                idempotencyKey: 'flow-reserve',
                originalFilename: 'Brochure.pdf',
              });
              expect(reserved.status).toBe(200);
              const id = assetIdOf(reserved);
              expect(id).toMatch(MEDIA_ID_PATTERN);
              expect(reserved.json).toEqual({
                mediaAssetRef: {
                  moduleId: 'core.media',
                  resourceId: id,
                  resourceType: 'core.media.asset',
                  tenantId: world.tenantId,
                },
                processingStatus: 'uploaded',
              });
              expect((yield* rowOf(world, id))?.processing_status).toBe('uploaded');
              expect((yield* metadataOf(edge, reader, id)).json).toMatchObject({
                contentVerified: false,
                processingStatus: 'uploaded',
              });
              expect((yield* downloadOf(edge, reader, id)).status).toBe(409);

              // BYTES to the existing edge, at the id the answer named.
              const put = yield* putBytes(edge, uploader, id, bytes);
              expect(put.status).toBe(200);
              expect(JSON.parse(textOf(put.bytes))).toMatchObject({
                byteSize: bytes.byteLength,
                contentSha256: digestOf(bytes),
                processingStatus: 'ready',
              });

              // CONFIRM over HTTP: a sealed asset is answered from its row, with the same sealed identity.
              const confirmed = yield* confirmOverHttp(edge, uploader, id, 'flow-confirm');
              expect(confirmed.status).toBe(200);
              expect(confirmed.json).toEqual({
                byteSize: bytes.byteLength,
                contentSha256: digestOf(bytes),
                mediaAssetRef: reservationOf(reserved).mediaAssetRef,
                processingStatus: 'ready',
              });

              // METADATA read, then RENAME over HTTP by the owner, then the metadata again.
              expect((yield* metadataOf(edge, reader, id)).json).toMatchObject({
                contentVerified: true,
                displayFilename: 'Brochure.pdf',
                processingStatus: 'ready',
              });
              const renamed = yield* renameOverHttp(edge, owner, id, 'Renamed.pdf', 'flow-rename');
              expect(renamed.status).toBe(200);
              expect(renamed.json).toMatchObject({ displayFilename: 'Renamed.pdf' });
              expect((yield* metadataOf(edge, reader, id)).json).toMatchObject({
                byteSize: bytes.byteLength,
                contentSha256: digestOf(bytes),
                displayFilename: 'Renamed.pdf',
                originalFilename: 'Brochure.pdf',
                processingStatus: 'ready',
              });

              // DOWNLOAD: the very bytes that were sent.
              const download = yield* downloadOf(edge, reader, id);
              expect(download.status).toBe(200);
              expect(download.bytes).toEqual(bytes);
              expect(yield* rowsOf(world)).toHaveLength(1);
            }),
          ),
        ),
    );

    suite.effect(
      'the routes carry the idempotent-invocation semantics of the other Shell operations: key required, same key answers the saved reply, another request is a conflict, no capability is 403',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* idempotentRoutes() {
              const uploader = person(world, 'uploader');
              const nobody = person(world, 'outsider');
              const owner = person(world, 'owner');
              yield* world.grant(uploader, uploaderCapabilities);
              const edge = yield* world.shell;
              const bytes = bytesOf('one reservation per key');

              // No Idempotency-Key header is a 428 and creates nothing.
              expect((yield* reserveOverHttp(edge, uploader, bytes, { idempotencyKey: null })).status).toBe(428);
              expect(yield* rowsOf(world)).toHaveLength(0);

              const first = yield* reserveOverHttp(edge, uploader, bytes, { idempotencyKey: 'once' });
              expect(first.status).toBe(200);
              const id = assetIdOf(first);
              // The same key again is the same answer, from the saved reply: one asset, not two.
              const replay = yield* reserveOverHttp(edge, uploader, bytes, { idempotencyKey: 'once' });
              expect(replay.status).toBe(200);
              expect(replay.json).toEqual(first.json);
              expect(assetIdOf(replay)).toBe(id);
              expect(yield* rowsOf(world)).toHaveLength(1);
              // The same key for another request is a conflict, never a silent swap of the payload.
              const other = yield* reserveOverHttp(edge, uploader, bytesOf('another file'), { idempotencyKey: 'once' });
              expect(other.status).toBe(409);
              expect(yield* rowsOf(world)).toHaveLength(1);
              // A new key is an independent upload: a second asset.
              const second = yield* reserveOverHttp(edge, uploader, bytes, { idempotencyKey: 'twice' });
              expect(second.status).toBe(200);
              expect(assetIdOf(second)).not.toBe(id);
              expect(yield* rowsOf(world)).toHaveLength(2);

              // Without the capability the engine refuses, and nothing is created.
              expect((yield* reserveOverHttp(edge, nobody, bytes, { idempotencyKey: 'denied' })).status).toBe(403);
              expect(yield* rowsOf(world)).toHaveLength(2);
              // One byte more than 10,000 parts of 5 GiB: the store can never write it, so nothing is reserved.
              const tooLarge = yield* reserveOverHttp(edge, uploader, bytes, {
                declaredByteSize: 10_000 * 5 * 1024 ** 3 + 1,
                idempotencyKey: 'too-large',
              });
              expect(tooLarge.status).toBe(422);
              expect(yield* rowsOf(world)).toHaveLength(2);
              // A rename needs its own key and its own capability, which the uploader does not hold.
              expect((yield* renameOverHttp(edge, owner, id, 'Named.pdf', null)).status).toBe(428);
              expect((yield* renameOverHttp(edge, uploader, id, 'Named.pdf', 'rename-denied')).status).toBe(403);
              expect((yield* renameOverHttp(edge, owner, id, 'Named.pdf', 'rename-ok')).status).toBe(200);
              expect((yield* renameOverHttp(edge, owner, id, 'Named.pdf', 'rename-ok')).status).toBe(200);
              expect((yield* renameOverHttp(edge, owner, id, 'Other.pdf', 'rename-ok')).status).toBe(409);
              // A rename of an asset this tenant does not have is the unknown-id answer.
              expect(
                (yield* renameOverHttp(edge, owner, '00000000-0000-4000-8000-0000000000ff', 'X.pdf', 'rename-missing'))
                  .status,
              ).toBe(404);
            }),
          ),
        ),
    );

    suite.effect(
      'the confirm route settles a stored object the client never saw confirmed, and refuses everything it cannot prove',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* confirmRecovery() {
              const uploader = person(world, 'uploader');
              const reader = person(world, 'downloader');
              const stranger = person(world, 'metadataOnly');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(reader, readerCapabilities);
              yield* world.grant(stranger, uploaderCapabilities);
              const edge = yield* world.shell;
              const bytes = patternBytes(4099);
              const id = assetIdOf(yield* reserveOverHttp(edge, uploader, bytes, { idempotencyKey: 'recover' }));

              // Nothing stored yet: uncertain, never a success, and the asset stays recoverable.
              const early = yield* confirmOverHttp(edge, uploader, id, 'confirm-early');
              expect(early.status).toBe(503);
              expect(textOf(early.bytes)).not.toMatch(/ready|contentSha256|storage|s3:/u);
              expect((yield* rowOf(world, id))?.processing_status).toBe('uploaded');

              // The bytes were stored but the client's answer was lost: another principal does not find the asset,
              // even with the confirm capability, and causes no read-back.
              yield* storeObjectOutOfBand(world, id, bytes);
              expect((yield* confirmOverHttp(edge, stranger, id, 'confirm-stranger')).status).toBe(404);
              expect((yield* rowOf(world, id))?.processing_status).toBe('uploaded');

              // The reserving principal settles it: ready, with the identity of the stored bytes.
              const settled = yield* confirmOverHttp(edge, uploader, id, 'confirm-settle');
              expect(settled.status).toBe(200);
              expect(settled.json).toMatchObject({
                byteSize: bytes.byteLength,
                contentSha256: digestOf(bytes),
                processingStatus: 'ready',
              });
              expect((yield* rowOf(world, id))?.processing_status).toBe('ready');
              expect((yield* downloadOf(edge, reader, id)).bytes).toEqual(bytes);
              // The same key answers the saved reply; a new key answers from the sealed row.
              expect((yield* confirmOverHttp(edge, uploader, id, 'confirm-settle')).json).toEqual(settled.json);
              expect((yield* confirmOverHttp(edge, uploader, id, 'confirm-again')).json).toEqual(settled.json);
              expect((yield* confirmOverHttp(edge, uploader, id, null)).status).toBe(428);
              expect(yield* rowsOf(world)).toHaveLength(1);
            }),
          ),
        ),
    );

    suite.effect(
      'the confirm route proves bytes that are not the declared content as an integrity failure and closes only that asset; without the confirm capability the Action refuses',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* confirmMismatch() {
              const uploader = person(world, 'uploader');
              const reserver = person(world, 'currentOnly');
              yield* world.grant(uploader, uploaderCapabilities);
              // May reserve, may not confirm: the host reads the object back, the Action still decides.
              yield* world.grant(reserver, [MEDIA_CAPABILITIES.upload]);
              const edge = yield* world.shell;
              const bytes = patternBytes(2048);
              const wrong = patternBytes(2049);

              const refused = assetIdOf(
                yield* reserveOverHttp(edge, reserver, bytes, { idempotencyKey: 'no-confirm' }),
              );
              yield* storeObjectOutOfBand(world, refused, bytes);
              expect((yield* confirmOverHttp(edge, reserver, refused, 'confirm-denied')).status).toBe(403);
              expect((yield* rowOf(world, refused))?.processing_status).toBe('uploaded');

              const id = assetIdOf(yield* reserveOverHttp(edge, uploader, bytes, { idempotencyKey: 'mismatch' }));
              yield* storeObjectOutOfBand(world, id, wrong);
              const failed = yield* confirmOverHttp(edge, uploader, id, 'confirm-wrong');
              expect(failed.status).toBe(422);
              expect(textOf(failed.bytes)).not.toMatch(/contentSha256|storage|s3:/u);
              expect((yield* rowOf(world, id))?.processing_status).toBe('failed');
              // A failed asset stays failed and never becomes usable; the other reservation is untouched.
              expect((yield* confirmOverHttp(edge, uploader, id, 'confirm-wrong-again')).status).toBe(422);
              expect((yield* rowOf(world, id))?.processing_status).toBe('failed');
              expect((yield* rowOf(world, refused))?.processing_status).toBe('uploaded');
            }),
          ),
        ),
    );

    suite.effect(
      'the confirm Action decides for a sealed or failed asset too: a revoked confirm grant is refused, and a foreign tenant in the reference is not found',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* confirmDecidedByTheAction() {
              const uploader = person(world, 'uploader');
              yield* world.grant(uploader, [MEDIA_CAPABILITIES.upload]);
              const confirmGrant = yield* world.grant(uploader, [MEDIA_CAPABILITIES.confirm]);
              const edge = yield* world.shell;
              const bytes = patternBytes(1024);
              const sealed = assetIdOf(yield* reserveOverHttp(edge, uploader, bytes, { idempotencyKey: 'seal' }));
              expect((yield* putBytes(edge, uploader, sealed, bytes)).status).toBe(200);
              const closed = assetIdOf(yield* reserveOverHttp(edge, uploader, bytes, { idempotencyKey: 'close' }));
              yield* storeObjectOutOfBand(world, closed, patternBytes(1025));
              expect((yield* confirmOverHttp(edge, uploader, closed, 'close-confirm')).status).toBe(422);
              const settled = yield* confirmOverHttp(edge, uploader, sealed, 'seal-confirm');
              expect(settled.status).toBe(200);
              // While the grant stands the same key is answered with the saved reply: the control for the refusal below.
              const replayed = yield* confirmOverHttp(edge, uploader, sealed, 'seal-confirm');
              expect(replayed.status).toBe(200);
              expect(replayed.json).toEqual(settled.json);

              // A foreign tenant named in the reference is "not found" before any read-back, whatever the asset's state.
              const foreignTenant = '00000000-0000-4000-8000-0000000000aa';
              expect((yield* confirmOverHttp(edge, uploader, sealed, 'foreign', foreignTenant)).status).toBe(404);

              // The capability goes away: a sealed asset is no longer answered from its row, and neither is a failed one.
              yield* world.revoke(confirmGrant.incarnationId);
              expect((yield* confirmOverHttp(edge, uploader, sealed, 'seal-confirm-new')).status).toBe(403);
              expect((yield* confirmOverHttp(edge, uploader, closed, 'close-confirm-new')).status).toBe(403);
              // Nor is the saved reply of the earlier key handed to a caller who may no longer confirm. Core refuses a
              // replay as an already committed invocation: the policy conflict, with no sealed identity in it.
              const refusedReplay = yield* confirmOverHttp(edge, uploader, sealed, 'seal-confirm');
              expect(refusedReplay.status).toBe(409);
              expect(JSON.parse(textOf(refusedReplay.bytes))).toMatchObject({
                status: 409,
                type: 'https://ontos.dev/problems/policy-conflict',
              });
              expect(textOf(refusedReplay.bytes)).not.toMatch(/contentSha256|byteSize|mediaAssetRef/u);
              expect((yield* rowOf(world, sealed))?.processing_status).toBe('ready');
              expect((yield* rowOf(world, closed))?.processing_status).toBe('failed');
            }),
          ),
        ),
    );

    suite.effect(
      'a scanning asset passes the real metadata gate as unverified content: only a metadata holder reads it, and it is neither downloadable nor confirmable',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* scanningMetadata() {
              const uploader = person(world, 'uploader');
              const reader = person(world, 'downloader');
              const outsider = person(world, 'outsider');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(reader, readerCapabilities);
              const edge = yield* world.shell;
              const bytes = patternBytes(512);
              const id = assetIdOf(yield* reserveOverHttp(edge, uploader, bytes, { idempotencyKey: 'scanning' }));
              yield* storeObjectOutOfBand(world, id, bytes);
              yield* world.admin
                .unsafe(
                  `update core.media_assets set processing_status = 'scanning' where tenant_id = $1 and media_asset_id = $2`,
                  [world.tenantId, id],
                )
                .pipe(Effect.orDie);

              const metadata = yield* metadataOf(edge, reader, id);
              expect(metadata.status).toBe(200);
              // Exactly these fields: no size and no digest, because nothing has been proven about the content.
              expect(metadata.json).toEqual({
                contentVerified: false,
                displayFilename: 'Brochure.pdf',
                ingestionSource: 'user',
                mediaAssetRef: refOf(world.tenantId, id),
                mimeType: 'application/pdf',
                processingStatus: 'scanning',
              });
              // The engine decides: uploading the file gives no right to read about it, and neither does nothing.
              expect((yield* metadataOf(edge, uploader, id)).status).toBe(403);
              expect((yield* metadataOf(edge, outsider, id)).status).toBe(403);

              // Not usable: no bytes leave, and a confirm with the right bytes stored is unavailable, never success.
              expect((yield* downloadOf(edge, reader, id)).status).toBe(409);
              expect((yield* confirmOverHttp(edge, uploader, id, 'confirm-scanning')).status).toBe(503);
              expect(yield* rowOf(world, id)).toMatchObject({ processing_status: 'scanning', sealed_at: null });
            }),
          ),
        ),
    );
  },
);
