import { Clock, ConfigProvider, DateTime, Deferred, Effect, Exit, Fiber, Layer, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import { FetchHttpClient, HttpClient } from 'effect/unstable/http';

import { PersistenceFailure } from '../../src/database/persistence-failure.ts';
import { ActiveApplicationCompositionService } from '../../src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionUnavailableError } from '../../src/modules/active-application-composition-errors.ts';
import { OntosOutboxSubscriptionContractSchema } from '../../src/modules/manifest.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineOutboxWorker, extractOutboxWorkerSubscriptions } from '../../src/outbox/definition.ts';
import { createOutboxWorkerHealth, serveOutboxWorkerHealth } from '../../src/outbox/health.ts';
import { defineOutboxWorkerEntry, runOutboxWorkerHost } from '../../src/outbox/process.ts';
import { OutboxRuntime } from '../../src/outbox/runtime.ts';
import type { OutboxCycleResult } from '../../src/outbox/runtime.ts';
import {
  freshOutboxWorkerCompositionSnapshot,
  makeOutboxWorkerComposition,
  outboxWorkerCompositionLayer,
} from '../support/outbox-worker-composition.ts';

const expectedDeployment = { appId: 'worker-fixture', buildMarker: 'worker-fixture-build' };

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

const runCycleFor =
  (loop: ObservedLoop) => (input: { readonly claimOwner: string; readonly compositionRevision: string }) =>
    Ref.update(loop.claimOwners, (owners) => [...owners, input.claimOwner]).pipe(
      Effect.andThen(Ref.get(loop.outcome)),
      Effect.flatMap((outcome) => {
        if (outcome === 'defect') {
          return Effect.die('controlled loop defect');
        }
        return outcome === 'fail' ? Effect.fail(controlledFailure) : Effect.succeed(emptyResult);
      }),
    );

const observedRuntimeLayer = (loop: ObservedLoop, runCycle = runCycleFor(loop)) =>
  Layer.effect(
    OutboxRuntime,
    Effect.acquireRelease(
      Effect.succeed({
        matchMessages: () => Effect.succeed({ deliveriesCreated: 0, messagesMatched: 0 }),
        runCycle,
      }),
      () => Ref.set(loop.disposed, true),
    ),
  );

const observedEntry = (claimOwnerPrefix: string, loop: ObservedLoop) =>
  defineOutboxWorkerEntry({
    claimOwnerPrefix,
    expectedDeployment,
    layer: observedRuntimeLayer(loop).pipe(Layer.merge(outboxWorkerCompositionLayer())),
    registrations: [],
    subscriptions: [],
  });

const registration = defineOutboxWorker(
  {
    consumerModuleKey: 'worker.fixture',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'background',
      authorization: { kind: 'owner_local_background' },
      entrypointKey: 'worker.fixture.projector',
      moduleKey: 'worker.fixture',
      role: 'worker',
    }),
    leaseDurationMs: 1000,
    payloadSchema: Schema.Struct({ messageKey: Schema.String.pipe(Schema.brand('MessageKey')) }),
    producerModuleKey: 'producer.fixture',
    retryPolicy: { initialBackoffMs: 0, maxAttempts: 1, maxBackoffMs: 0, multiplier: 1 },
    topic: 'producer.fixture.message-created',
    workerKey: 'worker.fixture.projector',
  },
  () => Effect.void,
);

const foreignRegistration = defineOutboxWorker(
  {
    ...registration.descriptor,
    consumerModuleKey: 'producer.fixture',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'background',
      authorization: { kind: 'owner_local_background' },
      entrypointKey: 'producer.fixture.unexpected-projector',
      moduleKey: 'producer.fixture',
      role: 'worker',
    }),
    workerKey: 'producer.fixture.unexpected-projector',
  },
  () => Effect.void,
);

const secondaryRegistration = defineOutboxWorker(
  {
    ...registration.descriptor,
    entrypoint: defineTenantModuleEntrypoint({
      access: 'background',
      authorization: { kind: 'owner_local_background' },
      entrypointKey: 'worker.fixture.secondary-projector',
      moduleKey: 'worker.fixture',
      role: 'worker',
    }),
    workerKey: 'worker.fixture.secondary-projector',
  },
  () => Effect.void,
);

const workerSubscriptions = extractOutboxWorkerSubscriptions([registration]);
const workerComposition = makeOutboxWorkerComposition([
  {
    ...expectedDeployment,
    dependencies: ['producer.fixture'],
    moduleId: 'worker.fixture',
    subscriptions: workerSubscriptions,
  },
  { appId: 'producer-fixture', moduleId: 'producer.fixture' },
]);

const renewedWorkerComposition = makeOutboxWorkerComposition([
  {
    ...expectedDeployment,
    dependencies: ['producer.fixture'],
    moduleId: 'worker.fixture',
    subscriptions: workerSubscriptions,
  },
  { appId: 'producer-fixture', moduleId: 'producer.fixture' },
  { appId: 'unrelated-fixture', moduleId: 'unrelated.fixture' },
]);

const twoWorkerSubscriptions = extractOutboxWorkerSubscriptions([registration, secondaryRegistration]);
const twoWorkerComposition = makeOutboxWorkerComposition([
  {
    ...expectedDeployment,
    dependencies: ['producer.fixture'],
    moduleId: 'worker.fixture',
    subscriptions: twoWorkerSubscriptions,
  },
  { appId: 'producer-fixture', moduleId: 'producer.fixture' },
]);

const loopConfig = { claimOwner: 'worker-fixture:test', maxDeliveries: 10, pollIntervalMs: 10 };

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
      expectedDeployment,
      layer: Layer.effect(
        OutboxRuntime,
        Deferred.await(ledgerRunning).pipe(Effect.andThen(Effect.fail(controlledFailure))),
      ).pipe(Layer.merge(outboxWorkerCompositionLayer())),
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

it.effect('admits a fresh revision each cycle without restarting an unchanged compiled owner', () =>
  Effect.gen(function* perCycleWorkerRevision() {
    const firstCycle = yield* Deferred.make<null>();
    const revisions = yield* Ref.make<readonly string[]>([]);
    let loads = 0;
    let activeComposition = workerComposition;
    const loop = yield* observedLoop;
    const entry = defineOutboxWorkerEntry({
      claimOwnerPrefix: 'worker-fixture',
      expectedDeployment,
      layer: Layer.merge(
        Layer.succeed(ActiveApplicationCompositionService, {
          load: Effect.suspend(() => {
            loads += 1;
            return freshOutboxWorkerCompositionSnapshot(activeComposition);
          }),
        }),
        observedRuntimeLayer(loop, (input) =>
          runCycleFor(loop)(input).pipe(
            Effect.andThen(Ref.update(revisions, (observed) => [...observed, input.compositionRevision])),
            Effect.andThen(Deferred.succeed(firstCycle, null)),
            Effect.as(emptyResult),
          ),
        ),
      ),
      registrations: [registration],
      subscriptions: workerSubscriptions,
    });
    const running = yield* entry.runLoop({ config: loopConfig }).pipe(Effect.forkChild);
    yield* Deferred.await(firstCycle);
    activeComposition = renewedWorkerComposition;
    yield* driveCycles(loop, 4);
    yield* Fiber.interrupt(running);

    const observed = yield* Ref.get(revisions);
    expect(observed).toHaveLength(4);
    expect(observed[0]).toBe(workerComposition.revision);
    expect([...new Set(observed.slice(1))]).toEqual([renewedWorkerComposition.revision]);
    expect(loads).toBeGreaterThanOrEqual(4);
    expect(yield* Ref.get(loop.disposed)).toBe(true);
  }),
);

it.effect('keeps health alive during an authority outage and admits later revisions without restarting', () =>
  Effect.gen(function* waitForInitialWorkerAuthority() {
    const client = yield* Layer.build(FetchHttpClient.layer).pipe(
      Effect.flatMap((services) => Effect.provide(HttpClient.HttpClient, services)),
    );
    const waiting = yield* observedLoop;
    const ledger = yield* observedLoop;
    const firstLoad = yield* Deferred.make<null>();
    const firstCycle = yield* Deferred.make<null>();
    const revisions = yield* Ref.make<readonly string[]>([]);
    let available = false;
    let loads = 0;
    let activeComposition = workerComposition;
    const entry = defineOutboxWorkerEntry({
      claimOwnerPrefix: 'waiting-outbox-worker',
      expectedDeployment,
      layer: observedRuntimeLayer(waiting, (input) =>
        runCycleFor(waiting)(input).pipe(
          Effect.andThen(Ref.update(revisions, (observed) => [...observed, input.compositionRevision])),
          Effect.andThen(Deferred.succeed(firstCycle, null)),
          Effect.as(emptyResult),
        ),
      ).pipe(
        Layer.merge(
          Layer.succeed(ActiveApplicationCompositionService, {
            load: Effect.suspend(() => {
              loads += 1;
              return Deferred.succeed(firstLoad, null).pipe(
                Effect.andThen(
                  available
                    ? freshOutboxWorkerCompositionSnapshot(activeComposition)
                    : Effect.fail(
                        new ActiveApplicationCompositionUnavailableError({ reason: 'Initial source is absent' }),
                      ),
                ),
              );
            }),
          }),
        ),
      ),
      registrations: [registration],
      subscriptions: workerSubscriptions,
    });
    const port = yield* freeHealthPort;
    const host = yield* runOutboxWorkerHost({
      entries: [entry, observedEntry('ledger-outbox-worker', ledger)],
      health: true,
    }).pipe(hostEnvironment({ OUTBOX_WORKER_HEALTH_PORT: String(port) }), Effect.forkChild);
    const readiness = client.get(`http://127.0.0.1:${port}/ready`).pipe(Effect.map(({ status }) => status));

    yield* Deferred.await(firstLoad);
    yield* driveCycles(ledger, 4);
    expect(loads).toBeGreaterThan(1);
    expect(yield* cyclesOf(waiting)).toBe(0);
    expect(yield* Ref.get(waiting.disposed)).toBe(false);
    expect(yield* readiness).toBe(503);

    available = true;
    yield* TestClock.adjust('10 millis');
    yield* Deferred.await(firstCycle);
    const admittedLoads = loads;
    expect(yield* readiness).toBe(200);
    activeComposition = renewedWorkerComposition;
    yield* driveCycles(waiting, 4);
    expect(loads).toBeGreaterThan(admittedLoads);
    const observed = yield* Ref.get(revisions);
    expect(observed[0]).toBe(workerComposition.revision);
    expect(observed.at(-1)).toBe(renewedWorkerComposition.revision);

    yield* Fiber.interrupt(host);
    expect(yield* Ref.get(waiting.disposed)).toBe(true);
    expect(yield* Ref.get(ledger.disposed)).toBe(true);
  }),
);

it.effect('blocks new claims when a later revision changes this owner build', () =>
  Effect.gen(function* rejectChangedOwnerBuild() {
    const loop = yield* observedLoop;
    const firstCycle = yield* Deferred.make<null>();
    const rejectedBuild = yield* Deferred.make<null>();
    const firstReady = yield* Deferred.make<null>();
    const health = yield* createOutboxWorkerHealth({ staleAfterMs: 5000 });
    const revisions = yield* Ref.make<readonly string[]>([]);
    const changedOwnerComposition = makeOutboxWorkerComposition([
      {
        ...expectedDeployment,
        buildMarker: 'worker-fixture-next-build',
        dependencies: ['producer.fixture'],
        moduleId: 'worker.fixture',
        subscriptions: workerSubscriptions,
      },
      { appId: 'producer-fixture', moduleId: 'producer.fixture' },
    ]);
    let activeComposition = workerComposition;
    const entry = defineOutboxWorkerEntry({
      claimOwnerPrefix: 'worker-fixture',
      expectedDeployment,
      layer: observedRuntimeLayer(loop, (input) =>
        runCycleFor(loop)(input).pipe(
          Effect.andThen(Ref.update(revisions, (observed) => [...observed, input.compositionRevision])),
          Effect.andThen(Deferred.succeed(firstCycle, null)),
          Effect.as(emptyResult),
        ),
      ).pipe(
        Layer.merge(
          Layer.succeed(ActiveApplicationCompositionService, {
            load: Effect.suspend(() => freshOutboxWorkerCompositionSnapshot(activeComposition)),
          }),
        ),
      ),
      registrations: [registration],
      subscriptions: workerSubscriptions,
    });
    const running = yield* entry
      .runLoop({
        config: loopConfig,
        health: {
          cycleFailed: health.cycleFailed.pipe(Effect.andThen(Deferred.succeed(rejectedBuild, null)), Effect.asVoid),
          cycleSucceeded: health.cycleSucceeded.pipe(Effect.andThen(Deferred.succeed(firstReady, null)), Effect.asVoid),
        },
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(firstCycle);
    yield* Deferred.await(firstReady);
    expect(yield* health.isReady).toBe(true);
    activeComposition = changedOwnerComposition;
    yield* TestClock.adjust('10 millis');
    yield* Deferred.await(rejectedBuild);
    expect(yield* cyclesOf(loop)).toBe(1);
    expect(yield* Ref.get(revisions)).toEqual([workerComposition.revision]);
    expect(yield* health.isReady).toBe(false);
    yield* Fiber.interrupt(running);
  }),
);

it.effect(
  'checks every registration for an approved owner and matching compiled deployment before the first cycle',
  () =>
    Effect.gen(function* rejectedWorkerArtifact() {
      const attempts = [
        { composition: makeOutboxWorkerComposition(), deployment: expectedDeployment, registrations: [registration] },
        {
          composition: workerComposition,
          deployment: { ...expectedDeployment, appId: 'another-worker' },
          registrations: [registration],
        },
        {
          composition: workerComposition,
          deployment: { ...expectedDeployment, buildMarker: 'another-build' },
          registrations: [registration],
        },
        {
          composition: workerComposition,
          deployment: expectedDeployment,
          registrations: [registration, foreignRegistration],
        },
      ];
      for (const { composition, deployment, registrations } of attempts) {
        const loop = yield* observedLoop;
        const admissionFailed = yield* Deferred.make<null>();
        const entry = defineOutboxWorkerEntry({
          claimOwnerPrefix: 'worker-fixture',
          expectedDeployment: deployment,
          layer: observedRuntimeLayer(loop).pipe(Layer.merge(outboxWorkerCompositionLayer(composition))),
          registrations,
          subscriptions: extractOutboxWorkerSubscriptions(registrations),
        });
        const running = yield* entry
          .runLoop({
            config: loopConfig,
            health: {
              cycleFailed: Deferred.succeed(admissionFailed, null).pipe(Effect.asVoid),
              cycleSucceeded: Effect.void,
            },
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(admissionFailed);
        expect(yield* cyclesOf(loop)).toBe(0);
        yield* Fiber.interrupt(running);
        expect(yield* Ref.get(loop.disposed)).toBe(true);
      }
    }),
);

it.effect('rejects a stale compiled owner when initial authority recovers without issuing claims', () =>
  Effect.gen(function* rejectStaleOwnerAfterColdBoot() {
    const loop = yield* observedLoop;
    const firstLoad = yield* Deferred.make<null>();
    const admissionFailed = yield* Deferred.make<null>();
    let loads = 0;
    const entry = defineOutboxWorkerEntry({
      claimOwnerPrefix: 'worker-fixture',
      expectedDeployment: { ...expectedDeployment, buildMarker: 'retired-worker-build' },
      layer: observedRuntimeLayer(loop).pipe(
        Layer.merge(
          Layer.succeed(ActiveApplicationCompositionService, {
            load: Effect.suspend(() => {
              loads += 1;
              return Deferred.succeed(firstLoad, null).pipe(
                Effect.andThen(
                  loads === 1
                    ? Effect.fail(
                        new ActiveApplicationCompositionUnavailableError({ reason: 'Initial source is absent' }),
                      )
                    : freshOutboxWorkerCompositionSnapshot(workerComposition),
                ),
              );
            }),
          }),
        ),
      ),
      registrations: [registration],
      subscriptions: workerSubscriptions,
    });
    const running = yield* entry
      .runLoop({
        config: loopConfig,
        health: {
          cycleFailed: Effect.suspend(() =>
            loads >= 2 ? Deferred.succeed(admissionFailed, null).pipe(Effect.asVoid) : Effect.void,
          ),
          cycleSucceeded: Effect.void,
        },
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(firstLoad);
    expect(yield* cyclesOf(loop)).toBe(0);
    yield* TestClock.adjust('10 millis');
    yield* Deferred.await(admissionFailed);
    expect(loads).toBeGreaterThanOrEqual(2);
    expect(yield* cyclesOf(loop)).toBe(0);
    yield* Fiber.interrupt(running);
    expect(yield* Ref.get(loop.disposed)).toBe(true);
  }),
);

it.effect('blocks claims and remains cancellable while injected authority is expired or invalid', () =>
  Effect.gen(function* rejectedWorkerAuthority() {
    for (const defect of ['expired', 'invalid-revision', 'invalid-contract']) {
      const loop = yield* observedLoop;
      const firstLoad = yield* Deferred.make<null>();
      const loads = yield* Ref.make(0);
      let composition = workerComposition;
      if (defect === 'invalid-revision') {
        composition = { ...workerComposition, revision: 'f'.repeat(64) };
      } else if (defect === 'invalid-contract') {
        composition = {
          ...workerComposition,
          modules: workerComposition.modules.map((module) => ({ ...module, contractDocument: '{}' })),
        };
      }
      const entry = defineOutboxWorkerEntry({
        claimOwnerPrefix: 'worker-fixture',
        expectedDeployment,
        layer: observedRuntimeLayer(loop).pipe(
          Layer.merge(
            Layer.succeed(ActiveApplicationCompositionService, {
              load: Ref.update(loads, (value) => value + 1).pipe(
                Effect.andThen(Deferred.succeed(firstLoad, null)),
                Effect.andThen(Clock.currentTimeMillis),
                Effect.map((now) => ({
                  composition,
                  observedAt: DateTime.makeUnsafe(now - 200),
                  validUntil: DateTime.makeUnsafe(defect === 'expired' ? now - 100 : now + 1000),
                })),
              ),
            }),
          ),
        ),
        registrations: [registration],
        subscriptions: workerSubscriptions,
      });
      const running = yield* entry.runLoop({ config: loopConfig }).pipe(Effect.forkChild);
      yield* Deferred.await(firstLoad);
      while ((yield* Ref.get(loads)) < 2) {
        yield* TestClock.adjust('10 millis');
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(loads)).toBeGreaterThan(1);
      expect(yield* cyclesOf(loop)).toBe(0);
      expect(yield* Ref.get(loop.disposed)).toBe(false);
      yield* Fiber.interrupt(running);
      expect(yield* Ref.get(loop.disposed)).toBe(true);
    }
  }),
);

it.effect(
  'rejects missing or changed compiled subscriptions against the complete approved owner contract before polling',
  () =>
    Effect.gen(function* rejectChangedWorkerCatalog() {
      const subscription = yield* Schema.decodeUnknownEffect(OntosOutboxSubscriptionContractSchema)(
        extractOutboxWorkerSubscriptions([registration])[0],
      );
      const attempts = [
        { composition: twoWorkerComposition, name: 'approved extra worker', subscriptions: [subscription] },
        { composition: workerComposition, name: 'compiled empty catalog', subscriptions: [] },
        {
          composition: workerComposition,
          name: 'compiled different producer',
          subscriptions: [{ ...subscription, producerModuleKey: 'another.producer' }],
        },
        {
          composition: workerComposition,
          name: 'compiled different topic',
          subscriptions: [{ ...subscription, topic: 'producer.fixture.message-updated' }],
        },
        {
          composition: workerComposition,
          name: 'compiled different worker',
          subscriptions: extractOutboxWorkerSubscriptions([secondaryRegistration]),
        },
      ];
      for (const { composition, name, subscriptions } of attempts) {
        const loop = yield* observedLoop;
        const admissionFailed = yield* Deferred.make<null>();
        const suppliedSubscriptions = yield* Schema.decodeUnknownEffect(
          Schema.Array(OntosOutboxSubscriptionContractSchema),
          { onExcessProperty: 'error' },
        )(subscriptions);
        const entry = defineOutboxWorkerEntry({
          claimOwnerPrefix: 'worker-fixture',
          expectedDeployment,
          layer: observedRuntimeLayer(loop, (input) =>
            runCycleFor(loop)(input).pipe(Effect.andThen(Effect.die('A changed catalog must prevent polling'))),
          ).pipe(Layer.merge(outboxWorkerCompositionLayer(composition))),
          registrations: [registration],
          subscriptions: suppliedSubscriptions,
        });
        const running = yield* entry
          .runLoop({
            config: loopConfig,
            health: {
              cycleFailed: Deferred.succeed(admissionFailed, null).pipe(Effect.asVoid),
              cycleSucceeded: Effect.void,
            },
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(admissionFailed);
        expect(yield* cyclesOf(loop), name).toBe(0);
        yield* Fiber.interrupt(running);
        expect(yield* Ref.get(loop.disposed), name).toBe(true);
      }
    }),
);

it.effect('accepts the complete approved owner subscription catalog in a different worker order', () =>
  Effect.gen(function* acceptReorderedWorkerCatalog() {
    const firstCycle = yield* Deferred.make<null>();
    const loop = yield* observedLoop;
    const entry = defineOutboxWorkerEntry({
      claimOwnerPrefix: 'worker-fixture',
      expectedDeployment,
      layer: observedRuntimeLayer(loop, (input) =>
        runCycleFor(loop)(input).pipe(Effect.tap(() => Deferred.succeed(firstCycle, null))),
      ).pipe(Layer.merge(outboxWorkerCompositionLayer(twoWorkerComposition))),
      registrations: [registration, secondaryRegistration],
      subscriptions: twoWorkerSubscriptions.toReversed(),
    });
    const running = yield* entry.runLoop({ config: loopConfig }).pipe(Effect.forkChild);
    yield* Deferred.await(firstCycle);
    yield* driveCycles(loop, 3);
    yield* Fiber.interrupt(running);

    expect(yield* cyclesOf(loop)).toBe(3);
    expect(yield* Ref.get(loop.disposed)).toBe(true);
  }),
);
