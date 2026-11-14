import { createServer } from 'node:http';

import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { AdmitSymmySyncPayloadSchema } from '@app/symmy-integration/api/admit-symmy-sync-action';
import { NodeHttpServer } from '@effect/platform-node';
import { Context, Effect, Layer, Option, Ref, Schema } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

import { SymmyC14ProductFixtureUnavailable } from './symmy-c14-product-runtime.mts';

const admissionPath = '/symmy-integration-api/symmy-integration/actions/admit-symmy-sync';
const routeContextPath = '/symmy-integration-api/reads/symmy-route-context';
const unavailable = () =>
  new SymmyC14ProductFixtureUnavailable({ message: 'The finite internal Sync retry test transport is unavailable' });

/** A local fault injector for two exact fixture paths, never a production gateway or an authentication substitute. */
export const startInternalSyncRetryTransport = Effect.fn('InternalC14Sync.retryTransport')(
  function* retryTransport(input: { readonly ownerOrigin: string; readonly port: number }) {
    const fixedKey = yield* Ref.make<Option.Option<string>>(Option.none());
    const bodyFingerprints = yield* Ref.make<readonly string[]>([]);
    const diagnostics = yield* Ref.make<readonly string[]>([]);
    const server = Context.get(
      yield* Layer.build(NodeHttpServer.layer(createServer, { host: '127.0.0.1', port: input.port })),
      HttpServer.HttpServer,
    );
    const application = Effect.gen(function* forwardExactNativeRequest() {
      const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest);
      const sourceUrl = new URL(request.url);
      yield* Ref.update(diagnostics, (previous) => [...previous, `received:${request.method}:${sourceUrl.pathname}`]);
      if (
        request.method !== 'POST' ||
        (sourceUrl.pathname !== admissionPath && sourceUrl.pathname !== routeContextPath)
      ) {
        return HttpServerResponse.empty({ status: 404 });
      }
      const headers = new Headers(request.headers);
      // The new connection owns its HTTP framing; authentication and application headers are preserved.
      for (const name of [
        'connection',
        'keep-alive',
        'proxy-connection',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
        'host',
      ]) {
        headers.delete(name);
      }
      const selected = yield* Ref.get(fixedKey);
      if (sourceUrl.pathname === admissionPath && Option.isSome(selected)) {
        const body = yield* Effect.tryPromise({
          catch: unavailable,
          try: async () => await Schema.decodeUnknownPromise(AdmitSymmySyncPayloadSchema)(await request.clone().json()),
        });
        const fingerprint = yield* Effect.try({ catch: unavailable, try: () => computeCanonicalValueHash(body) });
        yield* Ref.update(bodyFingerprints, (previous) => [...previous, fingerprint]);
        headers.set('idempotency-key', selected.value);
      }
      // Only the mechanical retry header changes. The original body and fresh signed assertion stream through.
      const init = { body: request.body, duplex: 'half' as const, headers, method: request.method };
      const target = yield* Effect.try({
        catch: unavailable,
        try: () => new Request(`${input.ownerOrigin}${sourceUrl.pathname}${sourceUrl.search}`, init),
      });
      const response = yield* Effect.tryPromise({ catch: unavailable, try: async () => await fetch(target) }).pipe(
        Effect.tapError(() => Ref.update(diagnostics, (previous) => [...previous, 'native-fetch-failed'])),
      );
      yield* Ref.update(diagnostics, (previous) => [...previous, `forwarded:${response.status}`]);
      return HttpServerResponse.fromWeb(response);
    });
    yield* server.serve(application);
    return {
      activate: (key: string) => Ref.set(fixedKey, Option.some(key)),
      bodyFingerprints: Ref.get(bodyFingerprints),
      deactivate: Ref.set(fixedKey, Option.none()),
      diagnostics: Ref.get(diagnostics),
    };
  },
);
