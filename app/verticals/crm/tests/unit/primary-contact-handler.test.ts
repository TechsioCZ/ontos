import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import { ChangeCustomerPrimaryContactConflict } from '../../src/actions/change-customer-primary-contact.action.ts';
import { changeCustomerPrimaryContactHandler } from '../../src/actions/change-customer-primary-contact.handler.ts';

const customerId = '10000000-0000-4000-8000-000000000001';
const previousContactId = '20000000-0000-4000-8000-000000000001';
const selectedContactId = '20000000-0000-4000-8000-000000000002';
const payload = {
  customerId,
  expectedCurrentPrimaryContactId: previousContactId,
  expectedCurrentPrimaryContactVersion: 2,
  expectedCustomerVersion: 4,
  expectedSelectedContactVersion: 1,
  selectedContactId,
} as const;
const result = {
  changedAt: '2026-08-12T10:00:00.000Z',
  customerId,
  customerVersion: 5,
  previousPrimaryContactId: previousContactId,
  previousPrimaryContactVersion: 3,
  primaryContactId: selectedContactId,
  primaryContactVersion: 2,
} as const;
const evidence = {
  accessKind: 'read' as const,
  queryHash: 'primary-contact-test-query',
  resultCount: 1,
  servingModuleKey: 'crm.core',
};

const context = (services: object) => {
  const events: object[] = [];
  const reads: object[] = [];
  return {
    events,
    reads,
    value: {
      actionInvocationId: '30000000-0000-4000-8000-000000000001',
      addDomainEvent: (event: object) =>
        Effect.sync(() => {
          events.push(event);
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

test('records contributing reads and emits the safe primary Contact change event', async () => {
  const handlerContext = context({
    changeCustomerPrimaryContact: () => Effect.succeed({ dataAccess: [evidence], result }),
  });
  assert.deepEqual(
    await Effect.runPromise(
      changeCustomerPrimaryContactHandler(payload, handlerContext.value as never),
    ),
    result,
  );
  assert.deepEqual(handlerContext.reads, [evidence]);
  assert.deepEqual(handlerContext.events, [
    {
      eventType: 'crm.core.customer.primary-contact-changed',
      payloadJson: {
        customerId,
        previousPrimaryContactId: previousContactId,
        primaryContactId: selectedContactId,
      },
      producerModuleKey: 'crm.core',
      subjectModuleKey: 'crm.core',
      subjectResourceId: customerId,
      subjectResourceType: 'crm.core.customer',
    },
  ]);
});

test('collects no evidence or event when the atomic service fails', async () => {
  const handlerContext = context({
    changeCustomerPrimaryContact: () =>
      Effect.fail(
        new ChangeCustomerPrimaryContactConflict({
          code: 'action_conflict',
          reason: 'Concurrent change',
        }),
      ),
  });
  await assert.rejects(
    Effect.runPromise(changeCustomerPrimaryContactHandler(payload, handlerContext.value as never)),
    (error: { readonly _tag?: string }) => error._tag === 'ChangeCustomerPrimaryContactConflict',
  );
  assert.deepEqual(handlerContext.reads, []);
  assert.deepEqual(handlerContext.events, []);
});
