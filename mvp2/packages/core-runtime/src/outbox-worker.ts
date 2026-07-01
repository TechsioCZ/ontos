import type { CoreTransaction } from './db/types.ts';

export type OutboxPayloadSchema<TPayload> = {
  readonly parse: (payload: unknown) => TPayload;
};

export type OutboxWorkerDescriptor<TPayload = unknown> = {
  readonly workerKey: string;
  readonly owningModuleKey: string;
  readonly consumerModuleKey: string;
  readonly topics: readonly string[];
  readonly payloadSchema?: OutboxPayloadSchema<TPayload>;
  readonly defaults?: OutboxWorkerOperationalDefaults;
};

export type OutboxWorkerOperationalDefaults = {
  readonly maxAttempts?: number;
  readonly retryBackoff?: OutboxWorkerRetryBackoff;
};

export type OutboxWorkerRetryBackoff =
  | {
      readonly kind: 'fixed';
      readonly delayMs: number;
    }
  | {
      readonly kind: 'exponential';
      readonly initialDelayMs: number;
      readonly maxDelayMs: number;
    };

export type OutboxWorkerHandlerInput<TPayload> = {
  readonly context: OutboxWorkerHandlerContext;
  readonly payload: TPayload;
};

export type OutboxWorkerHandlerContext = {
  readonly tenantId: string;
  readonly legalEntityId?: string;
  readonly originalPrincipalId?: string;
  readonly originalAuthBindingId?: string;
  readonly originalActionInvocationId?: string;
  readonly originalActionKey?: string;
  readonly originalActionIdempotencyKey?: string;
  readonly producerModuleKey: string;
  readonly consumerModuleKey: string;
  readonly workerKey: string;
  readonly topic: string;
  readonly outboxMessageId: string;
  readonly outboxDeliveryId: string;
  readonly domainEventId: string;
  readonly idempotencyKey: string;
};

export type OutboxWorkerHandlerServices = {
  readonly tx: CoreTransaction;
};

export type OutboxWorkerHandler<TPayload> = {
  bivarianceHack(
    input: OutboxWorkerHandlerInput<TPayload>,
    services: OutboxWorkerHandlerServices,
  ): Promise<void> | void;
}['bivarianceHack'];

export type OutboxWorkerRegistration<TPayload = unknown> = {
  readonly descriptor: OutboxWorkerDescriptor<TPayload>;
  readonly handler: OutboxWorkerHandler<TPayload>;
};
