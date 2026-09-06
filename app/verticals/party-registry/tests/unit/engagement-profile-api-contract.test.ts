// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Schema } from 'effect';
import {
  AttachOrganizationEngagementPayloadSchema,
  AttachPersonEngagementPayloadSchema,
  engagementProfileOperationContexts,
  partyRegistryApiContract,
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

test('publishes engagement operations from the Party Registry API boundary', () => {
  assert.equal(
    partyRegistryApiContract.readinessPath,
    '/party-registry-api/party-registry/readiness',
  );
  assert.deepEqual(
    Object.values(engagementProfileOperationContexts)
      .map(({ routePath }) => routePath)
      .toSorted(),
    [
      '/contacts/engagement/organizations/archive',
      '/contacts/engagement/organizations/attach',
      '/contacts/engagement/organizations/unarchive',
      '/contacts/engagement/people/archive',
      '/contacts/engagement/people/attach',
      '/contacts/engagement/people/unarchive',
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

test('public Party Registry engagement API does not expose legacy identity operations', async () => {
  const [apiSource, clientSource] = await Promise.all([
    readFile(new URL('../../shared/engagement-profile-api.ts', import.meta.url), 'utf-8'),
    readFile(new URL('../../src/api/engagement-profile-client.ts', import.meta.url), 'utf-8'),
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
