import type { DataAccessEventInput } from '@app/core-runtime';
import { Effect } from 'effect';
import type {
  DeleteCustomerActionHandler,
  DeleteCustomerDomainError,
  DeleteCustomerPayload,
  DeleteCustomerResult,
} from './delete-customer.action.ts';

export interface DeleteCustomerServices {
  readonly deleteCustomer: (
    input: DeleteCustomerPayload,
  ) => Effect.Effect<
    { readonly dataAccess: readonly DataAccessEventInput[]; readonly result: DeleteCustomerResult },
    DeleteCustomerDomainError
  >;
}

export const deleteCustomerHandler: DeleteCustomerActionHandler<DeleteCustomerServices> = (
  payload,
  context,
) =>
  Effect.gen(function* deleteCustomer() {
    const outcome = yield* context.services.deleteCustomer(payload);
    for (const evidence of outcome.dataAccess) {
      yield* context.recordDataAccess(evidence);
    }
    yield* context.addDomainEvent({
      eventType: 'crm.core.customer.deleted',
      payloadJson: { customerId: outcome.result.customerId },
      producerModuleKey: 'crm.core',
      subjectModuleKey: 'crm.core',
      subjectResourceId: outcome.result.customerId,
      subjectResourceType: 'crm.core.customer',
    });
    return outcome.result;
  });
