import { NodeHttpServer } from '@effect/platform-node';
import { sha256 } from '@noble/hashes/sha2.js';
import { DateTime, Effect, Exit, Match, Ref, Schema, Stream } from 'effect';
import { Hex } from 'effect/encoding';
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServerResponse } from 'effect/http';
import { NetAddress } from 'effect/net';
import { expect, it } from 'effect-rstest';

import { AssetDownloadAuthorizationSchema } from '../../src/media/download-contract.ts';
import { downloadResponseHeaders } from '../../src/media/download-headers.ts';
import { streamConfirmedBytes } from '../../src/media/download.ts';
import { TenantMediaAssetKeySchema, mediaAssetRefFor } from '../../src/media/identity.ts';
import { MediaIntegrityRecorder } from '../../src/media/integrity-recorder.ts';
import { ObjectStorage, ObjectStorageNetworkError } from '../../src/media/object-storage.ts';
import type { ObjectStorageService } from '../../src/media/object-storage.ts';
import { deriveMediaStorageKey } from '../../src/media/storage-key.ts';
import type { MediaVerifiableAsset } from '../../src/media/verified-read.ts';
import { makeInMemoryObjectStorage } from '../../src/testing/media-object-storage.ts';

/*
 * What a real HTTP client sees of the download edge (#1443, #1436): the same composition the Shell handler returns
 * (`streamConfirmedBytes` behind `downloadResponseHeaders`) served over a real loopback Node HTTP server and read by
 * a real fetch client. A clean end means exactly the confirmed bytes; corrupt or dropped bytes are a failed body read,
 * never a clean end; and Range and the conditional headers change nothing.
 */

const tenantId = '00000000-0000-4000-8000-000000000001';
const assetId = '00000000-0000-4000-8000-0000000000a1';
const encoder = new TextEncoder();
const content = encoder.encode('the confirmed bytes of one asset, long enough to arrive in several chunks');
const digestOf = (bytes: Uint8Array) => Hex.encode(sha256(bytes));
const keyIdentity = Schema.decodeUnknownSync(TenantMediaAssetKeySchema)({ mediaAssetId: assetId, tenantId });
const key = deriveMediaStorageKey(keyIdentity);

const asset: MediaVerifiableAsset = {
  byteSize: BigInt(content.byteLength),
  contentSha256: digestOf(content),
  processingStatus: 'ready',
  sealedAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
  storageKey: key,
  storageObjectVersionRef: null,
  storageProvider: 'in-memory-test-double',
};
const authorization = Schema.decodeUnknownSync(AssetDownloadAuthorizationSchema)({
  byteSize: content.byteLength,
  contentSha256: digestOf(content),
  displayFilename: 'contract.pdf',
  mediaAssetRef: mediaAssetRefFor(keyIdentity),
  mimeType: 'application/pdf',
});

const chunked = (bytes: Uint8Array): readonly Uint8Array[] => [
  bytes.slice(0, 20),
  bytes.slice(20, 40),
  bytes.slice(40),
];

/** A provider that serves the given object in three chunks. */
const providerOf = (
  served: Uint8Array,
  base: ObjectStorageService,
  ending?: Stream.Stream<never, ObjectStorageNetworkError>,
) =>
  ({
    ...base,
    get: () =>
      Effect.succeed({
        body: Stream.fromIterable(chunked(served)).pipe(Stream.concat(ending ?? Stream.empty)),
        stat: { byteSize: served.byteLength },
      }),
    stat: () => Effect.succeed({ byteSize: served.byteLength }),
  }) satisfies ObjectStorageService;

const noRecorder = Effect.gen(function* noRecorder() {
  const recorded = yield* Ref.make(0);
  return { recorded, service: { record: () => Ref.update(recorded, (count) => count + 1) } };
});

/** Serves one download whose provider is `storage`, and returns the loopback URL. */
const serveDownload = (storage: ObjectStorageService, recorder: typeof MediaIntegrityRecorder.Service) =>
  Effect.gen(function* serving() {
    const server = yield* NodeHttpServer.make(() => process.getBuiltinModule('http').createServer(), {
      host: '127.0.0.1',
      port: 0,
    });
    const download = streamConfirmedBytes(asset, authorization).pipe(
      Effect.provideService(ObjectStorage, storage),
      Effect.provideService(MediaIntegrityRecorder, recorder),
      Effect.map(({ body }) => HttpServerResponse.stream(body, { headers: downloadResponseHeaders(authorization) })),
      Effect.orDie,
    );
    yield* server.serve(download);
    const address = yield* Match.value(server.address).pipe(
      Match.when(NetAddress.isInetAddress, (inet) => Effect.succeed(inet)),
      Match.orElse(() => Effect.die('The download fixture did not bind to TCP')),
    );
    return `http://127.0.0.1:${address.port}/content`;
  });

it.layer(FetchHttpClient.layer, { excludeTestServices: true })('the download edge over HTTP', (suite) => {
  suite.effect('serves exactly the confirmed bytes with an allow-listed private header set, and ignores Range', () =>
    Effect.scoped(
      Effect.gen(function* delivered() {
        const base = yield* makeInMemoryObjectStorage();
        const url = yield* serveDownload(providerOf(content, base.service), (yield* noRecorder).service);
        const client = yield* HttpClient.HttpClient;
        for (const extra of [{}, { range: 'bytes=0-9' }, { 'if-none-match': '*', 'if-range': 'x' }]) {
          const response = yield* client.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(extra)));
          expect(response.status).toBe(200);
          expect(response.headers['content-length']).toBe(String(content.byteLength));
          expect(response.headers['cache-control']).toBe('private, no-store');
          expect(response.headers['content-type']).toBe('application/pdf');
          expect(response.headers['x-content-type-options']).toBe('nosniff');
          expect(response.headers['content-disposition']).toContain('attachment; filename="contract.pdf"');
          for (const absent of ['accept-ranges', 'etag', 'content-range', 'location', 'last-modified', 'set-cookie']) {
            expect(response.headers[absent], absent).toBeUndefined();
          }
          const bytes = new Uint8Array(yield* response.arrayBuffer);
          expect(bytes.byteLength).toBe(authorization.byteSize);
          expect(digestOf(bytes)).toBe(authorization.contentSha256);
        }
      }),
    ),
  );

  suite.effect('never lets corrupt or dropped bytes look like a complete body: the client read fails', () =>
    Effect.scoped(
      Effect.gen(function* aborted() {
        const base = yield* makeInMemoryObjectStorage();
        const recorder = yield* noRecorder;
        const tampered = encoder.encode('X'.repeat(content.byteLength));
        const sameSize = yield* serveDownload(providerOf(tampered, base.service), recorder.service);
        const client = yield* HttpClient.HttpClient;
        // The client fails before or while reading the body, never with a body it can take for complete.
        const readAll = (url: string) =>
          client.execute(HttpClientRequest.get(url)).pipe(Effect.flatMap((response) => response.arrayBuffer));
        expect(Exit.isFailure(yield* Effect.exit(readAll(sameSize)))).toBe(true);
        // The corruption reached the integrity port once, from the verified read.
        expect(yield* Ref.get(recorder.recorded)).toBe(1);

        const dropped = yield* serveDownload(
          providerOf(
            content,
            base.service,
            Stream.fail(new ObjectStorageNetworkError({ code: 'object_storage_network_error', reason: 'reset' })),
          ),
          recorder.service,
        );
        expect(Exit.isFailure(yield* Effect.exit(readAll(dropped)))).toBe(true);
        // A dropped transfer proves nothing: nothing more was recorded.
        expect(yield* Ref.get(recorder.recorded)).toBe(1);
      }),
    ),
  );
});
