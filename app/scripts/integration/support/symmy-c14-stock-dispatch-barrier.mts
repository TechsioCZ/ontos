import { createServer } from 'node:http';

import { InventorySourceAssertionIdSchema } from '@app/inventory/source-assertion';
import { ImportSourceAssertionPayloadSchema } from '@app/inventory/source-import';
import { NodeHttpServer } from '@effect/platform-node';
import { Context, Deferred, Effect, Layer, Option, Ref, Schema } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

import { SymmyC14ProductFixtureUnavailable } from './symmy-c14-product-runtime.mts';

const importPath = '/inventory-api/inventory/actions/import-source-assertion';
const loopbackOrigin = Schema.String.check(Schema.isPattern(/^http:\/\/127\.0\.0\.1:\d+$/u));
const problemMetadataSchema = Schema.Struct({ code: Schema.optionalKey(Schema.String) });
const unavailable = () =>
  new SymmyC14ProductFixtureUnavailable({ message: 'The native Stock dispatch barrier is unavailable' });

/** Test-only loopback proxy. It holds one exact native Stock request without replacing its signed authorization. */
export const installInternalC14StockDispatchBarrier = Effect.fn('InternalC14Stock.dispatchBarrier')(
  function* installBarrier(input: { readonly port: number; readonly targetOrigin: string }) {
    const target = yield* Schema.decodeUnknownEffect(loopbackOrigin)(input.targetOrigin);
    const server = Context.get(
      yield* Layer.build(NodeHttpServer.layer(createServer, { host: '127.0.0.1', port: input.port })),
      HttpServer.HttpServer,
    );
    const selectedAssertion = yield* Ref.make(Option.none<typeof InventorySourceAssertionIdSchema.Type>());
    const arrived = yield* Deferred.make<typeof ImportSourceAssertionPayloadSchema.Type>();
    const released = yield* Deferred.make<true>();
    const reply = yield* Deferred.make<{ readonly code?: string; readonly status: number }>();
    yield* Effect.addFinalizer(() => Deferred.succeed(released, true).pipe(Effect.asVoid));

    yield* server.serve(
      Effect.gen(function* forwardActualInventoryRequest() {
        const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest);
        const url = new URL(request.url);
        const selected = yield* Ref.get(selectedAssertion);
        let held = false;
        if (request.method === 'POST' && url.pathname === importPath && Option.isSome(selected)) {
          const payload = yield* Effect.tryPromise({
            catch: unavailable,
            try: async () =>
              await Schema.decodeUnknownPromise(ImportSourceAssertionPayloadSchema)(await request.clone().json()),
          });
          if (payload.items.length === 1 && payload.items[0]?.assertionId === selected.value) {
            held = yield* Deferred.succeed(arrived, payload);
            if (held) {
              yield* Deferred.await(released);
            }
          }
        }

        const response = yield* Effect.tryPromise({
          catch: unavailable,
          try: async () => {
            const forwarded = new Request(`${target}${url.pathname}${url.search}`, request);
            // Fetch recreates hop-by-hop framing. The signed end-to-end headers and body remain intact.
            for (const name of [
              'connection',
              'host',
              'keep-alive',
              'proxy-authenticate',
              'proxy-authorization',
              'te',
              'trailer',
              'transfer-encoding',
              'upgrade',
            ]) {
              forwarded.headers.delete(name);
            }
            return await fetch(forwarded, { redirect: 'manual' });
          },
        });
        if (held) {
          const metadata = yield* Effect.tryPromise({
            catch: unavailable,
            try: async () => await Schema.decodeUnknownPromise(problemMetadataSchema)(await response.clone().json()),
          }).pipe(Effect.catch(() => Effect.succeed({})));
          yield* Deferred.succeed(reply, { ...metadata, status: response.status });
        }
        return HttpServerResponse.fromWeb(response);
      }),
    );

    return {
      armForAssertion: (assertionId: string) =>
        Schema.decodeUnknownEffect(InventorySourceAssertionIdSchema)(assertionId).pipe(
          Effect.flatMap((id) => Ref.set(selectedAssertion, Option.some(id))),
        ),
      arrived: Deferred.await(arrived),
      release: Deferred.succeed(released, true),
      reply: Deferred.await(reply),
    };
  },
);
