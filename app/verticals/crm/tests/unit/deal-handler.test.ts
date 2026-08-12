import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import { CreateDealRejected } from '../../src/actions/create-deal.action.ts';
import { createDealHandler } from '../../src/actions/create-deal.handler.ts';
import { deleteDealHandler } from '../../src/actions/delete-deal.handler.ts';
import { editDealHandler } from '../../src/actions/edit-deal.handler.ts';

const customerId = '10000000-0000-4000-8000-000000000001';
const dealId = '30000000-0000-4000-8000-000000000001';
const deal = {
  contactId: null,
  contactLabel: null,
  createdAt: '2026-08-12T10:00:00.000Z',
  currency: 'CZK',
  customerId,
  customerLabel: 'Acme',
  dealId,
  description: null,
  expectedCloseDate: null,
  expectedValue: 1000,
  status: 'New' as const,
  title: 'Annual agreement',
  updatedAt: '2026-08-12T10:00:00.000Z',
  version: 1,
};
const payload = {
  currency: 'CZK',
  customerId,
  expectedValue: 1000,
  title: 'Annual agreement',
} as const;
const evidence = {
  accessKind: 'read' as const,
  queryHash: 'deal-test-query',
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
      actionInvocationId: '60000000-0000-4000-8000-000000000001',
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

test('records contributing reads and emits only past-tense Deal create/delete events', async () => {
  const createContext = context({
    createDeal: () => Effect.succeed({ dataAccess: [evidence], result: deal }),
  });
  const created = await Effect.runPromise(createDealHandler(payload, createContext.value as never));
  assert.equal(created.status, 'New');
  assert.deepEqual(createContext.reads, [evidence]);
  assert.deepEqual(createContext.events, [
    { eventType: 'crm.core.deal.created', subjectResourceId: dealId },
  ]);

  const editContext = context({
    editDeal: () => Effect.succeed({ dataAccess: [evidence], result: deal }),
  });
  await Effect.runPromise(
    editDealHandler({ ...payload, dealId, expectedVersion: 1 }, editContext.value as never),
  );
  assert.deepEqual(editContext.events, []);

  const result = {
    customerId,
    customerLabel: 'Acme',
    dealId,
    deletedAt: '2026-08-12T11:00:00.000Z',
    version: 2,
  };
  const deleteContext = context({
    deleteDeal: () => Effect.succeed({ dataAccess: [evidence], result }),
  });
  assert.deepEqual(
    await Effect.runPromise(
      deleteDealHandler({ dealId, expectedVersion: 1 }, deleteContext.value as never),
    ),
    result,
  );
  assert.deepEqual(deleteContext.events, [
    { eventType: 'crm.core.deal.deleted', subjectResourceId: dealId },
  ]);
});

test('collects no Deal evidence or events when business behavior rejects', async () => {
  const failed = context({
    createDeal: () =>
      Effect.fail(
        new CreateDealRejected({
          code: 'action_semantically_rejected',
          reason: 'Invalid Deal',
        }),
      ),
  });
  await assert.rejects(
    Effect.runPromise(createDealHandler(payload, failed.value as never)),
    (error: { readonly _tag?: string }) => error._tag === 'CreateDealRejected',
  );
  assert.deepEqual(failed.reads, []);
  assert.deepEqual(failed.events, []);
});
