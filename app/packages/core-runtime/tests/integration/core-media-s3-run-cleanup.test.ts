import { NodeCrypto } from '@effect/platform-node';
import { Cause, Effect, Exit, Layer, Redacted, Stream } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { makeS3ObjectStorage } from '../../src/media/s3-object-storage.ts';
import { parseS3ObjectStorageConfig } from '../../src/media/s3-config.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import { startR2BehaviourMock } from '../support/r2-behaviour-mock.ts';
import type { R2BehaviourMock } from '../support/r2-behaviour-mock.ts';
import { startS3FaultProxy } from '../support/s3-fault-proxy.ts';
import { cleanupRecordedKeys } from '../support/s3-run-cleanup.ts';

/*
 * The best-effort cleanup of the opt-in REAL-endpoint run, proven against the R2-behaviour MOCK (NOT R2): it removes
 * exactly the keys the run recorded (and the unfinished uploads under them), and nothing else.
 */

const encoder = new TextEncoder();
const RUN_TENANT = '11111111-1111-4111-8111-111111111111';
const FOREIGN_TENANT = '22222222-2222-4222-8222-222222222222';
const keyOf = (tenantId: string, mediaAssetId: string) => deriveMediaStorageKey({ mediaAssetId, tenantId });

const configOf = (mock: R2BehaviourMock) =>
  parseS3ObjectStorageConfig({
    CORE_MEDIA_S3_ACCESS_KEY_ID: Redacted.value(mock.credentials.accessKeyId),
    CORE_MEDIA_S3_ADDRESSING_STYLE: 'path',
    CORE_MEDIA_S3_BUCKET: mock.bucket,
    CORE_MEDIA_S3_CONDITIONAL_CREATE: 'supported',
    CORE_MEDIA_S3_ENDPOINT: mock.origin.origin,
    CORE_MEDIA_S3_REGION: 'auto',
    CORE_MEDIA_S3_SECRET_ACCESS_KEY: Redacted.value(mock.credentials.secretAccessKey),
  }).pipe(Effect.orDie);

const withMock = <Value, Failure, Requirement>(
  use: (mock: R2BehaviourMock) => Effect.Effect<Value, Failure, Requirement>,
) => Effect.scoped(startR2BehaviourMock().pipe(Effect.flatMap(use)));

it.layer(Layer.mergeAll(NodeCrypto.layer, FetchHttpClient.layer), { excludeTestServices: true })(
  'core media S3 run cleanup (R2-behaviour MOCK, NOT R2)',
  (suite) => {
    suite.effect('deletes the recorded keys and aborts their unfinished uploads, and leaves everything else', () =>
      withMock((mock) =>
        Effect.gen(function* cleanup() {
          const config = yield* configOf(mock);
          const storage = yield* makeS3ObjectStorage(config);
          const recordedKey = keyOf(RUN_TENANT, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
          const unfinishedKey = keyOf(RUN_TENANT, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
          const foreignKey = keyOf(FOREIGN_TENANT, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
          yield* storage.put({
            body: Stream.make(encoder.encode('written by the run')),
            contentType: 'text/plain',
            key: recordedKey,
          });
          // Something the run did NOT create: an object and an unfinished upload under other keys.
          mock.admin.put(mock.bucket, foreignKey, encoder.encode('someone else'));
          mock.admin.put(mock.bucket, 'a/key/that/is/not/ours', encoder.encode('someone else too'));
          // An upload that is still unfinished under a recorded key, and one under a key the run never recorded.
          mock.admin.startUpload(mock.bucket, unfinishedKey);
          mock.admin.startUpload(mock.bucket, foreignKey);

          const report = yield* cleanupRecordedKeys(config, [recordedKey, unfinishedKey]);

          expect(report).toStrictEqual({ aborted: 1, deleted: 2, failed: 0 });
          expect(mock.admin.keys(mock.bucket).toSorted()).toStrictEqual(
            ['a/key/that/is/not/ours', foreignKey].toSorted(),
          );
          expect(mock.admin.uploads(mock.bucket)).toStrictEqual([foreignKey]);
        }),
      ),
    );

    suite.effect('never touches anything when nothing was recorded', () =>
      withMock((mock) =>
        Effect.gen(function* nothingRecorded() {
          const config = yield* configOf(mock);
          mock.admin.put(mock.bucket, 'untouched', encoder.encode('x'));
          const report = yield* cleanupRecordedKeys(config, []);
          expect(report).toStrictEqual({ aborted: 0, deleted: 0, failed: 0 });
          expect(mock.admin.keys(mock.bucket)).toStrictEqual(['untouched']);
          expect(mock.requests().filter((request) => request.method === 'DELETE')).toStrictEqual([]);
        }),
      ),
    );

    suite.effect('is best effort: a refused delete is counted and reported, never thrown', () =>
      withMock((mock) =>
        Effect.gen(function* refused() {
          const config = yield* configOf(mock);
          const key = keyOf(RUN_TENANT, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
          mock.admin.put(mock.bucket, key, encoder.encode('x'));
          // A credential the provider refuses: every request fails, the cleanup still returns a report.
          const wrong = { ...config, secretAccessKey: config.accessKeyId };
          const report = yield* cleanupRecordedKeys(wrong, [key]);
          expect(report.deleted).toBe(0);
          expect(report.failed).toBeGreaterThan(0);
          expect(mock.admin.keys(mock.bucket)).toContain(key);
        }),
      ),
    );

    suite.effect('the fault proxy forwards in plain HTTP, so it refuses an upstream that is not on loopback', () =>
      Effect.gen(function* proxyRefusal() {
        const exit = yield* Effect.exit(
          Effect.scoped(startS3FaultProxy(new URL('https://0123456789abcdef.r2.cloudflarestorage.com'))),
        );
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      }),
    );
  },
);
