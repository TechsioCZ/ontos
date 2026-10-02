import { Deferred, Effect, Fiber, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { ActiveApplicationCompositionUnavailableError } from '../../src/modules/active-application-composition-errors.ts';
import { defineOutboxWorker } from '../../src/outbox/definition.ts';
import { PersistenceFailure } from '../../src/database/persistence-failure.ts';
import { OutboxPollerConfigError } from '../../src/outbox/errors.ts';
import { parseOutboxPollingConfig, runOutboxPollingLoop } from '../../src/outbox/poller.ts';
import type { OutboxCycleRunner } from '../../src/outbox/poller.ts';

const registration = defineOutboxWorker(
  {
    consumerModuleKey: 'consumer',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'background',
      authorization: { kind: 'owner_local_background' },
      entrypointKey: 'consumer.logger',
      moduleKey: 'consumer',
      role: 'worker',
    }),
    leaseDurationMs: 30_000,
    payloadSchema: Schema.Struct({
      messageKey: Schema.String.pipe(Schema.brand('MessageKey')),
    }),
    producerModuleKey: 'producer',
    retryPolicy: {
      initialBackoffMs: 1000,
      maxAttempts: 5,
      maxBackoffMs: 60_000,
      multiplier: 2,
    },
    topic: 'producer.message-created',
    workerKey: 'consumer.logger',
  },
  () => Effect.void,
);

const emptyResult = {
  claimed: 0,
  dead: 0,
  deliveriesCreated: 0,
  failed: 0,
  messagesMatched: 0,
  retried: 0,
  succeeded: 0,
} as const;

it.effect('uses safe one-second defaults and accepts bounded scalar overrides', () =>
  Effect.gen(function* validPollingConfiguration() {
    expect(
      yield* parseOutboxPollingConfig({
        claimOwnerPrefixes: ['consumer'],
        defaultProcessIdentity: '41:7',
        environment: {},
      }),
    ).toEqual([
      {
        claimOwner: 'consumer:41:7',
        maxDeliveries: 100,
        pollIntervalMs: 1000,
      },
    ]);

    expect(
      yield* parseOutboxPollingConfig({
        claimOwnerPrefixes: ['consumer'],
        defaultProcessIdentity: '41:7',
        environment: {
          OUTBOX_WORKER_MAX_DELIVERIES: '25',
          OUTBOX_WORKER_POLL_INTERVAL_MS: '250',
          OUTBOX_WORKER_PROCESS_IDENTITY: 'stage-host-a',
        },
      }),
    ).toEqual([
      {
        claimOwner: 'consumer:stage-host-a',
        maxDeliveries: 25,
        pollIntervalMs: 250,
      },
    ]);
  }),
);

it.effect('a process identity override keeps a distinct claim owner for every hosted loop', () =>
  Effect.gen(function* distinctClaimOwners() {
    const configs = yield* parseOutboxPollingConfig({
      claimOwnerPrefixes: ['billing-outbox-worker', 'ledger-outbox-worker'],
      defaultProcessIdentity: '41:7',
      environment: { OUTBOX_WORKER_PROCESS_IDENTITY: 'stage-host-a' },
    });
    expect(configs.map(({ claimOwner }) => claimOwner)).toEqual([
      'billing-outbox-worker:stage-host-a',
      'ledger-outbox-worker:stage-host-a',
    ]);
  }),
);

it.effect('rejects invalid polling values instead of falling back to a busy loop', () =>
  Effect.gen(function* invalidPollingConfiguration() {
    const error = yield* Effect.flip(
      parseOutboxPollingConfig({
        claimOwnerPrefixes: ['consumer'],
        defaultProcessIdentity: '41:7',
        environment: { OUTBOX_WORKER_POLL_INTERVAL_MS: '0' },
      }),
    );
    expect(Schema.is(OutboxPollerConfigError)(error)).toBe(true);
  }),
);

it.effect('rejects an empty host and a claim owner prefix hosted twice', () =>
  Effect.gen(function* invalidHostedLoops() {
    for (const claimOwnerPrefixes of [[], ['consumer', 'consumer'], ['']]) {
      const error = yield* Effect.flip(
        parseOutboxPollingConfig({ claimOwnerPrefixes, defaultProcessIdentity: '41:7', environment: {} }),
      );
      expect(Schema.is(OutboxPollerConfigError)(error)).toBe(true);
    }
  }),
);

it.effect('runs immediately, survives a typed cycle failure, and continues polling', () =>
  Effect.gen(function* pollingContinuesAfterFailure() {
    let calls = 0;
    const healthTransitions: string[] = [];
    const runCycle: OutboxCycleRunner<typeof registration, never> = () =>
      Effect.suspend(() => {
        calls += 1;
        return calls === 1
          ? Effect.fail(
              new PersistenceFailure({
                cause: 'controlled driver failure',
                reason: 'controlled test failure',
              }),
            )
          : Effect.succeed(emptyResult);
      });
    const running = yield* runOutboxPollingLoop(
      {
        admitComposition: Effect.succeed('a'.repeat(64)),
        config: {
          claimOwner: 'consumer:test',
          maxDeliveries: 10,
          pollIntervalMs: 10,
        },
        health: {
          cycleFailed: Effect.sync(() => healthTransitions.push('failed')),
          cycleSucceeded: Effect.sync(() => healthTransitions.push('ready')),
        },
        registrations: [registration],
        subscriptions: [registration.descriptor],
      },
      runCycle,
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust('20 millis');
    yield* Fiber.interrupt(running);
    expect(calls, 'polling loop did not continue').toBe(3);
    expect(healthTransitions).toEqual(['failed', 'ready', 'ready']);
  }).pipe(Effect.scoped),
);

it.effect('admits every new cycle while preserving the revision already supplied to an earlier cycle', () =>
  Effect.gen(function* renewedCycleAdmission() {
    const firstCycle = yield* Deferred.make<null>();
    const cycleInputs: { readonly compositionRevision: string }[] = [];
    let admissions = 0;
    let activeRevision = 'a'.repeat(64);
    const runCycle: OutboxCycleRunner<typeof registration, never> = (input) =>
      Effect.sync(() => {
        cycleInputs.push(input);
        return emptyResult;
      }).pipe(Effect.tap(() => Deferred.succeed(firstCycle, null)));
    const running = yield* runOutboxPollingLoop(
      {
        admitComposition: Effect.sync(() => {
          admissions += 1;
          return activeRevision;
        }),
        config: { claimOwner: 'consumer:test', maxDeliveries: 10, pollIntervalMs: 10 },
        registrations: [registration],
        subscriptions: [registration.descriptor],
      },
      runCycle,
    ).pipe(Effect.forkChild);

    yield* Deferred.await(firstCycle);
    activeRevision = 'b'.repeat(64);
    yield* TestClock.adjust('20 millis');
    yield* Fiber.interrupt(running);

    expect(admissions).toBe(3);
    expect(cycleInputs.map(({ compositionRevision }) => compositionRevision)).toEqual([
      'a'.repeat(64),
      'b'.repeat(64),
      'b'.repeat(64),
    ]);
  }),
);

it.effect('does not claim during unavailable admission and marks the next admitted cycle healthy', () =>
  Effect.gen(function* noClaimBeforeAdmission() {
    let admissions = 0;
    let cycles = 0;
    const healthTransitions: string[] = [];
    const runCycle: OutboxCycleRunner<typeof registration, never> = ({ compositionRevision }) =>
      Effect.sync(() => {
        expect(compositionRevision).toBe('a'.repeat(64));
        cycles += 1;
        return emptyResult;
      });
    const running = yield* runOutboxPollingLoop(
      {
        admitComposition: Effect.suspend(() => {
          admissions += 1;
          return admissions === 1
            ? Effect.fail(
                new ActiveApplicationCompositionUnavailableError({ reason: 'controlled unavailable authority' }),
              )
            : Effect.succeed('a'.repeat(64));
        }),
        config: { claimOwner: 'consumer:test', maxDeliveries: 10, pollIntervalMs: 10 },
        health: {
          cycleFailed: Effect.sync(() => healthTransitions.push('failed')),
          cycleSucceeded: Effect.sync(() => healthTransitions.push('ready')),
        },
        registrations: [registration],
        subscriptions: [registration.descriptor],
      },
      runCycle,
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust('20 millis');
    yield* Fiber.interrupt(running);

    expect(admissions).toBe(3);
    expect(cycles).toBe(2);
    expect(healthTransitions).toEqual(['failed', 'ready', 'ready']);
  }),
);
