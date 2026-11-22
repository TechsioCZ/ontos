import { sha256 } from '@noble/hashes/sha2.js';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Duration, Effect, Layer, Redacted } from 'effect';
import { Hex } from 'effect/encoding';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { EMPTY_PAYLOAD_SHA256, signS3Request } from '../../src/media/s3-signing.ts';
import { R2_MOCK_LABEL, startR2BehaviourMock } from '../support/r2-behaviour-mock.ts';
import type { R2BehaviourMock, R2BehaviourMockOptions } from '../support/r2-behaviour-mock.ts';

/*
 * R2-behaviour MOCK built from documentation, NOT R2. These tests prove what the MOCK does, so that a green run of the
 * provider suite against it means something: each case names the Cloudflare documentation statement it encodes (the
 * list with URLs is in the header of tests/support/r2-behaviour-mock.ts and in provider-inventory.md). Nothing here
 * is evidence about Cloudflare R2.
 */

const node = process.getBuiltinModule('node:crypto');
const nodeHttp = process.getBuiltinModule('node:http');
const encoder = new TextEncoder();
const MIB = 1024 * 1024;
const md5Hex = (bytes: Uint8Array) => node.createHash('md5').update(bytes).digest('hex');

interface RawInput {
  readonly accessKeyId?: string;
  readonly body?: Uint8Array;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method: 'DELETE' | 'GET' | 'HEAD' | 'POST' | 'PUT';
  readonly now?: DateTime.Utc;
  readonly region?: string;
  readonly secretAccessKey?: string;
  readonly signed?: boolean;
  readonly url: URL;
}

const payloadDigestOf = (body: Uint8Array) => (body.byteLength === 0 ? EMPTY_PAYLOAD_SHA256 : Hex.encode(sha256(body)));

/** One request to the mock, signed outside the adapter (and so independently of its request construction). */
const rawRequest = Effect.fn('R2MockTest.raw')(function* rawRequest(mock: R2BehaviourMock, input: RawInput) {
  const client = yield* HttpClient.HttpClient;
  const body = input.body ?? new Uint8Array(0);
  const signed =
    input.signed === false
      ? {}
      : signS3Request({
          accessKeyId: Redacted.make(input.accessKeyId ?? Redacted.value(mock.credentials.accessKeyId)),
          headers: input.headers ?? {},
          method: input.method,
          now: input.now ?? DateTime.makeUnsafe(mock.now()),
          payloadSha256: payloadDigestOf(body),
          region: input.region ?? 'auto',
          secretAccessKey: Redacted.make(input.secretAccessKey ?? Redacted.value(mock.credentials.secretAccessKey)),
          url: input.url,
        });
  const base = HttpClientRequest.make(input.method)(input.url.href).pipe(HttpClientRequest.setHeaders(signed));
  const request = input.body === undefined ? base : HttpClientRequest.bodyUint8Array(base, body);
  const response = yield* client.execute(request);
  return { headers: response.headers, status: response.status, text: yield* response.text };
});

const pathStyle = (mock: R2BehaviourMock, key = '', query = '') =>
  new URL(`${[mock.origin.origin, mock.bucket, key].filter((part) => part !== '').join('/')}${query}`);

const answerOf = (
  response: InstanceType<typeof nodeHttp.IncomingMessage>,
  whenDone: (answer: ChunkedAnswer) => void,
) => {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  response.on('end', () => {
    whenDone({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf-8') });
  });
};

interface ChunkedAnswer {
  readonly status: number;
  readonly text: string;
}

/** A PUT without a Content-Length header: node's HTTP client sends it chunked. */
const chunkedPut = (mock: R2BehaviourMock, key: string) => {
  const url = pathStyle(mock, key);
  const headers = signS3Request({
    accessKeyId: mock.credentials.accessKeyId,
    headers: {},
    method: 'PUT',
    now: DateTime.makeUnsafe(mock.now()),
    payloadSha256: Hex.encode(sha256(encoder.encode('chunked'))),
    region: 'auto',
    secretAccessKey: mock.credentials.secretAccessKey,
    url,
  });
  return Effect.callback<ChunkedAnswer>((resume) => {
    const request = nodeHttp.request(
      {
        headers: { ...headers, 'transfer-encoding': 'chunked' },
        host: url.hostname,
        method: 'PUT',
        path: url.pathname,
        port: url.port,
      },
      (response) => {
        answerOf(response, (answer) => {
          resume(Effect.succeed(answer));
        });
      },
    );
    request.write('chunked');
    request.end();
  });
};

const codeOf = (text: string) => /<Code>(?<code>[^<]+)<\/Code>/u.exec(text)?.groups?.['code'];
const tagOf = (text: string, tag: string) =>
  new RegExp(`<${tag}>(?<value>[^<]*)</${tag}>`, 'u').exec(text)?.groups?.['value'];
const textOf = (bytes: Uint8Array | undefined) => Buffer.from(bytes ?? new Uint8Array(0)).toString();

const withMock = <Value, Failure, Requirement>(
  options: R2BehaviourMockOptions,
  use: (mock: R2BehaviourMock) => Effect.Effect<Value, Failure, Requirement>,
) => Effect.scoped(startR2BehaviourMock(options).pipe(Effect.flatMap(use)));

const put = (mock: R2BehaviourMock, key: string, bytes: Uint8Array, headers: Record<string, string> = {}) =>
  rawRequest(mock, { body: bytes, headers, method: 'PUT', url: pathStyle(mock, key) });

const completeBody = (parts: readonly string[]) =>
  encoder.encode(
    `<CompleteMultipartUpload>${parts
      .map((etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${etag}</ETag></Part>`)
      .join('')}</CompleteMultipartUpload>`,
  );

/** The documented multipart ETag body: MD5 of the concatenated binary MD5s of the parts. */
const multipartDigest = (parts: readonly Uint8Array[]) =>
  md5Hex(Buffer.concat(parts.map((part) => Buffer.from(md5Hex(part), 'hex'))));

const encodedUploadId = (uploadId: string) => encodeURIComponent(uploadId);

const startUpload = (mock: R2BehaviourMock, key: string) =>
  rawRequest(mock, { method: 'POST', url: pathStyle(mock, key, '?uploads=') }).pipe(
    Effect.map((started) => tagOf(started.text, 'UploadId') ?? ''),
  );

const uploadPartOf = (
  mock: R2BehaviourMock,
  key: string,
  upload: { readonly id: string; readonly number: number },
  bytes: Uint8Array,
) =>
  rawRequest(mock, {
    body: bytes,
    method: 'PUT',
    url: pathStyle(mock, key, `?partNumber=${upload.number}&uploadId=${encodedUploadId(upload.id)}`),
  });

const completeUploadOf = (mock: R2BehaviourMock, key: string, uploadId: string, tags: readonly string[]) =>
  rawRequest(mock, {
    body: completeBody(tags),
    method: 'POST',
    url: pathStyle(mock, key, `?uploadId=${encodedUploadId(uploadId)}`),
  });

it.layer(Layer.mergeAll(NodeCrypto.layer, FetchHttpClient.layer), { excludeTestServices: true })(
  `${R2_MOCK_LABEL}: behaviour of the mock itself`,
  (suite) => {
    const mockIt = suite.effect;

    mockIt('says on every error document that it is a mock, never R2', () =>
      withMock({}, (mock) =>
        Effect.gen(function* labelled() {
          const answer = yield* rawRequest(mock, { method: 'GET', signed: false, url: pathStyle(mock, 'k') });
          expect(answer.text).toContain('NOT R2');
        }),
      ),
    );

    // https://developers.cloudflare.com/r2/api/error-codes/ : 10002 Unauthorized 401 (credentials missing or invalid)
    mockIt('answers 401 Unauthorized without credentials and for an unknown access key', () =>
      withMock({}, (mock) =>
        Effect.gen(function* unauthorized() {
          const anonymous = yield* rawRequest(mock, { method: 'GET', signed: false, url: pathStyle(mock, 'k') });
          expect([anonymous.status, codeOf(anonymous.text)]).toStrictEqual([401, 'Unauthorized']);
          const unknown = yield* rawRequest(mock, {
            accessKeyId: 'not-a-known-key',
            method: 'GET',
            url: pathStyle(mock, 'k'),
          });
          expect([unknown.status, codeOf(unknown.text)]).toStrictEqual([401, 'Unauthorized']);
        }),
      ),
    );

    // 10035 SignatureDoesNotMatch 403; region `auto` (and the alias `us-east-1`) from /r2/api/s3/api/
    mockIt('validates the SigV4 signature: a wrong secret or a foreign region is 403 SignatureDoesNotMatch', () =>
      withMock({}, (mock) =>
        Effect.gen(function* signature() {
          const key = 'sig';
          const ok = yield* put(mock, key, encoder.encode('x'));
          expect(ok.status).toBe(200);
          const wrongSecret = yield* rawRequest(mock, {
            method: 'GET',
            secretAccessKey: 'a-different-secret',
            url: pathStyle(mock, key),
          });
          expect([wrongSecret.status, codeOf(wrongSecret.text)]).toStrictEqual([403, 'SignatureDoesNotMatch']);
          const alias = yield* rawRequest(mock, { method: 'GET', region: 'us-east-1', url: pathStyle(mock, key) });
          expect(alias.status).toBe(200);
          const foreign = yield* rawRequest(mock, { method: 'GET', region: 'eu-west-1', url: pathStyle(mock, key) });
          expect([foreign.status, codeOf(foreign.text)]).toStrictEqual([403, 'SignatureDoesNotMatch']);
        }),
      ),
    );

    mockIt('rejects a request that was signed for another path', () =>
      withMock({}, (mock) =>
        Effect.gen(function* tampered() {
          const signed = signS3Request({
            accessKeyId: mock.credentials.accessKeyId,
            headers: {},
            method: 'GET',
            now: DateTime.makeUnsafe(mock.now()),
            payloadSha256: EMPTY_PAYLOAD_SHA256,
            region: 'auto',
            secretAccessKey: mock.credentials.secretAccessKey,
            url: pathStyle(mock, 'a'),
          });
          const client = yield* HttpClient.HttpClient;
          const other = yield* client.execute(
            HttpClientRequest.get(pathStyle(mock, 'b').href).pipe(HttpClientRequest.setHeaders(signed)),
          );
          expect(other.status).toBe(403);
          expect(codeOf(yield* other.text)).toBe('SignatureDoesNotMatch');
        }),
      ),
    );

    // Clock skew: R2 documents ExpiredRequest 403 ("signature has expired"); the tolerance is NOT VERIFIED, so the
    // mock takes it as an option and these cases do not depend on its default.
    mockIt('rejects a request signed far from the server clock as 403 ExpiredRequest', () =>
      withMock({ skewToleranceMillis: Duration.toMillis(Duration.minutes(5)) }, (mock) =>
        Effect.gen(function* skew() {
          const now = DateTime.makeUnsafe(mock.now());
          const late = yield* rawRequest(mock, {
            method: 'GET',
            now: DateTime.subtract(now, { minutes: 30 }),
            url: pathStyle(mock, 'k'),
          });
          expect([late.status, codeOf(late.text)]).toStrictEqual([403, 'ExpiredRequest']);
          const early = yield* rawRequest(mock, {
            method: 'GET',
            now: DateTime.add(now, { minutes: 30 }),
            url: pathStyle(mock, 'k'),
          });
          expect([early.status, codeOf(early.text)]).toStrictEqual([403, 'ExpiredRequest']);
          const near = yield* rawRequest(mock, {
            method: 'GET',
            now: DateTime.subtract(now, { minutes: 1 }),
            url: pathStyle(mock, 'k'),
          });
          expect([near.status, codeOf(near.text)]).toStrictEqual([404, 'NoSuchKey']);
        }),
      ),
    );

    // /r2/api/s3/presigned-urls/ shows a virtual-hosted URL; /r2/examples/aws/aws4fetch/ shows path style
    mockIt('serves path-style and virtual-hosted addressing for the same object', () =>
      withMock({}, (mock) =>
        Effect.gen(function* addressing() {
          const bytes = encoder.encode('addressing');
          expect((yield* put(mock, 'both', bytes)).status).toBe(200);
          const virtual = yield* rawRequest(mock, {
            method: 'GET',
            url: new URL(`http://${mock.bucket}.localhost:${mock.origin.port}/both`),
          });
          expect([virtual.status, virtual.text]).toStrictEqual([200, 'addressing']);
          const virtualWrite = yield* rawRequest(mock, {
            body: bytes,
            method: 'PUT',
            url: new URL(`http://${mock.bucket}.localhost:${mock.origin.port}/virtual-written`),
          });
          expect(virtualWrite.status).toBe(200);
          expect(mock.admin.keys(mock.bucket)).toContain('virtual-written');
        }),
      ),
    );

    // /r2/api/s3/api/ : If-None-Match on PutObject is atomic; 412 PreconditionFailed otherwise
    mockIt('refuses a create-only PUT of an existing key with 412 and keeps the original bytes', () =>
      withMock({}, (mock) =>
        Effect.gen(function* createOnly() {
          const first = yield* put(mock, 'once', encoder.encode('first'), { 'if-none-match': '*' });
          expect(first.status).toBe(200);
          const second = yield* put(mock, 'once', encoder.encode('second'), { 'if-none-match': '*' });
          expect([second.status, codeOf(second.text)]).toStrictEqual([412, 'PreconditionFailed']);
          expect(textOf(mock.admin.get(mock.bucket, 'once'))).toBe('first');
          const plain = yield* put(mock, 'once', encoder.encode('third'));
          expect(plain.status).toBe(200);
        }),
      ),
    );

    // /r2/api/s3/api/ : GetBucketVersioning and PutBucketVersioning are unimplemented
    mockIt('never reports an object version (R2 has no object versioning)', () =>
      withMock({}, (mock) =>
        Effect.gen(function* versioning() {
          const written = yield* put(mock, 'v', encoder.encode('v'));
          const read = yield* rawRequest(mock, { method: 'GET', url: pathStyle(mock, 'v') });
          const head = yield* rawRequest(mock, { method: 'HEAD', url: pathStyle(mock, 'v') });
          for (const answer of [written, read, head]) {
            expect(Object.keys(answer.headers)).not.toContain('x-amz-version-id');
          }
          const bucketVersioning = yield* rawRequest(mock, { method: 'GET', url: pathStyle(mock, '', '?versioning=') });
          expect(bucketVersioning.status).toBe(501);
        }),
      ),
    );

    // /r2/api/error-codes/ : 10033 MissingContentLength 411
    mockIt('answers 411 MissingContentLength to a PUT without a Content-Length (chunked)', () =>
      withMock({}, (mock) =>
        Effect.gen(function* chunked() {
          const answer = yield* chunkedPut(mock, 'chunked');
          expect([answer.status, codeOf(answer.text)]).toStrictEqual([411, 'MissingContentLength']);
          expect(mock.admin.keys(mock.bucket)).not.toContain('chunked');
        }),
      ),
    );

    // /r2/api/error-codes/ : 10007 NoSuchKey 404, 10006 NoSuchBucket 404; errors are XML with Code and Message
    mockIt('answers NoSuchKey and NoSuchBucket as 404 XML errors, and a HEAD without a body', () =>
      withMock({}, (mock) =>
        Effect.gen(function* notFound() {
          const missingKey = yield* rawRequest(mock, { method: 'GET', url: pathStyle(mock, 'absent') });
          expect([missingKey.status, codeOf(missingKey.text)]).toStrictEqual([404, 'NoSuchKey']);
          expect(tagOf(missingKey.text, 'Message')).toBeDefined();
          const missingBucket = yield* rawRequest(mock, {
            method: 'GET',
            url: new URL(`${mock.origin.origin}/no-such-bucket/absent`),
          });
          expect([missingBucket.status, codeOf(missingBucket.text)]).toStrictEqual([404, 'NoSuchBucket']);
          const head = yield* rawRequest(mock, { method: 'HEAD', url: pathStyle(mock, 'absent') });
          expect([head.status, head.text]).toStrictEqual([404, '']);
        }),
      ),
    );

    // /r2/api/s3/tokens/ : a token can be scoped to specific buckets; 10003 AccessDenied 403
    mockIt('refuses a bucket the credential is not scoped to with 403 AccessDenied', () =>
      withMock(
        { buckets: ['d20-test-r2mock', 'another-bucket-d20-test'], credentialBuckets: ['d20-test-r2mock'] },
        (mock) =>
          Effect.gen(function* scoped() {
            const denied = yield* rawRequest(mock, {
              method: 'GET',
              url: new URL(`${mock.origin.origin}/another-bucket-d20-test/k`),
            });
            expect([denied.status, codeOf(denied.text)]).toStrictEqual([403, 'AccessDenied']);
          }),
      ),
    );

    // /r2/objects/multipart-objects/ : part ETag = MD5 of the part; object ETag = MD5 of the concatenated binary part
    // MD5s, a hyphen and the number of parts
    mockIt('computes the multipart ETags as documented', () =>
      withMock({}, (mock) =>
        Effect.gen(function* multipart() {
          const first = new Uint8Array(5 * MIB).fill(1);
          const second = new Uint8Array(5 * MIB).fill(2);
          const last = encoder.encode('the last part may be small');
          const started = yield* rawRequest(mock, { method: 'POST', url: pathStyle(mock, 'big', '?uploads=') });
          expect(started.status).toBe(200);
          const uploadId = tagOf(started.text, 'UploadId') ?? '';
          const tags: string[] = [];
          for (const [index, part] of [first, second, last].entries()) {
            const url = pathStyle(mock, 'big', `?partNumber=${index + 1}&uploadId=${encodeURIComponent(uploadId)}`);
            const stored = yield* rawRequest(mock, { body: part, method: 'PUT', url });
            expect(stored.status).toBe(200);
            expect(stored.headers['etag']).toBe(`"${md5Hex(part)}"`);
            tags.push(stored.headers['etag'] ?? '');
          }
          const complete = yield* rawRequest(mock, {
            body: completeBody(tags),
            method: 'POST',
            url: pathStyle(mock, 'big', `?uploadId=${encodeURIComponent(uploadId)}`),
          });
          expect(complete.status).toBe(200);
          const expected = `"${multipartDigest([first, second, last])}-3"`;
          expect(tagOf(complete.text, 'ETag')?.replaceAll('&quot;', '"')).toBe(expected);
          const head = yield* rawRequest(mock, { method: 'HEAD', url: pathStyle(mock, 'big') });
          expect([head.status, head.headers['etag'], head.headers['content-length']]).toStrictEqual([
            200,
            expected,
            String(first.byteLength + second.byteLength + last.byteLength),
          ]);
        }),
      ),
    );

    // error-codes: 10048 InvalidPart "non-last parts aren't all the same size"; 10011 EntityTooSmall; 10024 NoSuchUpload
    mockIt('refuses unequal or too-small non-last parts and an unknown upload', () =>
      withMock({}, (mock) =>
        Effect.gen(function* refusals() {
          const unequal = yield* startUpload(mock, 'refused');
          for (const [number, bytes] of [
            [1, new Uint8Array(5 * MIB)],
            [2, new Uint8Array(6 * MIB)],
            [3, encoder.encode('end')],
          ] as const) {
            yield* uploadPartOf(mock, 'refused', { id: unequal, number }, bytes);
          }
          const unequalAnswer = yield* completeUploadOf(mock, 'refused', unequal, ['"x"', '"x"', '"x"']);
          expect([unequalAnswer.status, codeOf(unequalAnswer.text)]).toStrictEqual([400, 'InvalidPart']);
          const small = yield* startUpload(mock, 'refused');
          yield* uploadPartOf(mock, 'refused', { id: small, number: 1 }, encoder.encode('too small'));
          yield* uploadPartOf(mock, 'refused', { id: small, number: 2 }, encoder.encode('end'));
          const smallAnswer = yield* completeUploadOf(mock, 'refused', small, ['"x"', '"x"']);
          expect([smallAnswer.status, codeOf(smallAnswer.text)]).toStrictEqual([400, 'EntityTooSmall']);
          const unknown = yield* uploadPartOf(
            mock,
            'refused',
            { id: 'no-such-upload', number: 1 },
            encoder.encode('x'),
          );
          expect([unknown.status, codeOf(unknown.text)]).toStrictEqual([404, 'NoSuchUpload']);
          expect(mock.admin.keys(mock.bucket)).not.toContain('refused');
        }),
      ),
    );

    // extensions: conditions on CreateMultipartUpload are evaluated at initiation and "not retained for upload
    // completion"; to be create-only at commit, send If-None-Match: * on CompleteMultipartUpload
    mockIt('makes a multipart object create-only only when the condition is sent on the completion', () =>
      withMock({}, (mock) =>
        Effect.gen(function* multipartConditions() {
          yield* put(mock, 'taken', encoder.encode('already here'));
          const initiated = yield* rawRequest(mock, {
            headers: { 'if-none-match': '*' },
            method: 'POST',
            url: pathStyle(mock, 'taken', '?uploads='),
          });
          expect([initiated.status, codeOf(initiated.text)]).toStrictEqual([412, 'PreconditionFailed']);
          const started = yield* rawRequest(mock, { method: 'POST', url: pathStyle(mock, 'taken', '?uploads=') });
          const uploadId = tagOf(started.text, 'UploadId') ?? '';
          const part = yield* rawRequest(mock, {
            body: encoder.encode('only part'),
            method: 'PUT',
            url: pathStyle(mock, 'taken', `?partNumber=1&uploadId=${encodeURIComponent(uploadId)}`),
          });
          const conditional = yield* rawRequest(mock, {
            body: completeBody([part.headers['etag'] ?? '']),
            headers: { 'if-none-match': '*' },
            method: 'POST',
            url: pathStyle(mock, 'taken', `?uploadId=${encodeURIComponent(uploadId)}`),
          });
          expect([conditional.status, codeOf(conditional.text)]).toStrictEqual([412, 'PreconditionFailed']);
          expect(textOf(mock.admin.get(mock.bucket, 'taken'))).toBe('already here');
        }),
      ),
    );

    // limits page: key 1,024 bytes; object 4.995 TiB; single upload 4.995 GiB; 10,000 parts; metadata 8,192 bytes
    mockIt('enforces the documented size limits (lowered by option so a test can reach them)', () =>
      withMock({ limits: { maximumKeyBytes: 16, maximumSingleUploadBytes: 8 } }, (mock) =>
        Effect.gen(function* limits() {
          const long = yield* put(mock, 'k'.repeat(17), encoder.encode('x'));
          expect([long.status, codeOf(long.text)]).toStrictEqual([400, 'InvalidObjectName']);
          const big = yield* put(mock, 'big', encoder.encode('123456789'));
          expect([big.status, codeOf(big.text)]).toStrictEqual([400, 'EntityTooLarge']);
          const fits = yield* put(mock, 'fits', encoder.encode('12345678'));
          expect(fits.status).toBe(200);
        }),
      ),
    );

    mockIt('carries the documented limits as defaults', () =>
      withMock({}, (mock) =>
        Effect.sync(() => {
          expect(mock.limits).toStrictEqual({
            maximumKeyBytes: 1024,
            maximumMetadataBytes: 8192,
            maximumObjectBytes: 5 * 1024 ** 4 - 5 * 1024 ** 3,
            maximumParts: 10_000,
            maximumSingleUploadBytes: 5 * 1024 ** 3 - 5 * MIB,
            minimumPartBytes: 5 * MIB,
          });
        }),
      ),
    );

    // error-codes: 10037 BadDigest and 10014 InvalidDigest (Content-MD5 is documented on PutObject and UploadPart)
    mockIt('checks a Content-MD5 when one is sent', () =>
      withMock({}, (mock) =>
        Effect.gen(function* digest() {
          const bytes = encoder.encode('digest me');
          const good = yield* put(mock, 'md5-good', bytes, {
            'content-md5': Buffer.from(md5Hex(bytes), 'hex').toString('base64'),
          });
          expect(good.status).toBe(200);
          const bad = yield* put(mock, 'md5-bad', bytes, {
            'content-md5': Buffer.from(md5Hex(encoder.encode('other')), 'hex').toString('base64'),
          });
          expect([bad.status, codeOf(bad.text)]).toStrictEqual([400, 'BadDigest']);
          const malformed = yield* put(mock, 'md5-malformed', bytes, { 'content-md5': '!!!' });
          expect([malformed.status, codeOf(malformed.text)]).toStrictEqual([400, 'InvalidDigest']);
          expect(mock.admin.keys(mock.bucket)).toStrictEqual(['md5-good']);
        }),
      ),
    );

    // limits page footnote 5: concurrent writes to the same key at a higher rate than 1 per second return 429
    mockIt('answers 429 TooManyRequests to a second write of one key inside the interval (opt-in)', () =>
      withMock({ sameKeyWriteIntervalMillis: 60_000 }, (mock) =>
        Effect.gen(function* rateLimit() {
          expect((yield* put(mock, 'hot', encoder.encode('a'))).status).toBe(200);
          const second = yield* put(mock, 'hot', encoder.encode('b'));
          expect([second.status, codeOf(second.text)]).toStrictEqual([429, 'TooManyRequests']);
          expect((yield* put(mock, 'cold', encoder.encode('c'))).status).toBe(200);
          expect(textOf(mock.admin.get(mock.bucket, 'hot'))).toBe('a');
        }),
      ),
    );

    // The mock encodes only what the documentation states: anything else is answered loudly, never guessed.
    mockIt('answers an operation outside the encoded set as 501 and says R2 is NOT VERIFIED there', () =>
      withMock({}, (mock) =>
        Effect.gen(function* unverified() {
          const answer = yield* rawRequest(mock, { method: 'GET', url: pathStyle(mock, '', '?acl=') });
          expect(answer.status).toBe(501);
          expect(answer.text).toContain('NOT VERIFIED');
        }),
      ),
    );

    mockIt('lists unfinished multipart uploads (ListMultipartUploads is documented as supported)', () =>
      withMock({}, (mock) =>
        Effect.gen(function* listUploads() {
          const started = yield* rawRequest(mock, { method: 'POST', url: pathStyle(mock, 'listed', '?uploads=') });
          const uploadId = tagOf(started.text, 'UploadId') ?? '';
          const listing = yield* rawRequest(mock, { method: 'GET', url: pathStyle(mock, '', '?uploads=') });
          expect(listing.text).toContain('<ListMultipartUploadsResult');
          expect(listing.text).toContain('<Key>listed</Key>');
          const aborted = yield* rawRequest(mock, {
            method: 'DELETE',
            url: pathStyle(mock, 'listed', `?uploadId=${encodeURIComponent(uploadId)}`),
          });
          expect(aborted.status).toBe(204);
          const after = yield* rawRequest(mock, { method: 'GET', url: pathStyle(mock, '', '?uploads=') });
          expect(after.text).not.toContain('<Key>listed</Key>');
        }),
      ),
    );
  },
);
