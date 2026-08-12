import type { DataAccessEventInput } from '@app/core-runtime';
import { Effect } from 'effect';
import type {
  CreateContactActionHandler,
  CreateContactDomainError,
  CreateContactPayload,
  CreateContactResult,
} from './create-contact.action.ts';

export interface CreateContactServices {
  readonly createContact: (
    input: CreateContactPayload,
  ) => Effect.Effect<
    { readonly dataAccess: readonly DataAccessEventInput[]; readonly result: CreateContactResult },
    CreateContactDomainError
  >;
}

export const createContactHandler: CreateContactActionHandler<CreateContactServices> = (
  payload,
  context,
) =>
  Effect.gen(function* createContact() {
    const outcome = yield* context.services.createContact(payload);
    for (const evidence of outcome.dataAccess) {
      yield* context.recordDataAccess(evidence);
    }
    yield* context.addDomainEvent({
      eventType: 'crm.core.contact.created',
      payloadJson: {
        contactId: outcome.result.contactId,
        customerId: outcome.result.customerId,
      },
      producerModuleKey: 'crm.core',
      subjectModuleKey: 'crm.core',
      subjectResourceId: outcome.result.contactId,
      subjectResourceType: 'crm.core.contact',
    });
    return outcome.result;
  });
