import { ConfigProvider, Effect, Layer, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient, HttpClient } from 'effect/unstable/http';

import {
  combineOutboxWorkerHealth,
  createOutboxWorkerHealth,
  serveOutboxWorkerHealth,
} from '../../src/outbox/health.ts';
import { defineOutboxWorkerEntry, runOutboxWorkerHost } from '../../src/outbox/process.ts';
import { OutboxRuntime } from '../../src/outbox/runtime.ts';
import { outboxWorkerCompositionLayer } from '../support/outbox-worker-composition.ts';

it.live('production health binds all IPv4 interfaces for external-container probes', () =>
  Effect.gen(function* externallyReachableHealth() {
    const health = yield* createOutboxWorkerHealth({ staleAfterMs: 5000 });
    const server = yield* serveOutboxWorkerHealth(health, { port: 0 });
    expect(server.hostname).toBe('0.0.0.0');
  }),
);

it.live('readiness starts false, follows successful/failing cycles, expires, and closes on shutdown', () => {
  let now = 1000;
  return Effect.gen(function* healthLifecycle() {
    const services = yield* Layer.build(FetchHttpClient.layer);
    const client = yield* Effect.provide(HttpClient.HttpClient, services);
    const health = yield* createOutboxWorkerHealth({
      now: Effect.sync(() => now),
      staleAfterMs: 100,
    });
    const server = yield* serveOutboxWorkerHealth(health, { port: 0 });
    const live = client.get(`http://127.0.0.1:${server.port}/live`);
    const ready = client.get(`http://127.0.0.1:${server.port}/ready`);
    const startingLiveResponse = yield* live;
    expect(startingLiveResponse.status).toBe(200);
    expect(yield* startingLiveResponse.json).toEqual({ live: true });
    const startingResponse = yield* ready;
    expect(startingResponse.status).toBe(503);
    expect(yield* startingResponse.json).toEqual({ ready: false });
    expect((yield* client.get(`http://127.0.0.1:${server.port}/unknown`)).status).toBe(404);
    yield* health.cycleSucceeded;
    const readyResponse = yield* ready;
    expect(readyResponse.status).toBe(200);
    expect(yield* readyResponse.json).toEqual({ ready: true });
    now = 1101;
    expect((yield* ready).status).toBe(503);
    expect((yield* live).status).toBe(200);
    yield* health.cycleSucceeded;
    yield* health.cycleFailed;
    expect((yield* ready).status).toBe(503);
    expect((yield* live).status).toBe(200);
    yield* health.cycleSucceeded;
    yield* health.shuttingDown;
    expect((yield* ready).status).toBe(503);
    const stoppedLiveResponse = yield* live;
    expect(stoppedLiveResponse.status).toBe(503);
    expect(yield* stoppedLiveResponse.json).toEqual({ live: false });
  });
});

it.live('a host awaiting composition stays live while every business cycle remains unready', () =>
  Effect.gen(function* waitingHostLifecycle() {
    const services = yield* Layer.build(FetchHttpClient.layer);
    const client = yield* Effect.provide(HttpClient.HttpClient, services);
    const first = yield* createOutboxWorkerHealth({ staleAfterMs: 5000 });
    const second = yield* createOutboxWorkerHealth({ staleAfterMs: 5000 });
    const health = combineOutboxWorkerHealth([first, second]);
    const server = yield* serveOutboxWorkerHealth(health, { port: 0 });
    const live = client.get(`http://127.0.0.1:${server.port}/live`);
    const ready = client.get(`http://127.0.0.1:${server.port}/ready`);
    yield* first.cycleFailed;
    yield* second.cycleFailed;
    expect((yield* live).status).toBe(200);
    expect((yield* ready).status).toBe(503);
    yield* first.cycleSucceeded;
    expect((yield* ready).status).toBe(503);
    yield* second.cycleSucceeded;
    expect((yield* ready).status).toBe(200);
    yield* first.shuttingDown;
    expect((yield* live).status).toBe(503);
    expect((yield* ready).status).toBe(503);
    expect(yield* combineOutboxWorkerHealth([]).isLive).toBe(false);
  }),
);

it.live('closing the health scope marks it unavailable and releases its dynamically allocated port', () =>
  Effect.gen(function* releasedPort() {
    const health = yield* createOutboxWorkerHealth({ staleAfterMs: 5000 });
    yield* health.cycleSucceeded;
    const server = yield* Effect.scoped(serveOutboxWorkerHealth(health, { port: 0 }));
    expect(yield* health.isLive).toBe(false);
    expect(yield* health.isReady).toBe(false);
    const rebound = yield* Effect.scoped(serveOutboxWorkerHealth(health, { port: server.port }));
    expect(rebound.port).toBe(server.port);
  }),
);

it.live('a health port already in use produces a typed server startup failure', () =>
  Effect.gen(function* occupiedPort() {
    const health = yield* createOutboxWorkerHealth({ staleAfterMs: 5000 });
    const server = yield* serveOutboxWorkerHealth(health, { port: 0 });
    const failure = yield* Effect.flip(Effect.scoped(serveOutboxWorkerHealth(health, { port: server.port })));
    expect(Predicate.isTagged(failure, 'ServeError')).toBe(true);
  }),
);

it.effect('invalid configured health ports fail startup with a typed configuration error before polling', () =>
  Effect.gen(function* invalidPortConfiguration() {
    for (const port of ['0', '65536', '4102.5', 'invalid']) {
      const failure = yield* Effect.flip(
        runOutboxWorkerHost({
          entries: [
            defineOutboxWorkerEntry({
              claimOwnerPrefix: 'health-config-test',
              expectedDeployment: { appId: 'health-config-test', buildMarker: 'health-config-test-build' },
              layer: Layer.succeed(OutboxRuntime, {
                matchMessages: () => Effect.die('Invalid configuration must prevent matching'),
                runCycle: () => Effect.die('Invalid configuration must prevent polling'),
              }).pipe(Layer.merge(outboxWorkerCompositionLayer())),
              registrations: [],
              subscriptions: [],
            }),
          ],
          health: true,
        }).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ OUTBOX_WORKER_HEALTH_PORT: port }),
          ),
        ),
      );
      expect(Predicate.isTagged(failure, 'ConfigError')).toBe(true);
    }
  }),
);
