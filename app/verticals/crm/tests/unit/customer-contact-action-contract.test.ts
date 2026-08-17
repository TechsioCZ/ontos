// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Schema } from 'effect';
import { archiveContactAction } from '../../src/actions/archive-contact.action.ts';
import { archiveCustomerAction } from '../../src/actions/archive-customer.action.ts';
import { createContactAction } from '../../src/actions/create-contact.action.ts';
import { createCustomerAction } from '../../src/actions/create-customer.action.ts';
import { editContactAction } from '../../src/actions/edit-contact.action.ts';
import { editCustomerAction } from '../../src/actions/edit-customer.action.ts';
import { unarchiveContactAction } from '../../src/actions/unarchive-contact.action.ts';
import { unarchiveCustomerAction } from '../../src/actions/unarchive-customer.action.ts';
import { contactDetailRead } from '../../src/api/contact-detail.read.ts';
import { contactListRead } from '../../src/api/contact-list.read.ts';
import { customerDetailRead } from '../../src/api/customer-detail.read.ts';
import { customerListRead } from '../../src/api/customer-list.read.ts';
import {
  ContactSchema,
  CreateContactPayloadSchema,
  EditContactPayloadSchema,
} from '../../shared/apis/contact-detail.ts';
import {
  CreateCustomerPayloadSchema,
  CrmDateOnlySchema,
  CrmDicSchema,
  CrmIcoSchema,
  CrmLegalFormCodeSchema,
  CustomerSchema,
} from '../../shared/apis/customer-detail.ts';
import { ContactListRequestSchema } from '../../shared/apis/contact-list.ts';

const actions = [
  archiveContactAction,
  archiveCustomerAction,
  createContactAction,
  createCustomerAction,
  editContactAction,
  editCustomerAction,
  unarchiveContactAction,
  unarchiveCustomerAction,
] as const;

const expectedActionKeys = [
  'crm.core.archive-contact',
  'crm.core.archive-customer',
  'crm.core.create-contact',
  'crm.core.create-customer',
  'crm.core.edit-contact',
  'crm.core.edit-customer',
  'crm.core.unarchive-contact',
  'crm.core.unarchive-customer',
] as const;

test('registers the exact generated CRM write contracts', async () => {
  assert.deepEqual(
    actions.map(({ descriptor }) => descriptor.actionKey).toSorted(),
    expectedActionKeys,
  );
  for (const { descriptor } of actions) {
    assert.equal(descriptor.owningModuleKey, 'crm.core');
    assert.equal(descriptor.idempotency, 'required');
    assert.equal(descriptor.legalEntityScope, 'optional');
    assert.equal(descriptor.auditProfile, 'standard');
    assert.deepEqual(descriptor.policies, []);
    assert.equal(descriptor.tenantPermission, undefined);
    assert.deepEqual(descriptor.domainEvents, {});
    assert.deepEqual(descriptor.entrypoint, {
      access: 'write',
      entrypointKey: descriptor.actionKey,
      moduleKey: 'crm.core',
      role: 'action',
      scope: 'tenant',
    });
    assert.deepEqual(descriptor.accessEvidencePolicy, {
      captureMode: 'metadata_only',
      policyKey: `${descriptor.actionKey}.access.v1`,
    });
  }
  const [manifest, registration] = await Promise.all([
    readFile(new URL('../../vertical.manifest.ts', import.meta.url), 'utf-8'),
    readFile(new URL('../../vertical.registration.ts', import.meta.url), 'utf-8'),
  ]);
  for (const actionKey of expectedActionKeys) {
    const camelName = `${actionKey
      .slice('crm.core.'.length)
      .split('-')
      .map((segment, index) =>
        index === 0 ? segment : `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`,
      )
      .join('')}Action`;
    assert.match(manifest, new RegExp(`\\b${camelName},`, 'u'));
    assert.match(registration, new RegExp(`\\b${camelName},`, 'u'));
  }
});

test('normalizes business strings and rejects invalid or mutable-parent payloads', () => {
  assert.deepEqual(Schema.decodeUnknownSync(CreateCustomerPayloadSchema)({ name: '  Acme  ' }), {
    name: 'Acme',
  });
  assert.deepEqual(
    Schema.decodeUnknownSync(CreateContactPayloadSchema)({
      customerId: 'c2000000-0000-4000-8000-000000000001',
      email: '  User@Example.test  ',
      name: '  Ada  ',
      phone: '  +420 123  ',
    }),
    {
      customerId: 'c2000000-0000-4000-8000-000000000001',
      email: 'User@Example.test',
      name: 'Ada',
      phone: '+420 123',
    },
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(CreateContactPayloadSchema)({
      customerId: 'c2000000-0000-4000-8000-000000000001',
      email: 'not-an-email',
      name: 'Ada',
      phone: '+420',
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(EditContactPayloadSchema, { onExcessProperty: 'error' })({
      contactId: 'c3000000-0000-4000-8000-000000000001',
      customerId: 'c2000000-0000-4000-8000-000000000002',
      email: 'ada@example.test',
      name: 'Ada',
      phone: '+420',
    }),
  );
});

test('keeps result DTOs compatible with rows allowed by the existing persistence contract', () => {
  const legacyText = 'x'.repeat(400);
  const shared = {
    archivedAt: null,
    createdAt: '2026-08-14T10:00:00.000Z',
    updatedAt: '2026-08-14T10:00:00.000Z',
  } as const;
  assert.equal(
    Schema.decodeUnknownSync(CustomerSchema)({
      ...shared,
      customerId: 'c2000000-0000-4000-8000-000000000001',
      dic: null,
      dissolvedOn: null,
      establishedOn: null,
      ico: null,
      legalFormCode: null,
      name: legacyText,
    }).name,
    legacyText,
  );
  const legacyContact = Schema.decodeUnknownSync(ContactSchema)({
    ...shared,
    contactId: 'c3000000-0000-4000-8000-000000000001',
    customerId: 'c2000000-0000-4000-8000-000000000001',
    email: 'legacy-email-without-at-sign',
    name: legacyText,
    phone: legacyText,
  });
  assert.equal(legacyContact.email, 'legacy-email-without-at-sign');
  assert.equal(legacyContact.phone, legacyText);
  assert.throws(() => Schema.decodeUnknownSync(CreateCustomerPayloadSchema)({ name: legacyText }));
});

test('defines exact flat Customer business-field result schemas', () => {
  assert.equal(Schema.decodeUnknownSync(CrmIcoSchema)('00123456'), '00123456');
  assert.equal(Schema.decodeUnknownSync(CrmDicSchema)('  CZ00123456  '), 'CZ00123456');
  assert.equal(Schema.decodeUnknownSync(CrmLegalFormCodeSchema)('112'), '112');
  assert.equal(Schema.decodeUnknownSync(CrmDateOnlySchema)('2024-02-29'), '2024-02-29');
  for (const invalidIco of ['1234567', '123456789', '1234A678']) {
    assert.throws(() => Schema.decodeUnknownSync(CrmIcoSchema)(invalidIco));
  }
  assert.throws(() => Schema.decodeUnknownSync(CrmDicSchema)('   '));
  assert.throws(() => Schema.decodeUnknownSync(CrmDicSchema)('x'.repeat(21)));
  assert.throws(() => Schema.decodeUnknownSync(CrmLegalFormCodeSchema)('12A'));
  for (const invalidDate of ['2024-2-09', '2023-02-29', '2024-04-31']) {
    assert.throws(() => Schema.decodeUnknownSync(CrmDateOnlySchema)(invalidDate));
  }

  const decodeCustomer = Schema.decodeUnknownSync(CustomerSchema, { onExcessProperty: 'error' });
  const complete = decodeCustomer({
    archivedAt: null,
    createdAt: '2026-08-14T10:00:00.000Z',
    customerId: 'c2000000-0000-4000-8000-000000000001',
    dic: 'CZ00123456',
    dissolvedOn: '2026-08-17',
    establishedOn: '2020-01-02',
    ico: '00123456',
    legalFormCode: '112',
    name: 'Acme',
    updatedAt: '2026-08-14T10:00:00.000Z',
  });
  assert.deepEqual(complete, {
    archivedAt: null,
    createdAt: '2026-08-14T10:00:00.000Z',
    customerId: 'c2000000-0000-4000-8000-000000000001',
    dic: 'CZ00123456',
    dissolvedOn: '2026-08-17',
    establishedOn: '2020-01-02',
    ico: '00123456',
    legalFormCode: '112',
    name: 'Acme',
    updatedAt: '2026-08-14T10:00:00.000Z',
  });
  const nullable = decodeCustomer({
    ...complete,
    dic: null,
    dissolvedOn: null,
    establishedOn: null,
    ico: null,
    legalFormCode: null,
  });
  assert.deepEqual(nullable, {
    archivedAt: null,
    createdAt: '2026-08-14T10:00:00.000Z',
    customerId: 'c2000000-0000-4000-8000-000000000001',
    dic: null,
    dissolvedOn: null,
    establishedOn: null,
    ico: null,
    legalFormCode: null,
    name: 'Acme',
    updatedAt: '2026-08-14T10:00:00.000Z',
  });
  assert.deepEqual(
    decodeCustomer({
      ...complete,
      dissolvedOn: '2020-01-02',
      establishedOn: '2020-01-02',
    }),
    { ...complete, dissolvedOn: '2020-01-02', establishedOn: '2020-01-02' },
  );
  assert.throws(() =>
    decodeCustomer({
      ...complete,
      dissolvedOn: '2020-01-01',
      establishedOn: '2020-01-02',
    }),
  );
  const { ico: _omittedIco, ...customerWithoutIco } = nullable;
  assert.throws(() => decodeCustomer(customerWithoutIco));
  assert.throws(() => decodeCustomer({ ...complete, ares: { source: 'ares' } }));
  assert.throws(() => decodeCustomer({ ...complete, address: { city: 'Praha' } }));
  assert.throws(() => decodeCustomer({ ...complete, legalName: 'Alternate name' }));
});

test('registers four governed reads with exact tenant-scoped evidence contracts', () => {
  const reads = [customerDetailRead, customerListRead, contactDetailRead, contactListRead] as const;
  assert.deepEqual(reads.map(({ descriptor }) => descriptor.readKey).toSorted(), [
    'crm.core.api.contact-detail',
    'crm.core.api.contact-list',
    'crm.core.api.customer-detail',
    'crm.core.api.customer-list',
  ]);
  for (const { descriptor } of reads) {
    assert.equal(descriptor.owningModuleKey, 'crm.core');
    assert.equal(descriptor.legalEntityScope, 'optional');
    assert.equal(descriptor.permissionTarget, 'tenant');
    assert.deepEqual(descriptor.policies, []);
    assert.equal(descriptor.evidencePolicy.captureMode, 'metadata_only');
    assert.equal(descriptor.entrypoint.access, 'read');
    assert.equal(descriptor.entrypoint.role, 'api');
  }
  assert.equal(customerDetailRead.descriptor.accessKind, 'detail');
  assert.equal(contactDetailRead.descriptor.accessKind, 'detail');
  assert.equal(customerListRead.descriptor.accessKind, 'list');
  assert.equal(contactListRead.descriptor.accessKind, 'list');
});

test('requires a Customer scope and bounded stable pagination input for Contact lists', () => {
  const decode = Schema.decodeUnknownSync(ContactListRequestSchema, {
    onExcessProperty: 'error',
  });
  assert.deepEqual(
    decode({
      customerId: 'c2000000-0000-4000-8000-000000000001',
      limit: 100,
      offset: 0,
    }),
    {
      customerId: 'c2000000-0000-4000-8000-000000000001',
      limit: 100,
      offset: 0,
    },
  );
  assert.throws(() => decode({ limit: 10, offset: 0 }));
  assert.throws(() =>
    decode({
      customerId: 'c2000000-0000-4000-8000-000000000001',
      limit: 101,
      offset: 0,
    }),
  );
  assert.throws(() =>
    decode({
      customerId: 'c2000000-0000-4000-8000-000000000001',
      limit: 10,
      offset: -1,
    }),
  );
});
