import { sha256 } from '@noble/hashes/sha2.js';
import { Cause, DateTime, Effect, Exit, Logger, Option, Ref, Schema, Stream } from 'effect';
import { Hex } from 'effect/encoding';
import { expect, it } from 'effect-rstest';

import {
  downloadContentDisposition,
  downloadContentType,
  downloadResponseHeaders,
} from '../../src/media/download-headers.ts';
import { AssetDownloadAuthorizationSchema } from '../../src/media/download-contract.ts';
import type { AssetDownloadAuthorization } from '../../src/media/download-contract.ts';
import { MediaDownloadAborted, streamConfirmedBytes } from '../../src/media/download.ts';
import { TenantMediaAssetKeySchema, mediaAssetRefFor } from '../../src/media/identity.ts';
import { MediaIntegrityFailed, MediaNotReady, MediaUnavailable } from '../../src/media/errors.ts';
import { MediaIntegrityRecorder } from '../../src/media/integrity-recorder.ts';
import {
  ObjectStorage,
  ObjectStorageNetworkError,
  ObjectStorageObjectMissing,
  ObjectStorageServerError,
} from '../../src/media/object-storage.ts';
import type { ObjectStorageService } from '../../src/media/object-storage.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import type { MediaIntegrityFinding, MediaVerifiableAsset } from '../../src/media/verified-read.ts';
import { makeInMemoryObjectStorage } from '../../src/testing/media-object-storage.ts';

/*
 * The byte half of the governed download (#1443, #1436): what an ALLOWED request delivers, refuses and aborts. The
 * decision itself (the governed Read, SpiceDB, evidence) is proven against real PostgreSQL and SpiceDB in the
 * integration and authorization suites; here the provider is the in-memory double with controlled fault injection.
 */

const tenantId = '00000000-0000-4000-8000-000000000001';
const assetId = '00000000-0000-4000-8000-0000000000a1';
const encoder = new TextEncoder();
const content = encoder.encode('the confirmed bytes of one asset');
const digestOf = (bytes: Uint8Array) => Hex.encode(sha256(bytes));
const keyIdentity = Schema.decodeUnknownSync(TenantMediaAssetKeySchema)({ mediaAssetId: assetId, tenantId });
const key = deriveMediaStorageKey(keyIdentity);
const PROVIDER = 'in-memory-test-double';

const asset: MediaVerifiableAsset = {
  byteSize: BigInt(content.byteLength),
  contentSha256: digestOf(content),
  processingStatus: 'ready',
  sealedAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
  storageKey: key,
  storageObjectVersionRef: null,
  storageProvider: PROVIDER,
};
const authorization: AssetDownloadAuthorization = Schema.decodeUnknownSync(AssetDownloadAuthorizationSchema)({
  byteSize: content.byteLength,
  contentSha256: digestOf(content),
  displayFilename: 'contract.pdf',
  mediaAssetRef: mediaAssetRefFor(keyIdentity),
  mimeType: 'application/pdf',
});

const withStored = (bytes: Uint8Array) =>
  Effect.gen(function* stored() {
    const storage = yield* makeInMemoryObjectStorage();
    yield* storage.service.put({ body: Stream.make(bytes), contentType: 'application/octet-stream', key });
    return storage;
  });

/** A recorder that only remembers what it was handed. */
const makeRecorder = Effect.gen(function* recorder() {
  const recorded = yield* Ref.make<readonly MediaIntegrityFinding[]>([]);
  return {
    recorded,
    service: { record: (finding: MediaIntegrityFinding) => Ref.update(recorded, (all) => [...all, finding]) },
  };
});

const deliver = (storage: ObjectStorageService, recorder: typeof MediaIntegrityRecorder.Service) =>
  streamConfirmedBytes(asset, authorization).pipe(
    Effect.provideService(ObjectStorage, storage),
    Effect.provideService(MediaIntegrityRecorder, recorder),
  );

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const failureOf = <Value, Failure>(exit: Exit.Exit<Value, Failure>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

const totalBytes = (chunks: readonly Uint8Array[]) => chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);

it.effect('delivers exactly the confirmed bytes of a ready asset, then ends cleanly', () =>
  Effect.gen(function* delivered() {
    const storage = yield* withStored(content);
    const recorder = yield* makeRecorder;
    const download = yield* deliver(storage.service, recorder.service);
    const chunks = yield* Stream.runCollect(download.body);
    expect(Buffer.concat(chunks).equals(Buffer.from(content))).toBe(true);
    expect(download.authorization).toEqual(authorization);
    expect(yield* Ref.get(recorder.recorded)).toEqual([]);
  }),
);

it.effect('aborts a same-size tampered object without a clean end, and hands the finding to the integrity port', () =>
  Effect.gen(function* tampered() {
    const bad = encoder.encode('THE CONFIRMED BYTES OF ONE ASSET');
    const storage = yield* withStored(bad);
    const chunked: ObjectStorageService = {
      ...storage.service,
      get: () =>
        Effect.succeed({
          body: Stream.fromIterable([bad.slice(0, 11), bad.slice(11, 22), bad.slice(22)]),
          stat: { byteSize: bad.byteLength },
        }),
    };
    const recorder = yield* makeRecorder;
    const download = yield* deliver(chunked, recorder.service);
    const received: Uint8Array[] = [];
    const exit = yield* Effect.exit(
      Stream.runForEach(download.body, (chunk) => Effect.sync(() => received.push(chunk))),
    );
    expect(Schema.is(MediaDownloadAborted)(failureOf(exit))).toBe(true);
    expect(failureOf(exit)).toMatchObject({ reason: 'integrity_failed' });
    // The last chunk was never released: the body is shorter than the announced length.
    expect(totalBytes(received)).toBeLessThan(content.byteLength);
    const findings = yield* Ref.get(recorder.recorded);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.observed.contentSha256).toBe(digestOf(bad));
  }),
);

it.effect('closes a complete object of ANOTHER size before any byte, through a full verification and the port', () =>
  Effect.gen(function* otherSize() {
    const longer = encoder.encode('a different and longer confirmed body');
    const storage = yield* withStored(longer);
    const recorder = yield* makeRecorder;
    const exit = yield* Effect.exit(deliver(storage.service, recorder.service));
    expect(Schema.is(MediaIntegrityFailed)(failureOf(exit))).toBe(true);
    const findings = yield* Ref.get(recorder.recorded);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.observed).toEqual({ byteSize: longer.byteLength, contentSha256: digestOf(longer) });
  }),
);

it.effect('answers a doubtful read of another size as unavailable and records nothing', () =>
  Effect.gen(function* doubtful() {
    const storage = yield* withStored(content);
    const longer = encoder.encode('a different and longer confirmed body');
    const short: ObjectStorageService = {
      ...storage.service,
      // Declares a longer object but ends cleanly early: framing is doubtful, so no proof.
      get: () => Effect.succeed({ body: Stream.make(longer.slice(0, 4)), stat: { byteSize: longer.byteLength } }),
    };
    const recorder = yield* makeRecorder;
    const exit = yield* Effect.exit(deliver(short, recorder.service));
    expect(Schema.is(MediaUnavailable)(failureOf(exit))).toBe(true);
    expect(yield* Ref.get(recorder.recorded)).toEqual([]);
  }),
);

it.effect(
  'answers a provider outage and a missing object before the first byte as unavailable, never as corruption',
  () =>
    Effect.gen(function* outage() {
      const storage = yield* withStored(content);
      const recorder = yield* makeRecorder;
      const down: ObjectStorageService = {
        ...storage.service,
        get: () =>
          Effect.fail(new ObjectStorageNetworkError({ code: 'object_storage_network_error', reason: 'reset' })),
      };
      expect(Schema.is(MediaUnavailable)(failureOf(yield* Effect.exit(deliver(down, recorder.service))))).toBe(true);
      const gone: ObjectStorageService = {
        ...storage.service,
        get: () =>
          Effect.fail(new ObjectStorageObjectMissing({ code: 'object_storage_object_missing', reason: '404' })),
      };
      expect(Schema.is(MediaUnavailable)(failureOf(yield* Effect.exit(deliver(gone, recorder.service))))).toBe(true);
      expect(yield* Ref.get(recorder.recorded)).toEqual([]);
    }),
);

it.effect('aborts a dropped transfer as unavailable and never records corruption for it', () =>
  Effect.gen(function* dropped() {
    const storage = yield* withStored(content);
    const cut: ObjectStorageService = {
      ...storage.service,
      get: () =>
        Effect.succeed({
          body: Stream.concat(
            Stream.make(content.slice(0, 6)),
            Stream.fail(new ObjectStorageNetworkError({ code: 'object_storage_network_error', reason: 'reset' })),
          ),
          stat: { byteSize: content.byteLength },
        }),
    };
    const recorder = yield* makeRecorder;
    const download = yield* deliver(cut, recorder.service);
    const exit = yield* Effect.exit(Stream.runDrain(download.body));
    expect(failureOf(exit)).toMatchObject({ reason: 'unavailable' });
    expect(yield* Ref.get(recorder.recorded)).toEqual([]);
  }),
);

it.effect('refuses a row that is not a ready sealed identity without asking the provider', () =>
  Effect.gen(function* notReady() {
    const storage = yield* withStored(content);
    const recorder = yield* makeRecorder;
    const exit = yield* Effect.exit(
      streamConfirmedBytes({ ...asset, processingStatus: 'uploaded' }, authorization).pipe(
        Effect.provideService(ObjectStorage, storage.service),
        Effect.provideService(MediaIntegrityRecorder, recorder.service),
      ),
    );
    expect(Schema.is(MediaNotReady)(failureOf(exit))).toBe(true);
    expect(yield* storage.calls).toHaveLength(1);
  }),
);

it('presents the recorded type only as a plain media type and never lets a name inject a header', () => {
  expect(downloadContentType('application/pdf')).toBe('application/pdf');
  for (const hostile of ['text/html; charset=utf-8', 'text/html\r\nx-evil: 1', 'nonsense', '', 'a/b c']) {
    expect(downloadContentType(hostile)).toBe('application/octet-stream');
  }
  const names = [
    'invoice\u202Egnp.exe',
    'evil"\r\nSet-Cookie: x=1',
    '../../etc/passwd',
    String.raw`C:\temp\x.exe`,
    '',
    '   ',
    'žluťoučký kůň.pdf',
    'a'.repeat(500),
  ];
  for (const name of names) {
    const disposition = downloadContentDisposition(name);
    expect(disposition).not.toMatch(/[\r\n]/u);
    expect(disposition.startsWith('attachment; filename="')).toBe(true);
    expect(disposition).not.toContain('/');
    // Between the two quotes of the ASCII fallback there is no quote, backslash or control character.
    const fallback = /filename="(?<fallback>[^"]*)"; filename\*=UTF-8''/u.exec(disposition)?.groups?.['fallback'];
    expect(fallback).toBeDefined();
    expect(fallback).toMatch(/^[ -~]*$/u);
    expect(disposition).not.toMatch(/%E2%80%AE/u);
  }
  expect(downloadContentDisposition('žluťoučký kůň.pdf')).toContain(
    "filename*=UTF-8''%C5%BElu%C5%A5ou%C4%8Dk%C3%BD%20k%C5%AF%C5%88.pdf",
  );
});

it('answers with an allow-listed, private, no-store header set and nothing that invites a cached or ranged reuse', () => {
  const headers = downloadResponseHeaders(authorization);
  expect(headers).toEqual({
    'cache-control': 'private, no-store',
    'content-disposition': 'attachment; filename="contract.pdf"; filename*=UTF-8\'\'contract.pdf',
    'content-length': String(content.byteLength),
    'content-security-policy': "default-src 'none'; sandbox",
    'content-type': 'application/pdf',
    'x-content-type-options': 'nosniff',
  });
  const names = Object.keys(headers);
  for (const forbidden of ['etag', 'accept-ranges', 'last-modified', 'location', 'set-cookie', 'x-amz-version-id']) {
    expect(names).not.toContain(forbidden);
  }
});

it.effect(
  'leaks no URL, key, version, credential, digest or identifier into a refusal, an abort, a header or a log line',
  () =>
    Effect.gen(function* noLeak() {
      const emitted: string[] = [];
      const logger = Logger.make((options) => {
        const { annotations, message } = Logger.formatStructured.log(options);
        emitted.push(toJson({ annotations, message }));
      });
      const captured = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
      const leaky = new ObjectStorageServerError({
        code: 'object_storage_server_error',
        reason:
          'GET https://bucket.example/core-media/v1/abc?X-Amz-Signature=SIGSECRET Authorization: AWS4 Credential=AKIAXXXX token=TOKENSECRET',
      });
      const storage = yield* withStored(content);
      const recorder = yield* makeRecorder;
      const bad = encoder.encode('THE CONFIRMED BYTES OF ONE ASSET');
      const outage: ObjectStorageService = { ...storage.service, get: () => Effect.fail(leaky) };
      const outageExit = yield* Effect.exit(captured(deliver(outage, recorder.service)));
      const midway: ObjectStorageService = {
        ...storage.service,
        get: () =>
          Effect.succeed({
            body: Stream.concat(Stream.make(content.slice(0, 5)), Stream.fail(leaky)),
            stat: { byteSize: content.byteLength },
          }),
      };
      const dropped = yield* captured(deliver(midway, recorder.service));
      const droppedExit = yield* Effect.exit(captured(Stream.runDrain(dropped.body)));
      const corrupt: ObjectStorageService = {
        ...storage.service,
        get: () => Effect.succeed({ body: Stream.make(bad), stat: { byteSize: bad.byteLength } }),
      };
      const tampered = yield* captured(deliver(corrupt, recorder.service));
      const tamperedExit = yield* Effect.exit(captured(Stream.runDrain(tampered.body)));
      const results = [outageExit, droppedExit, tamperedExit, downloadResponseHeaders(authorization)];
      // What a client sees (refusals, aborts, headers) and every log line: the recorder's own findings are not part of it.
      const observed = toJson(results) + emitted.join('\n');
      const forbidden = [
        'SIGSECRET',
        'TOKENSECRET',
        'AKIAXXXX',
        'X-Amz',
        'https://',
        'bucket.example',
        key,
        PROVIDER,
        assetId,
        tenantId,
        digestOf(content),
        digestOf(bad),
        'core-media/v1/',
      ];
      for (const secret of forbidden) {
        const visible = secret === digestOf(content) ? observed.replaceAll(digestOf(content), '') : observed;
        expect(visible, `must not contain ${secret}`).not.toContain(secret);
      }
      expect(emitted.length).toBeGreaterThan(0);
    }),
);
