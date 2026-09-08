import { expect, it } from 'effect-rstest';
import { Context, Effect, Option, Schema } from 'effect';
import { defineOutboxWorker } from '../../src/outbox/definition.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { OutboxWorkerHandler, OutboxWorkerRegistration } from '../../src/outbox/definition.ts';
import { OutboxClaimLostError, OutboxWorkerDescriptorError } from '../../src/outbox/errors.ts';
import type {
  OutboxClaim,
  OutboxFailureStatus,
  OutboxRepositoryService,
} from '../../src/outbox/repository.ts';
import { makeOutboxRuntime } from '../../src/outbox/runtime.ts';

const TestHandlerFailureContract = Schema.TaggedStruct('TestHandlerFailure', {
  reason: Schema.String,
});
type TestHandlerFailureSelf = typeof TestHandlerFailureContract.Type;
const TestHandlerFailure = Schema.TaggedError<TestHandlerFailureSelf>()('TestHandlerFailure', {
  reason: Schema.String,
});

class TestWorkerDependency extends Context.Service<
  TestWorkerDependency,
  { readonly record: (messageId: string) => void }
>()('@app/core-runtime/tests/unit/outbox-runtime.test/TestWorkerDependency') {}

const MessageKey = Schema.String.pipe(Schema.brand('MessageKey'));

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
  handler: OutboxWorkerHandler<
    { readonly messageKey: typeof MessageKey.Type },
    HandlerError,
    HandlerRequirements
  >,
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
      payloadSchema: Schema.Struct({ messageKey: MessageKey }),
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
      claimNext: () => Effect.succeed(Option.fromNullishOr(claims.shift())),
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
  Schema.ConstraintDecoder<unknown>,
  string,
  string,
  unknown
>;

interface WorkerInvocation {
  readonly context: Parameters<OutboxWorkerHandler<{ readonly messageKey: string }, never>>[1];
  readonly payload: { readonly messageKey: string };
}

const run = (
  service: OutboxRepositoryService,
  registration: NoRequirementsWorker = worker(() => Effect.void),
) =>
  makeOutboxRuntime(service).runCycle({
    claimOwner: 'unit-runtime',
    registrations: [registration],
    subscriptions: [registration.descriptor],
  });

it.effect('owner-local cycles do not perform global matching', () =>
  Effect.gen(function* ownerLocalCycle() {
    const controlled = repository({ match: { deliveriesCreated: 0, messagesMatched: 2 } });

    expect(yield* run(controlled.service)).toEqual({
      claimed: 0,
      dead: 0,
      deliveriesCreated: 0,
      failed: 0,
      messagesMatched: 0,
      retried: 0,
      succeeded: 0,
    });
    expect(controlled.probe.completed).toEqual([]);
    expect(controlled.probe.failed).toEqual([]);
  }),
);

it.effect('matches messages only through the explicit Core matcher snapshot', () =>
  Effect.gen(function* explicitMatcherSnapshot() {
    const controlled = repository({ match: { deliveriesCreated: 3, messagesMatched: 2 } });
    const registration = worker(() => Effect.void);
    const result = yield* makeOutboxRuntime(controlled.service).matchMessages({
      subscriptions: [registration.descriptor],
    });

    expect(result).toEqual({ deliveriesCreated: 3, messagesMatched: 2 });
  }),
);

it.effect('rejects an owner-local worker missing from the installed subscription catalog', () =>
  Effect.gen(function* missingInstalledSubscription() {
    const controlled = repository();
    const registration = worker(() => Effect.void);
    const error = yield* Effect.flip(
      makeOutboxRuntime(controlled.service).runCycle({
        claimOwner: 'unit-runtime',
        registrations: [registration],
        subscriptions: [],
      }),
    );

    expect(Schema.is(OutboxWorkerDescriptorError)(error)).toBe(true);
    expect(error.reason).toMatch(/absent from the installed subscription catalog/u);
  }),
);

it.effect('rejects deployed owner descriptors without a matching local worker registration', () =>
  Effect.gen(function* missingLocalRegistration() {
    const controlled = repository();
    const registration = worker(() => Effect.void);
    const error = yield* Effect.flip(
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
    );

    expect(Schema.is(OutboxWorkerDescriptorError)(error)).toBe(true);
    expect(error.reason).toMatch(/contradicts its deployed descriptor snapshot/u);
  }),
);

it.effect('decodes a published payload, supplies exact context, and completes success', () =>
  Effect.gen(function* successfulDelivery() {
    const selected = claim();
    const controlled = repository({ claims: [selected] });
    let observed: WorkerInvocation | undefined;
    const registration = worker((payload, context) =>
      Effect.sync(() => {
        observed = { context, payload };
      }),
    );

    const result = yield* run(controlled.service, registration);

    expect(result.succeeded).toBe(1);
    expect(controlled.probe.completed).toEqual([selected]);
    expect(controlled.probe.failed).toEqual([]);
    expect(observed).toEqual({
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
  }),
);

it.effect('runs a worker with Effect services provided by its owning MicroVertical host', () =>
  Effect.gen(function* ownerProvidedServices() {
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
        payloadSchema: Schema.Struct({ messageKey: MessageKey }),
        producerModuleKey: 'producer',
        retryPolicy,
        topic: 'producer.message-created',
        workerKey: 'consumer.layered-logger',
      },
      (_payload, context) =>
        TestWorkerDependency.pipe(
          Effect.flatMap(({ record }) => Effect.sync(() => record(context.messageId))),
        ),
    );

    const result = yield* makeOutboxRuntime(controlled.service)
      .runCycle({
        claimOwner: 'unit-runtime',
        registrations: [registration],
        subscriptions: [registration.descriptor],
      })
      .pipe(
        Effect.provideService(TestWorkerDependency, {
          record: (messageId) => observed.push(messageId),
        }),
      );

    expect(result.succeeded).toBe(1);
    expect(observed).toEqual(['message-1']);
  }),
);

it.effect('records decode failures as retries without calling the handler or completion', () =>
  Effect.gen(function* decodeFailure() {
    const controlled = repository({
      claims: [claim(1, { messageKey: 42 })],
      failureStatuses: ['pending'],
    });
    let calls = 0;

    const result = yield* run(
      controlled.service,
      worker(() => Effect.sync(() => (calls += 1))),
    );

    expect(calls).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.retried).toBe(1);
    expect(controlled.probe.completed).toEqual([]);
    expect(controlled.probe.failed[0]?.message).toBe(
      'The Outbox Message payload does not match its published schema',
    );
  }),
);

it.effect('classifies declared failures, defects, retry exhaustion, and never completes them', () =>
  Effect.gen(function* failureClassification() {
    const declared = repository({ claims: [claim()], failureStatuses: ['pending'] });
    const declaredResult = yield* run(
      declared.service,
      worker(() => Effect.fail(new TestHandlerFailure({ reason: 'secret typed detail' }))),
    );
    expect(declaredResult.retried).toBe(1);
    expect(declared.probe.failed[0]?.message).toBe(
      'The Outbox Worker handler returned a declared failure',
    );

    const defect = repository({ claims: [claim(2)], failureStatuses: ['dead'] });
    const defectResult = yield* run(
      defect.service,
      worker(() => Effect.die(new Error('database password must not be stored'))),
    );
    expect(defectResult.dead).toBe(1);
    expect(defect.probe.failed[0]?.message).toBe('The Outbox Worker handler failed unexpectedly');
    expect(defect.probe.failed[0]?.message ?? '').not.toMatch(/password/u);
    expect(declared.probe.completed).toEqual([]);
    expect(defect.probe.completed).toEqual([]);
  }),
);

it.effect(
  'surfaces stale-claim finalization and leaves checkpoint responsibility with the repository',
  () =>
    Effect.gen(function* staleClaimFinalization() {
      const controlled = repository({
        claims: [claim()],
        completeError: new OutboxClaimLostError({
          code: 'outbox_claim_lost',
          reason: 'stale test claim',
        }),
      });

      const error = yield* Effect.flip(run(controlled.service));
      expect(Schema.is(OutboxClaimLostError)(error)).toBe(true);
      expect(controlled.probe.failed).toEqual([]);
    }),
);
