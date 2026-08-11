import type { DataAccessEventInput } from '@app/core-runtime';
import { Effect } from 'effect';
import type {
  EditCustomerActionHandler,
  EditCustomerDomainError,
  EditCustomerPayload,
  EditCustomerResult,
} from './edit-customer.action.ts';

export interface EditCustomerServices {
  readonly editCustomer: (
    input: EditCustomerPayload,
  ) => Effect.Effect<
    { readonly dataAccess: readonly DataAccessEventInput[]; readonly result: EditCustomerResult },
    EditCustomerDomainError
  >;
}

export const editCustomerHandler: EditCustomerActionHandler<EditCustomerServices> = (
  payload,
  context,
) =>
  Effect.gen(function* editCustomer() {
    const outcome = yield* context.services.editCustomer(payload);
    for (const evidence of outcome.dataAccess) {
      yield* context.recordDataAccess(evidence);
    }
    return outcome.result;
  });
