import type { DataAccessEventInput } from '@app/core-runtime';
import { Effect } from 'effect';
import type {
  DeleteContactActionHandler,
  DeleteContactDomainError,
  DeleteContactPayload,
  DeleteContactResult,
} from './delete-contact.action.ts';

export interface DeleteContactServices {
  readonly deleteContact: (
    input: DeleteContactPayload,
  ) => Effect.Effect<
    { readonly dataAccess: readonly DataAccessEventInput[]; readonly result: DeleteContactResult },
    DeleteContactDomainError
  >;
}

export const deleteContactHandler: DeleteContactActionHandler<DeleteContactServices> = (
  payload,
  context,
) =>
  Effect.gen(function* deleteContact() {
    const outcome = yield* context.services.deleteContact(payload);
    for (const evidence of outcome.dataAccess) {
      yield* context.recordDataAccess(evidence);
    }
    yield* context.addDomainEvent({
      eventType: 'crm.core.contact.deleted',
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
