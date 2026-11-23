import { sha256 } from '@noble/hashes/sha2.js';
import { NodeCrypto } from '@effect/platform-node';
import { Crypto, DateTime, Effect, Layer, Option, Redacted, Schema, Stream } from 'effect';
import type { Scope } from 'effect';
import { Hex } from 'effect/encoding';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { ContentDigest } from '../../src/media/content-digest.ts';
import { TenantMediaAssetKeySchema } from '../../src/media/identity.ts';
import {
  ObjectStorage,
  ObjectStorageChecksumUnsupported,
  ObjectStorageNetworkError,
  ObjectStorageObjectExists,
  ObjectStorageObjectMissing,
  ObjectStorageServerError,
  ObjectStorageTimeout,
} from '../../src/media/object-storage.ts';
import type { ObjectStorageFailure, ObjectStorageService } from '../../src/media/object-storage.ts';
import type { S3ObjectStorageConfigValue } from '../../src/media/s3-config.ts';
import { makeS3ObjectStorage } from '../../src/media/s3-object-storage.ts';
import { EMPTY_PAYLOAD_SHA256, signS3Request } from '../../src/media/s3-signing.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import { verifyStoredMediaObject } from '../../src/media/verification.ts';
import { emulatorConfig } from '../support/s3-emulator-config.ts';
import { loopbackOrigin, startS3FaultProxy } from '../support/s3-fault-proxy.ts';
import type { S3FaultProxy } from '../support/s3-fault-proxy.ts';

/*
 * EVIDENCE LEVEL: INTEGRATION EXECUTED against an S3-compatible EMULATOR (MinIO), NOT Cloudflare R2.
 *
 * The suite runs only when the CORE_MEDIA_S3_* settings in the process environment point at a LOOPBACK
 * S3-compatible server. It refuses any other endpoint, so it can never write test objects to a real provider.
 * Every fault below is CONTROLLED FAULT INJECTION by the proxy in tests/support, not a real incident. Nothing
 * here proves R2: its rows stay NOT VERIFIED until a real endpoint is configured and run by its owner.
 */

/**
 * The settings of the emulator. With none supplied the test is SKIPPED (never passed); a supplied endpoint that is
 * not loopback fails the suite instead of being written to.
 */
const MIB = 1024 * 1024;
const encoder = new TextEncoder();
const digestOf = (bytes: Uint8Array) => Hex.encode(sha256(bytes));
const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

const freshKey = Effect.gen(function* freshKeyEffect() {
  const identity = yield* Schema.decodeUnknownEffect(TenantMediaAssetKeySchema)({
    mediaAssetId: yield* nextUuid,
    tenantId: yield* nextUuid,
  }).pipe(Effect.orDie);
  return deriveMediaStorageKey(identity);
});

/** Deterministic pseudo-random bytes in chunks, never held whole. */
const patterned = (totalBytes: number, chunkBytes: number, seed = 1) =>
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

const tallyOf = <Failure>(body: Stream.Stream<Uint8Array, Failure>) =>
  Effect.gen(function* tallyEffect() {
    const digest = new ContentDigest();
    yield* Stream.runForEach(body, (chunk) => digest.add(chunk));
    return yield* digest.finish();
  });

const storageFor = makeS3ObjectStorage;

const failureOf = <Value>(effect: Effect.Effect<Value, ObjectStorageFailure>) =>
  Effect.flip(effect).pipe(Effect.map((failure) => failure));

/** One signed request straight to the provider, outside the adapter (used to observe and to seed the emulator). */
const rawProviderRequest = Effect.fn('S3IntegrationTest.raw')(function* rawProviderRequest(
  settings: S3ObjectStorageConfigValue,
  method: 'DELETE' | 'GET' | 'POST',
  url: URL,
) {
  const client = yield* HttpClient.HttpClient;
  // The provider's own clock signs the request: its `Date` header answers any request, even a refused one.
  const clock = yield* client.execute(HttpClientRequest.get(settings.endpoint.href));
  const headers = signS3Request({
    accessKeyId: settings.accessKeyId,
    headers: {},
    method,
    now: DateTime.makeUnsafe(clock.headers['date'] ?? ''),
    payloadSha256: EMPTY_PAYLOAD_SHA256,
    region: settings.region,
    secretAccessKey: settings.secretAccessKey,
    url,
  });
  return yield* client.execute(HttpClientRequest.make(method)(url.href).pipe(HttpClientRequest.setHeaders(headers)));
});

/** The keys that still have an unfinished multipart upload; it fails unless the provider answers a real listing. */
const unfinishedUploadKeys = Effect.fn('S3IntegrationTest.unfinishedUploads')(function* unfinishedUploads(
  settings: S3ObjectStorageConfigValue,
) {
  const response = yield* rawProviderRequest(
    settings,
    'GET',
    new URL(`${settings.endpoint.origin}/${settings.bucket}?uploads`),
  );
  const text = yield* response.text;
  expect(response.status).toBe(200);
  expect(text).toContain('<ListMultipartUploadsResult');
  return [...text.matchAll(/<Key>(?<key>[^<]+)<\/Key>/gu)].map((match) => match.groups?.['key'] ?? '');
});

const withProxy = <Value, Failure, Requirement>(
  ctx: { readonly skip: () => void },
  use: (proxy: S3FaultProxy) => Effect.Effect<Value, Failure, Requirement>,
): Effect.Effect<Value, Failure, Requirement | Scope.Scope> =>
  emulatorConfig(ctx).pipe(Effect.flatMap((base) => Effect.flatMap(startS3FaultProxy(base.endpoint), use)));

it.layer(Layer.mergeAll(NodeCrypto.layer, FetchHttpClient.layer), { excludeTestServices: true })(
  'core media S3-compatible object storage (emulator)',
  (suite) => {
    // Live clock (no test services): a request is signed with the real time, which a provider checks.
    const emulatorIt = suite.effect;

    emulatorIt('stores, stats and reads back a small object through the port', (ctx) =>
      Effect.gen(function* roundTrip() {
        const base = yield* emulatorConfig(ctx);
        const storage = yield* storageFor(base);
        const key = yield* freshKey;
        const bytes = encoder.encode('the bytes of one governed media asset');
        const stat = yield* storage.put({
          body: Stream.make(bytes),
          byteSize: bytes.byteLength,
          contentType: 'image/png',
          key,
        });
        expect(stat.byteSize).toBe(bytes.byteLength);
        // An unversioned bucket reports no version: the adapter never turns an ETag into one.
        expect(stat.versionRef).toBeUndefined();
        expect(yield* storage.stat(key)).toStrictEqual({ byteSize: bytes.byteLength });
        const opened = yield* storage.get(key);
        expect(opened.stat.byteSize).toBe(bytes.byteLength);
        expect((yield* tallyOf(opened.body)).contentSha256).toBe(digestOf(bytes));
      }),
    );

    emulatorIt('sees an unfinished multipart upload (positive control for the abort assertions)', (ctx) =>
      Effect.gen(function* positiveControl() {
        const base = yield* emulatorConfig(ctx);
        const key = yield* freshKey;
        const url = new URL(`${base.endpoint.origin}/${base.bucket}/${key}?uploads`);
        const started = yield* rawProviderRequest(base, 'POST', url);
        expect(started.status).toBe(200);
        const uploadId = /<UploadId>(?<id>[^<]+)<\/UploadId>/u.exec(yield* started.text)?.groups?.['id'] ?? '';
        expect(yield* unfinishedUploadKeys(base)).toContain(key);
        const abort = new URL(`${base.endpoint.origin}/${base.bucket}/${key}`);
        abort.searchParams.set('uploadId', uploadId);
        expect((yield* rawProviderRequest(base, 'DELETE', abort)).status).toBe(204);
        expect(yield* unfinishedUploadKeys(base)).not.toContain(key);
      }),
    );

    emulatorIt('stores an empty object', (ctx) =>
      Effect.gen(function* emptyObject() {
        const base = yield* emulatorConfig(ctx);
        const storage = yield* storageFor(base);
        const key = yield* freshKey;
        expect(
          (yield* storage.put({ body: Stream.empty, byteSize: 0, contentType: 'application/octet-stream', key }))
            .byteSize,
        ).toBe(0);
        const opened = yield* storage.get(key);
        expect(opened.stat.byteSize).toBe(0);
        expect((yield* tallyOf(opened.body)).byteSize).toBe(0);
      }),
    );

    emulatorIt('answers a missing object with the provider-missing failure, never a Core absence', (ctx) =>
      Effect.gen(function* missing() {
        const base = yield* emulatorConfig(ctx);
        const storage = yield* storageFor(base);
        const key = yield* freshKey;
        const stat = yield* failureOf(storage.stat(key));
        const get = yield* failureOf(storage.get(key));
        expect(Schema.is(ObjectStorageObjectMissing)(stat)).toBe(true);
        expect(Schema.is(ObjectStorageObjectMissing)(get)).toBe(true);
      }),
    );

    emulatorIt('never overwrites an object that is already stored (create-only write)', (ctx) =>
      Effect.gen(function* createOnly() {
        const base = yield* emulatorConfig(ctx);
        const storage = yield* storageFor(base);
        const key = yield* freshKey;
        const first = encoder.encode('first and confirmed');
        yield* storage.put({ body: Stream.make(first), byteSize: first.byteLength, contentType: 'text/plain', key });
        const second = encoder.encode('a later write that must not win');
        const refused = yield* failureOf(
          storage.put({ body: Stream.make(second), byteSize: second.byteLength, contentType: 'text/plain', key }),
        );
        expect(Schema.is(ObjectStorageObjectExists)(refused)).toBe(true);
        const opened = yield* storage.get(key);
        expect((yield* tallyOf(opened.body)).contentSha256).toBe(digestOf(first));
      }),
    );

    emulatorIt('never overwrites an object with a multipart write either', (ctx) =>
      Effect.gen(function* createOnlyMultipart() {
        const base = yield* emulatorConfig(ctx);
        const storage = yield* storageFor(base);
        const key = yield* freshKey;
        const first = encoder.encode('first and confirmed');
        yield* storage.put({ body: Stream.make(first), byteSize: first.byteLength, contentType: 'text/plain', key });
        const refused = yield* failureOf(
          storage.put({ body: patterned(6 * MIB, MIB), byteSize: 6 * MIB, contentType: 'text/plain', key }),
        );
        expect(Schema.is(ObjectStorageObjectExists)(refused)).toBe(true);
        expect((yield* tallyOf((yield* storage.get(key)).body)).contentSha256).toBe(digestOf(first));
        expect(yield* unfinishedUploadKeys(base)).not.toContain(key);
      }),
    );

    emulatorIt('streams a multi-part object in bounded parts and reads it back identically', (ctx) =>
      Effect.gen(function* multipart() {
        const base = yield* emulatorConfig(ctx);
        const storage = yield* storageFor(base);
        const key = yield* freshKey;
        const size = 11 * MIB + 17;
        const expected = yield* tallyOf(patterned(size, 3 * MIB + 5));
        const stat = yield* storage.put({
          body: patterned(size, 3 * MIB + 5),
          byteSize: size,
          contentType: 'application/octet-stream',
          key,
        });
        expect(stat.byteSize).toBe(size);
        expect((yield* storage.stat(key)).byteSize).toBe(size);
        expect(yield* tallyOf((yield* storage.get(key)).body)).toStrictEqual(expected);
      }),
    );

    emulatorIt('does not create an empty trailing part when the object is an exact multiple of the part size', (ctx) =>
      Effect.gen(function* exactParts() {
        const base = yield* emulatorConfig(ctx);
        const storage = yield* storageFor(base);
        const key = yield* freshKey;
        const size = 10 * MIB;
        const expected = yield* tallyOf(patterned(size, MIB));
        yield* storage.put({
          body: patterned(size, MIB),
          byteSize: size,
          contentType: 'application/octet-stream',
          key,
        });
        expect(yield* tallyOf((yield* storage.get(key)).body)).toStrictEqual(expected);
      }),
    );

    emulatorIt('leaves nothing readable and no unfinished upload when the body fails after a part was sent', (ctx) =>
      Effect.gen(function* failingBody() {
        const base = yield* emulatorConfig(ctx);
        const storage = yield* storageFor(base);
        const key = yield* freshKey;
        const body = Stream.concat(patterned(7 * MIB, MIB), Stream.fail('the request body broke' as const));
        const failure = yield* Effect.flip(
          storage.put({ body, byteSize: 9 * MIB, contentType: 'application/octet-stream', key }),
        );
        expect(failure).toBe('the request body broke');
        expect(Schema.is(ObjectStorageObjectMissing)(yield* failureOf(storage.stat(key)))).toBe(true);
        expect(yield* unfinishedUploadKeys(base)).not.toContain(key);
      }),
    );

    emulatorIt('never sends a single request when the body fails inside the first part', (ctx) =>
      Effect.gen(function* failingSmallBody() {
        const base = yield* emulatorConfig(ctx);
        const storage = yield* storageFor(base);
        const key = yield* freshKey;
        const body = Stream.concat(Stream.make(encoder.encode('partial')), Stream.fail('broken' as const));
        expect(yield* Effect.flip(storage.put({ body, contentType: 'text/plain', key }))).toBe('broken');
        expect(Schema.is(ObjectStorageObjectMissing)(yield* failureOf(storage.stat(key)))).toBe(true);
      }),
    );

    emulatorIt('does not ask the provider to verify a whole-object SHA-256', (ctx) =>
      Effect.gen(function* checksum() {
        const base = yield* emulatorConfig(ctx);
        const storage = yield* storageFor(base);
        const bytes = encoder.encode('x');
        const failure = yield* failureOf(
          storage.put({
            body: Stream.make(bytes),
            contentType: 'text/plain',
            expectedSha256: digestOf(bytes),
            key: yield* freshKey,
          }),
        );
        expect(Schema.is(ObjectStorageChecksumUnsupported)(failure)).toBe(true);
      }),
    );

    emulatorIt('maps a refused credential to a typed unavailable failure that never carries the credential', (ctx) =>
      Effect.gen(function* badCredential() {
        const base = yield* emulatorConfig(ctx);
        const secret = 'not-the-real-secret-value';
        const storage = yield* storageFor({ ...base, secretAccessKey: Redacted.make(secret) });
        const failure = yield* failureOf(storage.get(yield* freshKey));
        expect(Schema.is(ObjectStorageServerError)(failure)).toBe(true);
        expect(jsonText(failure)).not.toContain(secret);
        expect(jsonText(failure)).not.toContain(Redacted.value(base.accessKeyId));
        expect(jsonText(failure)).not.toContain(base.bucket);
        expect(jsonText(failure)).not.toContain(base.endpoint.host);
      }),
    );

    emulatorIt('maps a missing bucket on a write to an unavailable failure, not a missing object', (ctx) =>
      Effect.gen(function* missingBucket() {
        const base = yield* emulatorConfig(ctx);
        const storage = yield* storageFor({ ...base, bucket: `absent-${(yield* nextUuid).slice(0, 8)}` });
        const bytes = encoder.encode('x');
        const failure = yield* failureOf(
          storage.put({ body: Stream.make(bytes), contentType: 'text/plain', key: yield* freshKey }),
        );
        expect(Schema.is(ObjectStorageServerError)(failure)).toBe(true);
        expect(Schema.is(ObjectStorageObjectMissing)(failure)).toBe(false);
      }),
    );

    emulatorIt('maps a connection that nothing listens on to a network failure', (ctx) =>
      Effect.gen(function* outage() {
        const base = yield* emulatorConfig(ctx);
        const storage = yield* storageFor({ ...base, endpoint: loopbackOrigin(1) });
        const failure = yield* failureOf(storage.stat(yield* freshKey));
        expect(Schema.is(ObjectStorageNetworkError)(failure)).toBe(true);
      }),
    );

    emulatorIt('does not hand bytes to a caller that only knows the object key (the provider is private)', (ctx) =>
      Effect.gen(function* anonymous() {
        const base = yield* emulatorConfig(ctx);
        const storage = yield* storageFor(base);
        const key = yield* freshKey;
        const bytes = encoder.encode('private bytes');
        yield* storage.put({ body: Stream.make(bytes), contentType: 'text/plain', key });
        const { bucket, endpoint } = base;
        const anonymousRead = yield* (yield* HttpClient.HttpClient).execute(
          HttpClientRequest.get(`${endpoint.origin}/${bucket}/${key}`),
        );
        expect(anonymousRead.status).toBe(403);
        // The port exposes no URL, no signing and no listing: a credential holder behind it cannot mint one either.
        expect(Object.keys(storage).toSorted()).toStrictEqual(['get', 'providerId', 'put', 'stat']);
      }),
    );

    /* ---------------- CONTROLLED FAULT INJECTION through a real HTTP proxy to the emulator ---------------- */

    emulatorIt('CONTROLLED FAULT: a provider 503 on a write is an unavailable failure and nothing is stored', (ctx) =>
      Effect.scoped(
        withProxy(ctx, (proxy) =>
          Effect.gen(function* serverFault() {
            const base = yield* emulatorConfig(ctx);
            const storage = yield* storageFor({ ...base, endpoint: proxy.origin });
            const key = yield* freshKey;
            proxy.setRules([{ fault: { code: 'ServiceUnavailable', kind: 'status', status: 503 }, method: 'PUT' }]);
            const bytes = encoder.encode('bytes');
            const failure = yield* failureOf(storage.put({ body: Stream.make(bytes), contentType: 'text/plain', key }));
            expect(Schema.is(ObjectStorageServerError)(failure)).toBe(true);
            expect(proxy.injected()).toStrictEqual([{ fault: 'status-503-ServiceUnavailable', method: 'PUT' }]);
            expect(Schema.is(ObjectStorageObjectMissing)(yield* failureOf(storage.stat(key)))).toBe(true);
            // The same adapter reconnects once the fault is spent.
            yield* storage.put({ body: Stream.make(bytes), contentType: 'text/plain', key });
            expect((yield* storage.stat(key)).byteSize).toBe(bytes.byteLength);
          }),
        ),
      ),
    );

    emulatorIt('CONTROLLED FAULT: a reset connection is a network failure and the next request succeeds', (ctx) =>
      Effect.scoped(
        withProxy(ctx, (proxy) =>
          Effect.gen(function* resetFault() {
            const base = yield* emulatorConfig(ctx);
            const storage = yield* storageFor({ ...base, endpoint: proxy.origin });
            const key = yield* freshKey;
            const bytes = encoder.encode('bytes');
            yield* storage.put({ body: Stream.make(bytes), contentType: 'text/plain', key });
            proxy.setRules([{ fault: { kind: 'reset-before' }, method: 'HEAD' }]);
            const failure = yield* failureOf(storage.stat(key));
            expect(Schema.is(ObjectStorageNetworkError)(failure)).toBe(true);
            expect((yield* storage.stat(key)).byteSize).toBe(bytes.byteLength);
          }),
        ),
      ),
    );

    emulatorIt('CONTROLLED FAULT: a hung provider times out only when the deployment configures a timeout', (ctx) =>
      Effect.scoped(
        withProxy(ctx, (proxy) =>
          Effect.gen(function* hangFault() {
            const base = yield* emulatorConfig(ctx);
            const storage = yield* storageFor({
              ...base,
              endpoint: proxy.origin,
              requestTimeoutMillis: Option.some(250),
            });
            proxy.setRules([{ fault: { kind: 'hang' }, method: 'HEAD' }]);
            const failure = yield* failureOf(storage.stat(yield* freshKey));
            expect(Schema.is(ObjectStorageTimeout)(failure)).toBe(true);
            expect(proxy.injected()).toStrictEqual([{ fault: 'hang', method: 'HEAD' }]);
          }),
        ),
      ),
    );

    emulatorIt(
      'CONTROLLED FAULT: a connection cut in the middle of a read is a failed stream, never a clean end',
      (ctx) =>
        Effect.scoped(
          withProxy(ctx, (proxy) =>
            Effect.gen(function* truncatedRead() {
              const base = yield* emulatorConfig(ctx);
              const storage = yield* storageFor({ ...base, endpoint: proxy.origin });
              const key = yield* freshKey;
              const size = 3 * MIB;
              yield* storage.put({
                body: patterned(size, MIB),
                byteSize: size,
                contentType: 'application/octet-stream',
                key,
              });
              proxy.setRules([{ fault: { after: MIB, kind: 'truncate-body' }, method: 'GET' }]);
              const opened = yield* storage.get(key);
              const failure = yield* Effect.flip(Stream.runDrain(opened.body));
              expect(Schema.is(ObjectStorageNetworkError)(failure)).toBe(true);
              // Read-back verification must report this as unverifiable, not as a mismatch of the stored object.
              proxy.setRules([{ fault: { after: MIB, kind: 'truncate-body' }, method: 'GET' }]);
              const verification = yield* verifyStoredMediaObject({
                expected: { byteSize: size },
                storageKey: key,
                storageProvider: storage.providerId,
              }).pipe(Effect.provideService(ObjectStorage, storage));
              expect(verification.outcome).toBe('unverifiable');
            }),
          ),
        ),
    );

    emulatorIt(
      'CONTROLLED FAULT: a write that committed but was never acknowledged is uncertain, and a retry cannot replace it',
      (ctx) =>
        Effect.scoped(
          withProxy(ctx, (proxy) =>
            Effect.gen(function* uncertainCommit() {
              const base = yield* emulatorConfig(ctx);
              const storage = yield* storageFor({ ...base, endpoint: proxy.origin });
              const key = yield* freshKey;
              const bytes = encoder.encode('committed at the provider, unknown to the caller');
              proxy.setRules([{ fault: { kind: 'drop-answer-after-commit' }, method: 'PUT' }]);
              const failure = yield* failureOf(
                storage.put({ body: Stream.make(bytes), contentType: 'text/plain', key }),
              );
              expect(Schema.is(ObjectStorageNetworkError)(failure)).toBe(true);
              // The caller cannot tell: the provider holds the object although the put failed.
              expect((yield* storage.stat(key)).byteSize).toBe(bytes.byteLength);
              // A retry does not silently replace it; the stored object is judged by read-back.
              const retry = yield* failureOf(storage.put({ body: Stream.make(bytes), contentType: 'text/plain', key }));
              expect(Schema.is(ObjectStorageObjectExists)(retry)).toBe(true);
              const verification = yield* verifyStoredMediaObject({
                expected: { byteSize: bytes.byteLength, contentSha256: digestOf(bytes) },
                storageKey: key,
                storageProvider: storage.providerId,
              }).pipe(Effect.provideService(ObjectStorage, storage));
              expect(verification.outcome).toBe('verified');
            }),
          ),
        ),
    );

    emulatorIt(
      'CONTROLLED FAULT: a hash mismatch of stored bytes is a mismatch, an unreachable provider is not',
      (ctx) =>
        Effect.scoped(
          withProxy(ctx, (proxy) =>
            Effect.gen(function* mismatch() {
              const base = yield* emulatorConfig(ctx);
              const storage = yield* storageFor({ ...base, endpoint: proxy.origin });
              const key = yield* freshKey;
              const stored = encoder.encode('what the provider actually holds');
              yield* storage.put({ body: Stream.make(stored), contentType: 'text/plain', key });
              const declared = encoder.encode('what the asset was declared as');
              const wrongHash = yield* verifyStoredMediaObject({
                expected: { byteSize: stored.byteLength, contentSha256: digestOf(declared) },
                storageKey: key,
                storageProvider: storage.providerId,
              }).pipe(Effect.provideService(ObjectStorage, storage));
              expect(wrongHash.outcome).toBe('mismatch');
              proxy.setRules([{ fault: { code: 'InternalError', kind: 'status', status: 500 }, method: 'GET' }]);
              const outage = yield* verifyStoredMediaObject({
                expected: { byteSize: stored.byteLength, contentSha256: digestOf(stored) },
                storageKey: key,
                storageProvider: storage.providerId,
              }).pipe(Effect.provideService(ObjectStorage, storage));
              expect(outage.outcome).toBe('unverifiable');
            }),
          ),
        ),
    );

    emulatorIt(
      'CONTROLLED FAULT: a part upload that fails aborts the multipart upload and leaves nothing readable',
      (ctx) =>
        Effect.scoped(
          withProxy(ctx, (proxy) =>
            Effect.gen(function* partFault() {
              const base = yield* emulatorConfig(ctx);
              const storage: ObjectStorageService = yield* storageFor({ ...base, endpoint: proxy.origin });
              const key = yield* freshKey;
              proxy.setRules([
                {
                  fault: { code: 'InternalError', kind: 'status', status: 500 },
                  method: 'PUT',
                  pathIncludes: 'partNumber=2',
                },
              ]);
              const failure = yield* failureOf(
                storage.put({
                  body: patterned(12 * MIB, MIB),
                  byteSize: 12 * MIB,
                  contentType: 'application/octet-stream',
                  key,
                }),
              );
              expect(Schema.is(ObjectStorageServerError)(failure)).toBe(true);
              expect(Schema.is(ObjectStorageObjectMissing)(yield* failureOf(storage.stat(key)))).toBe(true);
              expect(yield* unfinishedUploadKeys(base)).not.toContain(key);
            }),
          ),
        ),
    );
  },
);
