/**
 * Test-only network latency: a loopback TCP proxy that holds every client-to-server chunk back by a fixed delay before
 * forwarding it, in order. Put in front of PostgreSQL or SpiceDB, it gives each request one extra round-trip delay,
 * as a separate database or SpiceDB service on the network does, without touching the code under test.
 */
import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';

import { Duration, Effect, FiberSet, Predicate } from 'effect';

interface OpenProxy {
  readonly port: number;
  readonly server: Server;
  readonly sockets: Set<Socket>;
}

type DelayedRunner = Effect.Success<ReturnType<typeof FiberSet.makeRuntime<never>>>;

/** Pipes `client` to `upstream` with every chunk delayed by `delay`, keeping the order chunks arrived in. */
const pipeDelayed = (client: Socket, upstream: Socket, delay: Duration.Duration, run: DelayedRunner): void => {
  client.on('data', (chunk) => {
    // Equal delays fire in arrival order, so the stream stays ordered.
    run(
      Effect.sleep(delay).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (!upstream.destroyed) {
              upstream.write(chunk);
            }
          }),
        ),
      ),
    );
  });
  upstream.on('data', (chunk) => {
    if (!client.destroyed) {
      client.write(chunk);
    }
  });
  const closeBoth = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('close', closeBoth);
  upstream.on('close', closeBoth);
  client.on('error', closeBoth);
  upstream.on('error', closeBoth);
};

/** A proxy to `host:port` on a free loopback port, closed with its scope. `delayMs` 0 forwards at once. */
export const delayedTcpProxy = Effect.fn('test.delayedTcpProxy')(function* delayedTcpProxy(input: {
  readonly delayMs: number;
  readonly host: string;
  readonly port: number;
}) {
  // Delayed writes run as fibers of this proxy's scope, so they end with it.
  const run = yield* FiberSet.makeRuntime();
  const delay = Duration.millis(input.delayMs);
  const proxy = yield* Effect.acquireRelease(
    Effect.callback<OpenProxy>((resume) => {
      const sockets = new Set<Socket>();
      const server = createServer((client) => {
        const upstream = createConnection({ host: input.host, port: input.port });
        sockets.add(client);
        sockets.add(upstream);
        pipeDelayed(client, upstream, delay, run);
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resume(Effect.succeed({ port: Predicate.hasProperty(address, 'port') ? address.port : 0, server, sockets }));
      });
    }),
    ({ server, sockets }) =>
      Effect.callback<undefined>((resume) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resume(Effect.undefined));
      }),
  );
  return proxy.port;
});
