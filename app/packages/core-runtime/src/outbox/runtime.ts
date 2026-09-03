/* eslint-disable unicorn/no-array-method-this-argument -- Effect's dual flatMap API is intentional. */
// @effect-diagnostics effectFnOpportunity:off globalDateInEffect:off instanceOfSchema:off
import { Cause, Context, Effect, Exit, Layer, Schema } from 'effect';
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
import { OutboxRepository, OutboxRepositoryLive } from './repository.ts';
import type { OutboxClaim, OutboxRepositoryService } from './repository.ts';

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

const validateCycleInput = <Registration extends AnyOutboxWorkerRegistration>(
  input: RunOutboxCycleInput<Registration>,
): Effect.Effect<
  {
    readonly claimOwner: string;
    readonly maxDeliveries: number;
    readonly now: Date;
    readonly registrations: readonly Registration[];
  },
  OutboxWorkerDescriptorError
> =>
  Effect.try({
    catch: (error) =>
      error instanceof OutboxWorkerDescriptorError
        ? error
        : descriptorFailure('The Outbox Worker descriptor set is invalid'),
    try: () => {
      if (input.claimOwner.trim().length === 0 || input.claimOwner.length > 200) {
        throw descriptorFailure('claimOwner must be a non-empty stable runtime identity');
      }
      const maxDeliveries = input.maxDeliveries ?? 100;
      if (!Number.isSafeInteger(maxDeliveries) || maxDeliveries < 1 || maxDeliveries > 1000) {
        throw descriptorFailure('maxDeliveries must be an integer from 1 through 1000');
      }
      const now = input.now ?? new Date();
      if (Number.isNaN(now.getTime())) {
        throw descriptorFailure('now must be a valid timestamp');
      }
      return {
        claimOwner: input.claimOwner,
        maxDeliveries,
        now,
        registrations: validateOutboxWorkerRegistrations(input.registrations),
      };
    },
  });

const claimAnnotations = (claim: OutboxClaim, outcome?: string) =>
  withOptionalProperty(
    withOptionalProperty(
      {
        attempt: claim.attemptNumber,
        claimId: claim.claimId,
        consumerModuleKey: claim.consumerModuleKey,
      },
      !(claim.correlationId === undefined),
      'correlationId',
      claim.correlationId,
      {
        deliveryId: claim.deliveryId,
        messageId: claim.messageId,
      },
    ),
    !(outcome === undefined),
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

const validateDeployedRegistrationSnapshot = (
  registrations: readonly AnyOutboxWorkerRegistration[],
  subscriptions: readonly OutboxWorkerSubscription[],
) =>
  Effect.gen(function* validateDeployedRegistrationSnapshotEffect() {
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

export const makeOutboxRuntime = (repository: OutboxRepositoryService): OutboxRuntimeService => {
  const matchMessages: OutboxRuntimeService['matchMessages'] = (input) =>
    Effect.gen(function* matchOutboxMessagesEffect() {
      const subscriptions = yield* Effect.try({
        catch: () => descriptorFailure('The installed subscription snapshot is invalid'),
        try: () => validateOutboxWorkerSubscriptions(input.subscriptions),
      });
      const now = input.now ?? new Date();
      if (Number.isNaN(now.getTime())) {
        return yield* descriptorFailure('now must be a valid timestamp');
      }
      return yield* repository
        .matchUnmatched(subscriptions, now)
        .pipe(Effect.tapError(() => logUnexpectedPersistence()));
    }).pipe(Effect.withSpan('OutboxMatcher.matchMessages'));
  const runCycle: OutboxRuntimeService['runCycle'] = <
    Registration extends AnyOutboxWorkerRegistration,
  >(
    input: RunOutboxCycleInput<Registration>,
  ) =>
    Effect.gen(function* runOutboxCycleEffect() {
      const validated = yield* validateCycleInput(input);
      const deployedSubscriptions = yield* Effect.try({
        catch: () => descriptorFailure('The deployed subscription snapshot is invalid'),
        try: () => validateOutboxWorkerSubscriptions(input.subscriptions),
      });
      yield* validateDeployedRegistrationSnapshot(validated.registrations, deployedSubscriptions);
      const registrationsByKey = new Map<string, Registration>(
        validated.registrations.map(
          (registration) => [registration.descriptor.workerKey, registration] as const,
        ),
      );
      let claimed = 0;
      let dead = 0;
      let failed = 0;
      let retried = 0;
      let succeeded = 0;

      while (claimed < validated.maxDeliveries) {
        const claim = yield* repository
          .claimNext(validated.registrations, validated.claimOwner, validated.now)
          .pipe(Effect.tapError(() => logUnexpectedPersistence()));
        if (claim === null) {
          break;
        }
        claimed += 1;
        const registration = registrationsByKey.get(claim.workerKey);
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
          const status = yield* repository.fail(claim, decodeError.reason, validated.now).pipe(
            Effect.tapError((error) =>
              error instanceof OutboxPersistenceError
                ? logUnexpectedPersistence(claim)
                : Effect.void,
            ),
            (effect) => withOutcomeSpan(effect, claim, 'payload_decode_failure'),
          );
          failed += 1;
          if (status === 'dead') {
            dead += 1;
          } else {
            retried += 1;
          }
          continue;
        }

        const handler = getOutboxWorkerHandler(registration);
        const exit = yield* Effect.exit(
          Effect.suspend(() => handler(decoded.value, handlerContext(claim))).pipe(
            Effect.withSpan('OutboxWorker.handle', { attributes: claimAnnotations(claim) }),
          ),
        );
        if (Exit.isFailure(exit)) {
          const declaredFailure = Cause.findErrorOption(exit.cause);
          if (declaredFailure._tag === 'None') {
            yield* Effect.annotateLogs(
              Effect.logError('Unexpected Outbox Worker handler defect'),
              claimAnnotations(claim, 'handler_defect'),
            );
          }
          const executionError = new OutboxHandlerExecutionError({
            code: 'outbox_handler_execution_failed',
            reason:
              declaredFailure._tag === 'Some'
                ? 'The Outbox Worker handler returned a declared failure'
                : 'The Outbox Worker handler failed unexpectedly',
          });
          const status = yield* repository.fail(claim, executionError.reason, validated.now).pipe(
            Effect.tapError((error) =>
              error instanceof OutboxPersistenceError
                ? logUnexpectedPersistence(claim)
                : Effect.void,
            ),
            (effect) => withOutcomeSpan(effect, claim, 'handler_failure'),
          );
          failed += 1;
          if (status === 'dead') {
            dead += 1;
          } else {
            retried += 1;
          }
          continue;
        }

        yield* repository.complete(claim, validated.now).pipe(
          Effect.tapError((error) =>
            error instanceof OutboxPersistenceError ? logUnexpectedPersistence(claim) : Effect.void,
          ),
          (effect) => withOutcomeSpan(effect, claim, 'success'),
        );
        succeeded += 1;
      }

      return Object.freeze({
        claimed,
        dead,
        deliveriesCreated: 0,
        failed,
        messagesMatched: 0,
        retried,
        succeeded,
      });
    }).pipe(
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
).pipe(Layer.provide(OutboxRepositoryLive));

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
