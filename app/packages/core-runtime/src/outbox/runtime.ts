/* oxlint-disable sonarjs/no-inverted-boolean-check -- Existing compatibility boundary; expires: 2026-12-31. */
/* eslint-disable unicorn/no-array-method-this-argument -- Effect's dual flatMap API is intentional. expires: 2026-12-31. */
// @effect-diagnostics effectFnOpportunity:off globalDateInEffect:off instanceOfSchema:off -- Existing compatibility boundary; expires: 2026-12-31.
import { Context, DateTime, Effect, Exit, Layer, Option, Schema } from 'effect';
import type {
  AnyOutboxWorkerRegistration,
  OutboxWorkerHandlerContext,
  OutboxWorkerRequirements,
  OutboxWorkerSubscription,
} from './definition.ts';
import {
  getOutboxWorkerHandler,
  attestOutboxWorkerHandlerContext,
  validateOutboxWorkerRegistrations,
  validateOutboxWorkerSubscriptions,
} from './definition.ts';
import {
  OutboxHandlerExecutionError,
  OutboxPayloadDecodeError,
  OutboxPersistenceError,
  OutboxWorkerDescriptorError,
} from './errors.ts';
import type { OutboxClaimLostError } from './errors.ts';
import { OutboxRepository } from './repository.ts';
import type { OutboxClaim, OutboxRepositoryService as OutboxRepositoryPort } from './repository.ts';

const withOptionalProperty = <
  Base extends object,
  Key extends PropertyKey,
  Value,
  Trailing extends object,
>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

export interface RunOutboxCycleInput<
  Registration extends AnyOutboxWorkerRegistration = AnyOutboxWorkerRegistration,
> {
  readonly claimOwner: string;
  readonly maxDeliveries?: number;
  readonly now?: Date;
  readonly registrations: readonly Registration[];
  readonly subscriptions: readonly OutboxWorkerSubscription[];
}

export interface MatchOutboxMessagesInput {
  readonly now?: Date;
  readonly subscriptions: readonly OutboxWorkerSubscription[];
}

export interface OutboxMatchResult {
  readonly deliveriesCreated: number;
  readonly messagesMatched: number;
}

export interface OutboxCycleResult {
  readonly claimed: number;
  readonly dead: number;
  readonly deliveriesCreated: number;
  readonly failed: number;
  readonly messagesMatched: number;
  readonly retried: number;
  readonly succeeded: number;
}

export type OutboxCycleError =
  | OutboxClaimLostError
  | OutboxPersistenceError
  | OutboxWorkerDescriptorError;

export interface OutboxRuntimeService {
  readonly matchMessages: (
    input: MatchOutboxMessagesInput,
  ) => Effect.Effect<OutboxMatchResult, OutboxPersistenceError | OutboxWorkerDescriptorError>;
  readonly runCycle: <Registration extends AnyOutboxWorkerRegistration>(
    input: RunOutboxCycleInput<Registration>,
  ) => Effect.Effect<OutboxCycleResult, OutboxCycleError, OutboxWorkerRequirements<Registration>>;
}

const descriptorFailure = (reason: string): OutboxWorkerDescriptorError =>
  new OutboxWorkerDescriptorError({ code: 'outbox_worker_descriptor_invalid', reason });

const validateCycleInput = Effect.fn('OutboxRuntime.validateCycleInput')(
  function* validateCycleInputEffect<Registration extends AnyOutboxWorkerRegistration>(
    input: RunOutboxCycleInput<Registration>,
  ) {
    if (input.claimOwner.trim().length === 0 || input.claimOwner.length > 200) {
      return yield* descriptorFailure('claimOwner must be a non-empty stable runtime identity');
    }
    const maxDeliveries = input.maxDeliveries ?? 100;
    if (!Number.isSafeInteger(maxDeliveries) || maxDeliveries < 1 || maxDeliveries > 1000) {
      return yield* descriptorFailure('maxDeliveries must be an integer from 1 through 1000');
    }
    const now = input.now ?? (yield* DateTime.nowAsDate);
    if (Number.isNaN(now.getTime())) {
      return yield* descriptorFailure('now must be a valid timestamp');
    }
    const registrations = yield* Effect.try({
      catch: (error) =>
        error instanceof OutboxWorkerDescriptorError
          ? error
          : descriptorFailure('The Outbox Worker descriptor set is invalid'),
      try: () => validateOutboxWorkerRegistrations(input.registrations),
    });
    return {
      claimOwner: input.claimOwner,
      maxDeliveries,
      now,
      registrations,
    };
  },
);

const claimAnnotations = (claim: OutboxClaim, outcome?: string) =>
  withOptionalProperty(
    withOptionalProperty(
      {
        attempt: claim.attemptNumber,
        claimId: claim.claimId,
        consumerModuleKey: claim.consumerModuleKey,
      },
      claim.correlationId !== undefined,
      'correlationId',
      claim.correlationId,
      {
        deliveryId: claim.deliveryId,
        messageId: claim.messageId,
      },
    ),
    outcome !== undefined,
    'outcome',
    outcome,
    {
      producerModuleKey: claim.producerModuleKey,
      tenantId: claim.tenantId,
      topic: claim.topic,
      workerKey: claim.workerKey,
    },
  );

const logUnexpectedPersistence = (claim?: OutboxClaim) =>
  Effect.annotateLogs(
    Effect.logError('Unexpected Outbox persistence failure'),
    claim === undefined
      ? { outcome: 'persistence_failure' }
      : claimAnnotations(claim, 'persistence_failure'),
  );

const withOutcomeSpan = <Value, Error, Requirements>(
  effect: Effect.Effect<Value, Error, Requirements>,
  claim: OutboxClaim,
  outcome: string,
): Effect.Effect<Value, Error, Requirements> =>
  effect.pipe(
    Effect.withSpan('OutboxWorker.finalize', {
      attributes: claimAnnotations(claim, outcome),
    }),
  );

const handlerContext = (claim: OutboxClaim): OutboxWorkerHandlerContext =>
  attestOutboxWorkerHandlerContext(
    withOptionalProperty(
      {
        attemptNumber: claim.attemptNumber,
        claimId: claim.claimId,
      },
      !(claim.correlationId === undefined),
      'correlationId',
      claim.correlationId,
      {
        deliveryId: claim.deliveryId,
        domainEventId: claim.domainEventId,
        messageId: claim.messageId,
        producerModuleKey: claim.producerModuleKey,
        tenantId: claim.tenantId,
        tenantSequenceNo: claim.tenantSequenceNo,
        topic: claim.topic,
        workerKey: claim.workerKey,
      },
    ),
  );

const subscriptionMatchesRegistration = (
  subscription: OutboxWorkerSubscription | undefined,
  registration: AnyOutboxWorkerRegistration,
): boolean =>
  subscription !== undefined &&
  subscription.consumerModuleKey === registration.descriptor.consumerModuleKey &&
  subscription.entrypoint.entrypointKey === registration.descriptor.entrypoint.entrypointKey &&
  subscription.entrypoint.moduleKey === registration.descriptor.entrypoint.moduleKey &&
  subscription.entrypoint.role === registration.descriptor.entrypoint.role &&
  subscription.entrypoint.access === registration.descriptor.entrypoint.access &&
  subscription.entrypoint.scope === registration.descriptor.entrypoint.scope &&
  subscription.producerModuleKey === registration.descriptor.producerModuleKey &&
  subscription.topic === registration.descriptor.topic;

const validateDeployedRegistrationSnapshot = Effect.fn(
  'OutboxRuntime.validateDeployedRegistrationSnapshot',
)(function* validateDeployedRegistrationSnapshotEffect(
  registrations: readonly AnyOutboxWorkerRegistration[],
  subscriptions: readonly OutboxWorkerSubscription[],
) {
  const subscriptionsByKey = new Map(
    subscriptions.map((subscription) => [subscription.workerKey, subscription]),
  );
  for (const registration of registrations) {
    if (
      !subscriptionMatchesRegistration(
        subscriptionsByKey.get(registration.descriptor.workerKey),
        registration,
      )
    ) {
      return yield* descriptorFailure(
        `worker ${registration.descriptor.workerKey} is absent from the installed subscription catalog`,
      );
    }
  }
  if (subscriptions.length !== registrations.length) {
    return yield* descriptorFailure(
      'the owner-local worker registration set contradicts its deployed descriptor snapshot',
    );
  }
});

interface OutboxCycleProgress {
  readonly claimed: number;
  readonly dead: number;
  readonly failed: number;
  readonly retried: number;
  readonly stopped: boolean;
  readonly succeeded: number;
}

const initialCycleProgress = (): OutboxCycleProgress => ({
  claimed: 0,
  dead: 0,
  failed: 0,
  retried: 0,
  stopped: false,
  succeeded: 0,
});

interface OutboxCycleExecution<Registration extends AnyOutboxWorkerRegistration> {
  readonly claimOwner: string;
  readonly now: Date;
  readonly registrations: readonly Registration[];
  readonly registrationsByKey: ReadonlyMap<string, Registration>;
}

const matchMessagesWithRepository = Effect.fn('makeOutboxRuntime.matchMessages')(
  function* matchMessagesWithRepositoryEffect(
    repository: OutboxRepositoryPort,
    input: MatchOutboxMessagesInput,
  ) {
    const subscriptions = yield* Effect.try({
      catch: (error) => {
        void error;
        return descriptorFailure('The installed subscription snapshot is invalid');
      },
      try: () => validateOutboxWorkerSubscriptions(input.subscriptions),
    });
    const now = input.now ?? (yield* DateTime.nowAsDate);
    if (Number.isNaN(now.getTime())) {
      return yield* descriptorFailure('now must be a valid timestamp');
    }
    return yield* repository
      .matchUnmatched(subscriptions, now)
      .pipe(Effect.tapError(() => logUnexpectedPersistence()));
  },
);

const processNextOutboxDelivery = Effect.fn('makeOutboxRuntime.processNextDelivery')(
  function* processNextOutboxDeliveryEffect<Registration extends AnyOutboxWorkerRegistration>(
    repository: OutboxRepositoryPort,
    execution: OutboxCycleExecution<Registration>,
    state: OutboxCycleProgress,
  ) {
    const claimOption = yield* repository
      .claimNext(execution.registrations, execution.claimOwner, execution.now)
      .pipe(Effect.tapError(() => logUnexpectedPersistence()));
    if (Option.isNone(claimOption)) {
      return { ...state, stopped: true };
    }
    const claim = claimOption.value;
    const claimedState = { ...state, claimed: state.claimed + 1 };
    const registration = execution.registrationsByKey.get(claim.workerKey);
    if (registration === undefined) {
      return yield* descriptorFailure(
        `claimed delivery references unknown worker ${claim.workerKey}`,
      );
    }
    const decoded = yield* Effect.exit(
      Schema.decodeUnknownEffect(registration.descriptor.payloadSchema)(claim.payloadJson),
    );
    if (Exit.isFailure(decoded)) {
      const decodeError = new OutboxPayloadDecodeError({
        code: 'outbox_payload_invalid',
        reason: 'The Outbox Message payload does not match its published schema',
      });
      const status = yield* repository.fail(claim, decodeError.reason, execution.now).pipe(
        Effect.tapError((error) =>
          error instanceof OutboxPersistenceError ? logUnexpectedPersistence(claim) : Effect.void,
        ),
        (effect) => withOutcomeSpan(effect, claim, 'payload_decode_failure'),
      );
      return {
        ...claimedState,
        dead: claimedState.dead + (status === 'dead' ? 1 : 0),
        failed: claimedState.failed + 1,
        retried: claimedState.retried + (status === 'pending' ? 1 : 0),
      };
    }

    const handler = getOutboxWorkerHandler(registration);
    const handlerExit = yield* Effect.exit(
      Effect.suspend(() => handler(decoded.value, handlerContext(claim))).pipe(
        Effect.match({
          onFailure: (error) => {
            void error;
            return 'declared_failure' as const;
          },
          onSuccess: () => 'success' as const,
        }),
        Effect.withSpan('OutboxWorker.handle', { attributes: claimAnnotations(claim) }),
      ),
    );
    if (Exit.isFailure(handlerExit)) {
      yield* Effect.annotateLogs(
        Effect.logError('Unexpected Outbox Worker handler defect'),
        claimAnnotations(claim, 'handler_defect'),
      );
    }
    if (Exit.isFailure(handlerExit) || handlerExit.value === 'declared_failure') {
      const executionError = new OutboxHandlerExecutionError({
        code: 'outbox_handler_execution_failed',
        reason: Exit.isFailure(handlerExit)
          ? 'The Outbox Worker handler failed unexpectedly'
          : 'The Outbox Worker handler returned a declared failure',
      });
      const status = yield* repository.fail(claim, executionError.reason, execution.now).pipe(
        Effect.tapError((error) =>
          error instanceof OutboxPersistenceError ? logUnexpectedPersistence(claim) : Effect.void,
        ),
        (effect) => withOutcomeSpan(effect, claim, 'handler_failure'),
      );
      return {
        ...claimedState,
        dead: claimedState.dead + (status === 'dead' ? 1 : 0),
        failed: claimedState.failed + 1,
        retried: claimedState.retried + (status === 'pending' ? 1 : 0),
      };
    }

    yield* repository.complete(claim, execution.now).pipe(
      Effect.tapError((error) =>
        error instanceof OutboxPersistenceError ? logUnexpectedPersistence(claim) : Effect.void,
      ),
      (effect) => withOutcomeSpan(effect, claim, 'success'),
    );
    return { ...claimedState, succeeded: claimedState.succeeded + 1 };
  },
);

const runCycleWithRepository = Effect.fn('makeOutboxRuntime.runCycle')(
  function* runCycleWithRepositoryEffect<Registration extends AnyOutboxWorkerRegistration>(
    repository: OutboxRepositoryPort,
    input: RunOutboxCycleInput<Registration>,
  ) {
    const validated = yield* validateCycleInput(input);
    const deployedSubscriptions = yield* Effect.try({
      catch: (error) => {
        void error;
        return descriptorFailure('The deployed subscription snapshot is invalid');
      },
      try: () => validateOutboxWorkerSubscriptions(input.subscriptions),
    });
    yield* validateDeployedRegistrationSnapshot(validated.registrations, deployedSubscriptions);
    const registrationsByKey = new Map<string, Registration>(
      validated.registrations.map(
        (registration) => [registration.descriptor.workerKey, registration] as const,
      ),
    );
    const execution: OutboxCycleExecution<Registration> = {
      claimOwner: validated.claimOwner,
      now: validated.now,
      registrations: validated.registrations,
      registrationsByKey,
    };
    const progress = yield* Effect.reduce(
      Array.from({ length: validated.maxDeliveries }),
      initialCycleProgress,
      (state) =>
        state.stopped
          ? Effect.succeed(state)
          : processNextOutboxDelivery(repository, execution, state),
    );

    return Object.freeze({
      claimed: progress.claimed,
      dead: progress.dead,
      deliveriesCreated: 0,
      failed: progress.failed,
      messagesMatched: 0,
      retried: progress.retried,
      succeeded: progress.succeeded,
    });
  },
);

export const makeOutboxRuntime = (repository: OutboxRepositoryPort): OutboxRuntimeService => {
  const matchMessages: OutboxRuntimeService['matchMessages'] = (input) =>
    matchMessagesWithRepository(repository, input).pipe(
      Effect.withSpan('OutboxMatcher.matchMessages'),
    );
  const runCycle: OutboxRuntimeService['runCycle'] = (input) =>
    runCycleWithRepository(repository, input).pipe(
      Effect.withSpan('OutboxWorker.runCycle', {
        attributes: { claimOwner: input.claimOwner },
      }),
    );

  return Object.freeze({ matchMessages, runCycle });
};

export class OutboxRuntime extends Context.Service<OutboxRuntime, OutboxRuntimeService>()(
  '@app/core-runtime/outbox/runtime/OutboxRuntime',
) {}

export const OutboxRuntimeLive = Layer.effect(
  OutboxRuntime,
  Effect.gen(function* makeOutboxRuntimeService() {
    const repository = yield* OutboxRepository;
    return makeOutboxRuntime(repository);
  }),
);

export const runOutboxCycle = <Registration extends AnyOutboxWorkerRegistration>(
  input: RunOutboxCycleInput<Registration>,
): Effect.Effect<
  OutboxCycleResult,
  OutboxCycleError,
  OutboxRuntime | OutboxWorkerRequirements<Registration>
> => Effect.flatMap(OutboxRuntime, (runtime) => runtime.runCycle(input));

export const matchOutboxMessages = (
  input: MatchOutboxMessagesInput,
): Effect.Effect<
  OutboxMatchResult,
  OutboxPersistenceError | OutboxWorkerDescriptorError,
  OutboxRuntime
> => Effect.flatMap(OutboxRuntime, (runtime) => runtime.matchMessages(input));
