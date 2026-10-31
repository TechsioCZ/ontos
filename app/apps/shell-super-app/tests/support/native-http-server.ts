import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';

import { NodeHttpClient } from '@effect/platform-node';
import { Context, Effect, Layer, Predicate, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';

export class OwnerProcessStartupError extends Schema.TaggedError<OwnerProcessStartupError>()(
  'OwnerProcessStartupError',
  {
    reason: Schema.String,
  },
) {}

type NativeNodeServerFactory = (handler: (request: Request) => PromiseLike<Response>) => PromiseLike<Server>;
const NativeNodeAdapterSchema = Schema.Struct({
  createNodeServer: Schema.declare<NativeNodeServerFactory>((value): value is NativeNodeServerFactory =>
    Predicate.isFunction(value),
  ),
});

export const startNativeHttpServer = Effect.fn('NativeModuleTransportTest.startShellServer')(
  function* startNativeShellServer(handler: (request: Request) => PromiseLike<Response>) {
    const shellRequire = createRequire(path.resolve('package.json'));
    const bffRequire = createRequire(shellRequire.resolve('@modern-js/bff-effect'));
    const adapter = yield* Schema.decodeUnknownEffect(NativeNodeAdapterSchema)(
      bffRequire('@modern-js/server-core/node'),
    );
    const ingress: { aborted: boolean; connection: string | null; path: string }[] = [];
    const server = yield* Effect.acquireRelease(
      Effect.promise(() =>
        adapter.createNodeServer((request) => {
          const observed = {
            aborted: request.signal.aborted,
            connection: request.headers.get('connection'),
            path: new URL(request.url).pathname,
          };
          ingress.push(observed);
          request.signal.addEventListener(
            'abort',
            () => {
              observed.aborted = true;
            },
            { once: true },
          );
          return handler(request);
        }),
      ),
      (ownedServer) =>
        Effect.callback<true>((resume) => {
          ownedServer.close(() => resume(Effect.succeed(true)));
          ownedServer.closeAllConnections();
        }),
    );
    yield* Effect.callback<true, OwnerProcessStartupError>((resume) => {
      const failed = (error: Error): void => {
        resume(Effect.fail(new OwnerProcessStartupError({ reason: error.message })));
      };
      server.once('error', failed);
      server.listen(0, '127.0.0.1', () => resume(Effect.succeed(true)));
      return Effect.sync(() => server.removeListener('error', failed));
    });
    const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }))(server.address());
    const origin = `http://127.0.0.1:${address.port}`;
    const clientServices = yield* Layer.build(NodeHttpClient.layerNodeHttp);
    const client = Context.get(clientServices, HttpClient.HttpClient);
    const targetRequest = (request: Request) => {
      const source = new URL(request.url);
      return new Request(`${origin}${source.pathname}${source.search}`, request);
    };
    return {
      handler: Effect.fn('NativeModuleTransportTest.executeFetchRequest')((request: Request) =>
        Effect.promise(async () => await fetch(targetRequest(request), { redirect: 'manual' })),
      ),
      ingress,
      nativeHandler: Effect.fn('NativeModuleTransportTest.executeWireRequest')(function* executeNativeRequest(
        request: Request,
      ) {
        const forwarded = targetRequest(request);
        const nativeRequest = HttpClientRequest.fromWeb(forwarded);
        if (forwarded.body === null) {
          return yield* client.execute(nativeRequest);
        }
        const body = yield* Effect.promise(async () => await forwarded.text());
        return yield* client.execute(HttpClientRequest.bodyText(nativeRequest, body));
      }),
      origin,
    };
  },
);
