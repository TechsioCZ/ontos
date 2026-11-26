import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeShellAuthenticationApiRuntime } from '../../api/index.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { templateDatabaseLayer } from '../support/access-admin-real-gate-fixture.ts';
import { MEDIA_CAPABILITIES, withMediaE2eWorld } from '../support/core-media-e2e-fixture.ts';
import type { E2eActor, MediaE2eWorld, ShellEdge } from '../support/core-media-e2e-fixture.ts';
import {
  bytesOf,
  currentOf,
  digestOf,
  downloadOf,
  failureCodeOf,
  failureTagOf,
  metadataOf,
  needed,
  parseJson,
  patternBytes,
  putBytes,
  refOf,
  renameAs,
  renameOverHttp,
  requireFaultInjection,
  reserve,
  reserveOverHttp,
  rowOf,
  rowsOf,
  textOf,
  untilStatus,
} from '../support/core-media-e2e-steps.ts';

/*
 * EVIDENCE: INTEGRATION EXECUTED on the real composition (#1446, rows 4-5 of the #1428 minimal acceptance): the
 * production Shell on loopback, the real Core Action runtime, a cloned PostgreSQL, the integration SpiceDB (grants and
 * revocations are the real people commands) and the real S3 adapter on an S3-compatible EMULATOR (MinIO, NOT R2).
 * Authentication is the one substitute (a header names the seeded principal). The engine partition is CONTROLLED FAULT
 * INJECTION (a TCP relay in front of the engine); every other refusal is the engine's own answer.
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

const problemOf = (response: { readonly bytes: Uint8Array }) => {
  const body = parseJson(response.bytes);
  return Predicate.hasProperty(body, '_tag') ? String(body._tag) : 'none';
};

/** One ready asset uploaded by the uploader, the person-level fixture every refusal below is about. */
const readyAsset = Effect.fn('CoreMediaE2e.readyAsset')(function* readyAsset(
  world: MediaE2eWorld,
  edge: ShellEdge,
  bytes: Uint8Array<ArrayBuffer>,
  key: string,
) {
  const uploader = person(world, 'uploader');
  const id = (yield* reserve(world, uploader, bytes, { idempotencyKey: key })).mediaAssetRef.resourceId;
  expect((yield* putBytes(edge, uploader, id, bytes)).status).toBe(200);
  return id;
});

it.layer(templateDatabaseLayer, { excludeTestServices: true, timeout: '600 seconds' })(
  'Core Media end to end: authorization, tenants and the earlier asset (rows 4-5)',
  (suite) => {
    suite.effect(
      'row 4: DENIED, metadata-only and a foreign tenant keep both the metadata and the bytes back, through the real gate',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* denied() {
              const uploader = person(world, 'uploader');
              const metadataOnly = person(world, 'metadataOnly');
              const downloader = person(world, 'downloader');
              const outsider = person(world, 'outsider');
              const foreignOwner = yield* needed(world.foreign.get('owner'), 'foreign owner');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(metadataOnly, [MEDIA_CAPABILITIES.metadata]);
              yield* world.grant(downloader, readerCapabilities);
              const edge = yield* world.shell;
              const bytes = bytesOf('only the entitled may read this');
              const id = yield* readyAsset(world, edge, bytes, 'denied-1');

              // Entitled: both. Metadata-only: the facts but never the bytes. A member with no role: neither.
              expect((yield* metadataOf(edge, downloader, id)).status).toBe(200);
              expect((yield* downloadOf(edge, downloader, id)).bytes).toEqual(bytes);
              expect((yield* metadataOf(edge, metadataOnly, id)).status).toBe(200);
              const withheld = yield* downloadOf(edge, metadataOnly, id);
              expect(withheld.status).toBe(403);
              expect(withheld.bytes.byteLength).toBeLessThan(2048);
              expect(textOf(withheld.bytes)).not.toContain(digestOf(bytes));
              expect((yield* metadataOf(edge, outsider, id)).status).toBe(403);
              expect((yield* downloadOf(edge, outsider, id)).status).toBe(403);

              // A foreign tenant, even with full access in its own tenant, learns nothing of the asset: the answer
              // is the one an id that never existed gets.
              const unknownId = '8d0e5b0e-2c61-4f43-a5a3-5f7b3c0d9a11';
              const foreignMetadata = yield* metadataOf(edge, foreignOwner, id);
              const unknownMetadata = yield* metadataOf(edge, foreignOwner, unknownId);
              expect(foreignMetadata.status).toBe(404);
              expect(foreignMetadata.status).toBe(unknownMetadata.status);
              const foreignDownload = yield* downloadOf(edge, foreignOwner, id);
              const unknownDownload = yield* downloadOf(edge, foreignOwner, unknownId);
              expect(foreignDownload.status).toBe(404);
              expect(problemOf(foreignDownload)).toBe(problemOf(unknownDownload));
              expect(foreignDownload.bytes.byteLength).toBeLessThan(2048);
              // And nothing of the foreign tenant exists under the asset's tenant either.
              expect((yield* rowsOf(world)).length).toBe(1);
            }),
          ),
        ),
    );

    suite.effect('row 4: a download-only grant is not a metadata grant, and a rename grant is neither', (ctx) =>
      withMediaE2eWorld(ctx, platform, (world) =>
        Effect.scoped(
          Effect.gen(function* separateCapabilities() {
            const uploader = person(world, 'uploader');
            const downloadOnly = person(world, 'downloader');
            const renamer = person(world, 'currentOnly');
            yield* world.grant(uploader, uploaderCapabilities);
            yield* world.grant(downloadOnly, [MEDIA_CAPABILITIES.download]);
            yield* world.grant(renamer, [MEDIA_CAPABILITIES.rename]);
            const edge = yield* world.shell;
            const bytes = bytesOf('capabilities are separate');
            const id = yield* readyAsset(world, edge, bytes, 'separate-1');
            expect((yield* downloadOf(edge, downloadOnly, id)).bytes).toEqual(bytes);
            expect((yield* metadataOf(edge, downloadOnly, id)).status).toBe(403);
            // The rename capability reads and downloads nothing.
            expect((yield* metadataOf(edge, renamer, id)).status).toBe(403);
            expect((yield* downloadOf(edge, renamer, id)).status).toBe(403);
          }),
        ),
      ),
    );

    suite.effect(
      'row 4: NEEDS_APPROVAL parks a rename of a proposer, and an owner rename changes only the display name',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* approvalAndRename() {
              const uploader = person(world, 'uploader');
              const proposer = person(world, 'currentOnly');
              const owner = person(world, 'owner');
              yield* world.grant(uploader, uploaderCapabilities);
              // A holder of `propose` only: the engine answers NEEDS_APPROVAL, never ALLOWED.
              yield* world.grant(proposer, [MEDIA_CAPABILITIES.rename], { mode: 'propose' });
              const edge = yield* world.shell;
              const bytes = bytesOf('presentation names are separate');
              const reservation = yield* reserve(world, uploader, bytes, {
                displayFilename: 'Original.pdf',
                idempotencyKey: 'rename-1',
                originalFilename: 'Original.pdf',
              });
              const id = reservation.mediaAssetRef.resourceId;
              expect((yield* putBytes(edge, uploader, id, bytes)).status).toBe(200);
              const before = yield* metadataOf(edge, owner, id);
              const currentBefore = yield* currentOf(world, owner, [refOf(world.tenantId, id)]);

              const proposed = yield* failureCodeOf(
                renameAs(world, proposer, reservation.mediaAssetRef, 'Proposed.pdf', 'rename-p'),
              );
              expect(proposed).toBe('action_approval_required');
              // Nothing changed: the proposal is not the rename.
              expect((yield* metadataOf(edge, owner, id)).json).toMatchObject({ displayFilename: 'Original.pdf' });

              // The owner's own rename changes the presentation name and nothing else of the asset.
              yield* renameAs(world, owner, reservation.mediaAssetRef, 'Renamed.pdf', 'rename-o');
              const after = yield* metadataOf(edge, owner, id);
              expect(after.json).toMatchObject({
                byteSize: bytes.byteLength,
                contentSha256: digestOf(bytes),
                displayFilename: 'Renamed.pdf',
                mediaAssetRef: reservation.mediaAssetRef,
                originalFilename: 'Original.pdf',
                processingStatus: 'ready',
              });
              expect(before.json).toMatchObject({ displayFilename: 'Original.pdf' });
              // Current V1 is the asset's, not its name's: the answer is the same after the rename.
              expect(currentBefore.entries.map(({ kind }) => kind)).toEqual(['AVAILABLE']);
              expect(yield* currentOf(world, owner, [refOf(world.tenantId, id)])).toEqual(currentBefore);
              expect((yield* downloadOf(edge, owner, id)).bytes).toEqual(bytes);
              expect((yield* rowsOf(world)).length).toBe(1);
            }),
          ),
        ),
    );

    suite.effect(
      'row 4: a stale permission is no grant: after the real revoke the next metadata read and download fail, and a new grant restores them',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* staleGrant() {
              const uploader = person(world, 'uploader');
              const reader = person(world, 'downloader');
              yield* world.grant(uploader, uploaderCapabilities);
              const grant = yield* world.grant(reader, readerCapabilities);
              const edge = yield* world.shell;
              const bytes = bytesOf('what a revoked reader saw before');
              const id = yield* readyAsset(world, edge, bytes, 'stale-1');

              // The reader saw the metadata and could download.
              expect((yield* metadataOf(edge, reader, id)).status).toBe(200);
              expect((yield* downloadOf(edge, reader, id)).bytes).toEqual(bytes);
              yield* world.revoke(grant.incarnationId);
              // The knowledge of the asset (its id, its name, a page the UI still shows) grants nothing now.
              expect((yield* downloadOf(edge, reader, id)).status).toBe(403);
              expect((yield* metadataOf(edge, reader, id)).status).toBe(403);
              expect((yield* rowOf(world, id))?.processing_status).toBe('ready');
              // A new decision is a new answer.
              yield* world.grant(reader, readerCapabilities);
              expect((yield* downloadOf(edge, reader, id)).bytes).toEqual(bytes);
            }),
          ),
        ),
    );

    suite.effect(
      'row 4: a transfer already authorized may finish after the revoke, and the very next request, a resumed range included, fails',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* transferOutlivesRevoke() {
              const uploader = person(world, 'uploader');
              const reader = person(world, 'downloader');
              yield* world.grant(uploader, uploaderCapabilities);
              const grant = yield* world.grant(reader, readerCapabilities);
              const edge = yield* world.shell;
              // Several megabytes, so the transfer is still running when the Permission ends.
              const bytes = patternBytes(6_291_459);
              const id = yield* readyAsset(world, edge, bytes, 'transfer-1');

              const response = yield* edge.open({
                actor: reader,
                headers: { 'x-correlation-id': 'e2e-transfer' },
                method: 'GET',
                path: `/core/media/assets/${id}/content`,
              });
              expect(response.status).toBe(200);
              const { body } = response;
              const stream = (yield* needed(body ?? undefined, 'download body')).getReader();
              const first = yield* Effect.promise(async () => await stream.read());
              expect(first.done).toBe(false);
              const received: Uint8Array[] = first.value === undefined ? [] : [first.value];

              yield* world.revoke(grant.incarnationId);
              // The transfer that began with a valid decision runs to its end, and its bytes are the stored ones.
              for (;;) {
                const next = yield* Effect.promise(async () => await stream.read());
                if (next.done) {
                  break;
                }
                received.push(next.value);
              }
              const total = received.reduce((sum, chunk) => sum + chunk.byteLength, 0);
              const joined = new Uint8Array(total);
              let offset = 0;
              for (const chunk of received) {
                joined.set(chunk, offset);
                offset += chunk.byteLength;
              }
              expect(total).toBe(bytes.byteLength);
              expect(digestOf(joined)).toBe(digestOf(bytes));

              // The next request is its own decision, and a resumed range is one too: both fail.
              expect((yield* downloadOf(edge, reader, id)).status).toBe(403);
              const resumed = yield* edge.request({
                actor: reader,
                headers: { range: 'bytes=1024-', 'x-correlation-id': 'e2e-range' },
                method: 'GET',
                path: `/core/media/assets/${id}/content`,
              });
              expect(resumed.status).toBe(403);
            }),
          ),
        ),
    );

    suite.effect(
      'row 4: a byte PUT replayed on a ready asset is decided again: after the real revoke it is refused',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* revokedReplay() {
              const uploader = person(world, 'uploader');
              const grant = yield* world.grant(uploader, uploaderCapabilities);
              const edge = yield* world.shell;
              const bytes = bytesOf('a replay is a request of its own');
              const id = yield* readyAsset(world, edge, bytes, 'replay-1');
              const sealed = yield* rowOf(world, id);

              expect((yield* putBytes(edge, uploader, id, bytes)).status).toBe(200);
              yield* world.revoke(grant.incarnationId);
              expect((yield* putBytes(edge, uploader, id, bytes)).status).toBe(403);
              expect(yield* rowOf(world, id)).toEqual(sealed);
            }),
          ),
        ),
    );

    suite.effect(
      'row 4: SpiceDB UNAVAILABLE keeps both the metadata and the bytes back and changes nothing (CONTROLLED FAULT INJECTION: engine partition)',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* engineUnavailable() {
              const injection = yield* requireFaultInjection(ctx, world);
              const uploader = person(world, 'uploader');
              const reader = person(world, 'downloader');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(reader, readerCapabilities);
              const edge = yield* world.shell;
              const bytes = bytesOf('unavailable is not allowed');
              const id = yield* readyAsset(world, edge, bytes, 'engine-1');
              const rowBefore = yield* rowOf(world, id);

              injection.engine.setDown(true);
              const metadata = yield* metadataOf(edge, reader, id);
              const download = yield* downloadOf(edge, reader, id);
              injection.engine.setDown(false);
              // Fail closed and retryable: never an ALLOWED, never a bytes answer, never a "not found".
              expect(metadata.status).toBe(503);
              expect(download.status).toBe(503);
              expect(download.bytes.byteLength).toBeLessThan(2048);
              expect(yield* rowOf(world, id)).toEqual(rowBefore);

              // The engine is back: the same request is answered again (the client reconnects with backoff).
              const recovered = yield* untilStatus(world, downloadOf(edge, reader, id), 200);
              expect(recovered.status).toBe(200);
              expect(recovered.bytes).toEqual(bytes);
            }),
          ),
        ),
    );

    suite.effect(
      'row 4: SpiceDB UNAVAILABLE never lets a byte PUT succeed or close the asset (CONTROLLED FAULT INJECTION: engine partition)',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* engineDownDuringUpload() {
              const injection = yield* requireFaultInjection(ctx, world);
              const uploader = person(world, 'uploader');
              yield* world.grant(uploader, uploaderCapabilities);
              const edge = yield* world.shell;
              const bytes = bytesOf('an upload with no decision is no upload');
              const id = (yield* reserve(world, uploader, bytes, { idempotencyKey: 'engine-put' })).mediaAssetRef
                .resourceId;

              injection.engine.setDown(true);
              const put = yield* putBytes(edge, uploader, id, bytes);
              injection.engine.setDown(false);
              // Whether or not any byte reached the store (decision 5 accepts bytes before confirm is decided), a
              // missing decision is a retryable refusal: nothing is sealed and nothing is closed.
              expect(put.status).toBe(503);
              expect(yield* rowOf(world, id)).toMatchObject({ processing_status: 'uploaded', sealed_at: null });

              const recovered = yield* untilStatus(world, putBytes(edge, uploader, id, bytes), 200);
              expect(recovered.status).toBe(200);
              expect(yield* rowOf(world, id)).toMatchObject({ processing_status: 'ready' });
            }),
          ),
        ),
    );

    suite.effect(
      'row 4: SpiceDB UNAVAILABLE reserves nothing and renames nothing (CONTROLLED FAULT INJECTION: engine partition)',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* engineDownForActions() {
              const injection = yield* requireFaultInjection(ctx, world);
              const uploader = person(world, 'uploader');
              const renamer = person(world, 'currentOnly');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(renamer, [MEDIA_CAPABILITIES.rename]);
              const edge = yield* world.shell;
              const bytes = bytesOf('no decision, no write');
              const id = yield* readyAsset(world, edge, bytes, 'engine-actions');
              const sealed = yield* rowOf(world, id);

              injection.engine.setDown(true);
              const reserved = yield* reserveOverHttp(edge, uploader, bytes, { idempotencyKey: 'engine-reserve' });
              const renamed = yield* renameOverHttp(edge, renamer, id, 'Renamed.pdf', 'engine-rename');
              injection.engine.setDown(false);
              expect(reserved.status).toBe(503);
              expect(renamed.status).toBe(503);
              expect((yield* rowsOf(world)).length).toBe(1);
              expect(yield* rowOf(world, id)).toEqual(sealed);

              // The engine is back: the same rename, under a new attempt, is answered.
              const recovered = yield* untilStatus(
                world,
                renameOverHttp(edge, renamer, id, 'Renamed.pdf', 'engine-rename-again'),
                200,
              );
              expect(recovered.status).toBe(200);
            }),
          ),
        ),
    );

    suite.effect(
      'row 4: a foreign principal naming this tenant in the reference learns nothing, and a grant aimed at one asset reaches that asset and no other',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* tenantAndResourceScope() {
              const uploader = person(world, 'uploader');
              const scoped = person(world, 'metadataOnly');
              const foreignOwner = yield* needed(world.foreign.get('owner'), 'foreign owner');
              yield* world.grant(uploader, uploaderCapabilities);
              const edge = yield* world.shell;
              const first = bytesOf('the asset the grant is aimed at');
              const second = bytesOf('another asset of the same tenant');
              const a = yield* readyAsset(world, edge, first, 'scope-a');
              const b = yield* readyAsset(world, edge, second, 'scope-b');

              // The reference names tenant T1, the principal is T2's owner: not found, like an id that never existed.
              const crossTenant = yield* metadataOf(edge, foreignOwner, a, world.tenantId);
              const unknown = yield* metadataOf(
                edge,
                foreignOwner,
                '8d0e5b0e-2c61-4f43-a5a3-5f7b3c0d9a11',
                world.tenantId,
              );
              expect(crossTenant.status).toBe(404);
              expect(problemOf(crossTenant)).toBe(problemOf(unknown));
              const crossCurrent = yield* currentOf(world, foreignOwner, [refOf(world.tenantId, a)]);
              expect(crossCurrent.entries.map(({ kind }) => kind)).toEqual(['ABSENT']);

              // Resource scope: the cells name asset A only. A is read and downloaded, B is not, with the same tenant.
              yield* world.grant(scoped, readerCapabilities, { targets: [a] });
              expect((yield* metadataOf(edge, scoped, a)).status).toBe(200);
              expect((yield* downloadOf(edge, scoped, a)).bytes).toEqual(first);
              expect((yield* metadataOf(edge, scoped, b)).status).toBe(403);
              expect((yield* downloadOf(edge, scoped, b)).status).toBe(403);
            }),
          ),
        ),
    );

    suite.effect(
      'row 5: a new upload never updates or overwrites an earlier asset, not even when it is aimed at it',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* newUploadLeavesEarlierAlone() {
              const uploader = person(world, 'uploader');
              const reader = person(world, 'downloader');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(reader, readerCapabilities);
              const edge = yield* world.shell;
              const first = bytesOf('the earlier asset');
              const second = bytesOf('a later and different file');
              const a = yield* readyAsset(world, edge, first, 'earlier-a');
              const rowA = yield* rowOf(world, a);
              const metadataA = yield* metadataOf(edge, reader, a);

              const b = yield* readyAsset(world, edge, second, 'earlier-b');
              expect(b).not.toBe(a);
              // The later bytes aimed at the earlier asset are a conflict, never an overwrite.
              expect((yield* putBytes(edge, uploader, a, second)).status).toBe(409);
              expect((yield* putBytes(edge, uploader, b, first)).status).toBe(409);

              expect(yield* rowOf(world, a)).toEqual(rowA);
              expect((yield* metadataOf(edge, reader, a)).json).toEqual(metadataA.json);
              expect((yield* downloadOf(edge, reader, a)).bytes).toEqual(first);
              expect((yield* downloadOf(edge, reader, b)).bytes).toEqual(second);
              expect((yield* rowsOf(world)).length).toBe(2);
              // The same reservation key with the later bytes is a conflict, not the earlier asset with new bytes.
              const conflicting = yield* failureTagOf(
                reserve(world, uploader, second, { idempotencyKey: 'earlier-a' }),
              );
              expect(conflicting).toBe('ActionRequestHashConflict');
              expect((yield* rowsOf(world)).length).toBe(2);
            }),
          ),
        ),
    );
  },
);
