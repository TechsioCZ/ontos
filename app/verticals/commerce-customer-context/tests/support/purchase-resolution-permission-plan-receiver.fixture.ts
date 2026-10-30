import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

import apiRuntime from '../../api/index.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

class PurchaseReceiverFixtureError extends Schema.TaggedError<PurchaseReceiverFixtureError>()(
  'PurchaseReceiverFixtureError',
  { reason: Schema.String },
) {}

const describe = Effect.sync(() => process.stdout.write(`${JSON.stringify(ultramodernApiMarker)}\n`));
const serve = Effect.scoped(
  Effect.gen(function* serveDefaultPurchaseReceiver() {
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => apiRuntime.createHandler()),
      (handler) => Effect.promise(async () => await handler.dispose()),
    );
    const server = yield* HttpServer.HttpServer;
    yield* server.serve(
      Effect.gen(function* defaultPurchaseReceiverRequest() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const webRequest = yield* HttpServerRequest.toWeb(request);
        const response = yield* Effect.tryPromise({
          catch: () => new PurchaseReceiverFixtureError({ reason: 'The default purchase HTTP adapter failed' }),
          try: async () => await runtime.handler(webRequest),
        });
        return HttpServerResponse.fromWeb(response);
      }),
    );
    const { address } = server;
    if (!Schema.is(Schema.Struct({ port: Schema.Number }))(address)) {
      return yield* new PurchaseReceiverFixtureError({
        reason: 'The purchase receiver requires a loopback TCP address',
      });
    }
    yield* Effect.sync(() =>
      process.stdout.write(`${JSON.stringify({ marker: ultramodernApiMarker, port: address.port, type: 'ready' })}\n`),
    );
    return yield* Effect.never;
  }),
);
NodeRuntime.runMain(
  process.argv.includes('--describe')
    ? describe.pipe(Effect.provide(NodeServices.layer))
    : serve.pipe(Effect.provide(NodeHttpServer.layerTest)),
);
