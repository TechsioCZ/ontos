import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import { createCustomerHandler } from '../../src/actions/create-customer.handler.ts';
import { deleteCustomerHandler } from '../../src/actions/delete-customer.handler.ts';
import { editCustomerHandler } from '../../src/actions/edit-customer.handler.ts';

const customerId = '10000000-0000-4000-8000-000000000001';
const customer = {
  address: null,
  companyRegistrationNumber: 'CZ123456',
  createdAt: '2026-01-01T00:00:00.000Z',
  customerId,
  email: null,
  name: 'Acme',
  phone: null,
  taxIdentificationNumber: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1,
  website: null,
} as const;
const evidence = {
  accessKind: 'read' as const,
  queryHash: 'customer-test-query',
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
      actionInvocationId: '20000000-0000-4000-8000-000000000001',
      addDomainEvent: (event: (typeof events)[number]) =>
        Effect.sync(() => {
          events.push({
            eventType: event.eventType,
            subjectResourceId: event.subjectResourceId,
          });
          return {} as never;
        }),
      addOutboxMessage: () => Effect.void,
      recordAuditEvidence: () => Effect.void,
      recordDataAccess: (access: object) =>
        Effect.sync(() => {
          reads.push(access);
        }),
      scope: {
        legalEntityId: '30000000-0000-4000-8000-000000000001',
        tenantId: '40000000-0000-4000-8000-000000000001',
      },
      services,
    },
  };
};

test('records contributing reads and emits only past-tense create/delete events', async () => {
  const createContext = context({
    createCustomer: () => Effect.succeed({ dataAccess: [evidence], result: customer }),
  });
  const created = await Effect.runPromise(
    createCustomerHandler({ name: 'Acme' }, createContext.value as never),
  );
  assert.equal(created.customerId, customerId);
  assert.deepEqual(createContext.reads, [evidence]);
  assert.deepEqual(createContext.events, [
    { eventType: 'crm.core.customer.created', subjectResourceId: customerId },
  ]);

  const editContext = context({
    editCustomer: () => Effect.succeed({ dataAccess: [evidence], result: customer }),
  });
  await Effect.runPromise(
    editCustomerHandler(
      { customerId, expectedVersion: 1, name: 'Acme' },
      editContext.value as never,
    ),
  );
  assert.deepEqual(editContext.reads, [evidence]);
  assert.deepEqual(editContext.events, []);

  const deleteResult = {
    customerId,
    deletedAt: '2026-01-02T00:00:00.000Z',
    version: 2,
  };
  const deleteContext = context({
    deleteCustomer: () => Effect.succeed({ dataAccess: [evidence], result: deleteResult }),
  });
  assert.deepEqual(
    await Effect.runPromise(
      deleteCustomerHandler({ customerId, expectedVersion: 1 }, deleteContext.value as never),
    ),
    deleteResult,
  );
  assert.deepEqual(deleteContext.events, [
    { eventType: 'crm.core.customer.deleted', subjectResourceId: customerId },
  ]);
});
