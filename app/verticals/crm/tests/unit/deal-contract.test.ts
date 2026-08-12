import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { CreateDealPayloadSchema } from '../../shared/apis/create-deal-action.ts';
import { DeleteDealPayloadSchema } from '../../shared/apis/delete-deal-action.ts';
import { DealViewSchema, DealWorkspaceRequestSchema } from '../../shared/apis/deal-workspace.ts';
import { EditDealPayloadSchema } from '../../shared/apis/edit-deal-action.ts';
import { createDealAction } from '../../src/actions/create-deal.action.ts';
import { deleteDealAction } from '../../src/actions/delete-deal.action.ts';
import { editDealAction } from '../../src/actions/edit-deal.action.ts';
import {
  dealRowToView,
  decodeDealCursor,
  encodeDealCursor,
  normalizeDealFields,
} from '../../src/deals/deal-service.ts';

const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Effect.runPromise(Schema.decodeUnknownEffect(schema)(input));

const customerId = '10000000-0000-4000-8000-000000000001';
const contactId = '20000000-0000-4000-8000-000000000001';
const dealId = '30000000-0000-4000-8000-000000000001';
const writable = {
  contactId,
  currency: 'CZK',
  customerId,
  description: 'Potential annual agreement',
  expectedCloseDate: '2026-12-31',
  expectedValue: 12_345.67,
  title: 'Annual agreement',
} as const;

test('keeps Deal payloads scope-free and reserves status, deletion, and optimistic state', async () => {
  assert.deepEqual(
    await decode(CreateDealPayloadSchema, {
      ...writable,
      deletedAt: 'forbidden',
      legalEntityId: 'forbidden',
      status: 'Won',
      tenantId: 'forbidden',
    }),
    writable,
  );
  assert.deepEqual(
    await decode(EditDealPayloadSchema, {
      ...writable,
      dealId,
      deletedAt: 'forbidden',
      expectedVersion: 2,
      status: 'Lost',
    }),
    { ...writable, dealId, expectedVersion: 2 },
  );
  assert.deepEqual(
    await decode(DeleteDealPayloadSchema, {
      dealId,
      expectedVersion: 2,
      status: 'Lost',
    }),
    { dealId, expectedVersion: 2 },
  );
});

test('validates and normalizes Deal money, currency, dates, and trimmed fields', async () => {
  assert.deepEqual(
    await Effect.runPromise(
      normalizeDealFields({
        ...writable,
        description: '  Potential annual agreement  ',
        title: '  Annual agreement  ',
      }),
    ),
    writable,
  );
  await Promise.all(
    [
      { ...writable, currency: 'czk' },
      { ...writable, currency: 'ZZZ' },
      { ...writable, expectedCloseDate: '2026-02-30' },
      { ...writable, expectedValue: -1 },
      { ...writable, expectedValue: 1.234 },
    ].map((invalid) => assert.rejects(decode(CreateDealPayloadSchema, invalid))),
  );
  await assert.rejects(
    Effect.runPromise(normalizeDealFields({ ...writable, title: ' ' })),
    (error: { readonly _tag?: string }) => error._tag === 'DealValidationError',
  );
  const withoutContact = await Effect.runPromise(
    normalizeDealFields({ ...writable, contactId: null }),
  );
  assert.equal(withoutContact.contactId, null);
});

test('exposes fixed status output and bounded deterministic list cursors and filters', async () => {
  const row = {
    ...writable,
    createdAt: new Date('2026-08-12T09:00:00.000Z'),
    dealId,
    deletedAt: null,
    legalEntityId: '40000000-0000-4000-8000-000000000001',
    status: 'New' as const,
    tenantId: '50000000-0000-4000-8000-000000000001',
    updatedAt: new Date('2026-08-12T10:00:00.000Z'),
    version: 1,
  };
  const view = dealRowToView(row, 'Acme', 'Ada Lovelace');
  await decode(DealViewSchema, view);
  assert.equal(view.status, 'New');
  const cursor = encodeDealCursor(view);
  assert.deepEqual(decodeDealCursor(cursor), {
    dealId,
    updatedAt: new Date('2026-08-12T10:00:00.000Z'),
  });
  assert.equal(decodeDealCursor(`${cursor}x`), undefined);
  await decode(DealWorkspaceRequestSchema, {
    cursor,
    customerId,
    limit: 100,
    operation: 'list',
  });
  await assert.rejects(
    decode(DealWorkspaceRequestSchema, {
      customerId: 'not-a-uuid',
      limit: 10,
      operation: 'list',
    }),
  );
  await assert.rejects(decode(DealWorkspaceRequestSchema, { limit: 101, operation: 'list' }));
});

test('declares owner-local idempotent Deal Actions and only create/delete events', () => {
  for (const action of [createDealAction, editDealAction, deleteDealAction]) {
    assert.equal(action.descriptor.owningModuleKey, 'crm.core');
    assert.equal(action.descriptor.entrypoint.access, 'write');
    assert.equal(action.descriptor.idempotency, 'required');
    assert.equal(action.descriptor.legalEntityScope, 'required');
  }
  assert.deepEqual(Object.keys(createDealAction.descriptor.domainEvents), [
    'crm.core.deal.created',
  ]);
  assert.deepEqual(Object.keys(editDealAction.descriptor.domainEvents), []);
  assert.deepEqual(Object.keys(deleteDealAction.descriptor.domainEvents), [
    'crm.core.deal.deleted',
  ]);
});

test('maps the full Deal transport vocabulary and keeps private code out of clients', async () => {
  const artifacts = await Promise.all(
    (['create', 'edit', 'delete'] as const).map(async (action) => ({
      action,
      client: await readFile(
        path.resolve(import.meta.dirname, `../../src/api/${action}-deal-action-client.ts`),
        'utf-8',
      ),
      server: await readFile(
        path.resolve(import.meta.dirname, `../../api/${action}-deal-action-server.ts`),
        'utf-8',
      ),
    })),
  );
  for (const { action, client, server } of artifacts) {
    assert.match(
      server,
      new RegExp(`${action[0]?.toUpperCase()}${action.slice(1)}DealUnavailable`, 'u'),
    );
    for (const status of ['400', '401', '403', '404', '409', '422', '500', '503']) {
      assert.match(server, new RegExp(`${status} as const`, 'u'));
    }
    assert.match(server, /www-authenticate/u);
    assert.doesNotMatch(server, /deal\.handler/u);

    assert.match(client, /makeEffectHttpApiClient/u);
    assert.doesNotMatch(client, /handler|deal-repository|deal-service/u);
  }
  const workspaceClient = await readFile(
    path.resolve(import.meta.dirname, '../../src/api/deal-workspace-client.ts'),
    'utf-8',
  );
  assert.match(workspaceClient, /makeEffectHttpApiClient/u);
  assert.doesNotMatch(workspaceClient, /handler|deal-repository|deal-service/u);

  const provider = await readFile(
    path.resolve(import.meta.dirname, '../../src/api/deal-detail.read.ts'),
    'utf-8',
  );
  assert.match(provider, /makeDealService/u);
  assert.match(provider, /getDeal\(input\.resourceId\)/u);
  assert.match(provider, /captureMode: 'metadata_only'/u);
  assert.doesNotMatch(provider, /no business implementation/u);
});
