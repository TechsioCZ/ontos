import type { DataAccessEventInput } from '@app/core-runtime';
import { Effect } from 'effect';
import type {
  CreateCustomerActionHandler,
  CreateCustomerDomainError,
  CreateCustomerPayload,
  CreateCustomerResult,
} from './create-customer.action.ts';

export interface CreateCustomerServices {
  readonly createCustomer: (
    input: CreateCustomerPayload,
  ) => Effect.Effect<
    { readonly dataAccess: readonly DataAccessEventInput[]; readonly result: CreateCustomerResult },
    CreateCustomerDomainError
  >;
}

export const createCustomerHandler: CreateCustomerActionHandler<CreateCustomerServices> = (
  payload,
  context,
) =>
  Effect.gen(function* createCustomer() {
    const outcome = yield* context.services.createCustomer(payload);
    for (const evidence of outcome.dataAccess) {
      yield* context.recordDataAccess(evidence);
    }
    yield* context.addDomainEvent({
      eventType: 'crm.core.customer.created',
      payloadJson: { customerId: outcome.result.customerId },
      producerModuleKey: 'crm.core',
      subjectModuleKey: 'crm.core',
      subjectResourceId: outcome.result.customerId,
      subjectResourceType: 'crm.core.customer',
    });
    return outcome.result;
  });
