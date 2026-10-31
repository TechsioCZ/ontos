import { ActiveApplicationCompositionSnapshotSchema } from '@app/core-runtime';
import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

/** Compose both fixture routes on the root-owned listener, rather than attaching competing handlers. */
export const servePurchaseFixtureHttpServer = Effect.fn('PurchaseFixture.serveHttpServer')(
  function* servePurchaseFixtureHttpServerEffect<E, R>(
    snapshot: ActiveApplicationCompositionSnapshot,
    catalog: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) {
    const document = yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
      snapshot,
    );
    const server = yield* HttpServer.HttpServer;
    yield* server.serve(
      Effect.gen(function* fixtureRequest() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.method === 'GET' && request.url === '/active-composition') {
          return HttpServerResponse.text(document, { contentType: 'application/json' });
        }
        if (request.method === 'POST' && request.url === '/reads/current-payment-terms') {
          return yield* catalog;
        }
        return HttpServerResponse.empty({ status: 404 });
      }),
    );
    return server;
  },
);
