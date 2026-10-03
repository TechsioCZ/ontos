import { NodeHttpServer } from '@effect/platform-node';
import { Clock, Effect, Match, Option, Ref } from 'effect';
import type { Scope } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { NetAddress } from 'effect/unstable/net';
import type { ServeError } from 'effect/unstable/http/HttpServerError';

interface HealthState {
  readonly lastSuccessfulCycleAt: Option.Option<number>;
  readonly running: boolean;
}

export interface OutboxWorkerHealth {
  readonly cycleFailed: Effect.Effect<void>;
  readonly cycleSucceeded: Effect.Effect<void>;
  readonly isLive: Effect.Effect<boolean>;
  readonly isReady: Effect.Effect<boolean>;
  readonly shuttingDown: Effect.Effect<void>;
}

export interface CreateOutboxWorkerHealthOptions {
  readonly now?: Effect.Effect<number>;
  readonly staleAfterMs: number;
}

const makeOutboxWorkerHealth = Effect.fn('OutboxWorkerHealth.make')(function* makeOutboxWorkerHealthEffect(
  staleAfterMs: number,
  now: Effect.Effect<number>,
) {
  const state = yield* Ref.make<HealthState>({
    lastSuccessfulCycleAt: Option.none(),
    running: true,
  });
  return {
    cycleFailed: Ref.update(state, (current) => ({
      ...current,
      lastSuccessfulCycleAt: Option.none(),
    })),
    cycleSucceeded: now.pipe(
      Effect.flatMap((lastSuccessfulCycleAt) =>
        Ref.update(state, (current) => ({
          ...current,
          lastSuccessfulCycleAt: Option.some(lastSuccessfulCycleAt),
        })),
      ),
    ),
    isLive: Ref.get(state).pipe(Effect.map((current) => current.running)),
    isReady: Effect.all([Ref.get(state), now], { concurrency: 1 }).pipe(
      Effect.map(
        ([current, currentTime]) =>
          current.running &&
          Option.isSome(current.lastSuccessfulCycleAt) &&
          currentTime - current.lastSuccessfulCycleAt.value <= staleAfterMs,
      ),
    ),
    shuttingDown: Ref.set(state, {
      lastSuccessfulCycleAt: Option.none(),
      running: false,
    }),
  };
});

export const createOutboxWorkerHealth = ({
  now = Clock.currentTimeMillis,
  staleAfterMs,
}: CreateOutboxWorkerHealthOptions): Effect.Effect<OutboxWorkerHealth> => makeOutboxWorkerHealth(staleAfterMs, now);

/** The lifecycle and readiness checks one health server serves and closes. */
export type OutboxWorkerReadiness = Pick<OutboxWorkerHealth, 'isLive' | 'isReady' | 'shuttingDown'>;

/** A host is ready only while it hosts at least one loop and every hosted polling loop is ready. */
export const combineOutboxWorkerHealth = (loops: readonly OutboxWorkerReadiness[]): OutboxWorkerReadiness => ({
  isLive: Effect.forEach(loops, (loop) => loop.isLive, { concurrency: 1 }).pipe(
    Effect.map((live) => live.length > 0 && live.every(Boolean)),
  ),
  isReady: Effect.forEach(loops, (loop) => loop.isReady, { concurrency: 1 }).pipe(
    Effect.map((ready) => ready.length > 0 && ready.every(Boolean)),
  ),
  shuttingDown: Effect.forEach(loops, (loop) => loop.shuttingDown, { concurrency: 1, discard: true }),
});

export interface OutboxWorkerHealthServer {
  readonly hostname: string;
  readonly port: number;
}

// Node supplies only the server constructor; the Effect adapter owns all socket I/O and cleanup.
const createNodeHealthServer = () => process.getBuiltinModule('http').createServer();

export const serveOutboxWorkerHealth: (
  health: OutboxWorkerReadiness,
  options: { readonly port: number },
) => Effect.Effect<OutboxWorkerHealthServer, ServeError, Scope.Scope> = Effect.fn('OutboxWorkerHealth.serve')(
  function* serveOutboxWorkerHealthEffect(health, options) {
    const server = yield* NodeHttpServer.make(createNodeHealthServer, {
      host: '0.0.0.0',
      port: options.port,
    });
    const healthApplication = HttpServerRequest.HttpServerRequest.use((request) => {
      if (request.url === '/live') {
        return health.isLive.pipe(
          Effect.map((live) => HttpServerResponse.jsonUnsafe({ live }, { status: live ? 200 : 503 })),
        );
      }
      if (request.url !== '/ready') {
        return Effect.succeed(HttpServerResponse.empty({ status: 404 }));
      }
      return health.isReady.pipe(
        Effect.map((ready) => HttpServerResponse.jsonUnsafe({ ready }, { status: ready ? 200 : 503 })),
      );
    });
    yield* server.serve(healthApplication);

    const address = yield* Match.value(server.address).pipe(
      Match.when(NetAddress.isInetAddress, (inetAddress) => Effect.succeed(inetAddress)),
      Match.orElse(() => Effect.die('Outbox health server did not bind to TCP')),
    );
    yield* Effect.addFinalizer(() => health.shuttingDown);
    return { hostname: NetAddress.formatIp(address.address), port: address.port };
  },
);
