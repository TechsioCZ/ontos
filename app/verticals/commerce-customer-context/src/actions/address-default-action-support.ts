import type {
  ActionHandlerContext,
  DataAccessEventInput,
  DeclaredDomainEvent,
  DomainEventContractMap,
  OutboxMessage,
} from '@app/core-runtime';
import { Effect } from 'effect';

interface AddressActionAttribution {
  readonly actionInvocationId: string;
  readonly principalId: string;
}

interface AddressDefaultActionSuccessEvent<DomainEvents extends DomainEventContractMap> {
  readonly domainEvent: DeclaredDomainEvent<DomainEvents>;
  readonly outboxMessage: OutboxMessage;
}

interface ExecuteAddressDefaultActionOptions<
  Payload,
  Result,
  DomainError,
  DomainEvents extends DomainEventContractMap,
  Services,
> {
  readonly context: ActionHandlerContext<DomainEvents, Services>;
  readonly dataAccess: (payload: Payload, result: Result) => DataAccessEventInput;
  readonly invoke: (
    services: Services,
    payload: Payload,
    attribution: AddressActionAttribution,
  ) => Effect.Effect<Result, DomainError>;
  readonly payload: Payload;
  readonly successEvent: (
    payload: Payload,
    result: Result,
  ) => AddressDefaultActionSuccessEvent<DomainEvents> | undefined;
}

export const executeAddressDefaultAction = Effect.fn('AddressDefaultActionSupport.executeAddressDefaultAction')(
  function* executeAddressDefaultActionEffect<
    Payload,
    Result,
    DomainError,
    DomainEvents extends DomainEventContractMap,
    Services,
  >(options: ExecuteAddressDefaultActionOptions<Payload, Result, DomainError, DomainEvents, Services>) {
    const result = yield* options.invoke(options.context.services, options.payload, {
      actionInvocationId: options.context.actionInvocationId,
      principalId: options.context.scope.principalId,
    });
    yield* options.context.recordDataAccess(options.dataAccess(options.payload, result));
    const successEvent = options.successEvent(options.payload, result);
    if (successEvent !== undefined) {
      const event = yield* options.context.addDomainEvent(successEvent.domainEvent);
      yield* options.context.addOutboxMessage(event, successEvent.outboxMessage);
    }
    return result;
  },
);
