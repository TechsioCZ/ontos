import type { DataAccessEventInput } from '@app/core-runtime';
import { Effect } from 'effect';
import type {
  ChangeCustomerPrimaryContactActionHandler,
  ChangeCustomerPrimaryContactDomainError,
  ChangeCustomerPrimaryContactPayload,
  ChangeCustomerPrimaryContactResult,
} from './change-customer-primary-contact.action.ts';

export interface ChangeCustomerPrimaryContactServices {
  readonly changeCustomerPrimaryContact: (
    input: ChangeCustomerPrimaryContactPayload,
  ) => Effect.Effect<
    {
      readonly dataAccess: readonly DataAccessEventInput[];
      readonly result: ChangeCustomerPrimaryContactResult;
    },
    ChangeCustomerPrimaryContactDomainError
  >;
}

export const changeCustomerPrimaryContactHandler: ChangeCustomerPrimaryContactActionHandler<
  ChangeCustomerPrimaryContactServices
> = (payload, context) =>
  Effect.gen(function* changeCustomerPrimaryContact() {
    const outcome = yield* context.services.changeCustomerPrimaryContact(payload);
    for (const evidence of outcome.dataAccess) {
      yield* context.recordDataAccess(evidence);
    }
    yield* context.addDomainEvent({
      eventType: 'crm.core.customer.primary-contact-changed',
      payloadJson: {
        customerId: outcome.result.customerId,
        previousPrimaryContactId: outcome.result.previousPrimaryContactId,
        primaryContactId: outcome.result.primaryContactId,
      },
      producerModuleKey: 'crm.core',
      subjectModuleKey: 'crm.core',
      subjectResourceId: outcome.result.customerId,
      subjectResourceType: 'crm.core.customer',
    });
    return outcome.result;
  });
