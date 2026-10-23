import { PartyContactPointsResponseSchema, PartyDetailResponseSchema } from '@app/party-registry/api';
import { Array as EffectArray, Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { projectCustomerOwnProfile, selectProfileContact } from '../../api/portal-auth/profile/party-profile.ts';
import { CustomerOwnProfileSchema, UpdateCustomerOwnProfileSchema } from '../../shared/portal-auth/profile-api.ts';
import {
  customerProfileReadOwnEntrypoint,
  customerProfileUpdateOwnEntrypoint,
} from '../../shared/portal-auth/profile-entrypoints.ts';
import {
  customerProfileReadOwnPermission,
  customerProfileUpdateOwnPermission,
} from '../../shared/permissions/customer-profile-self-service.ts';
import { commercePortalAuthAuditRecord } from '../../src/portal-auth/audit/audit-mapping.ts';

const tenantId = '7eb07e30-95be-498a-aefd-feb06fb54f24';
const partyRef = {
  moduleId: 'party.registry',
  resourceId: '6a5aaa8a-2222-4222-8222-222222222222',
  resourceType: 'party.registry.party',
  tenantId,
};
const at = '2026-10-23T12:00:00.000Z';
const detail = Schema.decodeUnknownEffect(PartyDetailResponseSchema)({
  currentFactAssertions: [],
  factHistory: null,
  party: {
    archivedAt: null,
    createdAt: at,
    displayName: 'Customer Name',
    partyRef,
    partyType: 'PERSON',
    revision: 3,
    updatedAt: at,
  },
  resolution: { aliasChain: [], canonicalPartyRef: partyRef, kind: 'DIRECT', requestedPartyRef: partyRef },
});
const contact = (id: string, preferred: boolean, revision = 1, current = true) => ({
  contactPointRef: {
    moduleId: 'party.registry',
    resourceId: id,
    resourceType: 'party.registry.party-contact-point',
    tenantId,
  },
  current,
  end: null,
  partyRef,
  privacyClassification: 'PERSONAL',
  provenance: { authoritative: false, method: 'DECLARED_BY_PARTY', source: 'PARTY_DECLARATION' },
  recordedAt: at,
  revision,
  state: current ? 'ACTIVE' : 'SUPERSEDED',
  storedPartyRef: partyRef,
  validFrom: at,
  validTo: null,
  value: {
    displayValue: `${id.slice(0, 8)}@example.test`,
    lookupValue: `${id.slice(0, 8)}@example.test`,
    preferred,
    type: 'EMAIL',
  },
  verification: { state: 'UNVERIFIED' },
});
const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const request = {
  contactEmail: 'customer@example.test',
  displayName: 'Customer Name',
  phone: '+420777123456',
  version: 'a'.repeat(64),
};

it('accepts editable profile data but rejects every browser identity and credential field', () => {
  const decode = Schema.decodeUnknownResult(UpdateCustomerOwnProfileSchema, { onExcessProperty: 'error' });
  expect(Result.isSuccess(decode(request))).toBe(true);
  for (const key of [
    'partyId',
    'tenantId',
    'legalEntityId',
    'contactPointRef',
    'providerSubjectId',
    'email',
    'password',
  ]) {
    expect(Result.isFailure(decode({ ...request, [key]: 'forged-other-customer' }))).toBe(true);
  }
  for (const input of [
    { ...request, phone: 'not-a-phone' },
    { ...request, displayName: '' },
    { ...request, displayName: 'x'.repeat(301) },
    { ...request, contactEmail: 'invalid' },
    { ...request, version: '' },
  ]) {
    expect(Result.isFailure(decode(input))).toBe(true);
  }
});

it('reads absent native names without inventing a value and permits the full native editable name length', () => {
  const read = Schema.decodeUnknownResult(CustomerOwnProfileSchema);
  const update = Schema.decodeUnknownResult(UpdateCustomerOwnProfileSchema);
  expect(Result.isSuccess(read({ ...request, displayName: '' }))).toBe(true);
  expect(Result.isSuccess(read({ ...request, displayName: 'x'.repeat(300) }))).toBe(true);
  expect(Result.isSuccess(update({ ...request, displayName: 'x'.repeat(300) }))).toBe(true);
});

it.effect('selects only live contacts, prefers the owner preference, and resolves ties deterministically', () =>
  Effect.gen(function* assertContactSelection() {
    const contacts = yield* Schema.decodeUnknownEffect(PartyContactPointsResponseSchema)({
      items: [contact(secondId, true), contact(firstId, false)],
    });
    expect(selectProfileContact(contacts.items, 'EMAIL')?.contactPointRef.resourceId).toBe(secondId);
    expect(selectProfileContact(contacts.items, 'PHONE')).toBeUndefined();
    const ties = yield* Schema.decodeUnknownEffect(PartyContactPointsResponseSchema)({
      items: [contact(secondId, true), contact(firstId, true)],
    });
    expect(selectProfileContact(ties.items, 'EMAIL')?.contactPointRef.resourceId).toBe(firstId);
    const ended = yield* Schema.decodeUnknownEffect(PartyContactPointsResponseSchema)({
      items: [contact(firstId, true, 2, false), contact(secondId, false)],
    });
    expect(selectProfileContact(ended.items, 'EMAIL')?.contactPointRef.resourceId).toBe(secondId);
  }),
);

it.effect(
  'projects native owner values, never login email, and versions all contact revisions independent of order',
  () =>
    Effect.gen(function* assertProfileProjection() {
      const party = yield* detail;
      const contacts = yield* Schema.decodeUnknownEffect(PartyContactPointsResponseSchema)({
        items: [contact(firstId, true), contact(secondId, false)],
      });
      const profile = projectCustomerOwnProfile(party, contacts);
      expect(profile.displayName).toBe('Customer Name');
      expect(profile.phone).toBe('');
      expect(profile.contactEmail).toBe('11111111@example.test');
      expect(profile.version).toMatch(/^[a-f0-9]{64}$/u);
      expect(projectCustomerOwnProfile(party, { items: EffectArray.reverse(contacts.items) }).version).toBe(
        profile.version,
      );
      const changed = yield* Schema.decodeUnknownEffect(PartyContactPointsResponseSchema)({
        items: [contact(firstId, true), contact(secondId, false, 2)],
      });
      expect(projectCustomerOwnProfile(party, changed).version).not.toBe(profile.version);
    }),
);

it('declares distinct read/write context permissions, never storefront Party access', () => {
  expect(customerProfileReadOwnEntrypoint.access).toBe('read');
  expect(customerProfileUpdateOwnEntrypoint.access).toBe('write');
  for (const [entrypoint, permission] of [
    [customerProfileReadOwnEntrypoint, customerProfileReadOwnPermission],
    [customerProfileUpdateOwnEntrypoint, customerProfileUpdateOwnPermission],
  ] as const) {
    expect(entrypoint.authorization).toEqual({ kind: 'context_permission', permission: permission.key });
    expect(permission.allowedScopeKinds).toEqual(['module']);
    expect(permission.protectedEntrypoints).toEqual([entrypoint.entrypointKey]);
    expect(entrypoint.moduleKey).toBe('commerce.customer-context');
  }
});

it('projects strict profile intent/completion evidence without editable PII', () => {
  const record = commercePortalAuthAuditRecord({
    correlationDigest: 'c'.repeat(64),
    eventType: 'commerce.portal-auth.profile-updated.v1',
    occurredAt: new Date(at),
    operation: 'customer-profile-update',
    outcome: 'success',
    providerSubjectId: 'opaque-subject',
  });
  expect(record.eventType).toBe('commerce.portal-auth.profile-updated.v1');
  expect(record.outcome).toBe('success');
  expect(JSON.stringify(record)).not.toContain(request.contactEmail);
  expect(Object.keys(record)).not.toContain('partyId');
});
