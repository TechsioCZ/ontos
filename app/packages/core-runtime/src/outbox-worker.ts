// @effect-diagnostics asyncFunction:off
import type { CoreTransaction } from './db/types.ts';
import { checkModuleStateAccess, isInstalledModuleKey } from './module-state.ts';
import type { ModuleActivationState } from './module-state.ts';

export interface OutboxPayloadSchema<TPayload> {
  readonly parse: (payload: unknown) => TPayload;
}

export interface OutboxWorkerDescriptor<TPayload = unknown> {
  readonly workerKey: string;
  readonly owningModuleKey: string;
  readonly consumerModuleKey: string;
  readonly topics: readonly string[];
  readonly payloadSchema?: OutboxPayloadSchema<TPayload>;
  readonly defaults?: OutboxWorkerOperationalDefaults;
}

export interface OutboxWorkerOperationalDefaults {
  readonly maxAttempts?: number;
  readonly retryBackoff?: OutboxWorkerRetryBackoff;
}

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

export interface OutboxWorkerHandlerInput<TPayload> {
  readonly context: OutboxWorkerHandlerContext;
  readonly payload: TPayload;
}

export interface OutboxWorkerHandlerContext {
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
}

export interface OutboxWorkerHandlerServices {
  readonly tx: CoreTransaction;
}

export type OutboxWorkerHandler<TPayload> = {
  readonly bivarianceHack: (
    input: OutboxWorkerHandlerInput<TPayload>,
    services: OutboxWorkerHandlerServices,
  ) => Promise<void> | void;
}['bivarianceHack'];

export interface OutboxWorkerRegistration<TPayload = unknown> {
  readonly descriptor: OutboxWorkerDescriptor<TPayload>;
  readonly handler: OutboxWorkerHandler<TPayload>;
}

export type OutboxWorkerModuleStateAccessDecision =
  | {
      readonly _tag: 'Allowed';
      readonly accessKind: 'mutate';
      readonly moduleKey: string;
      readonly state: ModuleActivationState;
    }
  | {
      readonly _tag: 'Denied';
      readonly accessKind: 'mutate';
      readonly moduleKey: string;
      readonly outcomeCode: 'module_state_mutate_blocked';
      readonly state: ModuleActivationState;
    };

export const checkOutboxWorkerModuleStateAccess = async ({
  consumerModuleKey,
  tenantId,
}: {
  readonly consumerModuleKey: string;
  readonly producerModuleKey: string;
  readonly tenantId: string;
}): Promise<OutboxWorkerModuleStateAccessDecision> => {
  if (!isInstalledModuleKey(consumerModuleKey)) {
    return {
      _tag: 'Denied',
      accessKind: 'mutate',
      moduleKey: consumerModuleKey,
      outcomeCode: 'module_state_mutate_blocked',
      state: 'inactive',
    };
  }

  const decision = await checkModuleStateAccess({
    accessKind: 'mutate',
    moduleKey: consumerModuleKey,
    tenantId,
  });

  return decision._tag === 'Allowed'
    ? {
        _tag: 'Allowed',
        accessKind: 'mutate',
        moduleKey: decision.moduleKey,
        state: decision.state,
      }
    : {
        _tag: 'Denied',
        accessKind: 'mutate',
        moduleKey: decision.moduleKey,
        outcomeCode: 'module_state_mutate_blocked',
        state: decision.state,
      };
};
