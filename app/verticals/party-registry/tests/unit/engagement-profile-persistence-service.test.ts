// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime, Effect } from 'effect';
import {
  ensureReferencesBelongToTenant,
  organizationEngagementProfileFromRecord,
} from '../../src/services/engagement-profile-persistence.service.ts';
import type { OrganizationEngagementProfileRecord } from '../../src/db/engagement-schema.ts';

const tenantId = 'c1000000-0000-4000-8000-000000000001';
const refs = {
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: 'c4000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  partyRef: {
    moduleId: 'party.registry',
    resourceId: 'c2000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.party',
    tenantId,
  },
} as const;

const row: OrganizationEngagementProfileRecord = {
  archivedAt: null,
  counterpartyResourceId: refs.counterpartyRef.resourceId,
  createdAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-03T08:00:00.000Z')),
  engagementProfileId: 'c5000000-0000-4000-8000-000000000001',
  partyResourceId: refs.partyRef.resourceId,
  tenantId,
  updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-03T08:00:00.000Z')),
};

test('reconstructs typed references from the owner-local persistence record', () => {
  const result = organizationEngagementProfileFromRecord(row);
  assert.deepEqual(result.partyRef, refs.partyRef);
  assert.deepEqual(result.counterpartyRef, refs.counterpartyRef);
  assert.equal('name' in result, false);
  assert.equal('ico' in result, false);
  assert.equal(
    organizationEngagementProfileFromRecord({ ...row, counterpartyResourceId: null })
      .counterpartyRef,
    null,
  );
});

test('fails closed when a caller-supplied ref crosses the trusted tenant', async () => {
  const failure = await Effect.runPromise(
    Effect.flip(
      ensureReferencesBelongToTenant(tenantId, {
        ...refs,
        partyRef: { ...refs.partyRef, tenantId: 'c9000000-0000-4000-8000-000000000001' },
      }),
    ),
  );
  assert.equal(failure._tag, 'EngagementProfileConflict');
  assert.equal(failure.code, 'contacts_party_counterparty_mismatch');
});
