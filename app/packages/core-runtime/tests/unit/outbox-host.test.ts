import { ConfigProvider, Deferred, Effect, Exit, Fiber, Layer, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import { FetchHttpClient, HttpClient } from 'effect/unstable/http';

import { PersistenceFailure } from '../../src/database/persistence-failure.ts';
import { createOutboxWorkerHealth, serveOutboxWorkerHealth } from '../../src/outbox/health.ts';
import { defineOutboxWorkerEntry, runOutboxWorkerHost } from '../../src/outbox/process.ts';
import { OutboxRuntime } from '../../src/outbox/runtime.ts';
import type { OutboxCycleResult } from '../../src/outbox/runtime.ts';

const emptyResult: OutboxCycleResult = {
  claimed: 0,
  dead: 0,
  deliveriesCreated: 0,
  failed: 0,
  messagesMatched: 0,
  retried: 0,
  succeeded: 0,
};

const controlledFailure = new PersistenceFailure({
  cause: 'controlled driver failure',
  reason: 'controlled test failure',
});

const CycleOutcomeSchema = Schema.Literals(['defect', 'fail', 'succeed']);
type CycleOutcome = typeof CycleOutcomeSchema.Type;

interface ObservedLoop {
  readonly claimOwners: Ref.Ref<readonly string[]>;
  readonly disposed: Ref.Ref<boolean>;
  readonly outcome: Ref.Ref<CycleOutcome>;
}

const observedLoop = Effect.gen(function* makeObservedLoop() {
  return {
    claimOwners: yield* Ref.make<readonly string[]>([]),
    disposed: yield* Ref.make(false),
    outcome: yield* Ref.make<CycleOutcome>('succeed'),
  } satisfies ObservedLoop;
});

const runCycleFor = (loop: ObservedLoop) => (input: { readonly claimOwner: string }) =>
  Ref.update(loop.claimOwners, (owners) => [...owners, input.claimOwner]).pipe(
    Effect.andThen(Ref.get(loop.outcome)),
    Effect.flatMap((outcome) => {
      if (outcome === 'defect') {
        return Effect.die('controlled loop defect');
      }
      return outcome === 'fail' ? Effect.fail(controlledFailure) : Effect.succeed(emptyResult);
    }),
  );

const observedEntry = (claimOwnerPrefix: string, loop: ObservedLoop) =>
  defineOutboxWorkerEntry({
    claimOwnerPrefix,
    layer: Layer.effect(
      OutboxRuntime,
      Effect.acquireRelease(
        Effect.succeed({
          matchMessages: () => Effect.succeed({ deliveriesCreated: 0, messagesMatched: 0 }),
          runCycle: runCycleFor(loop),
        }),
        () => Ref.set(loop.disposed, true),
      ),
    ),
    registrations: [],
    subscriptions: [],
  });

const cyclesOf = (loop: ObservedLoop) => Ref.get(loop.claimOwners).pipe(Effect.map((owners) => owners.length));

/** Advances virtual time one poll interval at a time until the loop has run `minimum` cycles. */
const driveCycles = (loop: ObservedLoop, minimum: number): Effect.Effect<void> =>
  cyclesOf(loop).pipe(
    Effect.flatMap((cycles) =>
      cycles >= minimum
        ? Effect.void
        : TestClock.adjust('10 millis').pipe(
            Effect.andThen(Effect.yieldNow),
            Effect.andThen(Effect.suspend(() => driveCycles(loop, minimum))),
          ),
    ),
  );

const hostEnvironment = (values: Record<string, string>) =>
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown({ OUTBOX_WORKER_POLL_INTERVAL_MS: '10', ...values }),
  );

const freeHealthPort = Effect.scoped(
  createOutboxWorkerHealth({ staleAfterMs: 5000 }).pipe(
    Effect.flatMap((health) => serveOutboxWorkerHealth(health, { port: 0 })),
    Effect.map(({ port }) => port),
  ),
);

it.effect('hosts two workers with distinct claim owners and independent polling loops', () =>
  Effect.gen(function* twoIndependentLoops() {
    const billing = yield* observedLoop;
    const ledger = yield* observedLoop;
    yield* Ref.set(billing.outcome, 'fail');
    const host = yield* runOutboxWorkerHost({
      entries: [observedEntry('billing-outbox-worker', billing), observedEntry('ledger-outbox-worker', ledger)],
    }).pipe(hostEnvironment({ OUTBOX_WORKER_PROCESS_IDENTITY: 'shared-host' }), Effect.forkChild);

    yield* Effect.all([driveCycles(billing, 3), driveCycles(ledger, 3)], { concurrency: 'unbounded' });
    yield* Fiber.interrupt(host);

    const billingOwners = new Set(yield* Ref.get(billing.claimOwners));
    const ledgerOwners = new Set(yield* Ref.get(ledger.claimOwners));
    expect([...billingOwners]).toEqual(['billing-outbox-worker:shared-host']);
    expect([...ledgerOwners]).toEqual(['ledger-outbox-worker:shared-host']);
    expect(yield* Ref.get(billing.disposed)).toBe(true);
    expect(yield* Ref.get(ledger.disposed)).toBe(true);
  }),
);

it.effect('serves one readiness endpoint that is ready only while every hosted loop is healthy', () =>
  Effect.gen(function* aggregatedReadiness() {
    const client = yield* Layer.build(FetchHttpClient.layer).pipe(
      Effect.flatMap((services) => Effect.provide(HttpClient.HttpClient, services)),
    );
    const billing = yield* observedLoop;
    const ledger = yield* observedLoop;
    yield* Ref.set(billing.outcome, 'fail');
    const port = yield* freeHealthPort;
    const host = yield* runOutboxWorkerHost({
      entries: [observedEntry('billing-outbox-worker', billing), observedEntry('ledger-outbox-worker', ledger)],
      health: true,
    }).pipe(hostEnvironment({ OUTBOX_WORKER_HEALTH_PORT: String(port) }), Effect.forkChild);
    const readiness = client.get(`http://127.0.0.1:${port}/ready`).pipe(Effect.map(({ status }) => status));

    yield* Effect.all([driveCycles(billing, 2), driveCycles(ledger, 2)], { concurrency: 'unbounded' });
    expect(yield* readiness).toBe(503);

    yield* Ref.set(billing.outcome, 'succeed');
    const recovered = yield* cyclesOf(billing);
    yield* driveCycles(billing, recovered + 2);
    expect(yield* readiness).toBe(200);

    yield* Fiber.interrupt(host);
  }),
);

it.effect('fails fast when one loop dies and disposes every hosted runtime before exiting', () =>
  Effect.gen(function* failFast() {
    const billing = yield* observedLoop;
    const ledger = yield* observedLoop;
    const host = yield* runOutboxWorkerHost({
      entries: [observedEntry('billing-outbox-worker', billing), observedEntry('ledger-outbox-worker', ledger)],
    }).pipe(hostEnvironment({}), Effect.forkChild);

    yield* driveCycles(ledger, 2);
    yield* Ref.set(billing.outcome, 'defect');

    yield* TestClock.adjust('10 millis');
    const exit = yield* Fiber.await(host);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(yield* Ref.get(billing.disposed)).toBe(true);
    expect(yield* Ref.get(ledger.disposed)).toBe(true);
  }),
);

it.effect('fails fast when one runtime cannot be built and releases the runtimes already running', () =>
  Effect.gen(function* failFastOnStartup() {
    const ledger = yield* observedLoop;
    const ledgerRunning = yield* Deferred.make<null>();
    const brokenEntry = defineOutboxWorkerEntry({
      claimOwnerPrefix: 'billing-outbox-worker',
      layer: Layer.effect(
        OutboxRuntime,
        Deferred.await(ledgerRunning).pipe(Effect.andThen(Effect.fail(controlledFailure))),
      ),
      registrations: [],
      subscriptions: [],
    });
    const host = yield* runOutboxWorkerHost({
      entries: [brokenEntry, observedEntry('ledger-outbox-worker', ledger)],
    }).pipe(hostEnvironment({}), Effect.forkChild);

    yield* driveCycles(ledger, 1);
    yield* Deferred.succeed(ledgerRunning, null);

    const exit = yield* Fiber.await(host);
    expect(exit).toStrictEqual(Exit.fail(controlledFailure));
    expect(yield* Ref.get(ledger.disposed)).toBe(true);
  }),
);
