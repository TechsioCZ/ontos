// @effect-diagnostics asyncFunction:off globalDate:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import { findCustomerRecord } from '../../src/services/customer-contact-persistence.service.ts';
import type { CustomerRecord } from '../../src/db/schema.ts';

type CustomerTransaction = Parameters<typeof findCustomerRecord>[0];

const transactionReturning = (row: CustomerRecord): CustomerTransaction =>
  ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([row]),
        }),
      }),
    }),
  }) as unknown as CustomerTransaction;

const baseRow = {
  archivedAt: null,
  createdAt: new Date('2026-08-14T10:00:00.000Z'),
  customerId: 'c2000000-0000-4000-8000-000000000001',
  name: 'Acme',
  tenantId: 'c1000000-0000-4000-8000-000000000001',
  updatedAt: new Date('2026-08-15T11:30:00.000Z'),
} as const;

test('maps complete persisted Customer business fields to flat date-only DTO values', async () => {
  const result = await Effect.runPromise(
    findCustomerRecord(
      transactionReturning({
        ...baseRow,
        dic: 'CZ00123456',
        dissolvedOn: '2026-08-17',
        establishedOn: '2020-01-02',
        ico: '00123456',
        legalFormCode: '112',
      }),
      baseRow.tenantId,
      baseRow.customerId,
    ),
  );

  assert.deepEqual(result, {
    _tag: 'found',
    value: {
      archivedAt: null,
      createdAt: '2026-08-14T10:00:00.000Z',
      customerId: baseRow.customerId,
      dic: 'CZ00123456',
      dissolvedOn: '2026-08-17',
      establishedOn: '2020-01-02',
      ico: '00123456',
      legalFormCode: '112',
      name: 'Acme',
      updatedAt: '2026-08-15T11:30:00.000Z',
    },
  });
});

test('maps legacy Customer rows to explicit null business fields', async () => {
  const result = await Effect.runPromise(
    findCustomerRecord(
      transactionReturning({
        ...baseRow,
        dic: null,
        dissolvedOn: null,
        establishedOn: null,
        ico: null,
        legalFormCode: null,
      }),
      baseRow.tenantId,
      baseRow.customerId,
    ),
  );

  assert.equal(result._tag, 'found');
  assert.deepEqual(result._tag === 'found' ? result.value : undefined, {
    archivedAt: null,
    createdAt: '2026-08-14T10:00:00.000Z',
    customerId: baseRow.customerId,
    dic: null,
    dissolvedOn: null,
    establishedOn: null,
    ico: null,
    legalFormCode: null,
    name: 'Acme',
    updatedAt: '2026-08-15T11:30:00.000Z',
  });
});
