import { sha256 } from '@noble/hashes/sha2.js';
import { NodeCrypto } from '@effect/platform-node';
import { Config, ConfigProvider, Crypto, DateTime, Effect, Layer, Option, Schema, Stream } from 'effect';
import type { Scope } from 'effect';
import { Hex } from 'effect/encoding';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { TenantMediaAssetKeySchema } from '../../src/media/identity.ts';
import { ObjectStorage } from '../../src/media/object-storage.ts';
import type { ObjectStorageService } from '../../src/media/object-storage.ts';
import { ObjectStorageConfigError, loadS3ObjectStorageConfig } from '../../src/media/s3-config.ts';
import type { S3ObjectStorageConfigValue } from '../../src/media/s3-config.ts';
import { makeS3ObjectStorage } from '../../src/media/s3-object-storage.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import { verifyReadyMediaAsset } from '../../src/media/verified-read.ts';
import type { MediaVerifiableAsset } from '../../src/media/verified-read.ts';
import { startS3FaultProxy } from '../support/s3-fault-proxy.ts';
import type { S3FaultProxy } from '../support/s3-fault-proxy.ts';

/*
 * EVIDENCE LEVEL: INTEGRATION EXECUTED against an S3-compatible EMULATOR (MinIO), NOT Cloudflare R2.
 *
 * The verified read of a READY asset through the REAL S3 adapter and a real HTTP exchange. Every fault is
 * CONTROLLED FAULT INJECTION by the proxy in tests/support (or an out-of-band write for the corruption), not a real
 * incident, and none of it proves R2: its rows stay NOT VERIFIED until a real endpoint is configured and run by its
 * owner. The suite runs only when CORE_MEDIA_S3_* points at a LOOPBACK server; with none supplied it is skipped.
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const configuredEndpoint = Config.schema(Schema.Trim, 'CORE_MEDIA_S3_ENDPOINT').pipe(
  Config.option,
  Config.map(Option.filter((value) => value.length > 0)),
);

const emulatorConfig = (ctx: { readonly skip: () => void }) =>
  // Skipped only when no endpoint is configured at all. The loader reads its settings concurrently, so which missing
  // setting it reports first is not stable; the endpoint is therefore judged here, and a partial or malformed
  // configuration beside a configured endpoint fails the test.
  configuredEndpoint.parse(ConfigProvider.fromEnv({ preserveEmptyStrings: true })).pipe(
    Effect.orDie,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.sync(() => ctx.skip()).pipe(Effect.andThen(Effect.never)),
        onSome: () =>
          loadS3ObjectStorageConfig({ envPath: '/nonexistent/core-media-s3-test.env' }).pipe(
            Effect.filterOrFail(
              (settings) => LOOPBACK.has(settings.endpoint.hostname),
              () =>
                new ObjectStorageConfigError({ reason: 'The S3 integration suite writes only to a loopback emulator' }),
            ),
            Effect.orDie,
          ),
      }),
    ),
  );

const withProxy = <Value, Failure, Requirement>(
  ctx: { readonly skip: () => void },
  use: (proxy: S3FaultProxy, base: S3ObjectStorageConfigValue) => Effect.Effect<Value, Failure, Requirement>,
): Effect.Effect<Value, Failure, Requirement | Scope.Scope> =>
  emulatorConfig(ctx).pipe(
    Effect.flatMap((base) => Effect.flatMap(startS3FaultProxy(base.endpoint), (proxy) => use(proxy, base))),
  );

const encoder = new TextEncoder();
const MIB = 1024 * 1024;
const digestOf = (bytes: Uint8Array) => Hex.encode(sha256(bytes));
const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

const freshKey = Effect.gen(function* freshKeyEffect() {
  const identity = yield* Schema.decodeUnknownEffect(TenantMediaAssetKeySchema)({
    mediaAssetId: yield* nextUuid,
    tenantId: yield* nextUuid,
  }).pipe(Effect.orDie);
  return deriveMediaStorageKey(identity);
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

it.layer(Layer.mergeAll(NodeCrypto.layer, FetchHttpClient.layer), { excludeTestServices: true })(
  'core media verified read through the S3 adapter (emulator)',
  (suite) => {
    suite.effect(
      'verifies a stored object, and an outage of any kind is unavailable until the same bytes answer again',
      (ctx) =>
        Effect.scoped(
          withProxy(ctx, (proxy, base) =>
            Effect.gen(function* outages() {
              const storage = yield* makeS3ObjectStorage({
                ...base,
                endpoint: proxy.origin,
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
      'answers a provider 404 as a missing object and a differing declared length as inconsistent metadata',
      (ctx) =>
        Effect.gen(function* missingAndLength() {
          const base = yield* emulatorConfig(ctx);
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
          expect(
            yield* verify(storage, readyRow(storage, key, { byteSize: content.byteLength, contentSha256 })),
          ).toEqual({
            outcome: 'inconsistent_metadata',
            reason: 'declared_size_differs',
          });
        }),
    );

    suite.effect('proves corruption only from a complete read of the recorded length whose digest differs', (ctx) =>
      Effect.gen(function* corruption() {
        const base = yield* emulatorConfig(ctx);
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
