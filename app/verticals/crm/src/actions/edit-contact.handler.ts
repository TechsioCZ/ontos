import type { DataAccessEventInput } from '@app/core-runtime';
import { Effect } from 'effect';
import type {
  EditContactActionHandler,
  EditContactDomainError,
  EditContactPayload,
  EditContactResult,
} from './edit-contact.action.ts';

export interface EditContactServices {
  readonly editContact: (
    input: EditContactPayload,
  ) => Effect.Effect<
    { readonly dataAccess: readonly DataAccessEventInput[]; readonly result: EditContactResult },
    EditContactDomainError
  >;
}

export const editContactHandler: EditContactActionHandler<EditContactServices> = (
  payload,
  context,
) =>
  Effect.gen(function* editContact() {
    const outcome = yield* context.services.editContact(payload);
    for (const evidence of outcome.dataAccess) {
      yield* context.recordDataAccess(evidence);
    }
    return outcome.result;
  });
