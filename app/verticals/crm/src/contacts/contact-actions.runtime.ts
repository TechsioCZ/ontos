import { Effect } from 'effect';
import { createContactHandler } from '../actions/create-contact.handler.ts';
import { bindCreateContactAction } from '../actions/create-contact.registration.ts';
import { deleteContactHandler } from '../actions/delete-contact.handler.ts';
import { bindDeleteContactAction } from '../actions/delete-contact.registration.ts';
import { editContactHandler } from '../actions/edit-contact.handler.ts';
import { bindEditContactAction } from '../actions/edit-contact.registration.ts';
import { makeContactService } from './contact-service.ts';

const contactServiceFactory = (
  transaction: Parameters<typeof makeContactService>[0],
  scope: { readonly tenantId: string },
) => Effect.succeed(makeContactService(transaction, scope.tenantId));

export const boundCreateContactAction = bindCreateContactAction(
  createContactHandler,
  contactServiceFactory,
);
export const boundEditContactAction = bindEditContactAction(
  editContactHandler,
  contactServiceFactory,
);
export const boundDeleteContactAction = bindDeleteContactAction(
  deleteContactHandler,
  contactServiceFactory,
);
