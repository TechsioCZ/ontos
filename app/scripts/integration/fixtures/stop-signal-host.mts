/**
 * A public host process for the stop-signal test: the real `hostApplication` on its own port, its `crm` unit serving
 * an event stream and an upload that only answers once its body ended, the real `publicPortClosing` and the real
 * `stopSignal` race, wired as `app-host.mts` wires them. Prints `PORT <n>` once it serves.
 */
import { createServer } from 'node:http';

import { NodeHttpServer } from '@effect/platform-node';
import { Config, Console, Context, Effect, Exit, Layer, Option, Ref, Scope, Stream } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { NetAddress } from 'effect/net';

import {
  PUBLIC_PORT_GRACEFUL_CLOSE_CAP,
  hostApplication,
  publicPortClosing,
  stopAccepting,
  stopSignal,
} from '../../zerops/app-host.mts';
import { withKeepAlive } from '../../zerops/http-keep-alive.mts';
import { HostRefusals, HostRefusalsLive } from '../../zerops/host-refusal-log.mts';
import { SupersedeDrains, SupersedeDrainsLive } from '../../zerops/supersede-drain.mts';

const unit = Effect.gen(function* unitAnswer() {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.url.startsWith('/events')) {
    return HttpServerResponse.stream(
      Stream.tick('50 millis').pipe(Stream.map((): Uint8Array => new TextEncoder().encode('data: tick\n\n'))),
      { contentType: 'text/event-stream' },
    );
  }
  const body = yield* request.arrayBuffer.pipe(Effect.orDie);
  return HttpServerResponse.text(String(body.byteLength));
});

const serveOn = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>, scope: Scope.Scope) =>
  Effect.gen(function* serve() {
    const server = Context.get(yield* Layer.buildWithScope(NodeHttpServer.layerTest, scope), HttpServer.HttpServer);
    yield* server.serve(app).pipe(Scope.provide(scope));
    return NetAddress.isUnixPathAddress(server.address) ? 0 : server.address.port;
  });

const program = Effect.gen(function* stopSignalHost() {
  const scope = yield* Effect.scope;
  const publicScope = yield* Scope.fork(scope, 'sequential');
  const unitPort = yield* serveOn(unit, scope);
  const published = yield* Ref.make(true);
  const drain = yield* SupersedeDrains;
  const app = hostApplication(
    new Map([['crm', unitPort]]),
    published,
    Effect.succeed(Option.none<string>()),
    yield* HostRefusals,
    drain,
  );
  // The public server exactly as the host makes it: kept-alive connections and its stop bounds included.
  const publicServer = withKeepAlive(createServer)();
  const server = yield* NodeHttpServer.make(() => publicServer, {
    gracefulShutdownTimeout: PUBLIC_PORT_GRACEFUL_CLOSE_CAP,
    host: '127.0.0.1',
    port: 0,
  }).pipe(Scope.provide(publicScope));
  yield* server.serve(app).pipe(Scope.provide(publicScope));
  const port = NetAddress.isUnixPathAddress(server.address) ? 0 : server.address.port;
  const closePublicPort = yield* publicPortClosing(publicScope, drain, publicServer);
  yield* Effect.addFinalizer(() =>
    Console.log('[fixture] closing the public port').pipe(
      Effect.andThen(closePublicPort),
      Effect.andThen(Console.log('[fixture] public port closed')),
    ),
  );
  yield* Console.log(`PORT ${String(port)}`);
  // FIXTURE_DRAIN_DEADLINE_AFTER_MS: the drain's deadline passes then, and closes the listener only, as the host's does.
  const deadlineAfter = yield* Config.Int('FIXTURE_DRAIN_DEADLINE_AFTER_MS').pipe(Config.option);
  if (Option.isSome(deadlineAfter)) {
    yield* Effect.sleep(deadlineAfter.value);
    yield* stopAccepting(publicServer);
    yield* Console.log('[fixture] drain deadline: listener closed');
  }
  return yield* Effect.never;
});

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(
    program.pipe(
      Effect.scoped,
      Effect.raceFirst(stopSignal),
      Effect.provide(Layer.merge(HostRefusalsLive, SupersedeDrainsLive)),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
