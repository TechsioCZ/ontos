import assert from 'node:assert/strict';
import test from 'node:test';
import { Cause, DateTime, Effect, Exit, Schema } from 'effect';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineOutboxWorker } from '../../src/outbox/definition.ts';
import { OutboxPollerConfigError, OutboxWorkerDescriptorError } from '../../src/outbox/errors.ts';
import { parseOutboxPollingConfig, runOutboxPollingLoop } from '../../src/outbox/poller.ts';
import type { OutboxRepositoryService } from '../../src/outbox/repository.ts';
import { makeOutboxRuntime } from '../../src/outbox/runtime.ts';

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
    leaseDurationMs: 1000,
    payloadSchema: Schema.String,
    producerModuleKey: 'producer',
    retryPolicy: { initialBackoffMs: 0, maxAttempts: 1, maxBackoffMs: 0, multiplier: 1 },
    topic: 'producer.message-created',
    workerKey: 'consumer.logger',
  },
  () => Effect.void,
);
const cycleInput = {
  claimOwner: 'runtime',
  now: DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T00:00:00Z')),
  registrations: [registration],
  subscriptions: [registration.descriptor],
};
const unexpectedRepositoryCall = () => Effect.die(new Error('validation reached persistence'));
const repository: OutboxRepositoryService = {
  claimNext: unexpectedRepositoryCall,
  complete: unexpectedRepositoryCall,
  fail: unexpectedRepositoryCall,
  matchUnmatched: unexpectedRepositoryCall,
};
const runtime = makeOutboxRuntime(repository);

const invalidDate = () => {
  const date = DateTime.toDateUtc(DateTime.makeUnsafe(0));
  date.setTime(Number.NaN);
  return date;
};

const assertFailure = <Value, Error>(
  effect: Effect.Effect<Value, Error>,
  reason: string,
  kind: 'descriptor' | 'poller' = 'descriptor',
) => {
  const exit = Effect.runSyncExit(effect);
  assert.ok(Exit.isFailure(exit));
  const failure = Cause.findErrorOption(exit.cause);
  assert.equal(failure._tag, 'Some');
  if (failure._tag === 'Some') {
    assert.ok(
      Schema.is(Schema.Union([OutboxWorkerDescriptorError, OutboxPollerConfigError]))(
        failure.value,
      ),
    );
    assert.equal(
      failure.value._tag,
      kind === 'descriptor' ? 'OutboxWorkerDescriptorError' : 'OutboxPollerConfigError',
    );
    assert.equal(
      failure.value.code,
      `outbox_${kind === 'descriptor' ? 'worker_descriptor' : 'poller_config'}_invalid`,
    );
    assert.equal(failure.value.reason, reason);
  }
};

const assertDefect = <Value, Error>(effect: Effect.Effect<Value, Error>, defect: unknown) => {
  const exit = Effect.runSyncExit(effect);
  assert.ok(Exit.isFailure(exit));
  assert.equal(Cause.findErrorOption(exit.cause)._tag, 'None');
  const found = Cause.findDefect(exit.cause);
  assert.equal(found._tag, 'Success');
  if (found._tag === 'Success') {
    assert.equal(found.success, defect);
  }
};

void test('cycle validation retains order, exact reasons, and rejects before persistence', () => {
  for (const claimOwner of ['', '   ', 'x'.repeat(201)]) {
    assertFailure(
      runtime.runCycle({ ...cycleInput, claimOwner, maxDeliveries: 0, now: invalidDate() }),
      'claimOwner must be a non-empty stable runtime identity',
    );
  }
  for (const maxDeliveries of [0, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertFailure(
      runtime.runCycle({ ...cycleInput, maxDeliveries, now: invalidDate() }),
      'maxDeliveries must be an integer from 1 through 1000',
    );
  }
  assertFailure(
    runtime.runCycle({
      ...cycleInput,
      now: invalidDate(),
      registrations: [registration, registration],
    }),
    'now must be a valid timestamp',
  );
  assertFailure(
    runtime.runCycle({
      ...cycleInput,
      registrations: [registration, registration],
      subscriptions: [{ ...registration.descriptor, topic: 'invalid' }],
    }),
    'duplicate Outbox Worker key consumer.logger',
  );
});

void test('foreign descriptor validation keeps installed versus deployed classifications and order', () => {
  const subscriptions = [{ ...registration.descriptor, topic: 'invalid' }];
  assertFailure(
    runtime.runCycle({ ...cycleInput, subscriptions }),
    'The deployed subscription snapshot is invalid',
  );
  assertFailure(
    runtime.matchMessages({ subscriptions, now: invalidDate() }),
    'The installed subscription snapshot is invalid',
  );
  assertFailure(
    runtime.matchMessages({ subscriptions: cycleInput.subscriptions, now: invalidDate() }),
    'now must be a valid timestamp',
  );
});

void test('cycle boundaries and defaults reach the repository unchanged', () => {
  const seen: { readonly owner: string; readonly now: Date }[] = [];
  const acceptingRuntime = makeOutboxRuntime({
    ...repository,
    claimNext: (_registrations, owner, now) =>
      Effect.sync(() => {
        seen.push({ owner, now });
        return null;
      }),
  });
  for (const maxDeliveries of [1, 1000]) {
    Effect.runSync(
      acceptingRuntime.runCycle({ ...cycleInput, claimOwner: 'x'.repeat(200), maxDeliveries }),
    );
  }
  Effect.runSync(acceptingRuntime.runCycle(cycleInput));
  assert.deepEqual(seen, [
    { owner: 'x'.repeat(200), now: cycleInput.now },
    { owner: 'x'.repeat(200), now: cycleInput.now },
    { owner: 'runtime', now: cycleInput.now },
  ]);
});

void test('unexpected validation defects are never reclassified as descriptor failures', () => {
  const defect = new Error('broken accessor');
  const brokenRegistration = new Proxy(registration, {
    get() {
      throw defect;
    },
  });
  const brokenSubscription = new Proxy(registration.descriptor, {
    get() {
      throw defect;
    },
  });
  assertDefect(runtime.runCycle({ ...cycleInput, registrations: [brokenRegistration] }), defect);
  assertDefect(runtime.runCycle({ ...cycleInput, subscriptions: [brokenSubscription] }), defect);
  assertDefect(runtime.matchMessages({ subscriptions: [brokenSubscription] }), defect);
  const brokenDate = DateTime.toDateUtc(DateTime.makeUnsafe(0));
  brokenDate.getTime = () => {
    throw defect;
  };
  assertDefect(runtime.runCycle({ ...cycleInput, now: brokenDate }), defect);
});

void test('poller config preserves scalar grammar, ordered failures, defaults and bounds', () => {
  const parse = (
    environment: Readonly<Record<string, string | undefined>>,
    defaultClaimOwner = 'default',
  ) => parseOutboxPollingConfig({ defaultClaimOwner, environment });
  for (const defaultClaimOwner of ['', 'x'.repeat(201)]) {
    assertFailure(
      parse({ OUTBOX_WORKER_MAX_DELIVERIES: '0' }, defaultClaimOwner),
      'OUTBOX_WORKER_CLAIM_OWNER must contain from 1 through 200 characters',
      'poller',
    );
  }
  for (const value of ['0', '1001', '-1', '+1', '1.5', '1e2', '9007199254740992']) {
    assertFailure(
      parse({ OUTBOX_WORKER_MAX_DELIVERIES: value, OUTBOX_WORKER_POLL_INTERVAL_MS: '0' }),
      'OUTBOX_WORKER_MAX_DELIVERIES must be an integer from 1 through 1000',
      'poller',
    );
  }
  for (const value of ['9', '3600001', '-10', '10.5', 'Infinity', '9007199254740992']) {
    assertFailure(
      parse({ OUTBOX_WORKER_POLL_INTERVAL_MS: value }),
      'OUTBOX_WORKER_POLL_INTERVAL_MS must be an integer from 10 through 3600000',
      'poller',
    );
  }
  assert.deepEqual(
    Effect.runSync(
      parse({
        OUTBOX_WORKER_CLAIM_OWNER: ' ',
        OUTBOX_WORKER_MAX_DELIVERIES: ' ',
        OUTBOX_WORKER_POLL_INTERVAL_MS: '',
      }),
    ),
    { claimOwner: 'default', maxDeliveries: 100, pollIntervalMs: 1000 },
  );
  for (const [maxDeliveries, pollIntervalMs] of [
    [1, 10],
    [1000, 3_600_000],
  ] as const) {
    const config = Effect.runSync(
      parse({
        OUTBOX_WORKER_CLAIM_OWNER: ` ${'x'.repeat(200)} `,
        OUTBOX_WORKER_MAX_DELIVERIES: ` 0${maxDeliveries} `,
        OUTBOX_WORKER_POLL_INTERVAL_MS: String(pollIntervalMs),
      }),
    );
    assert.deepEqual(config, { claimOwner: 'x'.repeat(200), maxDeliveries, pollIntervalMs });
    assert.ok(Object.isFrozen(config));
  }
  const defect = new Error('broken environment');
  assertDefect(
    parse(
      new Proxy(
        {},
        {
          get() {
            throw defect;
          },
        },
      ),
    ),
    defect,
  );
});

void test('poller interruption and defects bypass failure recovery and health transitions', () => {
  let transitions = 0;
  const input = {
    config: { claimOwner: 'runtime', maxDeliveries: 1, pollIntervalMs: 10 },
    health: {
      cycleFailed: Effect.sync(() => {
        transitions += 1;
      }),
      cycleSucceeded: Effect.sync(() => {
        transitions += 1;
      }),
    },
    registrations: [registration],
    subscriptions: [registration.descriptor],
  };
  const exit = Effect.runSyncExit(runOutboxPollingLoop(input, () => Effect.interrupt));
  assert.ok(Exit.isFailure(exit));
  assert.ok(Cause.hasInterruptsOnly(exit.cause));
  const defect = new Error('broken cycle');
  assertDefect(
    runOutboxPollingLoop(input, () => Effect.die(defect)),
    defect,
  );
  assert.equal(transitions, 0);
});
