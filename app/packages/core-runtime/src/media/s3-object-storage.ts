import { DateTime, Duration, Effect, Option, Stream } from 'effect';
import { WebCrypto } from 'effect/crypto';
import { sha256Bytes } from '../crypto/sha256.ts';
import { Hex } from 'effect/encoding';
import { HttpClient, HttpClientRequest } from 'effect/http';
import type { HttpClientError, HttpClientResponse } from 'effect/http';

import {
  ObjectStorageChecksumUnsupported,
  ObjectStorageNetworkError,
  ObjectStorageObjectExists,
  ObjectStorageObjectMissing,
  ObjectStorageServerError,
  ObjectStorageTimeout,
} from './object-storage.ts';
import type {
  ObjectBody,
  ObjectStat,
  ObjectStorageFailure,
  ObjectStorageService,
  PutObjectRequest,
} from './object-storage.ts';
import { S3_MAXIMUM_PART_BYTES, S3_MINIMUM_PART_BYTES } from './s3-config.ts';
import type { S3ObjectStorageConfigValue } from './s3-config.ts';
import { EMPTY_PAYLOAD_SHA256, signS3Request } from './s3-signing.ts';
import type { MediaStorageKey } from './storage-key.ts';

/*
 * The private S3-API adapter of the Core Media `ObjectStorage` port. It speaks the S3 REST protocol through the
 * Effect `HttpClient` service (the test seam) and signs with SigV4, so it names no provider and runs on node and
 * workerd. It owns provider schemas, request construction, failure mapping and redacted diagnostics.
 *
 * What it deliberately does not do:
 * - delete or overwrite a confirmed object: the port has no delete, a write is create-only where the
 *   deployment states the provider supports it, and the only DELETE it issues aborts its own unfinished
 *   multipart upload;
 * - retry, back off or time out on a value of its own: a request fails once with a typed failure, and a timeout
 *   exists only when the deployment configures one (recovery is the caller's, through the Action identity);
 * - ask the provider to verify a whole-object SHA-256: it is not part of the supported request set, so a
 *   request for it fails with `ObjectStorageChecksumUnsupported` and read-back verification decides;
 * - report an ETag as a version or a revision. `versionRef` is the provider's `x-amz-version-id`; only where the
 *   provider has none (an unversioned bucket, Cloudflare R2, MinIO) it is the technical pin `etag:<ETag>`, so a
 *   stat can tell that the stored object is no longer the one whose digest was verified. The pin is integrity
 *   evidence, never a revision, and it is as strong as the provider's ETag: a content hash (MD5, or the MD5 of
 *   the part MD5s) gives a different pin for different bytes of any length; an ETag that is not derived from the
 *   content (some encrypted or compatible stores) gives no such guarantee.
 *
 * Bytes are sent in parts of one bounded size. An object that fits one part is one `PutObject`, anything larger
 * is a multipart upload, so memory is bounded by about three parts (the one being sent, the next one and the
 * one being filled), sized from the declared object size and never allocated ahead of the bytes actually
 * received, and no request needs a stream body (which neither the
 * Fetch client nor workerd can frame with a length). The body is read to the end of a part before it is sent,
 * and a failing body aborts the multipart upload (or never sends the single request), so nothing is readable
 * under the key.
 */

/** Parts per multipart upload. An S3 protocol constant, shared by the providers this adapter targets. */
const S3_MAXIMUM_PARTS = 10_000;
type PartBytes = Uint8Array<ArrayBuffer>;
const EMPTY_BODY: PartBytes = new Uint8Array(0);
const encoder = new TextEncoder();
const MAXIMUM_ERROR_BODY_CHARACTERS = 8192;
const SAFE_CODE = /^[A-Za-z]{1,64}$/u;
const SAFE_TOKEN = /^[!-~]{1,2048}$/u;
const SAFE_VERSION = /^[!-~]{1,1024}$/u;
const CONTENT_LENGTH = /^\d{1,16}$/u;
const TRANSFER_FAULT_CODE =
  /^(?:BadDigest|ClientDisconnect|IncompleteBody|InvalidDigest|RequestTimeout|XAmzContentSHA256Mismatch)$/u;

const Operations = {
  abort: 'abort',
  complete: 'complete',
  createUpload: 'create-upload',
  get: 'get',
  head: 'head',
  put: 'put',
  uploadPart: 'upload-part',
} as const;
type Operation = (typeof Operations)[keyof typeof Operations];

const networkError = (reason: string) =>
  new ObjectStorageNetworkError({ code: 'object_storage_network_error', reason });
const serverError = (reason: string) => new ObjectStorageServerError({ code: 'object_storage_server_error', reason });

/** A transport failure of the HTTP client. Only the kind of failure is kept: its cause can name the host or URL. */
const transportFailure = (operation: Operation, error: HttpClientError.HttpClientError): ObjectStorageFailure =>
  networkError(`${operation}: the request did not complete (${error.reason._tag})`);

const textTag = (text: string, tag: string): string | undefined =>
  new RegExp(`<${tag}>(?<value>[^<]{1,2048})</${tag}>`, 'u').exec(text)?.groups?.['value'];

const safeCode = (text: string): string => {
  const code = textTag(text, 'Code');
  return code !== undefined && SAFE_CODE.test(code) ? code : 'Unknown';
};

const headerOf = (response: HttpClientResponse.HttpClientResponse, name: string): string | undefined =>
  response.headers[name];

const versionRefOf = (response: HttpClientResponse.HttpClientResponse): string | undefined => {
  const version = headerOf(response, 'x-amz-version-id');
  if (version !== undefined && version !== 'null' && SAFE_VERSION.test(version)) {
    return version;
  }
  // No version id: the ETag is the only thing that changes when the object under the key is written again.
  const etag = headerOf(response, 'etag');
  return etag !== undefined && SAFE_VERSION.test(etag) ? `etag:${etag}` : undefined;
};

const statOf = (byteSize: number, versionRef: string | undefined): ObjectStat =>
  versionRef === undefined ? { byteSize } : { byteSize, versionRef };

const parseLength = (value: string | undefined): number | undefined =>
  value !== undefined && CONTENT_LENGTH.test(value) ? Number(value) : undefined;

const escapeXml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** A part being assembled: it grows to at most `partSize` and is handed over whole, so each byte is copied once. */
interface PartBuffer {
  bytes: PartBytes;
  length: number;
}

const appendTo = (buffer: PartBuffer, chunk: Uint8Array, partSize: number): void => {
  const needed = buffer.length + chunk.byteLength;
  if (needed > buffer.bytes.byteLength) {
    const grown = new Uint8Array(Math.min(partSize, Math.max(needed, buffer.bytes.byteLength * 2)));
    grown.set(buffer.bytes.subarray(0, buffer.length));
    buffer.bytes = grown;
  }
  buffer.bytes.set(chunk, buffer.length);
  buffer.length = needed;
};

const freshPart = (): PartBuffer => ({ bytes: new Uint8Array(0), length: 0 });

/**
 * The body re-cut into parts of exactly `partSize` bytes, except for the last. Each part is copied into one
 * buffer that grows with the bytes received and never exceeds `partSize`: nothing is allocated for bytes that
 * have not arrived, whatever size was declared. The state is rebuilt for every run of the stream.
 */
export const cutIntoParts = <Failure>(
  body: Stream.Stream<Uint8Array, Failure>,
  partSize: number,
): Stream.Stream<PartBytes, Failure> => {
  const take = (current: PartBuffer, chunk: Uint8Array) => {
    const emitted: PartBytes[] = [];
    let state = current;
    let offset = 0;
    while (offset < chunk.byteLength) {
      const taken = Math.min(partSize - state.length, chunk.byteLength - offset);
      appendTo(state, chunk.subarray(offset, offset + taken), partSize);
      offset += taken;
      if (state.length === partSize) {
        emitted.push(state.bytes);
        state = freshPart();
      }
    }
    return [state, emitted] as const;
  };
  return body.pipe(
    Stream.mapAccum(freshPart, take, {
      onHalt: (state) => (state.length === 0 ? [] : [state.bytes.subarray(0, state.length)]),
    }),
  );
};

/** The size of the parts for an object of `byteSize` (when known), never below the configured or protocol minimum. */
export const partSizeFor = (configured: Option.Option<number>, byteSize?: number): number => {
  const base = Option.getOrElse(configured, () => S3_MINIMUM_PART_BYTES);
  return byteSize === undefined ? base : Math.max(base, Math.ceil(byteSize / S3_MAXIMUM_PARTS));
};

/** Maps a provider answer that is not a success to the port's failure. The provider body is never copied. */
const mapStatus = (operation: Operation, status: number, code: string, createOnly: boolean): ObjectStorageFailure => {
  const reason = `${operation}: HTTP ${status} ${code}`;
  if (status === 412 && createOnly) {
    return new ObjectStorageObjectExists({
      code: 'object_storage_object_exists',
      reason: 'An object already exists under the key',
    });
  }
  if (status === 404 && (operation === Operations.get || operation === Operations.head) && code !== 'NoSuchBucket') {
    return new ObjectStorageObjectMissing({ code: 'object_storage_object_missing', reason: 'Object not found' });
  }
  // A body the provider refused for its digest or length was not stored: a transfer fault, never a verdict on bytes.
  if (status === 400 && TRANSFER_FAULT_CODE.test(code)) {
    return networkError(reason);
  }
  if (status === 408 || status === 504) {
    return new ObjectStorageTimeout({ code: 'object_storage_timeout', reason });
  }
  return serverError(reason);
};

const readErrorText = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.map((text) => text.slice(0, MAXIMUM_ERROR_BODY_CHARACTERS)),
    Effect.orElseSucceed(() => ''),
  );

/** Reads an answer to its end so the connection and the request it references are released at once. */
const drain = (response: HttpClientResponse.HttpClientResponse) => Effect.ignore(response.text);

const readAnswer = (operation: Operation, response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.mapError((fault) => networkError(`${operation}: the answer could not be read (${fault.reason._tag})`)),
  );

const payloadDigest = (
  crypto: typeof globalThis.crypto,
  bytes: PartBytes,
): Effect.Effect<string, ObjectStorageFailure> =>
  bytes.byteLength === 0
    ? Effect.succeed(EMPTY_PAYLOAD_SHA256)
    : sha256Bytes(crypto, bytes, Duration.infinity).pipe(
        Effect.map(Hex.encode),
        Effect.catchTag('PlatformError', () => Effect.fail(serverError('The payload digest could not be computed'))),
      );

interface SendInput {
  readonly body?: PartBytes;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method: 'DELETE' | 'GET' | 'HEAD' | 'POST' | 'PUT';
  readonly operation: Operation;
  readonly url: URL;
}

/** The services the adapter acts through, captured once when it is composed. */
interface Wiring {
  readonly client: HttpClient.HttpClient;
  readonly config: S3ObjectStorageConfigValue;
  readonly crypto: typeof globalThis.crypto;
}

interface PutTarget {
  readonly contentType: string;
  readonly key: MediaStorageKey;
}

const objectUrl = (
  config: S3ObjectStorageConfigValue,
  key: MediaStorageKey,
  query: Readonly<Record<string, string>> = {},
) => {
  const url =
    config.addressingStyle === 'path'
      ? new URL(`${config.endpoint.origin}/${config.bucket}/${key}`)
      : new URL(`${config.endpoint.protocol}//${config.bucket}.${config.endpoint.host}/${key}`);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  return url;
};

const PRINTABLE_ASCII = /^[\u0020-\u007E]+$/u;
const UNTYPED_CONTENT = 'application/octet-stream';

/**
 * The recorded media type is caller-stated text. Outside printable ASCII it cannot travel as a signed header (the
 * transport would refuse or re-encode it), so the provider is told the neutral type. The recorded type stays on the
 * row and is what the download edge answers with: the provider's copy is never served.
 */
const providerContentType = (contentType: string) =>
  PRINTABLE_ASCII.test(contentType) ? contentType : UNTYPED_CONTENT;

/** Signs and sends one request. A non-2xx answer is returned as the response: the caller maps it. */
const send = Effect.fn('S3ObjectStorage.send')(function* send(wiring: Wiring, input: SendInput) {
  const { client, config, crypto } = wiring;
  const body = input.body ?? EMPTY_BODY;
  const payloadSha256 = yield* payloadDigest(crypto, body);
  const contentType = input.contentType === undefined ? undefined : providerContentType(input.contentType);
  const contentHeaders = contentType === undefined ? {} : { 'content-type': contentType };
  const headers = signS3Request({
    accessKeyId: config.accessKeyId,
    headers: { ...contentHeaders, ...input.headers },
    method: input.method,
    now: yield* DateTime.now,
    payloadSha256,
    region: config.region,
    secretAccessKey: config.secretAccessKey,
    url: input.url,
  });
  const base = HttpClientRequest.make(input.method)(input.url.href).pipe(HttpClientRequest.setHeaders(headers));
  const request = input.body === undefined ? base : HttpClientRequest.bodyUint8Array(base, body, contentType);
  return yield* client.execute(request).pipe(
    Effect.mapError((fault) => transportFailure(input.operation, fault)),
    // The provider is a third party: its client span would carry the bucket and key, its headers a trace.
    Effect.updateService(HttpClient.TracerDisabledWhen, () => () => true),
    Effect.updateService(HttpClient.TracerPropagationEnabled, () => false),
    // No value of our own: without a configured timeout the caller's budget is the only bound.
    Effect.timeoutOrElse({
      duration: Option.match(config.requestTimeoutMillis, { onNone: () => Duration.infinity, onSome: Duration.millis }),
      orElse: () =>
        Effect.fail(
          new ObjectStorageTimeout({
            code: 'object_storage_timeout',
            reason: `${input.operation}: the provider did not answer in time`,
          }),
        ),
    }),
  );
});

/** Passes a 2xx answer on, and maps anything else to the port failure (logging only its kind and status). */
const expectSuccess = Effect.fn('S3ObjectStorage.expectSuccess')(function* expectSuccess<Value, Failure, Requirement>(
  operation: Operation,
  response: HttpClientResponse.HttpClientResponse,
  createOnly: boolean,
  onSuccess: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<Value, Failure, Requirement>,
) {
  if (response.status >= 200 && response.status < 300) {
    return yield* onSuccess(response);
  }
  const code = safeCode(operation === Operations.head ? '' : yield* readErrorText(response));
  yield* Effect.logWarning('Object storage request was refused').pipe(
    Effect.annotateLogs({ operation, providerCode: code, status: response.status }),
  );
  return yield* mapStatus(operation, response.status, code, createOnly);
});

const stat = Effect.fn('S3ObjectStorage.stat')(function* stat(wiring: Wiring, key: MediaStorageKey) {
  const response = yield* send(wiring, {
    method: 'HEAD',
    operation: Operations.head,
    url: objectUrl(wiring.config, key),
  });
  return yield* expectSuccess(Operations.head, response, false, (ok) =>
    drain(ok).pipe(
      Effect.andThen(() => {
        const length = parseLength(headerOf(ok, 'content-length'));
        return length === undefined
          ? Effect.fail(serverError('head: the provider answered without a length'))
          : Effect.succeed(statOf(length, versionRefOf(ok)));
      }),
    ),
  );
});

/**
 * The stream must carry exactly the announced length: a connection that ends early is a failure of the stream,
 * whatever the platform reports, and never a clean end of a shorter object.
 */
const early = () => networkError('get: the connection ended before the object was complete');

const lengthCheckedBody = (response: HttpClientResponse.HttpClientResponse, length: number) => {
  const counted = { received: 0 };
  return response.stream.pipe(
    Stream.mapError(early),
    Stream.mapEffect(
      (chunk) =>
        Effect.suspend(() => {
          counted.received += chunk.byteLength;
          return counted.received > length
            ? Effect.fail(networkError('get: the provider sent more bytes than announced'))
            : Effect.succeed(chunk);
        }),
      { concurrency: 1 },
    ),
    Stream.concat(Stream.suspend(() => (counted.received === length ? Stream.empty : Stream.fail(early())))),
  );
};

const get = Effect.fn('S3ObjectStorage.get')(function* get(wiring: Wiring, key: MediaStorageKey) {
  const response = yield* send(wiring, {
    method: 'GET',
    operation: Operations.get,
    url: objectUrl(wiring.config, key),
  });
  return yield* expectSuccess(Operations.get, response, false, (ok) => {
    const length = parseLength(headerOf(ok, 'content-length'));
    return length === undefined
      ? Effect.fail(serverError('get: the provider answered without a length'))
      : Effect.succeed({
          body: lengthCheckedBody(ok, length),
          stat: statOf(length, versionRefOf(ok)),
        } satisfies ObjectBody);
  });
});

const createOnlyHeaders = (config: S3ObjectStorageConfigValue): Readonly<Record<string, string>> =>
  config.conditionalCreate === 'supported' ? { 'if-none-match': '*' } : {};

const putSingle = Effect.fn('S3ObjectStorage.putSingle')(function* putSingle(
  wiring: Wiring,
  target: PutTarget,
  bytes: PartBytes,
) {
  const response = yield* send(wiring, {
    body: bytes,
    contentType: target.contentType,
    headers: createOnlyHeaders(wiring.config),
    method: 'PUT',
    operation: Operations.put,
    url: objectUrl(wiring.config, target.key),
  });
  return yield* expectSuccess(Operations.put, response, wiring.config.conditionalCreate === 'supported', (ok) =>
    drain(ok).pipe(Effect.as(statOf(bytes.byteLength, versionRefOf(ok)))),
  );
});

const createUpload = Effect.fn('S3ObjectStorage.createUpload')(function* createUpload(
  wiring: Wiring,
  target: PutTarget,
) {
  const response = yield* send(wiring, {
    contentType: target.contentType,
    method: 'POST',
    operation: Operations.createUpload,
    url: objectUrl(wiring.config, target.key, { uploads: '' }),
  });
  return yield* expectSuccess(Operations.createUpload, response, false, (ok) =>
    readAnswer(Operations.createUpload, ok).pipe(
      Effect.flatMap((text) => {
        const uploadId = textTag(text, 'UploadId');
        return uploadId !== undefined && SAFE_TOKEN.test(uploadId)
          ? Effect.succeed(uploadId)
          : Effect.fail(serverError('create-upload: the provider answered without an upload id'));
      }),
    ),
  );
});

const uploadPart = Effect.fn('S3ObjectStorage.uploadPart')(function* uploadPart(
  wiring: Wiring,
  key: MediaStorageKey,
  part: { readonly bytes: PartBytes; readonly number: number; readonly uploadId: string },
) {
  const response = yield* send(wiring, {
    body: part.bytes,
    contentType: 'application/octet-stream',
    method: 'PUT',
    operation: Operations.uploadPart,
    url: objectUrl(wiring.config, key, { partNumber: String(part.number), uploadId: part.uploadId }),
  });
  return yield* expectSuccess(Operations.uploadPart, response, false, (ok) =>
    drain(ok).pipe(
      Effect.andThen(() => {
        const etag = headerOf(ok, 'etag');
        return etag !== undefined && SAFE_TOKEN.test(etag)
          ? Effect.succeed(etag)
          : Effect.fail(serverError('upload-part: the provider answered without a part tag'));
      }),
    ),
  );
});

const completeUpload = Effect.fn('S3ObjectStorage.completeUpload')(function* completeUpload(
  wiring: Wiring,
  key: MediaStorageKey,
  upload: { readonly etags: readonly string[]; readonly total: number; readonly uploadId: string },
) {
  const parts = upload.etags
    .map((etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`)
    .join('');
  const response = yield* send(wiring, {
    body: encoder.encode(`<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`),
    contentType: 'application/xml',
    headers: createOnlyHeaders(wiring.config),
    method: 'POST',
    operation: Operations.complete,
    url: objectUrl(wiring.config, key, { uploadId: upload.uploadId }),
  });
  const createOnly = wiring.config.conditionalCreate === 'supported';
  return yield* expectSuccess(Operations.complete, response, createOnly, (ok) =>
    readAnswer(Operations.complete, ok).pipe(
      // A 200 can still carry an error document: the object exists only when the answer says so.
      Effect.filterOrFail(
        (text) => !text.includes('<Error>'),
        (text) => {
          const code = safeCode(text);
          return mapStatus(Operations.complete, code === 'PreconditionFailed' ? 412 : 500, code, createOnly);
        },
      ),
      Effect.as(statOf(upload.total, versionRefOf(ok))),
    ),
  );
});

/** Best effort: an unfinished multipart upload is never readable. No lifecycle rule that would expire one is verified. */
const abortUpload = (wiring: Wiring, key: MediaStorageKey, uploadId: string) =>
  send(wiring, {
    method: 'DELETE',
    operation: Operations.abort,
    url: objectUrl(wiring.config, key, { uploadId }),
  }).pipe(
    Effect.flatMap(drain),
    Effect.tapError(() => Effect.logWarning('Object storage could not abort an unfinished upload')),
    Effect.ignore,
  );

/** What a put has sent so far. `held` is the one part kept back until the next one proves it is not the last. */
interface UploadProgress {
  readonly etags: string[];
  held: PartBytes | null;
  total: number;
  uploadId: string | null;
}

const sendHeldPart = Effect.fn('S3ObjectStorage.sendHeldPart')(function* sendHeldPart(
  wiring: Wiring,
  target: PutTarget,
  progress: UploadProgress,
  held: PartBytes,
) {
  if (progress.etags.length >= S3_MAXIMUM_PARTS) {
    return yield* serverError('put: the object needs more parts than the provider allows');
  }
  const uploadId = progress.uploadId ?? (yield* createUpload(wiring, target));
  // Recorded before the part is sent, so a failure of the part still aborts the upload that exists.
  progress.uploadId = uploadId;
  const etag = yield* uploadPart(wiring, target.key, { bytes: held, number: progress.etags.length + 1, uploadId });
  progress.etags.push(etag);
  return etag;
});

const acceptPart = Effect.fn('S3ObjectStorage.acceptPart')(function* acceptPart(
  wiring: Wiring,
  target: PutTarget,
  progress: UploadProgress,
  part: PartBytes,
) {
  if (progress.held !== null) {
    yield* sendHeldPart(wiring, target, progress, progress.held);
  }
  progress.held = part;
  progress.total += part.byteLength;
});

const finishPut = Effect.fn('S3ObjectStorage.finishPut')(function* finishPut(
  wiring: Wiring,
  target: PutTarget,
  progress: UploadProgress,
) {
  const { held, uploadId } = progress;
  const last = held ?? EMPTY_BODY;
  if (uploadId === null) {
    return yield* putSingle(wiring, target, last);
  }
  yield* sendHeldPart(wiring, target, progress, last);
  const { etags, total } = progress;
  return yield* completeUpload(wiring, target.key, { etags, total, uploadId });
});

/** The multipart upload a failed or interrupted put left behind, if one was started. */
const abortLeftover = (wiring: Wiring, key: MediaStorageKey, progress: UploadProgress) =>
  progress.uploadId === null ? Effect.void : abortUpload(wiring, key, progress.uploadId);

const put = Effect.fn('S3ObjectStorage.put')(function* put<BodyError>(
  wiring: Wiring,
  request: PutObjectRequest<BodyError>,
) {
  if (request.expectedSha256 !== undefined) {
    return yield* new ObjectStorageChecksumUnsupported({
      code: 'object_storage_checksum_unsupported',
      reason: 'The S3 adapter does not ask the provider to verify a whole-object SHA-256',
    });
  }
  const progress: UploadProgress = { etags: [], held: null, total: 0, uploadId: null };
  const partSize = partSizeFor(wiring.config.partSizeBytes, request.byteSize);
  if (partSize > S3_MAXIMUM_PART_BYTES) {
    return yield* serverError('put: the declared size needs parts larger than the provider allows');
  }
  const parts = cutIntoParts(request.body, partSize);
  return yield* Stream.runForEach(parts, (part) => acceptPart(wiring, request, progress, part)).pipe(
    Effect.andThen(() => finishPut(wiring, request, progress)),
    // A failure aborts inside the caller's budget (the abort is interruptible); an interruption must not be held
    // up by a provider that may be the reason for it, so its abort runs detached.
    Effect.tapError(() => abortLeftover(wiring, request.key, progress)),
    Effect.tapDefect(() => abortLeftover(wiring, request.key, progress)),
    Effect.onInterrupt(() => Effect.forkDetach(abortLeftover(wiring, request.key, progress))),
  );
});

/** The adapter, ready to be composed: it needs the Effect `HttpClient` and host WebCrypto services and nothing else. */
export const makeS3ObjectStorage = Effect.fn('S3ObjectStorage.make')(function* makeS3ObjectStorage(
  config: S3ObjectStorageConfigValue,
) {
  const wiring: Wiring = { client: yield* HttpClient.HttpClient, config, crypto: yield* WebCrypto.WebCrypto };
  const service: ObjectStorageService = {
    get: (key) => get(wiring, key),
    maximumObjectBytes: S3_MAXIMUM_PARTS * S3_MAXIMUM_PART_BYTES,
    providerId: config.providerId,
    put: (request) => put(wiring, request),
    stat: (key) => stat(wiring, key),
  };
  return service;
});
