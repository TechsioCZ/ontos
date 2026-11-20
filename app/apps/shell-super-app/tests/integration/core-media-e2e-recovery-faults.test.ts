import { Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeShellAuthenticationApiRuntime } from '../../api/index.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { templateDatabaseLayer } from '../support/access-admin-real-gate-fixture.ts';
import { MEDIA_CAPABILITIES, withMediaE2eWorld } from '../support/core-media-e2e-fixture.ts';
import type { E2eActor, MediaE2eWorld } from '../support/core-media-e2e-fixture.ts';
import {
  digestOf,
  downloadOf,
  metadataOf,
  patternBytes,
  putBytes,
  requireFaultInjection,
  reserve,
  rowOf,
  rowsOf,
  textOf,
} from '../support/core-media-e2e-steps.ts';

/*
 * EVIDENCE: INTEGRATION EXECUTED on the real composition, with every fault below CONTROLLED FAULT INJECTION and named as
 * such (#1446 scenarios of #1434 and #1447). The provider is an S3-compatible EMULATOR (MinIO), NOT R2: a fault proxy
 * (provider answer lost, connection reset, truncated body, forced status) or an out-of-band replacement of the stored
 * bytes stands for the incident; a database trigger stands for a database that refuses the confirm write. The real
 * Shell, Core runtime, PostgreSQL and SpiceDB run unchanged around each fault, and nothing a fault left behind is
 * hidden: every scenario reads the rows back.
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

/** Reads a response body to its end; an unclean end is a failure, never a short success. */
const readToEnd = (response: Response) =>
  Effect.exit(
    Effect.tryPromise({
      catch: () => 'transfer ended without a clean end' as const,
      try: async () => new Uint8Array(await response.arrayBuffer()),
    }),
  );

/** One ready asset of the uploader, and the reader that may download it. */
const readyAsset = Effect.fn('CoreMediaE2e.readyRecoveryAsset')(function* readyAsset(
  world: MediaE2eWorld,
  edge: Effect.Success<MediaE2eWorld['shell']>,
  bytes: Uint8Array<ArrayBuffer>,
  key: string,
) {
  const uploader = person(world, 'uploader');
  const id = (yield* reserve(world, uploader, bytes, { idempotencyKey: key })).mediaAssetRef.resourceId;
  expect((yield* putBytes(edge, uploader, id, bytes)).status).toBe(200);
  return id;
});

it.layer(templateDatabaseLayer, { excludeTestServices: true, timeout: '600 seconds' })(
  'Core Media end to end: provider and database faults, recovery and cleanup (#1434, #1447)',
  (suite) => {
    suite.effect(
      'a provider outage during a download is a request-level UNAVAILABLE, never absence, and changes no status (CONTROLLED FAULT INJECTION: connection reset, forced 404, truncated body)',
      (ctx) =>
        withMediaE2eWorld(platform, (world) =>
          Effect.scoped(
            Effect.gen(function* providerOutageOnDownload() {
              const { faults } = yield* requireFaultInjection(ctx, world);
              const uploader = person(world, 'uploader');
              const reader = person(world, 'downloader');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(reader, readerCapabilities);
              const edge = yield* world.shell;
              const bytes = patternBytes(786_433);
              const id = yield* readyAsset(world, edge, bytes, 'outage-1');
              const rowBefore = yield* rowOf(world, id);

              // The provider cannot be reached: the request is unavailable and the asset is still the same asset.
              faults.setRules([
                { fault: { kind: 'reset-before' }, method: 'GET', times: 50 },
                { fault: { kind: 'reset-before' }, method: 'HEAD', times: 50 },
              ]);
              const outage = yield* downloadOf(edge, reader, id);
              expect(outage.status).toBe(503);
              expect(yield* rowOf(world, id)).toEqual(rowBefore);

              // The provider answers 404 for an object Core has evidence of: that is not a missing asset.
              faults.setRules([
                { fault: { code: 'NoSuchKey', kind: 'status', status: 404 }, method: 'GET', times: 50 },
                { fault: { code: 'NoSuchKey', kind: 'status', status: 404 }, method: 'HEAD', times: 50 },
              ]);
              const missing = yield* downloadOf(edge, reader, id);
              expect(missing.status).toBe(503);
              expect((yield* metadataOf(edge, reader, id)).json).toMatchObject({ processingStatus: 'ready' });
              expect(yield* rowOf(world, id)).toEqual(rowBefore);

              // The transfer breaks halfway: the client never gets a clean end, and never a short "success".
              faults.setRules([{ fault: { after: 200_000, kind: 'truncate-body' }, method: 'GET' }]);
              const truncated = yield* edge.open({
                actor: reader,
                headers: { 'x-correlation-id': 'e2e-truncated' },
                method: 'GET',
                path: `/core/media/assets/${id}/content`,
              });
              const ended = yield* readToEnd(truncated);
              expect(
                Exit.isFailure(ended) || (Exit.isSuccess(ended) && ended.value.byteLength < bytes.byteLength),
              ).toBe(true);
              if (Exit.isSuccess(ended)) {
                expect(digestOf(ended.value)).not.toBe(digestOf(bytes));
              }
              expect(yield* rowOf(world, id)).toEqual(rowBefore);

              // The provider is back: the very same asset downloads again, byte for byte.
              faults.setRules([]);
              expect((yield* downloadOf(edge, reader, id)).bytes).toEqual(bytes);
              expect(faults.injected().length).toBeGreaterThan(2);
            }),
          ),
        ),
    );

    suite.effect(
      'bytes that do not match the declared identity never become ready: the upload ends failed or unconfirmed, nothing downloads, and no hash is published',
      () =>
        withMediaE2eWorld(platform, (world) =>
          Effect.scoped(
            Effect.gen(function* mismatchedUpload() {
              const uploader = person(world, 'uploader');
              const reader = person(world, 'downloader');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(reader, readerCapabilities);
              const edge = yield* world.shell;
              const declared = patternBytes(4096);
              const delivered = patternBytes(4096).map((byte, index) => (index === 4000 ? (byte + 1) % 256 : byte));
              const id = (yield* reserve(world, uploader, declared, { idempotencyKey: 'mismatch-1' })).mediaAssetRef
                .resourceId;

              // Same size, one different byte: the real hash of the body is not the declared one.
              const refused = yield* putBytes(edge, uploader, id, new Uint8Array(delivered));
              // A body that is not the declared identity is refused as a conflict before anything is sealed.
              expect(refused.status).toBe(409);
              expect(textOf(refused.bytes)).not.toMatch(/"processingStatus":"ready"/u);
              const row = yield* rowOf(world, id);
              expect(row?.processing_status).not.toBe('ready');
              expect(row?.sealed_at ?? null).toBeNull();
              // Never a false ready: no download, and the metadata publishes no verified size or hash.
              expect((yield* downloadOf(edge, reader, id)).status).not.toBe(200);
              const metadata = yield* metadataOf(edge, reader, id);
              expect(metadata.json).toMatchObject({ contentVerified: false });
              expect(textOf(metadata.bytes)).not.toContain(digestOf(declared));
              // The declared bytes themselves still complete the same asset.
              const retried = yield* putBytes(edge, uploader, id, declared);
              expect(retried.status).toBe(200);
              expect((yield* downloadOf(edge, reader, id)).bytes).toEqual(declared);
              expect((yield* rowsOf(world)).length).toBe(1);
            }),
          ),
        ),
    );

    suite.effect(
      'a ready asset whose stored bytes are replaced is never delivered as ready bytes (CONTROLLED FAULT INJECTION: out-of-band replacement at the emulator)',
      () =>
        withMediaE2eWorld(platform, (world) =>
          Effect.scoped(
            Effect.gen(function* corruptedAfterReady() {
              const uploader = person(world, 'uploader');
              const reader = person(world, 'downloader');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(reader, readerCapabilities);
              const edge = yield* world.shell;
              const original = patternBytes(786_433);
              const id = yield* readyAsset(world, edge, original, 'corrupt-1');
              // Same size, other bytes: only the digest can tell.
              const substituted = patternBytes(786_433).map((byte, index) =>
                index === 786_000 ? (byte + 1) % 256 : byte,
              );
              yield* world.replaceStoredObject(id, substituted);

              const response = yield* edge.open({
                actor: reader,
                headers: { 'x-correlation-id': 'e2e-corrupt' },
                method: 'GET',
                path: `/core/media/assets/${id}/content`,
              });
              const ended = yield* readToEnd(response);
              // The transfer is stopped at the proof of corruption: no clean end, or an error status before any byte.
              expect(response.status === 200 ? Exit.isFailure(ended) : response.status >= 400).toBe(true);
              if (Exit.isSuccess(ended)) {
                expect(digestOf(ended.value)).not.toBe(digestOf(substituted));
              }
            }),
          ),
        ),
    );

    suite.effect(
      'a database that refuses the confirm write after the bytes are stored ends unconfirmed and retryable, and the retry completes the one asset (CONTROLLED FAULT INJECTION: a trigger refuses the ready write)',
      () =>
        withMediaE2eWorld(platform, (world) =>
          Effect.scoped(
            Effect.gen(function* databaseRefusesConfirm() {
              const uploader = person(world, 'uploader');
              const reader = person(world, 'downloader');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(reader, readerCapabilities);
              const edge = yield* world.shell;
              const bytes = patternBytes(70_001);
              const id = (yield* reserve(world, uploader, bytes, { idempotencyKey: 'db-refuses-1' })).mediaAssetRef
                .resourceId;
              yield* world.admin.unsafe(
                `create function core.d20_e2e_refuse_ready() returns trigger language plpgsql as $$ begin raise exception 'controlled fault: the ready write is refused'; end $$`,
              );
              yield* world.admin.unsafe(
                `create trigger d20_e2e_refuse_ready before update on core.media_assets for each row when (new.processing_status = 'ready') execute function core.d20_e2e_refuse_ready()`,
              );
              const refused = yield* putBytes(edge, uploader, id, bytes);
              yield* world.admin.unsafe('drop trigger d20_e2e_refuse_ready on core.media_assets');
              expect(refused.status).toBe(503);
              expect((yield* rowOf(world, id))?.processing_status).toBe('uploaded');
              expect((yield* downloadOf(edge, reader, id)).status).not.toBe(200);

              // The bytes are in the object store already; the retry confirms them as the original intent.
              const retried = yield* putBytes(edge, uploader, id, bytes);
              expect(retried.status).toBe(200);
              expect((yield* rowOf(world, id))?.processing_status).toBe('ready');
              expect((yield* rowsOf(world)).length).toBe(1);
              expect((yield* downloadOf(edge, reader, id)).bytes).toEqual(bytes);
            }),
          ),
        ),
    );

    suite.effect(
      'a reconnect decides the confirm capability afresh: after the real revoke the retry is refused, and a new grant lets it complete (CONTROLLED FAULT INJECTION: answer lost and read-back unreachable)',
      (ctx) =>
        withMediaE2eWorld(platform, (world) =>
          Effect.scoped(
            Effect.gen(function* reconnectWithFreshAuthorization() {
              const { faults } = yield* requireFaultInjection(ctx, world);
              const uploader = person(world, 'uploader');
              const reader = person(world, 'downloader');
              const grant = yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(reader, readerCapabilities);
              const edge = yield* world.shell;
              const bytes = patternBytes(70_001);
              const id = (yield* reserve(world, uploader, bytes, { idempotencyKey: 'reconnect-1' })).mediaAssetRef
                .resourceId;
              faults.setRules([
                { fault: { kind: 'drop-answer-after-commit' }, method: 'PUT' },
                { fault: { kind: 'reset-before' }, method: 'GET', times: 50 },
                { fault: { kind: 'reset-before' }, method: 'HEAD', times: 50 },
              ]);
              expect((yield* putBytes(edge, uploader, id, bytes)).status).toBe(503);
              faults.setRules([]);

              yield* world.revoke(grant.incarnationId);
              const refused = yield* putBytes(edge, uploader, id, bytes);
              expect(refused.status).toBe(403);
              expect((yield* rowOf(world, id))?.processing_status).not.toBe('ready');

              yield* world.grant(uploader, uploaderCapabilities);
              expect((yield* putBytes(edge, uploader, id, bytes)).status).toBe(200);
              expect((yield* downloadOf(edge, reader, id)).bytes).toEqual(bytes);
              expect((yield* rowsOf(world)).length).toBe(1);
            }),
          ),
        ),
    );

    suite.effect(
      'concurrent recovery of one uncertain upload ends with exactly one confirmed asset and only typed answers (CONTROLLED FAULT INJECTION: answer lost and read-back unreachable)',
      (ctx) =>
        withMediaE2eWorld(platform, (world) =>
          Effect.scoped(
            Effect.gen(function* concurrentRecovery() {
              const { faults } = yield* requireFaultInjection(ctx, world);
              const uploader = person(world, 'uploader');
              const reader = person(world, 'downloader');
              yield* world.grant(uploader, uploaderCapabilities);
              yield* world.grant(reader, readerCapabilities);
              const edge = yield* world.shell;
              const bytes = patternBytes(262_147);
              const id = (yield* reserve(world, uploader, bytes, { idempotencyKey: 'concurrent-1' })).mediaAssetRef
                .resourceId;
              faults.setRules([
                { fault: { kind: 'drop-answer-after-commit' }, method: 'PUT' },
                { fault: { kind: 'reset-before' }, method: 'GET', times: 50 },
                { fault: { kind: 'reset-before' }, method: 'HEAD', times: 50 },
              ]);
              expect((yield* putBytes(edge, uploader, id, bytes)).status).toBe(503);
              faults.setRules([]);

              // Four clients recover the same attempt at once.
              const answers = yield* Effect.all(
                [1, 2, 3, 4].map(() => putBytes(edge, uploader, id, bytes)),
                { concurrency: 4 },
              );
              for (const answer of answers) {
                expect([200, 409, 503]).toContain(answer.status);
              }
              expect(answers.some(({ status }) => status === 200)).toBe(true);
              expect((yield* rowsOf(world)).length).toBe(1);
              expect((yield* rowOf(world, id))?.processing_status).toBe('ready');
              expect((yield* downloadOf(edge, reader, id)).bytes).toEqual(bytes);
            }),
          ),
        ),
    );
  },
);
