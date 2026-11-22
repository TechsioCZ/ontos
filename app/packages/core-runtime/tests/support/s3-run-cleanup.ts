import { Clock, DateTime, Effect } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import type { HttpClientError } from 'effect/http';

import type { S3ObjectStorageConfigValue } from '../../src/media/s3-config.ts';
import { EMPTY_PAYLOAD_SHA256, signS3Request } from '../../src/media/s3-signing.ts';

/*
 * The best-effort cleanup of the opt-in run of the S3 provider suite against a REAL endpoint. It removes ONLY the
 * keys the run recorded (exactly: the keys are the hashes of random identities the run created) and aborts the
 * unfinished multipart uploads that sit under those same keys. It never lists objects, never deletes by prefix and
 * never touches a key it was not handed: anything else in the bucket is left exactly as it was. It is not part of the
 * production adapter (the port has no delete); it is a test-support tool, and a failure of any single request is
 * counted and reported, never thrown.
 */

export interface S3CleanupReport {
  /** Unfinished multipart uploads under a recorded key that were aborted. */
  readonly aborted: number;
  /** Recorded keys whose DELETE the provider accepted (including "already absent"). */
  readonly deleted: number;
  /** Requests the provider refused or that did not complete. */
  readonly failed: number;
}

const objectUrl = (config: S3ObjectStorageConfigValue, key: string, query: Readonly<Record<string, string>> = {}) => {
  const url =
    config.addressingStyle === 'path'
      ? new URL(`${config.endpoint.origin}/${config.bucket}/${key}`)
      : new URL(`${config.endpoint.protocol}//${config.bucket}.${config.endpoint.host}/${key}`);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  return url;
};

const bucketUrl = (config: S3ObjectStorageConfigValue, query: string) =>
  config.addressingStyle === 'path'
    ? new URL(`${config.endpoint.origin}/${config.bucket}?${query}`)
    : new URL(`${config.endpoint.protocol}//${config.bucket}.${config.endpoint.host}/?${query}`);

const signedRequest = Effect.fn('S3RunCleanup.request')(function* signedRequest(
  config: S3ObjectStorageConfigValue,
  method: 'DELETE' | 'GET',
  url: URL,
) {
  const client = yield* HttpClient.HttpClient;
  const headers = signS3Request({
    accessKeyId: config.accessKeyId,
    headers: {},
    method,
    now: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
    payloadSha256: EMPTY_PAYLOAD_SHA256,
    region: config.region,
    secretAccessKey: config.secretAccessKey,
    url,
  });
  return yield* client.execute(HttpClientRequest.make(method)(url.href).pipe(HttpClientRequest.setHeaders(headers)));
});

const UPLOAD_ENTRY = /<Upload>(?<entry>.*?)<\/Upload>/gsu;
const entryField = (entry: string, tag: string) =>
  new RegExp(`<${tag}>(?<value>[^<]*)</${tag}>`, 'u').exec(entry)?.groups?.['value'];

/** The unfinished uploads of the bucket that sit under one of the recorded keys: nothing else is returned. */
const recordedUploads = Effect.fn('S3RunCleanup.uploads')(function* recordedUploads(
  config: S3ObjectStorageConfigValue,
  recorded: ReadonlySet<string>,
) {
  const response = yield* signedRequest(config, 'GET', bucketUrl(config, 'uploads='));
  if (response.status !== 200) {
    return yield* Effect.fail('the unfinished uploads could not be listed' as const);
  }
  const text = yield* response.text;
  return [...text.matchAll(UPLOAD_ENTRY)]
    .map((match) => match.groups?.['entry'] ?? '')
    .flatMap((entry) => {
      const key = entryField(entry, 'Key');
      const uploadId = entryField(entry, 'UploadId');
      return key !== undefined && uploadId !== undefined && recorded.has(key) ? [{ key, uploadId }] : [];
    });
});

const accepted = (status: number) => (status >= 200 && status < 300) || status === 404;

/** Whether the provider accepted one request; a request that did not complete is a refusal, never an error. */
const attempt = (
  request: Effect.Effect<{ readonly status: number }, HttpClientError.HttpClientError, HttpClient.HttpClient>,
) =>
  request.pipe(
    Effect.map((response) => accepted(response.status)),
    Effect.orElseSucceed(() => false),
  );

interface RecordedUpload {
  readonly key: string;
  readonly uploadId: string;
}
const NO_UPLOADS: readonly RecordedUpload[] = [];

/**
 * Removes the recorded keys, and aborts the unfinished uploads under them. Best effort and report only: it returns
 * what it did and what the provider refused, and never fails.
 */
export const cleanupRecordedKeys = Effect.fn('S3RunCleanup.cleanup')(function* cleanupRecordedKeys(
  config: S3ObjectStorageConfigValue,
  keys: readonly string[],
) {
  const recorded = new Set(keys);
  if (recorded.size === 0) {
    return { aborted: 0, deleted: 0, failed: 0 } satisfies S3CleanupReport;
  }
  const outcome = { aborted: 0, deleted: 0, failed: 0 };
  const uploads = yield* recordedUploads(config, recorded).pipe(
    Effect.catch(() =>
      Effect.sync(() => {
        outcome.failed += 1;
        return NO_UPLOADS;
      }),
    ),
  );
  for (const { key, uploadId } of uploads) {
    const done = yield* attempt(signedRequest(config, 'DELETE', objectUrl(config, key, { uploadId })));
    outcome[done ? 'aborted' : 'failed'] += 1;
  }
  for (const key of recorded) {
    const done = yield* attempt(signedRequest(config, 'DELETE', objectUrl(config, key)));
    outcome[done ? 'deleted' : 'failed'] += 1;
  }
  return outcome satisfies S3CleanupReport;
});
