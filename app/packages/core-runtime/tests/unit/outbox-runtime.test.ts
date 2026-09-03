/* eslint-disable max-classes-per-file, unicorn/no-array-method-this-argument -- Test-local typed failures and Effect's dual flatMap API are deliberate. */
// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { Context, Effect, Schema } from 'effect';
import { defineOutboxWorker } from '../../src/outbox/definition.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { OutboxWorkerHandler, OutboxWorkerRegistration } from '../../src/outbox/definition.ts';
import { OutboxClaimLostError } from '../../src/outbox/errors.ts';
import type {
  OutboxClaim,
  OutboxFailureStatus,
  OutboxRepositoryService,
} from '../../src/outbox/repository.ts';
import { makeOutboxRuntime } from '../../src/outbox/runtime.ts';

class TestHandlerFailure extends Schema.TaggedError<TestHandlerFailure>()('TestHandlerFailure', {
  reason: Schema.String,
}) {}

class TestWorkerDependency extends Context.Service<
  TestWorkerDependency,
  { readonly record: (messageId: string) => void }
>()('@app/core-runtime/tests/unit/outbox-runtime.test/TestWorkerDependency') {}

const retryPolicy = {
  initialBackoffMs: 0,
  maxAttempts: 2,
  maxBackoffMs: 0,
  multiplier: 1,
} as const;

const claim = (attemptNumber = 1, payloadJson?: OutboxClaim['payloadJson']): OutboxClaim => ({
  attemptId: `attempt-${attemptNumber}`,
  attemptNumber,
  claimId: `runtime:claim-${attemptNumber}`,
  consumerModuleKey: 'consumer',
  correlationId: 'correlation-1',
  deliveryId: 'delivery-1',
  domainEventId: 'event-1',
  messageId: 'message-1',
  payloadJson: payloadJson === undefined ? { messageKey: 'message-1' } : payloadJson,
  producerModuleKey: 'producer',
  retryPolicy,
  tenantId: 'tenant-1',
  tenantSequenceNo: 7n,
  topic: 'producer.message-created',
  workerKey: 'consumer.logger',
});

const worker = <HandlerError, HandlerRequirements = never>(
  handler: OutboxWorkerHandler<{ readonly messageKey: string }, HandlerError, HandlerRequirements>,
) =>
  defineOutboxWorker(
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
      payloadSchema: Schema.Struct({ messageKey: Schema.String }),
      producerModuleKey: 'producer',
      retryPolicy,
      topic: 'producer.message-created',
      workerKey: 'consumer.logger',
    },
    handler,
  );

interface RepositoryProbe {
  readonly completed: OutboxClaim[];
  readonly failed: { readonly claim: OutboxClaim; readonly message: string }[];
}

interface ControlledRepository {
  readonly probe: RepositoryProbe;
  readonly service: OutboxRepositoryService;
}

const repository = (
  options: {
    readonly claims?: readonly OutboxClaim[];
    readonly completeError?: OutboxClaimLostError;
    readonly failureStatuses?: readonly OutboxFailureStatus[];
    readonly match?: { readonly deliveriesCreated: number; readonly messagesMatched: number };
  } = {},
): ControlledRepository => {
  const claims = [...(options.claims ?? [])];
  const failureStatuses = [...(options.failureStatuses ?? [])];
  const probe: RepositoryProbe = { completed: [], failed: [] };
  return {
    probe,
    service: {
      claimNext: () => Effect.succeed(claims.shift() ?? null),
      complete: (claimed) => {
        if (options.completeError !== undefined) {
          return Effect.fail(options.completeError);
        }
        return Effect.sync(() => probe.completed.push(claimed)).pipe(Effect.asVoid);
      },
      fail: (claimed, message) =>
        Effect.sync(() => {
          probe.failed.push({ claim: claimed, message });
          return failureStatuses.shift() ?? 'pending';
        }),
      matchUnmatched: () =>
        Effect.succeed(options.match ?? { deliveriesCreated: 0, messagesMatched: 0 }),
    },
  };
};

type NoRequirementsWorker = OutboxWorkerRegistration<
  Schema.ConstraintDecoder<unknown, never>,
  string,
  string,
  unknown,
  never
>;

interface WorkerInvocation {
  readonly context: Parameters<
    OutboxWorkerHandler<{ readonly messageKey: string }, never, never>
  >[1];
  readonly payload: { readonly messageKey: string };
}

const run = (
  service: OutboxRepositoryService,
  registration: NoRequirementsWorker = worker(() => Effect.void),
) =>
  Effect.runPromise(
    makeOutboxRuntime(service).runCycle({
      claimOwner: 'unit-runtime',
      registrations: [registration],
      subscriptions: [registration.descriptor],
    }),
  );

test('owner-local cycles do not perform global matching', async () => {
  const controlled = repository({ match: { deliveriesCreated: 0, messagesMatched: 2 } });

  assert.deepEqual(await run(controlled.service), {
    claimed: 0,
    dead: 0,
    deliveriesCreated: 0,
    failed: 0,
    messagesMatched: 0,
    retried: 0,
    succeeded: 0,
  });
  assert.deepEqual(controlled.probe.completed, []);
  assert.deepEqual(controlled.probe.failed, []);
});

test('matches messages only through the explicit Core matcher snapshot', async () => {
  const controlled = repository({ match: { deliveriesCreated: 3, messagesMatched: 2 } });
  const registration = worker(() => Effect.void);
  const result = await Effect.runPromise(
    makeOutboxRuntime(controlled.service).matchMessages({
      subscriptions: [registration.descriptor],
    }),
  );

  assert.deepEqual(result, { deliveriesCreated: 3, messagesMatched: 2 });
});

test('rejects an owner-local worker missing from the installed subscription catalog', async () => {
  const controlled = repository();
  const registration = worker(() => Effect.void);
  await assert.rejects(
    Effect.runPromise(
      makeOutboxRuntime(controlled.service).runCycle({
        claimOwner: 'unit-runtime',
        registrations: [registration],
        subscriptions: [],
      }),
    ),
    (error: { readonly _tag?: string; readonly reason?: string }) =>
      error._tag === 'OutboxWorkerDescriptorError' &&
      /absent from the installed subscription catalog/u.test(error.reason ?? ''),
  );
});

test('rejects deployed owner descriptors without a matching local worker registration', async () => {
  const controlled = repository();
  const registration = worker(() => Effect.void);
  await assert.rejects(
    Effect.runPromise(
      makeOutboxRuntime(controlled.service).runCycle({
        claimOwner: 'unit-runtime',
        registrations: [registration],
        subscriptions: [
          registration.descriptor,
          {
            ...registration.descriptor,
            entrypoint: defineTenantModuleEntrypoint({
              access: 'background',
              authorization: { kind: 'owner_local_background' },
              entrypointKey: 'consumer.second-worker',
              moduleKey: registration.descriptor.consumerModuleKey,
              role: 'worker',
            }),
            workerKey: 'consumer.second-worker',
          },
        ],
      }),
    ),
    (error: { readonly _tag?: string; readonly reason?: string }) =>
      error._tag === 'OutboxWorkerDescriptorError' &&
      /contradicts its deployed descriptor snapshot/u.test(error.reason ?? ''),
  );
});

test('decodes a published payload, supplies exact context, and completes success', async () => {
  const selected = claim();
  const controlled = repository({ claims: [selected] });
  let observed: WorkerInvocation | undefined;
  const registration = worker((payload, context) =>
    Effect.sync(() => {
      observed = { context, payload };
    }),
  );

  const result = await run(controlled.service, registration);

  assert.equal(result.succeeded, 1);
  assert.deepEqual(controlled.probe.completed, [selected]);
  assert.deepEqual(controlled.probe.failed, []);
  assert.deepEqual(observed, {
    context: {
      attemptNumber: 1,
      claimId: 'runtime:claim-1',
      correlationId: 'correlation-1',
      deliveryId: 'delivery-1',
      domainEventId: 'event-1',
      messageId: 'message-1',
      producerModuleKey: 'producer',
      tenantId: 'tenant-1',
      tenantSequenceNo: 7n,
      topic: 'producer.message-created',
      workerKey: 'consumer.logger',
    },
    payload: { messageKey: 'message-1' },
  });
});

test('runs a worker with Effect services provided by its owning MicroVertical host', async () => {
  const selected = { ...claim(), workerKey: 'consumer.layered-logger' };
  const controlled = repository({ claims: [selected] });
  const observed: string[] = [];
  const registration = defineOutboxWorker(
    {
      consumerModuleKey: 'consumer',
      entrypoint: defineTenantModuleEntrypoint({
        access: 'background',
        authorization: { kind: 'owner_local_background' },
        entrypointKey: 'consumer.layered-logger',
        moduleKey: 'consumer',
        role: 'worker',
      }),
      leaseDurationMs: 30_000,
      payloadSchema: Schema.Struct({ messageKey: Schema.String }),
      producerModuleKey: 'producer',
      retryPolicy,
      topic: 'producer.message-created',
      workerKey: 'consumer.layered-logger',
    },
    (_payload, context) =>
      Effect.flatMap(TestWorkerDependency, ({ record }) =>
        Effect.sync(() => record(context.messageId)),
      ),
  );

  const result = await Effect.runPromise(
    makeOutboxRuntime(controlled.service)
      .runCycle({
        claimOwner: 'unit-runtime',
        registrations: [registration],
        subscriptions: [registration.descriptor],
      })
      .pipe(
        Effect.provideService(TestWorkerDependency, {
          record: (messageId) => observed.push(messageId),
        }),
      ),
  );

  assert.equal(result.succeeded, 1);
  assert.deepEqual(observed, ['message-1']);
});

test('records decode failures as retries without calling the handler or completion', async () => {
  const controlled = repository({
    claims: [claim(1, { messageKey: 42 })],
    failureStatuses: ['pending'],
  });
  let calls = 0;

  const result = await run(
    controlled.service,
    worker(() => Effect.sync(() => (calls += 1))),
  );

  assert.equal(calls, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.retried, 1);
  assert.deepEqual(controlled.probe.completed, []);
  assert.equal(
    controlled.probe.failed[0]?.message,
    'The Outbox Message payload does not match its published schema',
  );
});

test('classifies declared failures, defects, retry exhaustion, and never completes them', async () => {
  const declared = repository({ claims: [claim()], failureStatuses: ['pending'] });
  const declaredResult = await run(
    declared.service,
    worker(() => Effect.fail(new TestHandlerFailure({ reason: 'secret typed detail' }))),
  );
  assert.equal(declaredResult.retried, 1);
  assert.equal(
    declared.probe.failed[0]?.message,
    'The Outbox Worker handler returned a declared failure',
  );

  const defect = repository({ claims: [claim(2)], failureStatuses: ['dead'] });
  const defectResult = await run(
    defect.service,
    worker(() => Effect.die(new Error('database password must not be stored'))),
  );
  assert.equal(defectResult.dead, 1);
  assert.equal(defect.probe.failed[0]?.message, 'The Outbox Worker handler failed unexpectedly');
  assert.doesNotMatch(defect.probe.failed[0]?.message ?? '', /password/u);
  assert.deepEqual(declared.probe.completed, []);
  assert.deepEqual(defect.probe.completed, []);
});

test('surfaces stale-claim finalization and leaves checkpoint responsibility with the repository', async () => {
  const controlled = repository({
    claims: [claim()],
    completeError: new OutboxClaimLostError({
      code: 'outbox_claim_lost',
      reason: 'stale test claim',
    }),
  });

  await assert.rejects(
    run(controlled.service),
    (error: { readonly _tag?: string }) => error._tag === 'OutboxClaimLostError',
  );
  assert.deepEqual(controlled.probe.failed, []);
});
