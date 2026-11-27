import { sha256 } from '@noble/hashes/sha2.js';
import { NodeCrypto } from '@effect/platform-node';
import { Cause, DateTime, Effect, Exit, Layer, Option, Ref, Schema, Stream } from 'effect';
import { SecureRandom } from 'effect/crypto';
import type { Scope } from 'effect';
import { Hex } from 'effect/encoding';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { TenantMediaAssetKeySchema, mediaAssetRefFor } from '../../src/media/identity.ts';
import { ObjectStorage } from '../../src/media/object-storage.ts';
import type { ObjectStorageService } from '../../src/media/object-storage.ts';
import type { S3ObjectStorageConfigValue } from '../../src/media/s3-config.ts';
import { makeS3ObjectStorage } from '../../src/media/s3-object-storage.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import { AssetDownloadAuthorizationSchema } from '../../src/media/download-contract.ts';
import { MediaDownloadAborted, streamConfirmedBytes } from '../../src/media/download.ts';
import { MediaIntegrityFailed, MediaUnavailable } from '../../src/media/errors.ts';
import { MediaIntegrityRecorder } from '../../src/media/integrity-recorder.ts';
import { statReadyMediaAsset, verifyReadyMediaAsset } from '../../src/media/verified-read.ts';
import type { MediaVerifiableAsset } from '../../src/media/verified-read.ts';
import { startS3FaultProxy } from '../support/s3-fault-proxy.ts';
import {
  pointAt,
  recordKey,
  s3FaultInjectableConfig,
  s3ProviderConfig,
  s3Providers,
  spaceSameKeyWrites,
} from '../support/s3-provider-under-test.ts';
import type { S3ProviderUnderTest } from '../support/s3-provider-under-test.ts';
import type { S3FaultProxy } from '../support/s3-fault-proxy.ts';

/*
 * EVIDENCE LEVEL: INTEGRATION EXECUTED against an S3-compatible EMULATOR (MinIO) and against the R2-behaviour MOCK built
 * from documentation, NEITHER IS Cloudflare R2 (the provider rows are in tests/support/s3-provider-under-test.ts).
 *
 * The verified read of a READY asset through the REAL S3 adapter and a real HTTP exchange. Every fault is
 * CONTROLLED FAULT INJECTION by the proxy in tests/support (or an out-of-band write for the corruption), not a real
 * incident, and none of it proves R2: its rows stay NOT VERIFIED until a real endpoint is configured and run by its
 * owner. The emulator row runs only when CORE_MEDIA_S3_* points at a LOOPBACK server; with none supplied it is skipped.
 * The mock rows need no configuration.
 */

const withProxy = <Value, Failure, Requirement>(
  ctx: { readonly skip: () => void },
  use: (proxy: S3FaultProxy, base: S3ObjectStorageConfigValue) => Effect.Effect<Value, Failure, Requirement>,
): Effect.Effect<Value, Failure, Requirement | Scope.Scope | S3ProviderUnderTest> =>
  s3FaultInjectableConfig(ctx).pipe(
    Effect.flatMap((base) => Effect.flatMap(startS3FaultProxy(base.endpoint), (proxy) => use(proxy, base))),
  );

const encoder = new TextEncoder();
const MIB = 1024 * 1024;
const digestOf = (bytes: Uint8Array) => Hex.encode(sha256(bytes));
const nextUuid = SecureRandom.SecureRandom.use((crypto) => crypto.uuidV4());

const freshKey = Effect.gen(function* freshKeyEffect() {
  const identity = yield* Schema.decodeUnknownEffect(TenantMediaAssetKeySchema)({
    mediaAssetId: yield* nextUuid,
    tenantId: yield* nextUuid,
  }).pipe(Effect.orDie);
  const key = deriveMediaStorageKey(identity);
  yield* recordKey(key);
  return key;
});

/** Deterministic bytes in chunks, never held whole. */
const patterned = (totalBytes: number, chunkBytes: number, seed: number) =>
  Stream.unfold({ offset: 0, state: seed }, (cursor) => {
    if (cursor.offset >= totalBytes) {
      return Effect.undefined;
    }
    const size = Math.min(chunkBytes, totalBytes - cursor.offset);
    const chunk = new Uint8Array(size);
    let { state } = cursor;
    for (let index = 0; index < size; index += 1) {
      state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      chunk[index] = Math.floor(state / 16_777_216);
    }
    return Effect.succeed([chunk, { offset: cursor.offset + size, state }] as const);
  });

const digestOfStream = (body: Stream.Stream<Uint8Array>) =>
  Stream.runCollect(body).pipe(Effect.map((chunks) => digestOf(Buffer.concat(chunks))));

/** The row of a ready asset whose object is stored under `key` with the given content. */
const readyRow = (
  storage: ObjectStorageService,
  key: ReturnType<typeof deriveMediaStorageKey>,
  content: { readonly byteSize: number; readonly contentSha256: string },
): MediaVerifiableAsset => ({
  byteSize: BigInt(content.byteSize),
  contentSha256: content.contentSha256,
  processingStatus: 'ready',
  sealedAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
  storageKey: key,
  storageObjectVersionRef: null,
  storageProvider: storage.providerId,
});

const verify = (storage: ObjectStorageService, row: MediaVerifiableAsset) =>
  verifyReadyMediaAsset(row).pipe(Effect.provideService(ObjectStorage, storage));

const SIZE = 3 * MIB;

for (const provider of s3Providers) {
  it.layer(Layer.mergeAll(NodeCrypto.layer, FetchHttpClient.layer, provider.layer), { excludeTestServices: true })(
    `core media verified read through the S3 adapter [${provider.label}]`,
    (suite) => {
      suite.effect(
        'verifies a stored object, and an outage of any kind is unavailable until the same bytes answer again',
        (ctx) =>
          Effect.scoped(
            withProxy(ctx, (proxy, base) =>
              Effect.gen(function* outages() {
                const storage = yield* makeS3ObjectStorage({
                  ...pointAt(base, proxy.origin),
                  requestTimeoutMillis: Option.some(400),
                });
                const key = yield* freshKey;
                const bytes = patterned(SIZE, MIB, 7);
                const contentSha256 = yield* digestOfStream(bytes);
                yield* storage.put({
                  body: patterned(SIZE, MIB, 7),
                  byteSize: SIZE,
                  contentType: 'application/octet-stream',
                  key,
                });
                const row = readyRow(storage, key, { byteSize: SIZE, contentSha256 });
                expect(yield* verify(storage, row)).toMatchObject({ contentSha256, outcome: 'verified' });
                // CONTROLLED FAULT: a provider 503, a reset, a hang and a connection cut mid-body, each on its own request.
                const faults = [
                  [{ code: 'ServiceUnavailable', kind: 'status', status: 503 }, 'GET'],
                  [{ kind: 'reset-before' }, 'GET'],
                  [{ kind: 'hang' }, 'GET'],
                  [{ after: MIB, kind: 'truncate-body' }, 'GET'],
                  [{ kind: 'reset-before' }, 'HEAD'],
                ] as const;
                for (const [fault, method] of faults) {
                  proxy.setRules([{ fault, method }]);
                  const outcome = yield* verify(storage, row);
                  expect(outcome.outcome, `${fault.kind} on ${method}`).toBe('unavailable');
                  // A spent fault leaves the same bytes verified: the outage promoted nothing and changed nothing.
                  expect(yield* verify(storage, row)).toMatchObject({ contentSha256, outcome: 'verified' });
                }
                expect(proxy.injected().length).toBeGreaterThanOrEqual(faults.length);
              }),
            ),
          ),
      );

      suite.effect(
        'the Current stat check confirms a stored object with one HEAD and no body, and an outage, a missing object and another length are each their own answer',
        (ctx) =>
          Effect.scoped(
            withProxy(ctx, (proxy, base) =>
              Effect.gen(function* currentStat() {
                const storage = yield* makeS3ObjectStorage({
                  ...pointAt(base, proxy.origin),
                  requestTimeoutMillis: Option.some(400),
                });
                const stat = (row: MediaVerifiableAsset) =>
                  statReadyMediaAsset(row).pipe(Effect.provideService(ObjectStorage, storage));
                const key = yield* freshKey;
                const content = encoder.encode('the confirmed bytes');
                const row = readyRow(storage, key, { byteSize: content.byteLength, contentSha256: digestOf(content) });
                // Nothing stored yet: the provider's 404 is a missing object, never absence of the asset.
                expect(yield* stat(row)).toEqual({ outcome: 'missing_object' });
                yield* storage.put({ body: Stream.make(content), contentType: 'text/plain', key });
                const requestsBefore = proxy.requests();
                expect(yield* stat(row)).toEqual({ byteSize: content.byteLength, outcome: 'present' });
                // One exchange (a HEAD): no object body was requested for the answer.
                expect(proxy.requests() - requestsBefore).toBe(1);
                // CONTROLLED FAULT: a provider 503, a reset and a hang on the HEAD are each unavailable, then the same answer.
                for (const fault of [
                  { code: 'ServiceUnavailable', kind: 'status', status: 503 },
                  { kind: 'reset-before' },
                  { kind: 'hang' },
                ] as const) {
                  proxy.setRules([{ fault, method: 'HEAD' }]);
                  expect((yield* stat(row)).outcome, fault.kind).toBe('unavailable');
                  expect((yield* stat(row)).outcome, `${fault.kind} spent`).toBe('present');
                }
                // Another recorded length: inconsistent with the stored object, and nothing claims corruption.
                expect(yield* stat({ ...row, byteSize: BigInt(content.byteLength + 1) })).toEqual({
                  outcome: 'inconsistent_metadata',
                  reason: 'declared_size_differs',
                });
              }),
            ),
          ),
      );

      suite.effect(
        'answers a provider 404 as a missing object and a completely read object of another length as proven corruption',
        (ctx) =>
          Effect.gen(function* missingAndLength() {
            const base = yield* s3ProviderConfig(ctx);
            const storage = yield* makeS3ObjectStorage(base);
            const key = yield* freshKey;
            const content = encoder.encode('the confirmed bytes');
            const contentSha256 = digestOf(content);
            expect(
              yield* verify(storage, readyRow(storage, key, { byteSize: content.byteLength, contentSha256 })),
            ).toEqual({
              outcome: 'missing_object',
            });
            yield* storage.put({
              body: Stream.make(encoder.encode('another, longer object body')),
              contentType: 'text/plain',
              key,
            });
            const other = encoder.encode('another, longer object body');
            const outcome = yield* verify(
              storage,
              readyRow(storage, key, { byteSize: content.byteLength, contentSha256 }),
            );
            expect(outcome.outcome).toBe('integrity_failed');
            if (outcome.outcome === 'integrity_failed') {
              expect(outcome.finding.observed).toEqual({ byteSize: other.byteLength, contentSha256: digestOf(other) });
            }
          }),
      );

      suite.effect('proves corruption only from a complete read of the recorded length whose digest differs', (ctx) =>
        Effect.gen(function* corruption() {
          const base = yield* s3ProviderConfig(ctx);
          const key = yield* freshKey;
          const original = encoder.encode('the confirmed bytes of one asset!');
          const tampered = encoder.encode('THE CONFIRMED BYTES OF ONE ASSET!');
          expect(tampered.byteLength).toBe(original.byteLength);
          // The deployment states the provider honours create-only writes, so an out-of-band overwrite uses the other mode.
          const createOnly = yield* makeS3ObjectStorage(base);
          const overwriting = yield* makeS3ObjectStorage({ ...base, conditionalCreate: 'unsupported' });
          yield* createOnly.put({ body: Stream.make(original), contentType: 'text/plain', key });
          const row = readyRow(createOnly, key, { byteSize: original.byteLength, contentSha256: digestOf(original) });
          expect((yield* verify(createOnly, row)).outcome).toBe('verified');
          yield* spaceSameKeyWrites;
          yield* overwriting.put({ body: Stream.make(tampered), contentType: 'text/plain', key });
          const outcome = yield* verify(createOnly, row);
          expect(outcome.outcome).toBe('integrity_failed');
          if (outcome.outcome === 'integrity_failed') {
            expect(outcome.finding.observed.contentSha256).toBe(digestOf(tampered));
            expect(outcome.finding.recorded.contentSha256).toBe(digestOf(original));
          }
        }),
      );
    },
  );
}

const freshIdentity = Effect.gen(function* freshIdentityEffect() {
  return yield* Schema.decodeUnknownEffect(TenantMediaAssetKeySchema)({
    mediaAssetId: yield* nextUuid,
    tenantId: yield* nextUuid,
  }).pipe(Effect.orDie);
});

/** A recorder that only counts the findings it was handed. */
const countingRecorder = (count: Ref.Ref<number>): typeof MediaIntegrityRecorder.Service => ({
  record: () => Ref.update(count, (value) => value + 1),
});

const failureOf = <Value, Failure>(exit: Exit.Exit<Value, Failure>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

/** The download of a stored object through the REAL S3 adapter: the byte half of the governed download. */
for (const provider of s3Providers) {
  it.layer(Layer.mergeAll(NodeCrypto.layer, FetchHttpClient.layer, provider.layer), { excludeTestServices: true })(
    `core media download bytes through the S3 adapter [${provider.label}]`,
    (suite) => {
      suite.effect(
        'delivers exactly the confirmed bytes, aborts corrupt ones without a clean end and records only proven corruption',
        (ctx) =>
          Effect.scoped(
            withProxy(ctx, (proxy, base) =>
              Effect.gen(function* downloadThroughS3() {
                // No adapter timeout: this suite injects resets and cuts, never a hang, and a loaded machine must not flake.
                const storage = yield* makeS3ObjectStorage(pointAt(base, proxy.origin));
                const overwriting = yield* makeS3ObjectStorage({ ...base, conditionalCreate: 'unsupported' });
                const identity = yield* freshIdentity;
                const key = deriveMediaStorageKey(identity);
                yield* recordKey(key);
                const original = patterned(SIZE, MIB, 11);
                const contentSha256 = yield* digestOfStream(original);
                yield* storage.put({ body: original, byteSize: SIZE, contentType: 'application/octet-stream', key });
                const row = readyRow(storage, key, { byteSize: SIZE, contentSha256 });
                const authorization = yield* Schema.decodeUnknownEffect(AssetDownloadAuthorizationSchema)({
                  byteSize: SIZE,
                  contentSha256,
                  displayFilename: 'contract.pdf',
                  mediaAssetRef: mediaAssetRefFor(identity),
                  mimeType: 'application/octet-stream',
                }).pipe(Effect.orDie);
                const recorded = yield* Ref.make(0);
                const recorder = countingRecorder(recorded);
                const download = (current: MediaVerifiableAsset = row) =>
                  streamConfirmedBytes(current, authorization).pipe(
                    Effect.provideService(ObjectStorage, storage),
                    Effect.provideService(MediaIntegrityRecorder, recorder),
                  );

                // The confirmed bytes, in full, with a clean end.
                const delivered = yield* download();
                const chunks = yield* Stream.runCollect(delivered.body);
                expect(digestOf(Buffer.concat(chunks))).toBe(contentSha256);
                expect(Buffer.concat(chunks).byteLength).toBe(SIZE);

                // CONTROLLED FAULT: a connection cut mid-body is an aborted body and proves nothing.
                proxy.setRules([{ fault: { after: MIB, kind: 'truncate-body' }, method: 'GET' }]);
                const cut = yield* download();
                const cutExit = yield* Effect.exit(Stream.runDrain(cut.body));
                expect(Schema.is(MediaDownloadAborted)(failureOf(cutExit))).toBe(true);
                expect(failureOf(cutExit)).toMatchObject({ reason: 'unavailable' });
                // CONTROLLED FAULT: the provider is unreachable before the first byte: an unavailable request.
                proxy.setRules([{ fault: { kind: 'reset-before' }, method: 'GET' }]);
                expect(Schema.is(MediaUnavailable)(failureOf(yield* Effect.exit(download())))).toBe(true);
                expect(yield* Ref.get(recorded)).toBe(0);

                // The same bytes still verify after the faults: nothing was promoted or changed.
                const again = yield* download();
                expect(digestOf(Buffer.concat(yield* Stream.runCollect(again.body)))).toBe(contentSha256);

                // Out-of-band replacement with same-size bytes: the body aborts, never ending cleanly, and it is recorded.
                const tampered = patterned(SIZE, MIB, 12);
                yield* spaceSameKeyWrites;
                yield* overwriting.put({
                  body: tampered,
                  byteSize: SIZE,
                  contentType: 'application/octet-stream',
                  key,
                });
                const corrupt = yield* download();
                const corruptExit = yield* Effect.exit(Stream.runDrain(corrupt.body));
                expect(Schema.is(MediaDownloadAborted)(failureOf(corruptExit))).toBe(true);
                expect(failureOf(corruptExit)).toMatchObject({ reason: 'integrity_failed' });
                expect(yield* Ref.get(recorded)).toBe(1);

                // Another size of a completely read object is proven corruption too: refused before any byte.
                yield* spaceSameKeyWrites;
                yield* overwriting.put({
                  body: Stream.make(encoder.encode('another, longer object body')),
                  contentType: 'text/plain',
                  key,
                });
                expect(Schema.is(MediaIntegrityFailed)(failureOf(yield* Effect.exit(download())))).toBe(true);
                expect(yield* Ref.get(recorded)).toBe(2);
              }),
            ),
          ),
      );
    },
  );
}
