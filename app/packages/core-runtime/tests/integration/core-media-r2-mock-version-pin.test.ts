import { sha256 } from '@noble/hashes/sha2.js';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Layer, Redacted, Stream } from 'effect';
import { Hex } from 'effect/encoding';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { ObjectStorage } from '../../src/media/object-storage.ts';
import { parseS3ObjectStorageConfig } from '../../src/media/s3-config.ts';
import { makeS3ObjectStorage } from '../../src/media/s3-object-storage.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import { statReadyMediaAsset } from '../../src/media/verified-read.ts';
import type { MediaVerifiableAsset } from '../../src/media/verified-read.ts';
import { R2_MOCK_LABEL, startR2BehaviourMock } from '../support/r2-behaviour-mock.ts';
import type { R2BehaviourMock } from '../support/r2-behaviour-mock.ts';

/*
 * R2-behaviour MOCK built from documentation, NOT R2. How the adapter fills the version pin of an asset when the
 * provider has no object versioning (R2 documents GetBucketVersioning and PutBucketVersioning as unimplemented, so it
 * sends no `x-amz-version-id`): the pin is `etag:<ETag>` of the stored object. These tests prove, against a provider
 * that sends no version id, that the pin
 *   - exists after a single write and after a multipart write, and is the same on a write answer, a read and a stat;
 *   - is the documented ETag (MD5 of a part; for a multipart object the MD5 of the concatenated binary MD5s, a hyphen
 *     and the number of parts: https://developers.cloudflare.com/r2/objects/multipart-objects/);
 *   - changes when a same-length object is written under the key out of band, which Current's stat then reports.
 * Whether R2's ETag of a single PutObject is the MD5 of the body is NOT VERIFIED by the pages read: the single-object
 * assertions here are about the mock and are the first thing a real run would confirm or refute.
 */

const encoder = new TextEncoder();
const MIB = 1024 * 1024;
const node = process.getBuiltinModule('node:crypto');
const md5 = (bytes: Uint8Array) => node.createHash('md5').update(bytes).digest();

const settingsOf = (mock: R2BehaviourMock) =>
  parseS3ObjectStorageConfig({
    CORE_MEDIA_S3_ACCESS_KEY_ID: Redacted.value(mock.credentials.accessKeyId),
    CORE_MEDIA_S3_ADDRESSING_STYLE: 'path',
    CORE_MEDIA_S3_BUCKET: mock.bucket,
    CORE_MEDIA_S3_CONDITIONAL_CREATE: 'supported',
    CORE_MEDIA_S3_ENDPOINT: mock.origin.origin,
    CORE_MEDIA_S3_REGION: 'auto',
    CORE_MEDIA_S3_SECRET_ACCESS_KEY: Redacted.value(mock.credentials.secretAccessKey),
  }).pipe(Effect.orDie);

const withStorage = <Value, Failure, Requirement>(
  run: (provider: {
    readonly mock: R2BehaviourMock;
    readonly storage: Effect.Success<ReturnType<typeof makeS3ObjectStorage>>;
  }) => Effect.Effect<Value, Failure, Requirement>,
) =>
  Effect.scoped(
    Effect.gen(function* open() {
      const mock = yield* startR2BehaviourMock();
      const storage = yield* makeS3ObjectStorage(yield* settingsOf(mock));
      return yield* run({ mock, storage });
    }),
  );

const liveServices = Layer.mergeAll(NodeCrypto.layer, FetchHttpClient.layer);

const keyOf = (seed: string) =>
  deriveMediaStorageKey({
    mediaAssetId: `00000000-0000-4000-8000-${seed.padStart(12, '0')}`,
    tenantId: '33333333-3333-4333-8333-333333333333',
  });

const readyRowWithPin = (
  storageProvider: string,
  key: ReturnType<typeof deriveMediaStorageKey>,
  stored: { readonly byteSize: number; readonly versionRef: string },
): MediaVerifiableAsset => ({
  byteSize: BigInt(stored.byteSize),
  contentSha256: Hex.encode(sha256(new Uint8Array(0))),
  processingStatus: 'ready',
  sealedAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
  storageKey: key,
  storageObjectVersionRef: stored.versionRef,
  storageProvider,
});

it.layer(liveServices, { excludeTestServices: true })(
  `${R2_MOCK_LABEL}: the version pin of an unversioned provider`,
  (suite) => {
    suite.effect('pins a single object by its ETag, alike on the write answer, a read and a stat', () =>
      withStorage(({ storage }) =>
        Effect.gen(function* singlePin() {
          const key = keyOf('1');
          const bytes = encoder.encode('a single object, one PutObject');
          const written = yield* storage.put({
            body: Stream.make(bytes),
            byteSize: bytes.byteLength,
            contentType: 'text/plain',
            key,
          });
          const expected = `etag:"${md5(bytes).toString('hex')}"`;
          expect(written.versionRef).toBe(expected);
          expect((yield* storage.stat(key)).versionRef).toBe(expected);
          expect((yield* storage.get(key)).stat.versionRef).toBe(expected);
        }),
      ),
    );

    suite.effect('pins a multipart object by the documented multipart ETag, alike on a read and a stat', () =>
      withStorage(({ storage }) =>
        Effect.gen(function* multipartPin() {
          const key = keyOf('2');
          const bytes = new Uint8Array(11 * MIB).map((_, index) => index % 251);
          yield* storage.put({
            body: Stream.make(bytes),
            byteSize: bytes.byteLength,
            contentType: 'application/octet-stream',
            key,
          });
          // 11 MiB in parts of 5 MiB: 5 + 5 + 1.
          const parts = [bytes.subarray(0, 5 * MIB), bytes.subarray(5 * MIB, 10 * MIB), bytes.subarray(10 * MIB)];
          const expected = `etag:"${md5(Buffer.concat(parts.map((part) => md5(part)))).toString('hex')}-3"`;
          expect((yield* storage.stat(key)).versionRef).toBe(expected);
          const opened = yield* storage.get(key);
          yield* Stream.runDrain(opened.body);
          expect(opened.stat.versionRef).toBe(expected);
        }),
      ),
    );

    suite.effect(
      'sees a same-length object written under the key out of band: the pin changes, Current is not present',
      () =>
        withStorage(({ mock, storage }) =>
          Effect.gen(function* replaced() {
            const key = keyOf('3');
            const original = encoder.encode('the confirmed bytes of one asset!');
            const other = encoder.encode('THE CONFIRMED BYTES OF ONE ASSET!');
            expect(other.byteLength).toBe(original.byteLength);
            const written = yield* storage.put({
              body: Stream.make(original),
              byteSize: original.byteLength,
              contentType: 'text/plain',
              key,
            });
            const row = readyRowWithPin(storage.providerId, key, {
              byteSize: original.byteLength,
              versionRef: written.versionRef ?? '',
            });
            const stat = () => statReadyMediaAsset(row).pipe(Effect.provideService(ObjectStorage, storage));
            expect(yield* stat()).toStrictEqual({ byteSize: original.byteLength, outcome: 'present' });
            // OUT-OF-BAND WRITE: an operator or a second writer replaces the object with same-length bytes.
            mock.admin.put(mock.bucket, key, other);
            expect((yield* storage.stat(key)).byteSize).toBe(original.byteLength);
            expect((yield* storage.stat(key)).versionRef).not.toBe(written.versionRef);
            expect(yield* stat()).toMatchObject({ outcome: 'inconsistent_metadata', reason: 'object_replaced' });
          }),
        ),
    );
  },
);
