// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Schema } from 'effect';
import {
  AttachOrganizationEngagementPayloadSchema,
  AttachPersonEngagementPayloadSchema,
  contactsApiContract,
  contactsOperationContexts,
} from '../../shared/api.ts';

const tenantId = 'd1000000-0000-4000-8000-000000000001';
const partyRef = {
  moduleId: 'party.registry',
  resourceId: 'd2000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: 'd3000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;

test('publishes only typed engagement profile operation paths', () => {
  assert.equal(contactsApiContract.readinessPath, '/contacts-api/contacts/readiness');
  assert.deepEqual(
    Object.values(contactsOperationContexts)
      .map(({ routePath }) => routePath)
      .toSorted(),
    [
      '/contacts/engagement/organizations/archive',
      '/contacts/engagement/organizations/attach',
      '/contacts/engagement/organizations/unarchive',
      '/contacts/engagement/people/archive',
      '/contacts/engagement/people/attach',
      '/contacts/engagement/people/unarchive',
      '/contacts/readiness',
      '/reads/organization-engagement-profile',
      '/reads/person-engagement-profile',
    ],
  );
});

test('attach contracts accept only public Party Registry refs', () => {
  const payload = { counterpartyRef, partyRef };
  assert.deepEqual(
    Schema.decodeUnknownSync(AttachOrganizationEngagementPayloadSchema)(payload),
    payload,
  );
  assert.deepEqual(Schema.decodeUnknownSync(AttachPersonEngagementPayloadSchema)(payload), payload);

  for (const schema of [
    AttachOrganizationEngagementPayloadSchema,
    AttachPersonEngagementPayloadSchema,
  ] as const) {
    assert.deepEqual(
      Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })({ partyRef }),
      { partyRef },
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })({
        ...payload,
        customerId: 'd4000000-0000-4000-8000-000000000001',
      }),
    );
  }
});

test('public Contacts API and client no longer expose identity-owned operations', async () => {
  const [apiSource, clientSource] = await Promise.all([
    readFile(new URL('../../shared/api.ts', import.meta.url), 'utf-8'),
    readFile(new URL('../../src/api/contacts-client.ts', import.meta.url), 'utf-8'),
  ]);

  for (const source of [apiSource, clientSource]) {
    assert.doesNotMatch(
      source,
      /\b(?:createCustomer|editCustomer|archiveCustomer|unarchiveCustomer)\b/u,
    );
    assert.doesNotMatch(
      source,
      /\b(?:createContact|editContact|archiveContact|unarchiveContact)\b/u,
    );
    assert.doesNotMatch(source, /CustomerAresLookup|customerId|contactId/u);
  }
});
