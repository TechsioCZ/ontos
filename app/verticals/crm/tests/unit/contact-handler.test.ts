import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import { CreateContactRejected } from '../../src/actions/create-contact.action.ts';
import { createContactHandler } from '../../src/actions/create-contact.handler.ts';
import { deleteContactHandler } from '../../src/actions/delete-contact.handler.ts';
import { editContactHandler } from '../../src/actions/edit-contact.handler.ts';

const customerId = '10000000-0000-4000-8000-000000000001';
const contactId = '20000000-0000-4000-8000-000000000001';
const contact = {
  contactId,
  createdAt: '2026-01-01T00:00:00.000Z',
  customerId,
  customerLabel: 'Acme',
  displayName: 'Ada Lovelace',
  email: null,
  firstName: 'Ada',
  isPrimaryContact: false,
  jobTitle: null,
  lastName: 'Lovelace',
  phone: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1,
} as const;
const evidence = {
  accessKind: 'read' as const,
  queryHash: 'contact-test-query',
  resultCount: 1,
  servingModuleKey: 'crm.core',
};

const context = (services: object) => {
  const events: { readonly eventType: string; readonly subjectResourceId: string }[] = [];
  const reads: object[] = [];
  return {
    events,
    reads,
    value: {
      actionInvocationId: '30000000-0000-4000-8000-000000000001',
      addDomainEvent: (event: (typeof events)[number]) =>
        Effect.sync(() => {
          events.push({ eventType: event.eventType, subjectResourceId: event.subjectResourceId });
          return {} as never;
        }),
      addOutboxMessage: () => Effect.void,
      recordAuditEvidence: () => Effect.void,
      recordDataAccess: (access: object) => Effect.sync(() => void reads.push(access)),
      scope: {
        legalEntityId: '40000000-0000-4000-8000-000000000001',
        tenantId: '50000000-0000-4000-8000-000000000001',
      },
      services,
    },
  };
};

test('records contributing reads and emits only past-tense Contact create/delete events', async () => {
  const createContext = context({
    createContact: () => Effect.succeed({ dataAccess: [evidence], result: contact }),
  });
  const created = await Effect.runPromise(
    createContactHandler({ customerId, firstName: 'Ada' }, createContext.value as never),
  );
  assert.equal(created.isPrimaryContact, false);
  assert.deepEqual(createContext.reads, [evidence]);
  assert.deepEqual(createContext.events, [
    { eventType: 'crm.core.contact.created', subjectResourceId: contactId },
  ]);

  const editContext = context({
    editContact: () => Effect.succeed({ dataAccess: [evidence], result: contact }),
  });
  await Effect.runPromise(
    editContactHandler(
      { contactId, expectedVersion: 1, firstName: 'Ada' },
      editContext.value as never,
    ),
  );
  assert.deepEqual(editContext.reads, [evidence]);
  assert.deepEqual(editContext.events, []);

  const result = {
    contactId,
    customerId,
    customerLabel: 'Acme',
    deletedAt: '2026-01-02T00:00:00.000Z',
    version: 2,
  } as const;
  const deleteContext = context({
    deleteContact: () => Effect.succeed({ dataAccess: [evidence], result }),
  });
  assert.deepEqual(
    await Effect.runPromise(
      deleteContactHandler({ contactId, expectedVersion: 1 }, deleteContext.value as never),
    ),
    result,
  );
  assert.deepEqual(deleteContext.events, [
    { eventType: 'crm.core.contact.deleted', subjectResourceId: contactId },
  ]);
});

test('does not collect Contact evidence or events when business behavior fails', async () => {
  const failedContext = context({
    createContact: () =>
      Effect.fail(
        new CreateContactRejected({
          code: 'action_semantically_rejected',
          reason: 'Invalid Contact',
        }),
      ),
  });
  await assert.rejects(
    Effect.runPromise(
      createContactHandler({ customerId, firstName: 'Ada' }, failedContext.value as never),
    ),
    (error: { readonly _tag?: string }) => error._tag === 'CreateContactRejected',
  );
  assert.deepEqual(failedContext.reads, []);
  assert.deepEqual(failedContext.events, []);
});
