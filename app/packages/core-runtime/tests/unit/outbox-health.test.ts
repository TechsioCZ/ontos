/* oxlint-disable typescript/return-await */
// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigProvider, Effect, Layer, Result } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/unstable/http';
import { createOutboxWorkerHealth, serveOutboxWorkerHealth } from '../../src/outbox/health.ts';
import { runOutboxWorkerProcess } from '../../src/outbox/process.ts';
import { OutboxRuntime } from '../../src/outbox/runtime.ts';

test('production health binds all IPv4 interfaces for external-container probes', async () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* externallyReachableHealth() {
        const health = yield* createOutboxWorkerHealth({ staleAfterMs: 5000 });
        const server = yield* serveOutboxWorkerHealth(health, { port: 0 });
        assert.equal(server.hostname, '0.0.0.0');
      }),
    ),
  ));

test('readiness starts false, follows successful/failing cycles, expires, and closes on shutdown', async () => {
  let now = 1000;
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* healthLifecycle() {
        const services = yield* Layer.build(FetchHttpClient.layer);
        const client = yield* Effect.provide(HttpClient.HttpClient, services);
        const health = yield* createOutboxWorkerHealth({
          now: Effect.sync(() => now),
          staleAfterMs: 100,
        });
        const server = yield* serveOutboxWorkerHealth(health, { port: 0 });
        const ready = client.get(`http://127.0.0.1:${server.port}/ready`);
        const startingResponse = yield* ready;
        assert.equal(startingResponse.status, 503);
        assert.deepEqual(yield* startingResponse.json, { ready: false });
        assert.equal((yield* client.get(`http://127.0.0.1:${server.port}/unknown`)).status, 404);
        yield* health.cycleSucceeded;
        const readyResponse = yield* ready;
        assert.equal(readyResponse.status, 200);
        assert.deepEqual(yield* readyResponse.json, { ready: true });
        now = 1101;
        assert.equal((yield* ready).status, 503);
        yield* health.cycleSucceeded;
        yield* health.cycleFailed;
        assert.equal((yield* ready).status, 503);
        yield* health.cycleSucceeded;
        yield* health.shuttingDown;
        assert.equal((yield* ready).status, 503);
      }),
    ),
  );
});

test('closing the health scope marks it unavailable and releases its dynamically allocated port', async () =>
  Effect.runPromise(
    Effect.gen(function* releasedPort() {
      const health = yield* createOutboxWorkerHealth({ staleAfterMs: 5000 });
      yield* health.cycleSucceeded;
      const server = yield* Effect.scoped(serveOutboxWorkerHealth(health, { port: 0 }));
      assert.equal(yield* health.isReady, false);
      const rebound = yield* Effect.scoped(serveOutboxWorkerHealth(health, { port: server.port }));
      assert.equal(rebound.port, server.port);
    }),
  ));

test('a health port already in use produces a typed server startup failure', async () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* occupiedPort() {
        const health = yield* createOutboxWorkerHealth({ staleAfterMs: 5000 });
        const server = yield* serveOutboxWorkerHealth(health, { port: 0 });
        const result = yield* Effect.result(
          Effect.scoped(serveOutboxWorkerHealth(health, { port: server.port })),
        );
        assert.ok(Result.isFailure(result));
        assert.equal(result.failure._tag, 'ServeError');
      }),
    ),
  ));

test('invalid configured health ports fail startup with a typed configuration error before polling', async () =>
  Effect.runPromise(
    Effect.gen(function* invalidPortConfiguration() {
      for (const port of ['0', '65536', '4102.5', 'invalid']) {
        const result = yield* Effect.result(
          runOutboxWorkerProcess({
            claimOwnerPrefix: 'health-config-test',
            health: true,
            registrations: [],
            subscriptions: [],
          }).pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({ OUTBOX_WORKER_HEALTH_PORT: port }),
            ),
            Effect.provideService(OutboxRuntime, {
              matchMessages: () => Effect.die('Invalid configuration must prevent matching'),
              runCycle: () => Effect.die('Invalid configuration must prevent polling'),
            }),
          ),
        );
        assert.ok(Result.isFailure(result));
        assert.equal(result.failure._tag, 'ConfigError');
      }
    }),
  ));
