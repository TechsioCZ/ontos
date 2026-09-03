// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off processEnv:off
/* eslint-disable promise/avoid-new, promise/param-names -- Controlled promises coordinate and bound the long-running test fiber. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { defineOutboxWorker } from '../../src/outbox/definition.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { OutboxPersistenceError } from '../../src/outbox/errors.ts';
import { parseOutboxPollingConfig, runOutboxPollingLoop } from '../../src/outbox/poller.ts';
import type { OutboxCycleRunner } from '../../src/outbox/poller.ts';

const registration = defineOutboxWorker(
  {
    consumerModuleKey: 'consumer',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'background',
      entrypointKey: 'consumer.logger',
      moduleKey: 'consumer',
      role: 'worker',
    }),
    leaseDurationMs: 30_000,
    payloadSchema: Schema.Struct({ messageKey: Schema.String }),
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

test('uses safe one-second defaults and accepts bounded scalar overrides', async () => {
  assert.deepEqual(
    await Effect.runPromise(
      parseOutboxPollingConfig({ defaultClaimOwner: 'consumer:default', environment: {} }),
    ),
    {
      claimOwner: 'consumer:default',
      maxDeliveries: 100,
      pollIntervalMs: 1000,
    },
  );

  assert.deepEqual(
    await Effect.runPromise(
      parseOutboxPollingConfig({
        defaultClaimOwner: 'consumer:default',
        environment: {
          OUTBOX_WORKER_CLAIM_OWNER: 'consumer:configured',
          OUTBOX_WORKER_MAX_DELIVERIES: '25',
          OUTBOX_WORKER_POLL_INTERVAL_MS: '250',
        },
      }),
    ),
    {
      claimOwner: 'consumer:configured',
      maxDeliveries: 25,
      pollIntervalMs: 250,
    },
  );
});

test('rejects invalid polling values instead of falling back to a busy loop', async () => {
  await assert.rejects(
    Effect.runPromise(
      parseOutboxPollingConfig({
        defaultClaimOwner: 'consumer:default',
        environment: { OUTBOX_WORKER_POLL_INTERVAL_MS: '0' },
      }),
    ),
    (error: { readonly _tag?: string }) => error._tag === 'OutboxPollerConfigError',
  );
});

test('runs immediately, survives a typed cycle failure, and continues polling', async () => {
  let calls = 0;
  const healthTransitions: string[] = [];
  let completed!: () => void;
  const observedThreeCalls = new Promise<void>((resolve) => {
    completed = resolve;
  });
  const runCycle: OutboxCycleRunner<typeof registration, never> = () =>
    Effect.suspend(() => {
      calls += 1;
      if (calls === 3) {
        completed();
      }
      return calls === 1
        ? Effect.fail(
            new OutboxPersistenceError({
              code: 'outbox_persistence_failed',
              reason: 'controlled test failure',
            }),
          )
        : Effect.succeed(emptyResult);
    });
  const controller = new AbortController();
  const running = Effect.runPromise(
    runOutboxPollingLoop(
      {
        config: { claimOwner: 'consumer:test', maxDeliveries: 10, pollIntervalMs: 10 },
        health: {
          cycleFailed: Effect.sync(() => healthTransitions.push('failed')),
          cycleSucceeded: Effect.sync(() => healthTransitions.push('ready')),
        },
        registrations: [registration],
        subscriptions: [registration.descriptor],
      },
      runCycle,
    ),
    { signal: controller.signal },
  );

  await Promise.race([
    observedThreeCalls,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('polling loop did not continue')), 1000);
    }),
  ]);
  controller.abort();
  await assert.rejects(running);
  assert.ok(calls >= 3);
  assert.deepEqual(healthTransitions.slice(0, 3), ['failed', 'ready', 'ready']);
});
