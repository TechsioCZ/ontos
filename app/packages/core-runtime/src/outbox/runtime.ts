/* eslint-disable unicorn/no-array-method-this-argument -- Effect's dual flatMap API is intentional. */
// @effect-diagnostics globalDateInEffect:off instanceOfSchema:off
import { Cause, Context, Effect, Exit, Layer, Schema } from 'effect';
import type {
  AnyOutboxWorkerRegistration,
  OutboxWorkerHandlerContext,
  OutboxWorkerRequirements,
  OutboxWorkerSubscription,
} from './definition.ts';
import {
  getOutboxWorkerHandler,
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
import { installedOutboxWorkerSubscriptions } from './subscriptions.generated.ts';

export interface RunOutboxCycleInput<
  Registration extends AnyOutboxWorkerRegistration = AnyOutboxWorkerRegistration,
> {
  readonly claimOwner: string;
  readonly maxDeliveries?: number;
  readonly now?: Date;
  readonly registrations: readonly Registration[];
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

const claimAnnotations = (
  claim: OutboxClaim,
  outcome?: string,
): Readonly<Record<string, string | number>> => ({
  attempt: claim.attemptNumber,
  claimId: claim.claimId,
  consumerModuleKey: claim.consumerModuleKey,
  ...(claim.correlationId === undefined ? {} : { correlationId: claim.correlationId }),
  deliveryId: claim.deliveryId,
  messageId: claim.messageId,
  ...(outcome === undefined ? {} : { outcome }),
  producerModuleKey: claim.producerModuleKey,
  tenantId: claim.tenantId,
  topic: claim.topic,
  workerKey: claim.workerKey,
});

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

const handlerContext = (claim: OutboxClaim): OutboxWorkerHandlerContext => ({
  attemptNumber: claim.attemptNumber,
  claimId: claim.claimId,
  ...(claim.correlationId === undefined ? {} : { correlationId: claim.correlationId }),
  deliveryId: claim.deliveryId,
  domainEventId: claim.domainEventId,
  messageId: claim.messageId,
  producerModuleKey: claim.producerModuleKey,
  tenantId: claim.tenantId,
  tenantSequenceNo: claim.tenantSequenceNo,
  topic: claim.topic,
  workerKey: claim.workerKey,
});

export const makeOutboxRuntime = (
  repository: OutboxRepositoryService,
  subscriptions: readonly OutboxWorkerSubscription[] = installedOutboxWorkerSubscriptions,
): OutboxRuntimeService => {
  const matchingSubscriptions = validateOutboxWorkerSubscriptions(subscriptions);
  const matchingSubscriptionsByKey = new Map(
    matchingSubscriptions.map((subscription) => [subscription.workerKey, subscription]),
  );
  const runCycle: OutboxRuntimeService['runCycle'] = <
    Registration extends AnyOutboxWorkerRegistration,
  >(
    input: RunOutboxCycleInput<Registration>,
  ) =>
    Effect.gen(function* runOutboxCycleEffect() {
      const validated = yield* validateCycleInput(input);
      for (const registration of validated.registrations) {
        const subscription = matchingSubscriptionsByKey.get(registration.descriptor.workerKey);
        if (
          subscription === undefined ||
          subscription.consumerModuleKey !== registration.descriptor.consumerModuleKey ||
          subscription.producerModuleKey !== registration.descriptor.producerModuleKey ||
          subscription.topic !== registration.descriptor.topic
        ) {
          return yield* descriptorFailure(
            `worker ${registration.descriptor.workerKey} is absent from the installed subscription catalog`,
          );
        }
      }
      const registrationsByKey = new Map<string, Registration>(
        validated.registrations.map(
          (registration) => [registration.descriptor.workerKey, registration] as const,
        ),
      );
      const matched = yield* repository
        .matchUnmatched(matchingSubscriptions, validated.now)
        .pipe(Effect.tapError(() => logUnexpectedPersistence()));
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
        deliveriesCreated: matched.deliveriesCreated,
        failed,
        messagesMatched: matched.messagesMatched,
        retried,
        succeeded,
      });
    }).pipe(
      Effect.withSpan('OutboxWorker.runCycle', {
        attributes: { claimOwner: input.claimOwner },
      }),
    );

  return Object.freeze({ runCycle });
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
