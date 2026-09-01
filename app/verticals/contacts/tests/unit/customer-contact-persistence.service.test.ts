// @effect-diagnostics asyncFunction:off globalDate:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import {
  createCustomerRecord,
  editCustomerRecord,
  findCustomerRecord,
} from '../../src/services/customer-contact-persistence.service.ts';
import type { CustomerRecord } from '../../src/db/schema.ts';

type CustomerTransaction = Parameters<typeof findCustomerRecord>[0];
type CustomerCreateTransaction = Parameters<typeof createCustomerRecord>[0];
type CustomerEditTransaction = Parameters<typeof editCustomerRecord>[0];
type CustomerCreateValues = Parameters<
  ReturnType<CustomerCreateTransaction['insert']>['values']
>[0];
type CustomerEditValues = Parameters<ReturnType<CustomerEditTransaction['update']>['set']>[0];

const transactionReturning = (row: CustomerRecord): CustomerTransaction => ({
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve([row]),
      }),
    }),
  }),
});

const baseRow = {
  archivedAt: null,
  createdAt: new Date('2026-08-14T10:00:00.000Z'),
  customerId: 'c2000000-0000-4000-8000-000000000001',
  name: 'Acme',
  tenantId: 'c1000000-0000-4000-8000-000000000001',
  updatedAt: new Date('2026-08-15T11:30:00.000Z'),
} as const;

const completeBusinessFields = {
  dic: 'CZ00123456',
  dissolvedOn: '2026-08-17',
  establishedOn: '2020-01-02',
  ico: '00123456',
  legalFormCode: '112',
} as const;

const rejectingTransaction = (constraint: string): CustomerCreateTransaction => ({
  insert: () => ({
    values: () => ({
      returning: () =>
        Promise.reject(
          new Error('Drizzle query failed', {
            cause: Object.assign(new Error('duplicate key'), {
              code: '23505',
              constraint,
            }),
          }),
        ),
    }),
  }),
});

test('maps complete persisted Customer business fields to flat date-only DTO values', async () => {
  const result = await Effect.runPromise(
    findCustomerRecord(
      transactionReturning({
        ...baseRow,
        ...completeBusinessFields,
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

test('persists every Customer business field on create and edit', async () => {
  let inserted: CustomerCreateValues | undefined;
  const createTransaction: CustomerCreateTransaction = {
    insert: () => ({
      values: (value) => {
        inserted = value;
        return {
          returning: () =>
            Promise.resolve([{ ...baseRow, ...completeBusinessFields, name: 'Created' }]),
        };
      },
    }),
  };
  const created = await Effect.runPromise(
    createCustomerRecord(createTransaction, baseRow.tenantId, {
      ...completeBusinessFields,
      name: 'Created',
    }),
  );
  assert.deepEqual(inserted, {
    ...completeBusinessFields,
    name: 'Created',
    tenantId: baseRow.tenantId,
  });
  assert.deepEqual(
    {
      dic: created.dic,
      dissolvedOn: created.dissolvedOn,
      establishedOn: created.establishedOn,
      ico: created.ico,
      legalFormCode: created.legalFormCode,
      name: created.name,
    },
    { ...completeBusinessFields, name: 'Created' },
  );

  let updated: CustomerEditValues | undefined;
  const editTransaction: CustomerEditTransaction = {
    update: () => ({
      set: (value) => {
        updated = value;
        return {
          where: () => ({
            returning: () =>
              Promise.resolve([
                {
                  ...baseRow,
                  dic: null,
                  dissolvedOn: null,
                  establishedOn: null,
                  ico: null,
                  legalFormCode: null,
                  name: 'Cleared',
                  updatedAt: value.updatedAt,
                },
              ]),
          }),
        };
      },
    }),
  };
  const edited = await Effect.runPromise(
    editCustomerRecord(editTransaction, baseRow.tenantId, {
      customerId: baseRow.customerId,
      dic: null,
      dissolvedOn: null,
      establishedOn: null,
      ico: null,
      legalFormCode: null,
      name: 'Cleared',
    }),
  );
  assert.deepEqual(
    {
      dic: updated?.dic,
      dissolvedOn: updated?.dissolvedOn,
      establishedOn: updated?.establishedOn,
      ico: updated?.ico,
      legalFormCode: updated?.legalFormCode,
      name: updated?.name,
    },
    {
      dic: null,
      dissolvedOn: null,
      establishedOn: null,
      ico: null,
      legalFormCode: null,
      name: 'Cleared',
    },
  );
  assert.equal(edited._tag, 'found');
  assert.equal(edited._tag === 'found' ? edited.value.ico : undefined, null);
});

test('maps only the named tenant/IČO uniqueness constraint to the typed conflict', async () => {
  const payload = { ...completeBusinessFields, name: 'Duplicate' };
  const conflict = await Effect.runPromise(
    Effect.flip(
      createCustomerRecord(
        rejectingTransaction('contacts_customers_tenant_ico_uk'),
        baseRow.tenantId,
        payload,
      ),
    ),
  );
  assert.equal(conflict._tag, 'ContactsCustomerIcoConflict');
  assert.equal(JSON.stringify(conflict).includes('contacts_customers_tenant_ico_uk'), false);
  assert.equal(JSON.stringify(conflict).includes(baseRow.tenantId), false);

  const unrelated = await Effect.runPromise(
    Effect.flip(
      createCustomerRecord(
        rejectingTransaction('another_unique_constraint'),
        baseRow.tenantId,
        payload,
      ),
    ),
  );
  assert.equal(unrelated._tag, 'ContactsPersistenceUnavailable');
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
