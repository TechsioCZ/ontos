import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { Effect, Stream } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeShellAuthenticationApiRuntime } from '../../api/index.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { templateDatabaseLayer } from '../support/access-admin-real-gate-fixture.ts';
import { MEDIA_CAPABILITIES, withMediaE2eWorld } from '../support/core-media-e2e-fixture.ts';
import type { E2eActor, MediaE2eWorld } from '../support/core-media-e2e-fixture.ts';
import {
  bytesOf,
  digestOf,
  downloadOf,
  failureCodeOf,
  failureTagOf,
  metadataOf,
  patternBytes,
  putBytes,
  requireFaultInjection,
  reserve,
  reservationPayload,
  rowOf,
  rowsOf,
  textOf,
} from '../support/core-media-e2e-steps.ts';
import { deriveMediaStorageKey } from '../../../../packages/core-runtime/src/media/storage-key.ts';

/*
 * EVIDENCE: INTEGRATION EXECUTED on the real composition (#1446, rows 1-3 of the #1428 minimal acceptance).
 *
 *  - Shell: the production BFF runtime on a real loopback HTTP server (`PUT .../bytes`, `GET .../content`, the metadata
 *    read). The signed-in person is a header-named seeded principal (the one authentication substitute).
 *  - Core: the governed Action runtime over the same PostgreSQL and the real access gate (reserve).
 *  - PostgreSQL: a database cloned per case. SpiceDB: the integration engine, grants made by the real stage install
 *    and the real people commands. Object store: the real S3 adapter on an S3-compatible EMULATOR (MinIO), NOT R2.
 * Faults here are CONTROLLED FAULT INJECTION (the proxy in core-runtime tests/support); everything else is live.
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

const person = (world: MediaE2eWorld, name: string): E2eActor => {
  const actor = world.people.get(name);
  if (actor === undefined) {
    throw new Error(`The world has no ${name}`);
  }
  return actor;
};

const storedBytes = (world: MediaE2eWorld, mediaAssetId: string) =>
  Effect.gen(function* storedBytesEffect() {
    const object = yield* world.storage.get(deriveMediaStorageKey({ mediaAssetId, tenantId: world.tenantId }));
    const chunks = yield* Stream.runCollect(object.body);
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return joined;
  }).pipe(Effect.orDie);

const identityOf = (response: { readonly json: unknown; readonly status: number }) => response.json;

it.layer(templateDatabaseLayer, { excludeTestServices: true, timeout: '600 seconds' })(
  'Core Media end to end: stored bytes, identity and retry (rows 1-3)',
  (suite) => {
    suite.effect(
      'row 2: an authorized download returns the very bytes that were stored, and the documented size and SHA-256',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* happyPath() {
              const uploader = person(world, 'uploader');
              const reader = person(world, 'downloader');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(reader, readerCapabilities);
              const edge = yield* world.shell;
              // Several chunks and not a multiple of any block size, so a truncated or shifted stream cannot match.
              const bytes = patternBytes(1_572_869);

              const reservation = yield* reserve(world, uploader, bytes, { idempotencyKey: 'happy-1' });
              const id = reservation.mediaAssetRef.resourceId;
              expect(reservation.processingStatus).toBe('uploaded');
              // A reservation is not a success: the row exists, nothing is usable yet.
              expect((yield* rowOf(world, id))?.processing_status).toBe('uploaded');
              expect((yield* metadataOf(edge, reader, id)).json).toMatchObject({
                contentVerified: false,
                processingStatus: 'uploaded',
              });
              expect((yield* downloadOf(edge, reader, id)).status).toBe(409);

              const put = yield* putBytes(edge, uploader, id, bytes);
              expect(put.status).toBe(200);
              expect(JSON.parse(textOf(put.bytes))).toEqual({
                byteSize: bytes.byteLength,
                contentSha256: digestOf(bytes),
                mediaAssetRef: reservation.mediaAssetRef,
                processingStatus: 'ready',
              });

              // A different authorized client reads the verified metadata and downloads the same bytes.
              const metadata = yield* metadataOf(edge, reader, id);
              expect(metadata.status).toBe(200);
              expect(metadata.json).toMatchObject({
                byteSize: bytes.byteLength,
                contentSha256: digestOf(bytes),
                contentVerified: true,
                displayFilename: 'Brochure.pdf',
                processingStatus: 'ready',
              });
              // No storage internal is ever public: no provider, key, version reference, credential or URL.
              expect(textOf(metadata.bytes)).not.toMatch(/storage|provider|s3:|core-media\/v1|credential|http/iu);
              const download = yield* downloadOf(edge, reader, id);
              expect(download.status).toBe(200);
              expect(download.bytes.byteLength).toBe(bytes.byteLength);
              expect(digestOf(download.bytes)).toBe(digestOf(bytes));
              expect(download.bytes).toEqual(bytes);
              expect(download.headers.get('cache-control')).toContain('no-store');
              // The bytes come from the governed route itself: no redirect, no provider header, no reusable address.
              for (const name of ['location', 'etag', 'x-amz-request-id', 'x-amz-version-id', 'server']) {
                expect(download.headers.get(name), name).toBeNull();
              }
              // The object the provider holds is the same bytes (observed straight at the emulator).
              expect(digestOf(yield* storedBytes(world, id))).toBe(digestOf(bytes));
              const row = yield* rowOf(world, id);
              expect(row).toMatchObject({
                byte_size: String(bytes.byteLength),
                content_sha256: digestOf(bytes),
                processing_status: 'ready',
              });
            }),
          ),
        ),
    );

    suite.effect(
      'row 1: two files with the same name and the same bytes are two assets and nothing merges by name',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* sameName() {
              const uploader = person(world, 'uploader');
              const reader = person(world, 'downloader');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(reader, readerCapabilities);
              const edge = yield* world.shell;
              const bytes = bytesOf('photo bytes');

              const first = yield* reserve(world, uploader, bytes, {
                displayFilename: 'photo.png',
                idempotencyKey: 'same-name-a',
                originalFilename: 'photo.png',
              });
              const a = first.mediaAssetRef.resourceId;
              expect((yield* putBytes(edge, uploader, a, bytes)).status).toBe(200);
              const before = yield* metadataOf(edge, reader, a);

              // An independent upload of the same name and the same bytes is a new asset, whatever the hash says.
              const second = yield* reserve(world, uploader, bytes, {
                displayFilename: 'photo.png',
                idempotencyKey: 'same-name-b',
                originalFilename: 'photo.png',
              });
              const b = second.mediaAssetRef.resourceId;
              expect(b).not.toBe(a);
              expect((yield* putBytes(edge, uploader, b, bytes)).status).toBe(200);

              expect((yield* rowsOf(world)).map((row) => row.media_asset_id).toSorted()).toEqual([a, b].toSorted());
              const rows = yield* rowsOf(world);
              expect(new Set(rows.map((row) => row.storage_key)).size).toBe(2);
              // A is untouched by B: the same metadata and the same bytes.
              expect(identityOf(yield* metadataOf(edge, reader, a))).toEqual(identityOf(before));
              expect((yield* downloadOf(edge, reader, a)).bytes).toEqual(bytes);
              expect((yield* downloadOf(edge, reader, b)).bytes).toEqual(bytes);
            }),
          ),
        ),
    );

    suite.effect(
      'row 3: repeating the same attempt does not double the effect; a conflicting repeat and a replayed byte hop are refused',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* retry() {
              const uploader = person(world, 'uploader');
              const reader = person(world, 'downloader');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(reader, readerCapabilities);
              const edge = yield* world.shell;
              const bytes = bytesOf('retried once');

              const first = yield* reserve(world, uploader, bytes, { idempotencyKey: 'retry-1' });
              const id = first.mediaAssetRef.resourceId;
              // The same operation again: not a second asset (the governed runtime answers the committed one).
              expect(yield* failureCodeOf(reserve(world, uploader, bytes, { idempotencyKey: 'retry-1' }))).toBe(
                'action_already_committed',
              );
              expect(yield* rowsOf(world)).toHaveLength(1);
              // The same key with another request is a conflict, never a silent swap of the payload.
              expect(
                yield* failureTagOf(reserve(world, uploader, bytesOf('another file'), { idempotencyKey: 'retry-1' })),
              ).toBe('ActionRequestHashConflict');
              expect(yield* rowsOf(world)).toHaveLength(1);

              expect((yield* putBytes(edge, uploader, id, bytes)).status).toBe(200);
              const sealedAt = (yield* rowOf(world, id))?.sealed_at;
              expect(sealedAt).not.toBeNull();
              // The same PUT again after success: the same identity, no second confirmation, nothing rewritten.
              const replay = yield* putBytes(edge, uploader, id, bytes);
              expect(replay.status).toBe(200);
              expect(JSON.parse(textOf(replay.bytes))).toMatchObject({
                byteSize: bytes.byteLength,
                contentSha256: digestOf(bytes),
                processingStatus: 'ready',
              });
              expect((yield* rowOf(world, id))?.sealed_at).toEqual(sealedAt);
              expect(yield* rowsOf(world)).toHaveLength(1);
              // Other bytes for the already confirmed asset are a conflict, and the asset keeps its own.
              const other = yield* putBytes(edge, uploader, id, bytesOf('not the same!'));
              expect(other.status).toBe(409);
              expect((yield* downloadOf(edge, reader, id)).bytes).toEqual(bytes);
              expect(reservationPayload(bytes).declaredContentSha256).toBe((yield* rowOf(world, id))?.content_sha256);
            }),
          ),
        ),
    );

    suite.effect(
      'row 3: when the provider answer is lost after the write, the edge reads the stored bytes back and completes the one asset as the original intent (CONTROLLED FAULT INJECTION)',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* reconciled() {
              const uploader = person(world, 'uploader');
              const reader = person(world, 'downloader');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(reader, readerCapabilities);
              const proxy = (yield* requireFaultInjection(ctx, world)).faults;
              const edge = yield* world.shell;
              const bytes = patternBytes(70_001);
              const id = (yield* reserve(world, uploader, bytes, { idempotencyKey: 'lost-answer-1' })).mediaAssetRef
                .resourceId;

              // The provider commits the object but its answer never reaches Core.
              proxy.setRules([{ fault: { kind: 'drop-answer-after-commit' }, method: 'PUT' }]);
              const answered = yield* putBytes(edge, uploader, id, bytes);
              expect(proxy.injected().map(({ fault }) => fault)).toContain('drop-answer-after-commit');
              proxy.setRules([]);
              // Success only because the stored bytes were read back and proved to be the declared ones: one asset.
              expect(answered.status).toBe(200);
              expect(yield* rowsOf(world)).toHaveLength(1);
              expect((yield* rowOf(world, id))?.processing_status).toBe('ready');
              expect((yield* downloadOf(edge, reader, id)).bytes).toEqual(bytes);
            }),
          ),
        ),
    );

    suite.effect(
      'row 3: an outcome that stays uncertain is never reported as success, and the retry of the same attempt completes the one asset (CONTROLLED FAULT INJECTION: answer lost and read-back unreachable)',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* uncertain() {
              const uploader = person(world, 'uploader');
              const reader = person(world, 'downloader');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(reader, readerCapabilities);
              const proxy = (yield* requireFaultInjection(ctx, world)).faults;
              const edge = yield* world.shell;
              const bytes = patternBytes(70_001);
              const id = (yield* reserve(world, uploader, bytes, { idempotencyKey: 'uncertain-1' })).mediaAssetRef
                .resourceId;

              // The provider commits the object, its answer is lost, and the provider cannot be asked afterwards.
              proxy.setRules([
                { fault: { kind: 'drop-answer-after-commit' }, method: 'PUT' },
                { fault: { kind: 'reset-before' }, method: 'GET', times: 50 },
                { fault: { kind: 'reset-before' }, method: 'HEAD', times: 50 },
              ]);
              const lost = yield* putBytes(edge, uploader, id, bytes);
              expect(proxy.injected().length).toBeGreaterThan(1);
              // Never a success: a typed, retryable non-success, and the asset is not usable.
              expect(lost.status).toBe(503);
              expect(textOf(lost.bytes)).not.toMatch(/ready|contentSha256|storage|s3:/u);
              expect((yield* rowOf(world, id))?.processing_status).toBe('uploaded');
              proxy.setRules([]);
              expect((yield* downloadOf(edge, reader, id)).status).toBe(409);

              // A client that no longer holds the bytes cannot finish the attempt by sending nothing: an empty body is
              // not the declared identity, so there is no confirm-without-bytes route and none is needed here.
              const withoutBytes = yield* putBytes(edge, uploader, id, new Uint8Array(0));
              expect(withoutBytes.status).toBe(409);
              expect((yield* rowOf(world, id))?.processing_status).toBe('uploaded');

              // The retry of the same attempt checks the stored bytes against the original intent and completes the
              // same asset: still exactly one.
              const retried = yield* putBytes(edge, uploader, id, bytes);
              expect(retried.status).toBe(200);
              expect(yield* rowsOf(world)).toHaveLength(1);
              expect((yield* rowOf(world, id))?.processing_status).toBe('ready');
              expect((yield* downloadOf(edge, reader, id)).bytes).toEqual(bytes);
            }),
          ),
        ),
    );
  },
);
