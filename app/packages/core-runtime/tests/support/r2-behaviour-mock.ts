import { DateTime, Effect, Option, Predicate, Redacted } from 'effect';

/*
 * ====================================================================================================================
 *  R2-behaviour MOCK built from documentation - NOT R2.
 * ====================================================================================================================
 *
 * An in-process HTTP server (node:http, no dependency) that reproduces the Cloudflare R2 S3-API behaviours which are
 * STATED in Cloudflare's public documentation and which differ from the MinIO emulator or matter to the Core Media S3
 * adapter. It exists so that the provider suite can run, today and without credentials, against something that
 * behaves like the documented R2 where MinIO does not. A green run against it is evidence about THIS FILE and about
 * the adapter's handling of the documented behaviours. It is NEVER evidence that Cloudflare R2 works. It lives in test
 * support and is exported from no production barrel.
 *
 * Rule of this file: encode only what the documentation states. Where the documentation is silent the mock does not
 * guess: it answers `501` with a message saying the behaviour is NOT VERIFIED (see `unverified`), so an unverified
 * dependency of the adapter fails loudly instead of passing on an invention.
 *
 * ENCODED (source: Cloudflare R2 documentation, fetched 2026-11-22; every case is exercised in
 * tests/integration/core-media-r2-behaviour-mock.test.ts):
 *  - Region `auto`; "an empty value and `us-east-1` will alias to the `auto` region"
 *      https://developers.cloudflare.com/r2/api/s3/api/
 *  - SigV4 validation: 403 SignatureDoesNotMatch, 403 ExpiredRequest, 401 Unauthorized (credentials missing or
 *    invalid), 403 AccessDenied (insufficient permissions; a token "scope[d] ... to a set of buckets"),
 *    access key id = token id, secret = SHA-256 of the token value (the mock only issues a random pair)
 *      https://developers.cloudflare.com/r2/api/error-codes/ , https://developers.cloudflare.com/r2/api/s3/tokens/
 *  - Addressing: a virtual-hosted URL (`https://my-bucket.<ACCOUNT_ID>.r2.cloudflarestorage.com/...`) in
 *    https://developers.cloudflare.com/r2/api/s3/presigned-urls/ and path style in
 *    https://developers.cloudflare.com/r2/examples/aws/aws4fetch/
 *  - Conditional writes: "The conditional headers on `PutObject` (such as `If-Match` and `If-None-Match`) are
 *    evaluated atomically"; failure is `412 PreconditionFailed`; on `CreateMultipartUpload` the conditions are
 *    evaluated at initiation and "not retained for upload completion"; "To create a multipart object only if its key
 *    does not exist, send `If-None-Match: *` on `CompleteMultipartUpload`."
 *      https://developers.cloudflare.com/r2/api/s3/api/ , https://developers.cloudflare.com/r2/api/s3/extensions/
 *  - No object versioning: Get/PutBucketVersioning are unimplemented; the mock never sends `x-amz-version-id`
 *      https://developers.cloudflare.com/r2/api/s3/api/
 *  - Content-Length: 411 MissingContentLength ("Content-Length header is missing"); a chunked PUT carries none
 *      https://developers.cloudflare.com/r2/api/error-codes/
 *  - Errors are XML with `Code` and `Message`; 404 NoSuchKey / NoSuchBucket / NoSuchUpload; a HEAD 404 has no body
 *      https://developers.cloudflare.com/r2/api/error-codes/
 *  - Multipart: part ETag = MD5 of the part; object ETag = hash of the concatenated binary MD5s plus `-<parts>`;
 *    minimum part 5 MiB (EntityTooSmall) except the last; "All parts except the last must be the same size"
 *    (InvalidPart); at most 10,000 parts; ListMultipartUploads and AbortMultipartUpload are implemented
 *      https://developers.cloudflare.com/r2/objects/multipart-objects/ , https://developers.cloudflare.com/r2/api/s3/api/
 *  - Limits: key 1,024 bytes, metadata 8,192 bytes, object 4.995 TiB, single upload / part 4.995 GiB, 10,000 parts
 *      https://developers.cloudflare.com/r2/platform/limits/
 *  - Content-MD5 on PutObject and UploadPart (BadDigest, InvalidDigest)
 *      https://developers.cloudflare.com/r2/api/s3/api/ , https://developers.cloudflare.com/r2/api/error-codes/
 *  - 429 TooManyRequests for "Concurrent writes to the same object name (key) at a higher rate" than 1 per second
 *    (opt-in: `sameKeyWriteIntervalMillis`; the order of 429 against 412 is NOT VERIFIED, 412 is evaluated first)
 *      https://developers.cloudflare.com/r2/platform/limits/
 *  - Documented status codes InternalError 500 / ServiceUnavailable 503 / TooManyRequests 429 are produced by the
 *    existing fault proxy placed in front of this server (tests/support/s3-fault-proxy.ts), not by the mock itself.
 *
 * NOT VERIFIED, therefore NOT ENCODED (the mock answers 501 or ignores it, and no test asserts it):
 *  - the clock-skew tolerance, and the error code R2 uses for skew (the mock uses the documented ExpiredRequest and a
 *    tolerance that is an OPTION, default 15 minutes: an AWS S3 convention, not an R2 statement);
 *  - the answer for any region other than `auto`/`us-east-1` (the mock says SignatureDoesNotMatch, inferred);
 *  - whether `x-amz-content-sha256` is verified against the body, `UNSIGNED-PAYLOAD`, aws-chunked bodies;
 *  - `x-amz-checksum-*` request headers, the single-PutObject ETag value (the mock sends the MD5, no test asserts it),
 *    ETag mismatches in CompleteMultipartUpload, the order of parts there, an empty part list, a part number outside
 *    1..10,000, Range reads, ListParts, ListObjectsV2, copy operations, the 7-day expiry of unfinished uploads;
 *  - whether a Content-Length-less request other than PutObject/UploadPart is refused with 411;
 *  - the error ordering between NoSuchBucket and AccessDenied for a bucket the token cannot see (the mock reports
 *    NoSuchBucket for a bucket that does not exist and AccessDenied for an existing one outside the token's scope);
 *  - the message texts of every error, and the response headers other than ETag, Content-Length and Content-Type.
 */

export const R2_MOCK_LABEL = 'R2-behaviour MOCK built from documentation (NOT R2)';

const http = process.getBuiltinModule('node:http');
const nodeCrypto = process.getBuiltinModule('node:crypto');

type IncomingMessage = InstanceType<typeof http.IncomingMessage>;
type ServerResponse = InstanceType<typeof http.ServerResponse>;
type Socket = IncomingMessage['socket'];

const KIB = 1024;
const MIB = KIB * KIB;
const GIB = MIB * KIB;
const TIB = GIB * KIB;

export interface R2MockLimits {
  readonly maximumKeyBytes: number;
  readonly maximumMetadataBytes: number;
  readonly maximumObjectBytes: number;
  readonly maximumParts: number;
  readonly maximumSingleUploadBytes: number;
  readonly minimumPartBytes: number;
}

/** The documented limits (https://developers.cloudflare.com/r2/platform/limits/). */
const DOCUMENTED_LIMITS: R2MockLimits = {
  maximumKeyBytes: 1024,
  maximumMetadataBytes: 8192,
  // "The object size limit is 5 GiB less than 5 TiB, so 4.995 TiB."
  maximumObjectBytes: 5 * TIB - 5 * GIB,
  maximumParts: 10_000,
  // "The max upload size is 5 MiB less than 5 GiB, so 4.995 GiB."
  maximumSingleUploadBytes: 5 * GIB - 5 * MIB,
  // multipart-objects: "Minimum part size: 5 MiB (except for the last part)"
  minimumPartBytes: 5 * MIB,
};

export interface R2BehaviourMockOptions {
  /** The buckets that exist. The first is the one the credential is issued for. Default `d20-test-r2mock`. */
  readonly buckets?: readonly string[];
  /** The buckets the issued credential may use. Default: the first bucket only. */
  readonly credentialBuckets?: readonly string[];
  readonly limits?: Partial<R2MockLimits>;
  /** The server clock, in epoch milliseconds. Default: the system clock. */
  readonly now?: () => number;
  /** Opt-in: a second committed write to one key inside this interval answers 429 TooManyRequests. */
  readonly sameKeyWriteIntervalMillis?: number;
  /** Not documented by R2 (NOT VERIFIED). Default 15 minutes. */
  readonly skewToleranceMillis?: number;
}

interface StoredObject {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly etag: string;
  readonly modifiedMillis: number;
}

interface StoredPart {
  readonly bytes: Buffer;
  readonly etag: string;
}

interface PendingUpload {
  readonly bucket: string;
  readonly contentType: string;
  readonly key: string;
  readonly parts: Map<number, StoredPart>;
}

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

export interface R2BehaviourMock {
  readonly admin: {
    readonly get: (bucket: string, key: string) => Uint8Array | undefined;
    readonly keys: (bucket: string) => readonly string[];
    /** An out-of-band write (as an operator or a second writer would do), never through the S3 API checks. */
    readonly put: (bucket: string, key: string, bytes: Uint8Array) => void;
    /** An unfinished multipart upload, as a crashed writer would leave one. Returns its upload id. */
    readonly startUpload: (bucket: string, key: string) => string;
    readonly uploads: (bucket: string) => readonly string[];
  };
  readonly bucket: string;
  readonly credentials: { readonly accessKeyId: Redacted.Redacted; readonly secretAccessKey: Redacted.Redacted };
  readonly limits: R2MockLimits;
  /** The server clock in epoch milliseconds: sign requests with it. */
  readonly now: () => number;
  /** `http://127.0.0.1:<port>`: path style. `http://<bucket>.localhost:<port>` reaches the same server virtual-hosted. */
  readonly origin: URL;
  readonly requests: () => readonly RecordedRequest[];
}

const md5 = (bytes: Uint8Array): Buffer => nodeCrypto.createHash('md5').update(bytes).digest();
const sha256Hex = (text: string): string => nodeCrypto.createHash('sha256').update(text).digest('hex');
const hmac = (key: Buffer | string, message: string): Buffer =>
  nodeCrypto.createHmac('sha256', key).update(message).digest();
const quoted = (hash: Buffer, suffix = '') => `"${hash.toString('hex')}${suffix}"`;
const escapeXml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const encodeRfc3986 = (text: string): string =>
  encodeURIComponent(text).replaceAll(
    /[!'()*]/gu,
    (character) => `%${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}`,
  );

/** The regions R2 documents: `auto`, and `us-east-1` as its alias. */
const ACCEPTED_REGIONS = new Set(['auto', 'us-east-1']);
const VIRTUAL_HOST_SUFFIX = '.localhost';
const DEFAULT_CONTENT_TYPE = 'binary/octet-stream';
const XML_PROLOG = '<?xml version="1.0" encoding="UTF-8"?>';
const AUTHORIZATION =
  /^AWS4-HMAC-SHA256 Credential=(?<credential>[^,\s]+),\s*SignedHeaders=(?<signed>[^,\s]+),\s*Signature=(?<signature>[0-9a-f]{64})$/u;
const AMZ_DATE = /^(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})T(?<hour>\d{2})(?<minute>\d{2})(?<second>\d{2})Z$/u;

const errorBody = (code: string, message: string) =>
  `${XML_PROLOG}<Error><Code>${code}</Code><Message>${escapeXml(R2_MOCK_LABEL)}: ${escapeXml(message)}</Message></Error>`;

/** A refusal the documentation names. */
interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

const refuse = (status: number, code: string, message: string): Refusal => ({ code, message, status });

const unverified = (what: string): Refusal =>
  refuse(501, 'NotImplemented', `R2's behaviour for ${what} is NOT VERIFIED (not documented); the mock does not guess`);

const startOfRequest = (header: string | undefined): number | undefined => {
  const groups = header === undefined ? undefined : AMZ_DATE.exec(header)?.groups;
  if (groups === undefined) {
    return undefined;
  }
  const { day, hour, minute, month, second, year } = groups;
  const parsed = DateTime.make(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : undefined;
};

interface Target {
  readonly bucket: string;
  readonly key: string;
  readonly path: string;
  readonly query: URLSearchParams;
}

/** The bucket and key of a request: virtual-hosted when the host is `<bucket>.localhost`, path style otherwise. */
const targetOf = (request: IncomingMessage): Target | undefined => {
  const raw = request.url ?? '/';
  const split = raw.indexOf('?');
  const path = split === -1 ? raw : raw.slice(0, split);
  const query = new URLSearchParams(split === -1 ? '' : raw.slice(split + 1));
  const hostname = (request.headers.host ?? '').replace(/:\d+$/u, '');
  try {
    if (hostname.endsWith(VIRTUAL_HOST_SUFFIX)) {
      return {
        bucket: hostname.slice(0, -VIRTUAL_HOST_SUFFIX.length),
        key: decodeURIComponent(path.slice(1)),
        path,
        query,
      };
    }
    const [bucket = '', ...rest] = path.slice(1).split('/');
    return { bucket: decodeURIComponent(bucket), key: decodeURIComponent(rest.join('/')), path, query };
  } catch {
    return undefined;
  }
};

const compareText = (left: string, right: string): number => Number(left > right) - Number(left < right);

const canonicalPath = (path: string): string =>
  path
    .split('/')
    .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
    .join('/');

const canonicalQuery = (query: URLSearchParams): string =>
  [...query.entries()]
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .toSorted(
      ([left, leftValue], [right, rightValue]) => compareText(left, right) || compareText(leftValue, rightValue),
    )
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

const bodyOf = (request: IncomingMessage, whenDone: (body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  request.on('end', () => {
    whenDone(Buffer.concat(chunks));
  });
};

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
};

class MockState {
  readonly buckets: Map<string, Map<string, StoredObject>>;
  readonly lastWrite = new Map<string, number>();
  readonly log: RecordedRequest[] = [];
  readonly uploads = new Map<string, PendingUpload>();

  constructor(bucketNames: readonly string[]) {
    this.buckets = new Map(bucketNames.map((name) => [name, new Map<string, StoredObject>()]));
  }
}

interface Context {
  readonly credentials: {
    readonly accessKeyId: string;
    readonly buckets: ReadonlySet<string>;
    readonly secretAccessKey: string;
  };
  readonly limits: R2MockLimits;
  readonly now: () => number;
  readonly sameKeyWriteIntervalMillis: number | undefined;
  readonly skewToleranceMillis: number;
  readonly state: MockState;
}

const BAD_SIGNATURE = 'the request signature we calculated does not match the signature you provided';
const BAD_CREDENTIALS = 'credentials are missing or invalid';
const TOO_MANY_WRITES = 'concurrent writes to the same object name at a higher rate than 1 per second';
const KEY_TOO_LONG = 'the object key is too long';
const NO_LENGTH = 'the Content-Length header is missing';
const NO_SUCH_UPLOAD = 'the specified multipart upload does not exist';
const XML_HEADERS = { 'content-type': 'application/xml' } as const;

interface ParsedAuthorization {
  readonly accessKeyId: string;
  readonly date: string;
  readonly region: string;
  readonly service: string;
  readonly signature: string;
  readonly signed: string;
  readonly terminator: string;
}

const parseAuthorization = (request: IncomingMessage): ParsedAuthorization | undefined => {
  const authorization = header(request, 'authorization');
  const groups = authorization === undefined ? undefined : AUTHORIZATION.exec(authorization)?.groups;
  if (groups === undefined) {
    return undefined;
  }
  const [accessKeyId = '', date = '', region = '', service = '', terminator = ''] = (groups['credential'] ?? '').split(
    '/',
  );
  return {
    accessKeyId,
    date,
    region,
    service,
    signature: groups['signature'] ?? '',
    signed: groups['signed'] ?? '',
    terminator,
  };
};

/** The signature the server computes (node crypto, written independently of the adapter's @noble signer). */
const expectedSignature = (
  context: Context,
  request: IncomingMessage,
  target: Target,
  parsed: ParsedAuthorization,
  stamp: string,
): string => {
  const canonicalHeaders = parsed.signed
    .split(';')
    .map((name) => `${name}:${(header(request, name) ?? '').trim().replaceAll(/\s+/gu, ' ')}\n`)
    .join('');
  const canonicalRequest = [
    request.method ?? '',
    canonicalPath(target.path),
    canonicalQuery(target.query),
    canonicalHeaders,
    parsed.signed,
    header(request, 'x-amz-content-sha256') ?? '',
  ].join('\n');
  const scope = `${parsed.date}/${parsed.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const dateKey = hmac(`AWS4${context.credentials.secretAccessKey}`, parsed.date);
  const signingKey = hmac(hmac(hmac(dateKey, parsed.region), 's3'), 'aws4_request');
  return hmac(signingKey, stringToSign).toString('hex');
};

const scopeIsRecognised = (parsed: ParsedAuthorization, stamp: string | undefined): boolean =>
  stamp !== undefined &&
  stamp.startsWith(parsed.date) &&
  parsed.service === 's3' &&
  parsed.terminator === 'aws4_request' &&
  ACCEPTED_REGIONS.has(parsed.region) &&
  parsed.signed.split(';').includes('host');

/** SigV4 as the server checks it. */
const authenticate = (context: Context, request: IncomingMessage, target: Target): Refusal | undefined => {
  const parsed = parseAuthorization(request);
  if (parsed?.accessKeyId !== context.credentials.accessKeyId) {
    return refuse(401, 'Unauthorized', BAD_CREDENTIALS);
  }
  const stamp = header(request, 'x-amz-date');
  const requestTime = startOfRequest(stamp);
  if (stamp === undefined || requestTime === undefined || !scopeIsRecognised(parsed, stamp)) {
    return refuse(403, 'SignatureDoesNotMatch', BAD_SIGNATURE);
  }
  const expected = Buffer.from(expectedSignature(context, request, target, parsed, stamp));
  const given = Buffer.from(parsed.signature);
  if (expected.byteLength !== given.byteLength || !nodeCrypto.timingSafeEqual(expected, given)) {
    return refuse(403, 'SignatureDoesNotMatch', BAD_SIGNATURE);
  }
  return Math.abs(context.now() - requestTime) > context.skewToleranceMillis
    ? refuse(403, 'ExpiredRequest', 'the request signature has expired')
    : undefined;
};

const authorizeBucket = (context: Context, bucket: string): Refusal | undefined => {
  if (!context.state.buckets.has(bucket)) {
    return refuse(404, 'NoSuchBucket', 'the specified bucket does not exist');
  }
  return context.credentials.buckets.has(bucket) ? undefined : refuse(403, 'AccessDenied', 'access denied');
};

/** If-Match and If-None-Match against the destination object (and `*` as "any object"). */
const preconditionOf = (request: IncomingMessage, existing: StoredObject | undefined): Refusal | undefined => {
  const failed = refuse(412, 'PreconditionFailed', 'at least one of the pre-conditions you specified did not hold');
  const ifNoneMatch = header(request, 'if-none-match');
  const ifMatch = header(request, 'if-match');
  const matches = (condition: string) =>
    existing !== undefined && (condition === '*' || condition.split(',').some((tag) => tag.trim() === existing.etag));
  if (ifNoneMatch !== undefined && matches(ifNoneMatch)) {
    return failed;
  }
  if (ifMatch !== undefined && !matches(ifMatch)) {
    return failed;
  }
  return undefined;
};

const metadataBytes = (request: IncomingMessage): number =>
  Object.entries(request.headers)
    .filter(([name]) => name.startsWith('x-amz-meta-'))
    .reduce((total, [name, value]) => total + Buffer.byteLength(name) + Buffer.byteLength(String(value)), 0);

/** Content-MD5 when the client sends one: BadDigest on a different digest, InvalidDigest on a malformed one. */
const contentMd5Refusal = (request: IncomingMessage, body: Buffer): Refusal | undefined => {
  const sent = header(request, 'content-md5');
  if (sent === undefined) {
    return undefined;
  }
  if (!/^[A-Za-z0-9+/]{22}==$/u.test(sent)) {
    return refuse(400, 'InvalidDigest', 'the Content-MD5 you specified is not valid');
  }
  return Buffer.from(sent, 'base64').equals(md5(body))
    ? undefined
    : refuse(400, 'BadDigest', 'the Content-MD5 you specified did not match what we received');
};

interface Answer {
  readonly body?: Buffer | string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status: number;
}

const objectHeaders = (object: StoredObject) => ({
  'content-length': String(object.bytes.byteLength),
  'content-type': object.contentType,
  etag: object.etag,
  'last-modified': DateTime.toDateUtc(DateTime.makeUnsafe(object.modifiedMillis)).toUTCString(),
});

const withinWriteInterval = (context: Context, bucket: string, key: string): boolean => {
  const { sameKeyWriteIntervalMillis } = context;
  const last = context.state.lastWrite.get(`${bucket}\0${key}`);
  return (
    sameKeyWriteIntervalMillis !== undefined && last !== undefined && context.now() - last < sameKeyWriteIntervalMillis
  );
};

const commit = (context: Context, target: Target, object: StoredObject): void => {
  context.state.buckets.get(target.bucket)?.set(target.key, object);
  context.state.lastWrite.set(`${target.bucket}\0${target.key}`, context.now());
};

/** The refusals shared by the two requests that carry object bytes (PutObject, UploadPart). */
const uploadRefusal = (context: Context, request: IncomingMessage, body: Buffer): Refusal | undefined => {
  const { limits } = context;
  if (header(request, 'content-length') === undefined) {
    return refuse(411, 'MissingContentLength', NO_LENGTH);
  }
  if (body.byteLength > limits.maximumSingleUploadBytes) {
    return refuse(400, 'EntityTooLarge', 'the upload exceeds the maximum upload size');
  }
  return contentMd5Refusal(request, body);
};

const putObject = (context: Context, request: IncomingMessage, target: Target, body: Buffer): Answer | Refusal => {
  const { limits } = context;
  if (Buffer.byteLength(target.key) > limits.maximumKeyBytes) {
    return refuse(400, 'InvalidObjectName', KEY_TOO_LONG);
  }
  if (metadataBytes(request) > limits.maximumMetadataBytes) {
    return refuse(400, 'MetadataTooLarge', 'the metadata exceeds the limit');
  }
  const refusal =
    uploadRefusal(context, request, body) ??
    preconditionOf(request, context.state.buckets.get(target.bucket)?.get(target.key));
  if (refusal !== undefined) {
    return refusal;
  }
  if (withinWriteInterval(context, target.bucket, target.key)) {
    return refuse(429, 'TooManyRequests', TOO_MANY_WRITES);
  }
  const object: StoredObject = {
    bytes: body,
    contentType: header(request, 'content-type') ?? DEFAULT_CONTENT_TYPE,
    etag: quoted(md5(body)),
    modifiedMillis: context.now(),
  };
  commit(context, target, object);
  return { headers: { etag: object.etag }, status: 200 };
};

const createUpload = (context: Context, request: IncomingMessage, target: Target): Answer | Refusal => {
  if (Buffer.byteLength(target.key) > context.limits.maximumKeyBytes) {
    return refuse(400, 'InvalidObjectName', KEY_TOO_LONG);
  }
  // Conditions on CreateMultipartUpload are evaluated against the destination now and are not retained.
  const failed = preconditionOf(request, context.state.buckets.get(target.bucket)?.get(target.key));
  if (failed !== undefined) {
    return failed;
  }
  const uploadId = nodeCrypto.randomBytes(24).toString('base64url');
  context.state.uploads.set(uploadId, {
    bucket: target.bucket,
    contentType: header(request, 'content-type') ?? DEFAULT_CONTENT_TYPE,
    key: target.key,
    parts: new Map(),
  });
  const result = `<Bucket>${escapeXml(target.bucket)}</Bucket><Key>${escapeXml(target.key)}</Key><UploadId>${uploadId}</UploadId>`;
  return {
    body: `${XML_PROLOG}<InitiateMultipartUploadResult>${result}</InitiateMultipartUploadResult>`,
    headers: XML_HEADERS,
    status: 200,
  };
};

const pendingUpload = (context: Context, target: Target): PendingUpload | Refusal => {
  const upload = context.state.uploads.get(target.query.get('uploadId') ?? '');
  return upload?.bucket === target.bucket && upload.key === target.key
    ? upload
    : refuse(404, 'NoSuchUpload', NO_SUCH_UPLOAD);
};

const uploadPart = (context: Context, request: IncomingMessage, target: Target, body: Buffer): Answer | Refusal => {
  const upload = pendingUpload(context, target);
  if ('status' in upload) {
    return upload;
  }
  const number = Number(target.query.get('partNumber'));
  if (!Number.isInteger(number) || number < 1 || number > context.limits.maximumParts) {
    return unverified('a part number outside 1..10,000');
  }
  const refusal = uploadRefusal(context, request, body);
  if (refusal !== undefined) {
    return refusal;
  }
  const etag = quoted(md5(body));
  // "Uploading to the same part number replaces the previous part."
  upload.parts.set(number, { bytes: body, etag });
  return { headers: { etag }, status: 200 };
};

const listedParts = (xml: string): readonly number[] =>
  [...xml.matchAll(/<Part>\s*<PartNumber>(?<number>\d+)<\/PartNumber>/gu)].map((match) =>
    Number(match.groups?.['number']),
  );

/** The parts a completion names, or the refusal for a list the mock does not understand or the upload cannot satisfy. */
const partsOfCompletion = (context: Context, upload: PendingUpload, body: Buffer): readonly StoredPart[] | Refusal => {
  const numbers = listedParts(body.toString('utf-8'));
  if (numbers.length === 0) {
    return unverified('completing an upload with no parts');
  }
  if (numbers.some((number, index) => index > 0 && number <= (numbers[index - 1] ?? 0))) {
    return unverified('a part list that is not in ascending order');
  }
  const parts = numbers.map((number) => upload.parts.get(number));
  const stored = parts.filter((part) => part !== undefined);
  if (stored.length !== parts.length) {
    return refuse(400, 'InvalidPart', 'one or more of the specified parts could not be found');
  }
  const nonLast = stored.slice(0, -1);
  if (nonLast.some((part) => part.bytes.byteLength < context.limits.minimumPartBytes)) {
    return refuse(400, 'EntityTooSmall', 'a part other than the last is smaller than the minimum part size');
  }
  return nonLast.some((part) => part.bytes.byteLength !== nonLast[0]?.bytes.byteLength)
    ? refuse(400, 'InvalidPart', 'all parts except the last must be the same size')
    : stored;
};

const completeUpload = (context: Context, request: IncomingMessage, target: Target, body: Buffer): Answer | Refusal => {
  const upload = pendingUpload(context, target);
  if ('status' in upload) {
    return upload;
  }
  const parts = partsOfCompletion(context, upload, body);
  if ('status' in parts) {
    return parts;
  }
  const joined = Buffer.concat(parts.map((part) => part.bytes));
  if (joined.byteLength > context.limits.maximumObjectBytes) {
    return refuse(400, 'EntityTooLarge', 'the object exceeds the maximum size');
  }
  const failed = preconditionOf(request, context.state.buckets.get(target.bucket)?.get(target.key));
  if (failed !== undefined) {
    return failed;
  }
  if (withinWriteInterval(context, target.bucket, target.key)) {
    return refuse(429, 'TooManyRequests', TOO_MANY_WRITES);
  }
  const etag = quoted(md5(Buffer.concat(parts.map((part) => md5(part.bytes)))), `-${parts.length}`);
  commit(context, target, {
    bytes: joined,
    contentType: upload.contentType,
    etag,
    modifiedMillis: context.now(),
  });
  context.state.uploads.delete(target.query.get('uploadId') ?? '');
  const result = `<Bucket>${escapeXml(target.bucket)}</Bucket><Key>${escapeXml(target.key)}</Key><ETag>${escapeXml(etag)}</ETag>`;
  return {
    body: `${XML_PROLOG}<CompleteMultipartUploadResult>${result}</CompleteMultipartUploadResult>`,
    headers: XML_HEADERS,
    status: 200,
  };
};

const readObject = (context: Context, target: Target, withBody: boolean): Answer | Refusal => {
  const object = context.state.buckets.get(target.bucket)?.get(target.key);
  if (object === undefined) {
    return refuse(404, 'NoSuchKey', 'the specified key does not exist');
  }
  const headers = objectHeaders(object);
  return withBody ? { body: object.bytes, headers, status: 200 } : { headers, status: 200 };
};

const abortUpload = (context: Context, target: Target): Answer | Refusal => {
  const upload = pendingUpload(context, target);
  if ('status' in upload) {
    return upload;
  }
  context.state.uploads.delete(target.query.get('uploadId') ?? '');
  return { status: 204 };
};

const deleteObject = (context: Context, target: Target): Answer => {
  context.state.buckets.get(target.bucket)?.delete(target.key);
  return { status: 204 };
};

const listUploads = (context: Context, target: Target): Answer => {
  const entries = [...context.state.uploads.entries()]
    .filter(([, upload]) => upload.bucket === target.bucket)
    .map(
      ([uploadId, upload]) => `<Upload><Key>${escapeXml(upload.key)}</Key><UploadId>${uploadId}</UploadId></Upload>`,
    );
  const result = `<Bucket>${escapeXml(target.bucket)}</Bucket>${entries.join('')}`;
  return {
    body: `${XML_PROLOG}<ListMultipartUploadsResult>${result}</ListMultipartUploadsResult>`,
    headers: XML_HEADERS,
    status: 200,
  };
};

interface Call {
  readonly body: Buffer;
  readonly context: Context;
  readonly method: string;
  /** The query parameter names, in order. */
  readonly names: readonly string[];
  readonly request: IncomingMessage;
  readonly target: Target;
}

interface Route {
  readonly applies: (call: Call) => boolean;
  readonly run: (call: Call) => Answer | Refusal;
}

const hasOnly = (call: Call, ...expected: readonly string[]) =>
  call.names.length === expected.length && expected.every((name) => call.names.includes(name));

/** Everything the documentation states and the adapter or its tests use. Any other request is `unverified`. */
const ROUTES: readonly Route[] = [
  {
    applies: (call) => call.target.key === '' && call.method === 'GET' && hasOnly(call, 'uploads'),
    run: ({ context, target }) => listUploads(context, target),
  },
  {
    applies: (call) =>
      call.target.key !== '' && call.method === 'PUT' && header(call.request, 'x-amz-copy-source') !== undefined,
    run: () => unverified('copy operations'),
  },
  {
    applies: (call) => call.target.key !== '' && call.method === 'PUT' && call.names.length === 0,
    run: ({ body, context, request, target }) => putObject(context, request, target, body),
  },
  {
    applies: (call) => call.target.key !== '' && call.method === 'PUT' && hasOnly(call, 'partNumber', 'uploadId'),
    run: ({ body, context, request, target }) => uploadPart(context, request, target, body),
  },
  {
    applies: (call) => call.target.key !== '' && call.method === 'POST' && hasOnly(call, 'uploads'),
    run: ({ context, request, target }) => createUpload(context, request, target),
  },
  {
    applies: (call) => call.target.key !== '' && call.method === 'POST' && hasOnly(call, 'uploadId'),
    run: ({ body, context, request, target }) => completeUpload(context, request, target, body),
  },
  {
    applies: (call) => call.target.key !== '' && call.method === 'GET' && call.names.length === 0,
    run: ({ context, target }) => readObject(context, target, true),
  },
  {
    applies: (call) => call.target.key !== '' && call.method === 'HEAD' && call.names.length === 0,
    run: ({ context, target }) => readObject(context, target, false),
  },
  {
    applies: (call) => call.target.key !== '' && call.method === 'DELETE' && hasOnly(call, 'uploadId'),
    run: ({ context, target }) => abortUpload(context, target),
  },
  {
    applies: (call) => call.target.key !== '' && call.method === 'DELETE' && call.names.length === 0,
    run: ({ context, target }) => deleteObject(context, target),
  },
];

const dispatch = (context: Context, request: IncomingMessage, target: Target, body: Buffer): Answer | Refusal => {
  const call: Call = {
    body,
    context,
    method: request.method ?? 'GET',
    names: [...target.query.keys()],
    request,
    target,
  };
  const route = ROUTES.find((candidate) => candidate.applies(call));
  return (
    route?.run(call) ??
    unverified(
      `${call.method} ${call.target.key === '' ? 'on the bucket' : 'on an object'} with query (${call.names.join(', ')})`,
    )
  );
};

const send = (context: Context, request: IncomingMessage, response: ServerResponse, answer: Answer | Refusal) => {
  context.state.log.push({ method: request.method ?? '', path: request.url ?? '', status: answer.status });
  if ('code' in answer) {
    if (request.method === 'HEAD') {
      // A HEAD answer has no body, so a 404 cannot tell a missing key from a missing bucket.
      response.writeHead(answer.status);
      response.end();
      return;
    }
    const text = errorBody(answer.code, answer.message);
    response.writeHead(answer.status, { 'content-length': Buffer.byteLength(text), ...XML_HEADERS });
    response.end(text);
    return;
  }
  response.writeHead(answer.status, answer.headers ?? {});
  response.end(request.method === 'HEAD' ? undefined : answer.body);
};

const handle = (context: Context) => (request: IncomingMessage, response: ServerResponse) => {
  bodyOf(request, (body) => {
    const target = targetOf(request);
    if (target === undefined) {
      send(context, request, response, refuse(400, 'InvalidObjectName', 'the object key is not valid'));
      return;
    }
    const refusal = authenticate(context, request, target) ?? authorizeBucket(context, target.bucket);
    send(context, request, response, refusal ?? dispatch(context, request, target, body));
  });
};

const randomHex = (bytes: number) => nodeCrypto.randomBytes(bytes).toString('hex');

const adminOf = (context: Context): R2BehaviourMock['admin'] => ({
  get: (bucket, key) => context.state.buckets.get(bucket)?.get(key)?.bytes,
  keys: (bucket) => [...(context.state.buckets.get(bucket)?.keys() ?? [])],
  put: (bucket, key, bytes) => {
    context.state.buckets.get(bucket)?.set(key, {
      bytes: Buffer.from(bytes),
      contentType: DEFAULT_CONTENT_TYPE,
      etag: quoted(md5(bytes)),
      modifiedMillis: context.now(),
    });
  },
  startUpload: (bucket, key) => {
    const uploadId = nodeCrypto.randomBytes(24).toString('base64url');
    context.state.uploads.set(uploadId, { bucket, contentType: DEFAULT_CONTENT_TYPE, key, parts: new Map() });
    return uploadId;
  },
  uploads: (bucket) =>
    [...context.state.uploads.values()].filter((upload) => upload.bucket === bucket).map((upload) => upload.key),
});

const contextOf = (options: R2BehaviourMockOptions) => {
  const buckets = options.buckets ?? ['d20-test-r2mock'];
  return {
    buckets,
    context: {
      credentials: {
        accessKeyId: `r2mock${randomHex(8)}`,
        buckets: new Set(options.credentialBuckets ?? buckets.slice(0, 1)),
        secretAccessKey: randomHex(32),
      },
      limits: { ...DOCUMENTED_LIMITS, ...options.limits },
      now: options.now ?? (() => DateTime.toEpochMillis(DateTime.nowUnsafe())),
      sameKeyWriteIntervalMillis: options.sameKeyWriteIntervalMillis,
      skewToleranceMillis: options.skewToleranceMillis ?? 15 * 60 * 1000,
      state: new MockState(buckets),
    },
  };
};

const mockOf = (context: Context, buckets: readonly string[], port: number): R2BehaviourMock => {
  const origin = new URL('https://127.0.0.1');
  origin.protocol = 'http:';
  origin.port = String(port);
  return {
    admin: adminOf(context),
    bucket: buckets[0] ?? '',
    credentials: {
      accessKeyId: Redacted.make(context.credentials.accessKeyId),
      secretAccessKey: Redacted.make(context.credentials.secretAccessKey),
    },
    limits: context.limits,
    now: context.now,
    origin,
    requests: () => [...context.state.log],
  };
};

type Server = ReturnType<typeof http.createServer>;

const listen = (options: R2BehaviourMockOptions) =>
  Effect.callback<{ readonly mock: R2BehaviourMock; readonly server: Server }>((resume) => {
    const { buckets, context } = contextOf(options);
    const sockets = new Set<Socket>();
    const server = http.createServer(handle(context));
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
      });
    });
    server.on('close', () => {
      for (const socket of sockets) {
        socket.destroy();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resume(
        Effect.succeed({
          mock: mockOf(context, buckets, Predicate.hasProperty(address, 'port') ? address.port : 0),
          server,
        }),
      );
    });
  });

const close = ({ server }: { readonly server: Server }) =>
  Effect.callback<undefined>((resume) => {
    server.closeAllConnections();
    server.close(() => {
      resume(Effect.undefined);
    });
  });

/** Starts the mock on a free loopback port for the lifetime of the surrounding scope. */
export const startR2BehaviourMock = (options: R2BehaviourMockOptions = {}) =>
  Effect.acquireRelease(listen(options), close).pipe(Effect.map(({ mock }) => mock));
