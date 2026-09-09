import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';
import type { CoreTransaction } from '../db/types.ts';
import { actionInvocations, domainEvents, outboxMessages, tenants } from '../db/schema.ts';
import { computeCanonicalValueHash } from '../actions/repository.ts';
import type { OutboxWorkerHandlerContext } from './definition.ts';
import { isVerifiedOutboxWorkerHandlerContext } from './definition.ts';
import { OutboxWorkerCompletionPublicationError } from './completion-publication-error.ts';

export { OutboxWorkerCompletionPublicationError } from './completion-publication-error.ts';

const completionDefinition: unique symbol = Symbol(
  '@app/core-runtime/outbox/worker-completion-definition',
);
const moduleKeyPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const eventTypePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const boundedKeyPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,299}$/u;

class OutboxWorkerCompletionDefinitionValue<
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
> {
  readonly [completionDefinition] = true;
  readonly consumerModuleKey: string;
  readonly eventType: string;
  readonly payloadSchema: PayloadSchema;
  readonly producerModuleKey: string;
  readonly topic: string;
  readonly workerKey: string;

  constructor(input: OutboxWorkerCompletionDefinitionInput<PayloadSchema>) {
    this.consumerModuleKey = input.consumerModuleKey;
    this.eventType = input.eventType;
    this.payloadSchema = input.payloadSchema;
    this.producerModuleKey = input.producerModuleKey;
    this.topic = input.topic;
    this.workerKey = input.workerKey;
  }
}

export interface OutboxWorkerCompletionDefinitionInput<
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
> {
  readonly consumerModuleKey: string;
  readonly eventType: string;
  readonly payloadSchema: PayloadSchema;
  readonly producerModuleKey: string;
  readonly topic: string;
  readonly workerKey: string;
}

export type OutboxWorkerCompletionDefinition<
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
> = Readonly<OutboxWorkerCompletionDefinitionValue<PayloadSchema>>;

export interface OutboxWorkerCompletionInput<Payload> {
  /** Stable owner mutation UUID. It is also the idempotent completion Domain Event identity. */
  readonly completionId: string;
  readonly occurredAt: Date;
  readonly payloadJson: Payload;
  readonly sourceActionInvocationId: string;
  readonly subjectModuleKey: string;
  readonly subjectResourceId: string;
  readonly subjectResourceType: string;
}

export interface OutboxWorkerCompletionPublicationResult {
  readonly domainEventId: string;
  readonly outcome: 'ALREADY_PUBLISHED' | 'PUBLISHED';
}

export interface OutboxWorkerCompletionPublisher {
  readonly publish: <PayloadSchema extends Schema.ConstraintDecoder<unknown>>(
    definition: OutboxWorkerCompletionDefinition<PayloadSchema>,
    input: OutboxWorkerCompletionInput<PayloadSchema['Type']>,
  ) => Effect.Effect<
    OutboxWorkerCompletionPublicationResult,
    OutboxWorkerCompletionPublicationError
  >;
}

export interface PersistOutboxWorkerCompletionInput {
  readonly completionId: string;
  readonly eventType: string;
  readonly legalEntityId: string;
  readonly occurredAt: Date;
  readonly payloadJson: unknown;
  readonly producerModuleKey: string;
  readonly sourceActionInvocationId: string;
  readonly subjectModuleKey: string;
  readonly subjectResourceId: string;
  readonly subjectResourceType: string;
  readonly tenantId: string;
  readonly topic: string;
}

export type PersistOutboxWorkerCompletion = (
  input: PersistOutboxWorkerCompletionInput,
) => Effect.Effect<OutboxWorkerCompletionPublicationResult, OutboxWorkerCompletionPublicationError>;

const invalid = (reason: string): OutboxWorkerCompletionPublicationError =>
  new OutboxWorkerCompletionPublicationError({
    code: 'outbox_worker_completion_invalid',
    reason,
    retryable: false,
  });

const conflict = (): OutboxWorkerCompletionPublicationError =>
  new OutboxWorkerCompletionPublicationError({
    code: 'outbox_worker_completion_conflict',
    reason: 'The completion identity is already bound to different durable evidence',
    retryable: false,
  });

const unavailable = (cause?: unknown): OutboxWorkerCompletionPublicationError => {
  const error = new OutboxWorkerCompletionPublicationError({
    code: 'outbox_worker_completion_unavailable',
    reason: 'The worker completion could not be published durably',
    retryable: true,
  });
  return cause === undefined
    ? error
    : Object.defineProperty(error, 'cause', {
        configurable: false,
        enumerable: false,
        value: cause,
      });
};

export const defineOutboxWorkerCompletion = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
>(
  input: OutboxWorkerCompletionDefinitionInput<PayloadSchema>,
): OutboxWorkerCompletionDefinition<PayloadSchema> => {
  if (
    !moduleKeyPattern.test(input.consumerModuleKey) ||
    input.producerModuleKey !== input.consumerModuleKey ||
    !eventTypePattern.test(input.eventType) ||
    input.topic !== input.eventType ||
    !input.workerKey.startsWith(`${input.consumerModuleKey}.`)
  ) {
    throw invalid(
      'A completion must be bound to its exact owner worker, producer, event type, topic, and payload schema',
    );
  }
  return Object.freeze(new OutboxWorkerCompletionDefinitionValue(input));
};

const validDefinition = <PayloadSchema extends Schema.ConstraintDecoder<unknown>>(
  definition: OutboxWorkerCompletionDefinition<PayloadSchema>,
  context: OutboxWorkerHandlerContext,
): boolean =>
  definition[completionDefinition] &&
  Object.isFrozen(definition) &&
  definition.workerKey === context.workerKey &&
  definition.consumerModuleKey === context.consumerModuleKey &&
  definition.producerModuleKey === context.consumerModuleKey &&
  definition.topic === definition.eventType;

const validInput = (input: OutboxWorkerCompletionInput<unknown>): boolean =>
  uuidPattern.test(input.completionId) &&
  uuidPattern.test(input.sourceActionInvocationId) &&
  Option.isSome(DateTime.make(input.occurredAt)) &&
  moduleKeyPattern.test(input.subjectModuleKey) &&
  boundedKeyPattern.test(input.subjectResourceId) &&
  boundedKeyPattern.test(input.subjectResourceType);

export const outboxWorkerCompletionPublisherFor = (
  dependencies: Readonly<{
    context: OutboxWorkerHandlerContext;
    legalEntityId: string;
    persist: PersistOutboxWorkerCompletion;
  }>,
): OutboxWorkerCompletionPublisher => ({
  publish: (definition, input) => {
    const { context, legalEntityId, persist } = dependencies;
    if (
      !isVerifiedOutboxWorkerHandlerContext(context) ||
      !uuidPattern.test(context.tenantId) ||
      !uuidPattern.test(legalEntityId) ||
      !validDefinition(definition, context) ||
      !validInput(input)
    ) {
      return Effect.fail(invalid('The worker completion scope or identity is invalid'));
    }
    return Schema.decodeUnknownEffect(definition.payloadSchema)(input.payloadJson).pipe(
      Effect.mapError((cause) =>
        Object.defineProperty(invalid('The worker completion payload is invalid'), 'cause', {
          configurable: false,
          enumerable: false,
          value: cause,
        }),
      ),
      Effect.flatMap((payloadJson) =>
        persist({
          completionId: input.completionId,
          eventType: definition.eventType,
          legalEntityId,
          occurredAt: input.occurredAt,
          payloadJson,
          producerModuleKey: definition.producerModuleKey,
          sourceActionInvocationId: input.sourceActionInvocationId,
          subjectModuleKey: input.subjectModuleKey,
          subjectResourceId: input.subjectResourceId,
          subjectResourceType: input.subjectResourceType,
          tenantId: context.tenantId,
          topic: definition.topic,
        }),
      ),
    );
  },
});

const epochMillis = (value: Date): number | undefined =>
  DateTime.make(value).pipe(Option.map(DateTime.toEpochMillis), Option.getOrUndefined);

const sameInstant = (left: Date, right: Date): boolean => epochMillis(left) === epochMillis(right);

export const persistOutboxWorkerCompletion = (
  transaction: CoreTransaction,
): PersistOutboxWorkerCompletion =>
  Effect.fn('OutboxWorkerCompletionPublisher.persist')(
    function* persistOutboxWorkerCompletionEffect(input) {
      const [sourceInvocation] = yield* transaction
        .select({
          actionInvocationId: actionInvocations.actionInvocationId,
          legalEntityId: actionInvocations.legalEntityId,
          status: actionInvocations.status,
        })
        .from(actionInvocations)
        .where(
          and(
            eq(actionInvocations.tenantId, input.tenantId),
            eq(actionInvocations.actionInvocationId, input.sourceActionInvocationId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (
        sourceInvocation === undefined ||
        sourceInvocation.legalEntityId !== input.legalEntityId ||
        sourceInvocation.status !== 'succeeded'
      ) {
        return yield* invalid(
          'The completion source Action is not durably succeeded in the exact Legal Entity scope',
        );
      }

      const [lockedTenant] = yield* transaction
        .select({ tenantId: tenants.tenantId })
        .from(tenants)
        .where(eq(tenants.tenantId, input.tenantId))
        .for('update')
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (lockedTenant === undefined) {
        return yield* unavailable();
      }

      const created = yield* transaction
        .insert(domainEvents)
        .values({
          actionInvocationId: input.sourceActionInvocationId,
          domainEventId: input.completionId,
          eventType: input.eventType,
          legalEntityId: input.legalEntityId,
          occurredAt: input.occurredAt,
          payloadJson: input.payloadJson,
          producerModuleKey: input.producerModuleKey,
          subjectModuleKey: input.subjectModuleKey,
          subjectResourceId: input.subjectResourceId,
          subjectResourceType: input.subjectResourceType,
          tenantId: input.tenantId,
        })
        .onConflictDoNothing()
        .returning({ domainEventId: domainEvents.domainEventId })
        .pipe(Effect.mapError(unavailable));
      if (created.length === 1) {
        yield* transaction
          .insert(outboxMessages)
          .values({
            domainEventId: input.completionId,
            payloadJson: input.payloadJson,
            producerModuleKey: input.producerModuleKey,
            tenantId: input.tenantId,
            topic: input.topic,
          })
          .pipe(Effect.mapError(unavailable));
        return { domainEventId: input.completionId, outcome: 'PUBLISHED' };
      }

      const [existing] = yield* transaction
        .select({
          actionInvocationId: domainEvents.actionInvocationId,
          eventType: domainEvents.eventType,
          legalEntityId: domainEvents.legalEntityId,
          occurredAt: domainEvents.occurredAt,
          payloadJson: domainEvents.payloadJson,
          producerModuleKey: domainEvents.producerModuleKey,
          subjectModuleKey: domainEvents.subjectModuleKey,
          subjectResourceId: domainEvents.subjectResourceId,
          subjectResourceType: domainEvents.subjectResourceType,
          topic: outboxMessages.topic,
        })
        .from(domainEvents)
        .innerJoin(
          outboxMessages,
          and(
            eq(outboxMessages.tenantId, domainEvents.tenantId),
            eq(outboxMessages.domainEventId, domainEvents.domainEventId),
          ),
        )
        .where(
          and(
            eq(domainEvents.tenantId, input.tenantId),
            eq(domainEvents.domainEventId, input.completionId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (
        existing === undefined ||
        existing.actionInvocationId !== input.sourceActionInvocationId ||
        existing.eventType !== input.eventType ||
        existing.legalEntityId !== input.legalEntityId ||
        !sameInstant(existing.occurredAt, input.occurredAt) ||
        existing.producerModuleKey !== input.producerModuleKey ||
        existing.subjectModuleKey !== input.subjectModuleKey ||
        existing.subjectResourceId !== input.subjectResourceId ||
        existing.subjectResourceType !== input.subjectResourceType ||
        existing.topic !== input.topic ||
        computeCanonicalValueHash(existing.payloadJson) !==
          computeCanonicalValueHash(input.payloadJson)
      ) {
        return yield* conflict();
      }
      return { domainEventId: input.completionId, outcome: 'ALREADY_PUBLISHED' };
    },
  );
