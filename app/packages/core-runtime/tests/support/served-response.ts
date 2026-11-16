import { NodeHttpServer } from '@effect/platform-node';
import { Effect, Match } from 'effect';
import { HttpClient, HttpClientRequest, HttpServerResponse } from 'effect/http';
import type { HttpServerRequest } from 'effect/http';
import { NetAddress } from 'effect/net';

/**
 * The status and headers of the one response `application` gives a GET of `/` with `headers`, served by a real Node HTTP server on
 * a loopback port, asked through the provided `HttpClient`: what a caller of the owner actually receives, pre-response handlers included.
 */
export const servedResponse = <E>(
  application: Effect.Effect<HttpServerResponse.HttpServerResponse, E, HttpServerRequest.HttpServerRequest>,
  headers: Readonly<Record<string, string>> = {},
) =>
  Effect.scoped(
    Effect.gen(function* serveOnce() {
      const server = yield* NodeHttpServer.make(() => process.getBuiltinModule('http').createServer(), {
        host: '127.0.0.1',
        port: 0,
      });
      yield* server.serve(application.pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 503 }))));
      const address = yield* Match.value(server.address).pipe(
        Match.when(NetAddress.isInetAddress, (inetAddress) => Effect.succeed(inetAddress)),
        Match.orElse(() => Effect.die('The served-response fixture did not bind to TCP')),
      );
      const response = yield* (yield* HttpClient.HttpClient).execute(
        HttpClientRequest.get(`http://127.0.0.1:${address.port}/`).pipe(HttpClientRequest.setHeaders(headers)),
      );
      return { headers: response.headers, status: response.status };
    }),
  );
