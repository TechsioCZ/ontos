/* oxlint-disable sonarjs/no-undefined-assignment */
import { NodeHttpServer } from '@effect/platform-node';
import { Clock, Effect, Ref } from 'effect';
import type { Scope } from 'effect';
import type { ServeError } from 'effect/unstable/http/HttpServerError';
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';

interface HealthState {
  readonly lastSuccessfulCycleAt: number | undefined;
  readonly running: boolean;
}

export interface OutboxWorkerHealth {
  readonly cycleFailed: Effect.Effect<void>;
  readonly cycleSucceeded: Effect.Effect<void>;
  readonly isReady: Effect.Effect<boolean>;
  readonly shuttingDown: Effect.Effect<void>;
}

export interface CreateOutboxWorkerHealthOptions {
  readonly now?: Effect.Effect<number>;
  readonly staleAfterMs: number;
}

export const createOutboxWorkerHealth = ({
  now = Clock.currentTimeMillis,
  staleAfterMs,
}: CreateOutboxWorkerHealthOptions): Effect.Effect<OutboxWorkerHealth> =>
  Ref.make<HealthState>({ lastSuccessfulCycleAt: undefined, running: true }).pipe(
    Effect.map((state) => ({
      cycleFailed: Ref.update(state, (current) => ({
        ...current,
        lastSuccessfulCycleAt: undefined,
      })),
      cycleSucceeded: now.pipe(
        Effect.flatMap((lastSuccessfulCycleAt) =>
          Ref.update(state, (current) => ({ ...current, lastSuccessfulCycleAt })),
        ),
      ),
      isReady: Effect.all([Ref.get(state), now]).pipe(
        Effect.map(
          ([current, currentTime]) =>
            current.running &&
            current.lastSuccessfulCycleAt !== undefined &&
            currentTime - current.lastSuccessfulCycleAt <= staleAfterMs,
        ),
      ),
      shuttingDown: Ref.set(state, { lastSuccessfulCycleAt: undefined, running: false }),
    })),
  );

export interface OutboxWorkerHealthServer {
  readonly hostname: string;
  readonly port: number;
}

// Node supplies only the server constructor; the Effect adapter owns all socket I/O and cleanup.
const createNodeHealthServer = () => process.getBuiltinModule('http').createServer();

export const serveOutboxWorkerHealth = (
  health: OutboxWorkerHealth,
  options: { readonly port: number },
): Effect.Effect<OutboxWorkerHealthServer, ServeError, Scope.Scope> =>
  Effect.gen(function* serveOutboxWorkerHealthEffect() {
    const server = yield* NodeHttpServer.make(createNodeHealthServer, {
      host: '0.0.0.0',
      port: options.port,
    });
    const healthApplication = HttpServerRequest.HttpServerRequest.use((request) => {
      if (request.url !== '/ready') {
        return Effect.succeed(HttpServerResponse.empty({ status: 404 }));
      }
      return health.isReady.pipe(
        Effect.map((ready) =>
          HttpServerResponse.jsonUnsafe({ ready }, { status: ready ? 200 : 503 }),
        ),
      );
    });
    yield* server.serve(healthApplication);

    if (server.address._tag !== 'TcpAddress') {
      return yield* Effect.die('Outbox health server did not bind to TCP');
    }
    yield* Effect.addFinalizer(() => health.shuttingDown);
    return { hostname: server.address.hostname, port: server.address.port };
  });
