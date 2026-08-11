import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { CreateCustomerPayloadSchema } from '../../shared/apis/create-customer-action.ts';
import { DeleteCustomerPayloadSchema } from '../../shared/apis/delete-customer-action.ts';
import { EditCustomerPayloadSchema } from '../../shared/apis/edit-customer-action.ts';
import {
  CustomerDirectoryRequestSchema,
  CustomerViewSchema,
} from '../../shared/apis/customer-directory.ts';
import { createCustomerAction } from '../../src/actions/create-customer.action.ts';
import { deleteCustomerAction } from '../../src/actions/delete-customer.action.ts';
import { editCustomerAction } from '../../src/actions/edit-customer.action.ts';
import {
  decodeCustomerCursor,
  encodeCustomerCursor,
  normalizeCustomerFields,
} from '../../src/customers/customer-service.ts';

const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Effect.runPromise(Schema.decodeUnknownEffect(schema)(input));

test('keeps Customer mutation payloads tenant-free and separates edit from delete', async () => {
  const customerId = '10000000-0000-4000-8000-000000000001';
  const created = await decode(CreateCustomerPayloadSchema, {
    legalEntityId: 'forbidden',
    name: 'Acme',
    status: 'active',
    tenantId: 'forbidden',
  });
  assert.deepEqual(created, { name: 'Acme' });

  const edited = await decode(EditCustomerPayloadSchema, {
    customerId,
    deletedAt: 'forbidden',
    expectedVersion: 2,
    name: 'Acme Two',
  });
  assert.deepEqual(edited, { customerId, expectedVersion: 2, name: 'Acme Two' });
  assert.deepEqual(await decode(DeleteCustomerPayloadSchema, { customerId, expectedVersion: 2 }), {
    customerId,
    expectedVersion: 2,
  });
  assert.deepEqual(
    await decode(DeleteCustomerPayloadSchema, { customerId, expectedVersion: 2, name: 'ignored' }),
    { customerId, expectedVersion: 2 },
  );
});

test('normalizes all Customer fields and validates structured addresses', async () => {
  const normalized = await Effect.runPromise(
    normalizeCustomerFields({
      address: { addressLine1: '  Main 1 ', city: ' Prague ', countryCode: 'cz' },
      companyRegistrationNumber: ' cz 12-34/56 ',
      email: ' SALES@EXAMPLE.COM ',
      name: '  Acme s.r.o.  ',
      phone: ' +420   123 456 ',
      taxIdentificationNumber: ' cz 123 456 ',
      website: 'https://example.com',
    }),
  );
  assert.deepEqual(normalized, {
    addressLine1: 'Main 1',
    addressLine2: null,
    city: 'Prague',
    companyRegistrationNumber: 'CZ123456',
    countryCode: 'CZ',
    email: 'sales@example.com',
    name: 'Acme s.r.o.',
    phone: '+420 123 456',
    postalCode: null,
    region: null,
    taxIdentificationNumber: 'CZ123456',
    website: 'https://example.com/',
  });
  await assert.rejects(
    Effect.runPromise(normalizeCustomerFields({ address: { city: 'Prague' }, name: 'Acme' })),
    (error: { readonly _tag?: string }) => error._tag === 'CustomerValidationError',
  );
});

test('uses bounded deterministic cursor contracts and round trips normalized names', async () => {
  const customer = {
    address: null,
    companyRegistrationNumber: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    customerId: '10000000-0000-4000-8000-000000000001',
    email: null,
    name: 'Žluťoučký Kůň',
    phone: null,
    taxIdentificationNumber: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    website: null,
  } as const;
  await decode(CustomerViewSchema, customer);
  const cursor = encodeCustomerCursor(customer);
  assert.deepEqual(decodeCustomerCursor(cursor), {
    customerId: customer.customerId,
    normalizedName: 'žluťoučký kůň',
  });
  await assert.rejects(decode(CustomerDirectoryRequestSchema, { limit: 101, operation: 'list' }));
  await assert.rejects(decode(CustomerDirectoryRequestSchema, { operation: 'list' }));
});

test('declares owner-local, idempotent, Legal-Entity-scoped Actions and stable events', () => {
  for (const action of [createCustomerAction, editCustomerAction, deleteCustomerAction]) {
    assert.equal(action.descriptor.owningModuleKey, 'crm.core');
    assert.equal(action.descriptor.entrypoint.access, 'write');
    assert.equal(action.descriptor.idempotency, 'required');
    assert.equal(action.descriptor.legalEntityScope, 'required');
  }
  assert.deepEqual(Object.keys(createCustomerAction.descriptor.domainEvents), [
    'crm.core.customer.created',
  ]);
  assert.deepEqual(Object.keys(editCustomerAction.descriptor.domainEvents), []);
  assert.deepEqual(Object.keys(deleteCustomerAction.descriptor.domainEvents), [
    'crm.core.customer.deleted',
  ]);
});
