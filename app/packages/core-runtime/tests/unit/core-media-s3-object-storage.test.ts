import { NodeCrypto } from '@effect/platform-node';
import { Effect, Fiber, Match, Option, Redacted, Schema, Stream } from 'effect';
import { expect, it } from 'effect-rstest';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';
import type { HttpClientRequest } from 'effect/http';
import { TestClock } from 'effect/testing';

import {
  ObjectStorageChecksumUnsupported,
  ObjectStorageNetworkError,
  ObjectStorageObjectExists,
  ObjectStorageObjectMissing,
  ObjectStorageServerError,
  ObjectStorageTimeout,
} from '../../src/media/object-storage.ts';
import type { ObjectStorageFailure } from '../../src/media/object-storage.ts';
import { S3_MINIMUM_PART_BYTES } from '../../src/media/s3-config.ts';
import type { S3ObjectStorageConfigValue } from '../../src/media/s3-config.ts';
import { cutIntoParts, makeS3ObjectStorage, partSizeFor } from '../../src/media/s3-object-storage.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';

const SECRET = 'unit-test-secret-value';
const ACCESS = 'unit-test-access-id';
const key = deriveMediaStorageKey({
  mediaAssetId: '00000000-0000-4000-8000-0000000000a1',
  tenantId: '00000000-0000-4000-8000-000000000001',
});
const MIB = 1024 * 1024;
const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const configWith = (overrides: Partial<S3ObjectStorageConfigValue> = {}): S3ObjectStorageConfigValue => ({
  accessKeyId: Redacted.make(ACCESS),
  addressingStyle: 'path',
  bucket: 'unit-bucket',
  conditionalCreate: 'supported',
  endpoint: new URL('https://storage.example.test'),
  fingerprint: '0123456789abcdef',
  partSizeBytes: Option.none(),
  providerId: 's3:0123456789abcdef',
  region: 'auto',
  requestTimeoutMillis: Option.none(),
  secretAccessKey: Redacted.make(SECRET),
  ...overrides,
});

interface Recorded {
  readonly body: Uint8Array | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly url: URL;
}

/** What the provider does with one request: answer it, or fail it at the transport. */
type Answer = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

const reply =
  (response: Response): Answer =>
  (request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, response));
const HANG: Answer = () => Effect.never;
const transportFailure =
  (cause: Error): Answer =>
  (request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ cause, request }) }),
    );

/** The HttpClient service seam: records each request and answers from a script. */
const provider = (answer: (recorded: Recorded) => Answer) => {
  const requests: Recorded[] = [];
  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest, url) => {
    const recorded: Recorded = {
      body: Match.value(request.body).pipe(
        Match.tag('Uint8Array', ({ body }) => body),
        Match.orElse(() => null),
      ),
      headers: request.headers,
      method: request.method,
      url,
    };
    requests.push(recorded);
    return answer(recorded)(request);
  });
  return { requests, withProvider: Effect.provideService(HttpClient.HttpClient, client) };
};

const xmlError = (code: string, status: number) =>
  reply(
    new Response(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>sensitive provider text</Message></Error>`, {
      status,
    }),
  );
const ok = (headers: Record<string, string> = {}) => reply(new Response(null, { headers, status: 200 }));
const bodyOf = (recorded: Recorded | undefined) => new TextDecoder().decode(recorded?.body ?? new Uint8Array(0));

const storageOn = (settings: S3ObjectStorageConfigValue, answer: (recorded: Recorded) => Answer) => {
  const stub = provider(answer);
  return { ...stub, storage: makeS3ObjectStorage(settings).pipe(stub.withProvider) };
};

const failureOf = <Value>(effect: Effect.Effect<Value, ObjectStorageFailure>) => Effect.flip(effect);

const partSizes = (total: number, chunk: number, part: number) =>
  Stream.runCollect(
    cutIntoParts(
      Stream.fromIterable(
        Array.from(
          { length: Math.ceil(total / chunk) },
          (_, index) => new Uint8Array(Math.min(chunk, total - index * chunk)),
        ),
      ),
      part,
    ),
  ).pipe(Effect.map((parts) => [...parts].map((bytes) => bytes.byteLength)));

const mapped: readonly [string, () => Answer, (failure: ObjectStorageFailure) => boolean][] = [
  ['HEAD 404', () => reply(new Response(null, { status: 404 })), Schema.is(ObjectStorageObjectMissing)],
  ['5xx', () => xmlError('InternalError', 500), Schema.is(ObjectStorageServerError)],
  ['503 slow down', () => xmlError('SlowDown', 503), Schema.is(ObjectStorageServerError)],
  ['forbidden credentials', () => xmlError('SignatureDoesNotMatch', 403), Schema.is(ObjectStorageServerError)],
  ['gateway timeout', () => xmlError('GatewayTimeout', 504), Schema.is(ObjectStorageTimeout)],
  ['transport reset', () => transportFailure(new Error('ECONNRESET')), Schema.is(ObjectStorageNetworkError)],
];

const isPartUpload = (recorded: Recorded) => recorded.method === 'PUT' && recorded.url.searchParams.has('partNumber');
const isCompletion = (recorded: Recorded) =>
  recorded.method === 'POST' && recorded.url.searchParams.has('uploadId') && !isPartUpload(recorded);

const uploadScript = (recorded: Recorded): Answer => {
  const { searchParams } = recorded.url;
  if (recorded.method === 'POST' && searchParams.has('uploads')) {
    return reply(
      new Response('<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>'),
    );
  }
  if (isPartUpload(recorded)) {
    return ok({ etag: `"etag-${searchParams.get('partNumber')}"` });
  }
  if (isCompletion(recorded)) {
    return reply(
      new Response('<CompleteMultipartUploadResult><Key>k</Key></CompleteMultipartUploadResult>', {
        headers: { 'x-amz-version-id': 'v-9' },
      }),
    );
  }
  return ok();
};

const operationsOf = (requests: readonly Recorded[]) =>
  requests.map((request) => `${request.method} ${request.url.search}`);

it('sizes parts from the declared object size without ever going below the minimum or past the part limit', () => {
  expect(partSizeFor(Option.none())).toBe(S3_MINIMUM_PART_BYTES);
  expect(partSizeFor(Option.none(), 100)).toBe(S3_MINIMUM_PART_BYTES);
  expect(partSizeFor(Option.some(8 * MIB))).toBe(8 * MIB);
  expect(partSizeFor(Option.none(), 100 * 1024 * MIB)).toBe(Math.ceil((100 * 1024 * MIB) / 10_000));
});

it.effect('cuts a body into equal parts, with a smaller last part and no empty part', () =>
  Effect.gen(function* cuts() {
    expect(yield* partSizes(25, 7, 10)).toStrictEqual([10, 10, 5]);
    expect(yield* partSizes(20, 4, 10)).toStrictEqual([10, 10]);
    expect(yield* partSizes(0, 1, 10)).toStrictEqual([]);
    expect(yield* partSizes(3, 3, 10)).toStrictEqual([3]);
    expect(yield* partSizes(35, 100, 10)).toStrictEqual([10, 10, 10, 5]);
  }),
);

it.effect('keeps the bytes of every part in order', () =>
  Effect.gen(function* order() {
    const source = Uint8Array.from({ length: 23 }, (_, index) => index);
    const parts = [
      ...(yield* Stream.runCollect(
        cutIntoParts(Stream.make(source.slice(0, 9), source.slice(9, 10), source.slice(10)), 10),
      )),
    ];
    expect(parts.flatMap((part) => [...part])).toStrictEqual([...source]);
  }),
);

it.layer(NodeCrypto.layer)('the S3 object storage adapter against a scripted provider', (suite) => {
  suite.effect('treats a write the provider refused for its digest as a transfer fault: nothing was stored', () =>
    Effect.gen(function* refusedDigest() {
      const { storage } = storageOn(configWith(), () => xmlError('BadDigest', 400));
      const failure = yield* failureOf(
        (yield* storage).put({ body: Stream.make(new Uint8Array(3)), contentType: 'a/b', key }),
      );
      expect(Schema.is(ObjectStorageNetworkError)(failure)).toBe(true);
    }),
  );

  suite.effect('builds a signed, path-style request and sends no credential but the signature', () =>
    Effect.gen(function* pathStyle() {
      const { requests, storage } = storageOn(configWith(), () => ok({ 'content-length': '12' }));
      const service = yield* storage;
      expect(service.providerId).toBe('s3:0123456789abcdef');
      expect(yield* service.stat(key)).toStrictEqual({ byteSize: 12 });
      const [request] = requests;
      expect(request?.method).toBe('HEAD');
      expect(request?.url.href).toBe(`https://storage.example.test/unit-bucket/${key}`);
      expect(request?.headers['authorization']).toMatch(
        /^AWS4-HMAC-SHA256 Credential=unit-test-access-id\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/u,
      );
      expect(request?.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/u);
      expect(jsonText(request?.headers)).not.toContain(SECRET);
    }),
  );

  suite.effect('builds a virtual-host request with the bucket in the host name', () =>
    Effect.gen(function* virtualHost() {
      const { requests, storage } = storageOn(configWith({ addressingStyle: 'virtual-host' }), () =>
        ok({ 'content-length': '1' }),
      );
      yield* (yield* storage).stat(key);
      expect(requests[0]?.url.href).toBe(`https://unit-bucket.storage.example.test/${key}`);
    }),
  );

  suite.effect('writes create-only when the deployment states the provider supports it, and not otherwise', () =>
    Effect.gen(function* conditionalWrite() {
      const supported = storageOn(configWith(), () => ok());
      yield* (yield* supported.storage).put({ body: Stream.make(new Uint8Array(3)), contentType: 'image/png', key });
      expect(supported.requests[0]?.method).toBe('PUT');
      expect(supported.requests[0]?.headers['if-none-match']).toBe('*');
      expect(supported.requests[0]?.headers['content-type']).toBe('image/png');
      expect(supported.requests[0]?.headers['authorization']).toContain(
        'SignedHeaders=content-type;host;if-none-match;',
      );

      const unsupported = storageOn(configWith({ conditionalCreate: 'unsupported' }), () => ok());
      yield* (yield* unsupported.storage).put({ body: Stream.make(new Uint8Array(3)), contentType: 'image/png', key });
      expect(unsupported.requests[0]?.headers['if-none-match']).toBeUndefined();
    }),
  );

  suite.effect('sends a header-safe content type, whatever the recorded media type says', () =>
    Effect.gen(function* contentTypeSafety() {
      // The recorded media type is caller-stated text: outside printable ASCII it cannot travel as a signed header.
      for (const recorded of ['text/\u0159', 'text/caf\u00e9', 'text/plain\u0000']) {
        const { requests, storage } = storageOn(configWith(), () => ok());
        yield* (yield* storage).put({ body: Stream.make(new Uint8Array(3)), contentType: recorded, key });
        expect(requests[0]?.headers['content-type']).toBe('application/octet-stream');
      }
      const { requests, storage } = storageOn(configWith(), () => ok());
      yield* (yield* storage).put({
        body: Stream.make(new Uint8Array(3)),
        contentType: 'text/plain; charset=utf-8',
        key,
      });
      expect(requests[0]?.headers['content-type']).toBe('text/plain; charset=utf-8');
    }),
  );

  suite.effect('reports a version only when the provider returns a version id, never an ETag', () =>
    Effect.gen(function* versioned() {
      const none = storageOn(configWith(), () => ok({ 'content-length': '3', etag: '"abc"' }));
      expect(yield* (yield* none.storage).stat(key)).toStrictEqual({ byteSize: 3 });
      const suspended = storageOn(configWith(), () => ok({ 'content-length': '3', 'x-amz-version-id': 'null' }));
      expect(yield* (yield* suspended.storage).stat(key)).toStrictEqual({ byteSize: 3 });
      const real = storageOn(configWith(), () => ok({ 'content-length': '3', 'x-amz-version-id': 'v-123' }));
      expect(yield* (yield* real.storage).stat(key)).toStrictEqual({ byteSize: 3, versionRef: 'v-123' });
    }),
  );

  suite.effect('maps provider answers to the port failures without copying any provider text', () =>
    Effect.gen(function* statusMapping() {
      for (const [label, answer, matches] of mapped) {
        const { storage } = storageOn(configWith(), answer);
        const failure = yield* failureOf((yield* storage).stat(key));
        expect(matches(failure), label).toBe(true);
        expect(jsonText(failure), label).not.toContain('sensitive provider text');
        expect(jsonText(failure), label).not.toContain('unit-bucket');
        expect(jsonText(failure), label).not.toContain(key);
      }
    }),
  );

  suite.effect('maps a 404 to a missing object only for NoSuchKey: a missing bucket is unavailable', () =>
    Effect.gen(function* missingObjectOrBucket() {
      const noKey = storageOn(configWith(), () => xmlError('NoSuchKey', 404));
      expect(Schema.is(ObjectStorageObjectMissing)(yield* failureOf((yield* noKey.storage).get(key)))).toBe(true);
      const noBucket = storageOn(configWith(), () => xmlError('NoSuchBucket', 404));
      const failure = yield* failureOf((yield* noBucket.storage).get(key));
      expect(Schema.is(ObjectStorageServerError)(failure)).toBe(true);
      expect(Schema.is(ObjectStorageObjectMissing)(failure)).toBe(false);
    }),
  );

  suite.effect(
    'maps a refused create-only write to the exists failure and a precondition on a read to a server failure',
    () =>
      Effect.gen(function* preconditions() {
        const created = storageOn(configWith(), () => xmlError('PreconditionFailed', 412));
        const refused = yield* failureOf(
          (yield* created.storage).put({ body: Stream.make(new Uint8Array(1)), contentType: 'a/b', key }),
        );
        expect(Schema.is(ObjectStorageObjectExists)(refused)).toBe(true);
        const read = storageOn(configWith(), () => xmlError('PreconditionFailed', 412));
        expect(Schema.is(ObjectStorageServerError)(yield* failureOf((yield* read.storage).get(key)))).toBe(true);
      }),
  );

  suite.effect('refuses a request to verify a whole-object SHA-256 before sending anything', () =>
    Effect.gen(function* checksum() {
      const { requests, storage } = storageOn(configWith(), () => ok());
      const failure = yield* failureOf(
        (yield* storage).put({
          body: Stream.make(new Uint8Array(1)),
          contentType: 'a/b',
          expectedSha256: 'a'.repeat(64),
          key,
        }),
      );
      expect(Schema.is(ObjectStorageChecksumUnsupported)(failure)).toBe(true);
      expect(requests).toHaveLength(0);
    }),
  );

  suite.effect('fails a read whose connection ends before the announced length', () =>
    Effect.gen(function* framing() {
      const short = storageOn(configWith(), () => reply(new Response('abc', { headers: { 'content-length': '10' } })));
      const opened = yield* (yield* short.storage).get(key);
      expect(opened.stat.byteSize).toBe(10);
      const failure = yield* Effect.flip(Stream.runDrain(opened.body));
      expect(Schema.is(ObjectStorageNetworkError)(failure)).toBe(true);

      const exact = storageOn(configWith(), () => reply(new Response('abc', { headers: { 'content-length': '3' } })));
      const complete = yield* (yield* exact.storage).get(key);
      expect([...(yield* Stream.runCollect(complete.body))].map((chunk) => chunk.byteLength)).toStrictEqual([3]);
    }),
  );

  suite.effect('fails a read that carries no length, so a stat is never invented', () =>
    Effect.gen(function* noLength() {
      const { storage } = storageOn(configWith(), () => reply(new Response(new ReadableStream(), { status: 200 })));
      const failure = yield* failureOf((yield* storage).get(key));
      expect(Schema.is(ObjectStorageServerError)(failure)).toBe(true);
    }),
  );

  suite.effect('times out only when the deployment configures a timeout', () =>
    Effect.gen(function* timeout() {
      const { storage } = storageOn(configWith({ requestTimeoutMillis: Option.some(1000) }), () => HANG);
      const service = yield* storage;
      const fiber = yield* Effect.forkChild(failureOf(service.stat(key)));
      yield* TestClock.adjust(1000);
      expect(Schema.is(ObjectStorageTimeout)(yield* Fiber.join(fiber))).toBe(true);
    }),
  );

  suite.effect('uploads an object larger than one part as equal parts and completes it create-only', () =>
    Effect.gen(function* multipart() {
      const { requests, storage } = storageOn(configWith(), uploadScript);
      const total = 11 * MIB;
      const stat = yield* (yield* storage).put({
        body: Stream.make(new Uint8Array(4 * MIB), new Uint8Array(4 * MIB), new Uint8Array(3 * MIB)),
        byteSize: total,
        contentType: 'video/mp4',
        key,
      });
      expect(stat).toStrictEqual({ byteSize: total, versionRef: 'v-9' });
      expect(operationsOf(requests)).toStrictEqual([
        'POST ?uploads=',
        'PUT ?partNumber=1&uploadId=upload-1',
        'PUT ?partNumber=2&uploadId=upload-1',
        'PUT ?partNumber=3&uploadId=upload-1',
        'POST ?uploadId=upload-1',
      ]);
      expect(requests.slice(1, 4).map((request) => request.body?.byteLength)).toStrictEqual([5 * MIB, 5 * MIB, MIB]);
      expect(requests[0]?.headers['content-type']).toBe('video/mp4');
      expect(requests[4]?.headers['if-none-match']).toBe('*');
      expect(requests[1]?.headers['if-none-match']).toBeUndefined();
      expect(bodyOf(requests[4])).toBe(
        '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"etag-1"</ETag></Part><Part><PartNumber>2</PartNumber><ETag>"etag-2"</ETag></Part><Part><PartNumber>3</PartNumber><ETag>"etag-3"</ETag></Part></CompleteMultipartUpload>',
      );
    }),
  );

  suite.effect('aborts the multipart upload and completes nothing when the body fails after a part was sent', () =>
    Effect.gen(function* abortOnBodyFailure() {
      const { requests, storage } = storageOn(configWith(), uploadScript);
      const body = Stream.concat(Stream.make(new Uint8Array(6 * MIB)), Stream.fail('the request body broke' as const));
      const failure = yield* Effect.flip((yield* storage).put({ body, contentType: 'a/b', key }));
      expect(failure).toBe('the request body broke');
      expect(operationsOf(requests)).toStrictEqual([
        'POST ?uploads=',
        'PUT ?partNumber=1&uploadId=upload-1',
        'DELETE ?uploadId=upload-1',
      ]);
    }),
  );

  suite.effect('sends no request at all when the body fails before the first part is full', () =>
    Effect.gen(function* noRequestOnEarlyFailure() {
      const { requests, storage } = storageOn(configWith(), uploadScript);
      const body = Stream.concat(Stream.make(new Uint8Array(10)), Stream.fail('broken' as const));
      expect(yield* Effect.flip((yield* storage).put({ body, contentType: 'a/b', key }))).toBe('broken');
      expect(requests).toHaveLength(0);
    }),
  );

  suite.effect('treats a 200 answer that carries an error document on completion as a failure and aborts', () =>
    Effect.gen(function* completeWithError() {
      const { requests, storage } = storageOn(configWith(), (recorded) =>
        isCompletion(recorded)
          ? reply(new Response('<Error><Code>InternalError</Code></Error>', { status: 200 }))
          : uploadScript(recorded),
      );
      const failure = yield* failureOf(
        (yield* storage).put({ body: Stream.make(new Uint8Array(6 * MIB)), contentType: 'a/b', key }),
      );
      expect(Schema.is(ObjectStorageServerError)(failure)).toBe(true);
      expect(requests.at(-1)?.method).toBe('DELETE');
    }),
  );

  suite.effect('maps a refused create-only completion to the exists failure and aborts the upload', () =>
    Effect.gen(function* completeRefused() {
      const { requests, storage } = storageOn(configWith(), (recorded) =>
        isCompletion(recorded) ? xmlError('PreconditionFailed', 412) : uploadScript(recorded),
      );
      const failure = yield* failureOf(
        (yield* storage).put({ body: Stream.make(new Uint8Array(6 * MIB)), contentType: 'a/b', key }),
      );
      expect(Schema.is(ObjectStorageObjectExists)(failure)).toBe(true);
      expect(requests.at(-1)?.method).toBe('DELETE');
    }),
  );

  suite.effect(
    'stops a put that would need more parts than the provider allows and aborts the upload',
    () =>
      Effect.gen(function* tooManyParts() {
        // One-byte parts (a value the configuration parser would refuse) make the 10 000-part limit reachable.
        const { requests, storage } = storageOn(configWith({ partSizeBytes: Option.some(1) }), uploadScript);
        const failure = yield* failureOf(
          (yield* storage).put({ body: Stream.make(new Uint8Array(10_001)), contentType: 'a/b', key }),
        );
        expect(Schema.is(ObjectStorageServerError)(failure)).toBe(true);
        expect(requests.filter(isPartUpload)).toHaveLength(10_000);
        expect(requests.at(-1)?.method).toBe('DELETE');
      }),
    20_000,
  );

  suite.effect('exposes only the four port operations and no way to mint a URL or read a credential', () =>
    Effect.gen(function* surface() {
      const { storage } = storageOn(configWith(), () => ok());
      const service = yield* storage;
      expect(Object.keys(service).toSorted()).toStrictEqual(['get', 'providerId', 'put', 'stat']);
      expect(jsonText(Object.values(service).map(String))).not.toContain(SECRET);
    }),
  );
});
