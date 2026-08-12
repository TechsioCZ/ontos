import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { CreateContactPayloadSchema } from '../../shared/apis/create-contact-action.ts';
import { DeleteContactPayloadSchema } from '../../shared/apis/delete-contact-action.ts';
import { EditContactPayloadSchema } from '../../shared/apis/edit-contact-action.ts';
import {
  ContactViewSchema,
  CustomerDirectoryRequestSchema,
} from '../../shared/apis/customer-directory.ts';
import { createContactAction } from '../../src/actions/create-contact.action.ts';
import { deleteContactAction } from '../../src/actions/delete-contact.action.ts';
import { editContactAction } from '../../src/actions/edit-contact.action.ts';
import {
  contactRowToView,
  decodeContactCursor,
  encodeContactCursor,
  normalizeContactFields,
} from '../../src/contacts/contact-service.ts';

const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Effect.runPromise(Schema.decodeUnknownEffect(schema)(input));

const customerId = '10000000-0000-4000-8000-000000000001';
const contactId = '20000000-0000-4000-8000-000000000001';

test('keeps Contact mutation payloads scope-free and reserves ownership, primary, and deletion', async () => {
  const created = await decode(CreateContactPayloadSchema, {
    customerId,
    deletedAt: 'forbidden',
    firstName: 'Ada',
    isPrimaryContact: true,
    legalEntityId: 'forbidden',
    tenantId: 'forbidden',
  });
  assert.deepEqual(created, { customerId, firstName: 'Ada' });

  const edited = await decode(EditContactPayloadSchema, {
    contactId,
    customerId: 'forbidden',
    deletedAt: 'forbidden',
    expectedVersion: 2,
    firstName: 'Grace',
    isPrimaryContact: true,
  });
  assert.deepEqual(edited, { contactId, expectedVersion: 2, firstName: 'Grace' });
  assert.deepEqual(
    await decode(DeleteContactPayloadSchema, {
      contactId,
      expectedVersion: 2,
      isPrimaryContact: true,
    }),
    { contactId, expectedVersion: 2 },
  );
});

test('normalizes optional Contact fields and requires at least one trimmed name part', async () => {
  assert.deepEqual(
    await Effect.runPromise(
      normalizeContactFields({
        email: ' ADA@EXAMPLE.COM ',
        firstName: '  Ada ',
        jobTitle: ' Engineer ',
        lastName: ' ',
        phone: ' +420   123 456 ',
      }),
    ),
    {
      email: 'ada@example.com',
      firstName: 'Ada',
      jobTitle: 'Engineer',
      lastName: null,
      phone: '+420 123 456',
    },
  );
  const lastNameOnly = await Effect.runPromise(normalizeContactFields({ lastName: 'Lovelace' }));
  assert.equal(lastNameOnly.lastName, 'Lovelace');
  await assert.rejects(
    Effect.runPromise(normalizeContactFields({ firstName: ' ', lastName: '' })),
    (error: { readonly _tag?: string }) => error._tag === 'ContactValidationError',
  );
  await assert.rejects(
    Effect.runPromise(normalizeContactFields({ email: 'not-an-email', firstName: 'Ada' })),
    (error: { readonly _tag?: string }) => error._tag === 'ContactValidationError',
  );
});

test('uses bounded deterministic Contact cursors and complete safe views', async () => {
  const row = {
    contactId,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    customerId,
    deletedAt: null,
    email: null,
    firstName: 'Žofie',
    isPrimaryContact: false,
    jobTitle: null,
    lastName: 'Černá',
    phone: null,
    tenantId: '30000000-0000-4000-8000-000000000001',
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    version: 1,
  } as const;
  const view = contactRowToView(row, 'Acme');
  await decode(ContactViewSchema, view);
  assert.equal(view.displayName, 'Žofie Černá');
  assert.equal(view.customerLabel, 'Acme');
  assert.equal(view.isPrimaryContact, false);
  const cursor = encodeContactCursor(view);
  assert.deepEqual(decodeContactCursor(cursor), {
    contactId,
    normalizedFirstName: 'žofie',
    normalizedLastName: 'černá',
  });
  assert.equal(decodeContactCursor(`${cursor}x`), undefined);
  await assert.rejects(
    decode(CustomerDirectoryRequestSchema, {
      cursor: `bm90LWpzb24.${contactId}`,
      customerId,
      limit: 1,
      operation: 'contacts',
    }),
  );
  const unicodeCursor = encodeContactCursor({
    contactId,
    firstName: '名'.repeat(200),
    lastName: '姓'.repeat(200),
  });
  await decode(CustomerDirectoryRequestSchema, {
    cursor: unicodeCursor,
    customerId,
    limit: 1,
    operation: 'contacts',
  });
  await assert.rejects(
    decode(CustomerDirectoryRequestSchema, { customerId, limit: 101, operation: 'contacts' }),
  );
});

test('declares owner-local idempotent Contact Actions and only create/delete events', () => {
  for (const action of [createContactAction, editContactAction, deleteContactAction]) {
    assert.equal(action.descriptor.owningModuleKey, 'crm.core');
    assert.equal(action.descriptor.entrypoint.access, 'write');
    assert.equal(action.descriptor.idempotency, 'required');
    assert.equal(action.descriptor.legalEntityScope, 'required');
  }
  assert.deepEqual(Object.keys(createContactAction.descriptor.domainEvents), [
    'crm.core.contact.created',
  ]);
  assert.deepEqual(Object.keys(editContactAction.descriptor.domainEvents), []);
  assert.deepEqual(Object.keys(deleteContactAction.descriptor.domainEvents), [
    'crm.core.contact.deleted',
  ]);
});

test('maps the complete Contact BFF failure vocabulary and keeps private handlers server-only', async () => {
  const actionNames = ['create', 'edit', 'delete'] as const;
  const servers = await Promise.all(
    actionNames.map(async (action) => ({
      action,
      server: await readFile(
        path.resolve(import.meta.dirname, `../../api/${action}-contact-action-server.ts`),
        'utf-8',
      ),
    })),
  );
  for (const { action, server } of servers) {
    assert.match(
      server,
      new RegExp(`${action[0]?.toUpperCase()}${action.slice(1)}ContactUnavailable`, 'u'),
    );
    for (const status of ['400', '401', '403', '404', '409', '422', '500', '503']) {
      assert.match(server, new RegExp(`${status} as const`, 'u'));
    }
    assert.match(server, /www-authenticate/u);
    assert.doesNotMatch(server, /contact\.handler/u);
  }
  const browserClients = await Promise.all(
    actionNames.map((action) =>
      readFile(
        path.resolve(import.meta.dirname, `../../src/api/${action}-contact-action-client.ts`),
        'utf-8',
      ),
    ),
  );
  for (const client of browserClients) {
    assert.doesNotMatch(client, /handler|contact-repository|contact-service/u);
    assert.match(client, /makeEffectHttpApiClient/u);
  }
  const provider = await readFile(
    path.resolve(import.meta.dirname, '../../src/api/contact-detail.read.ts'),
    'utf-8',
  );
  assert.match(provider, /makeContactService/u);
  assert.match(provider, /getContact\(input\.resourceId\)/u);
  assert.match(provider, /displayName\.slice\(0, 300\)/u);
  assert.match(provider, /captureMode: 'metadata_only'/u);
  assert.doesNotMatch(provider, /no business implementation/u);
});
