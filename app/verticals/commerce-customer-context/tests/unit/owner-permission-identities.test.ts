import { expect, it } from 'effect-rstest';
import {
  customerOwnerPermissionTarget,
  customerPermissionKey,
  customerPermissionObjectId,
} from '../../src/permissions/authorization.ts';
import type { CustomerPermissionRequest } from '../../src/permissions/authorization.ts';

// Exact literals copied from the corrected pre-extraction f580298e Core baseline.
// Expected values never call an encoder or import another owner's test fixture.
const tenantId = '00000000-0000-4000-8000-000000000001';
const legalEntityId = '00000000-0000-4000-8000-000000000002';

it('preserves the literal retail_profile grant, key and history identities', () => {
  const request = {
    permission: 'retail.profile.read',
    target: { kind: 'retail_profile', legalEntityId, profileId: 'profile:one/á', tenantId },
  } satisfies CustomerPermissionRequest;
  const objectId =
    'ctx_WyJyZXRhaWwucHJvZmlsZS5yZWFkIiwiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAxIiwiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAyIiwicmV0YWlsX3Byb2ZpbGUiLCJwcm9maWxlOm9uZS_DoSJd';
  const key =
    'retail.profile.read:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:retail_profile:profile:one/á';
  const alternatives: readonly string[] = [];
  expect(customerPermissionObjectId(request)).toBe(objectId);
  expect(customerPermissionKey(request)).toBe(key);
  for (const transport of ['action', 'read'] as const) {
    const actual = customerOwnerPermissionTarget(request, transport);
    expect(actual.objectId).toBe(objectId);
    expect(actual.key).toBe(key);
    expect(actual.target).toEqual(request.target);
    expect(actual.scope).toEqual({ kind: 'legal_entity', legalEntityId, tenantId });
    expect(actual.requiredStorefrontId).toBe(undefined);
    expect(actual.alternativeObjectIds).toEqual(alternatives);
    // Exact Storefront first, then broad Counterparty; separate targets stay conjunctive.
    expect([actual.objectId, ...(actual.alternativeObjectIds ?? [])]).toEqual([objectId, ...alternatives]);
    expect(actual.transportObjectId).toBe('profile:one/á');
    expect(actual.transportModuleKey).toBe(
      transport === 'action' ? 'commerce.customer-context' : 'retail.profile.read',
    );
    expect(actual.transportResourceType).toBe(
      transport === 'action' ? 'retail_profile:retail.profile.read' : 'retail_profile',
    );
  }
});

it('preserves the literal counterparty grant, key and history identities', () => {
  const request = {
    permission: 'counterparty.purchase.submit',
    target: { counterpartyId: 'counterparty:one', kind: 'counterparty', legalEntityId, tenantId },
  } satisfies CustomerPermissionRequest;
  const objectId =
    'ctx_WyJjb3VudGVycGFydHkucHVyY2hhc2Uuc3VibWl0IiwiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAxIiwiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAyIiwiY291bnRlcnBhcnR5IiwiY291bnRlcnBhcnR5Om9uZSJd';
  const key =
    'counterparty.purchase.submit:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:counterparty:counterparty:one';
  const alternatives: readonly string[] = [];
  expect(customerPermissionObjectId(request)).toBe(objectId);
  expect(customerPermissionKey(request)).toBe(key);
  for (const transport of ['action', 'read'] as const) {
    const actual = customerOwnerPermissionTarget(request, transport);
    expect(actual.objectId).toBe(objectId);
    expect(actual.key).toBe(key);
    expect(actual.target).toEqual(request.target);
    expect(actual.scope).toEqual({ kind: 'legal_entity', legalEntityId, tenantId });
    expect(actual.requiredStorefrontId).toBe(undefined);
    expect(actual.alternativeObjectIds).toEqual(alternatives);
    // Exact Storefront first, then broad Counterparty; separate targets stay conjunctive.
    expect([actual.objectId, ...(actual.alternativeObjectIds ?? [])]).toEqual([objectId, ...alternatives]);
    expect(actual.transportObjectId).toBe('counterparty:one');
    expect(actual.transportModuleKey).toBe(
      transport === 'action' ? 'commerce.customer-context' : 'counterparty.purchase.submit',
    );
    expect(actual.transportResourceType).toBe(
      transport === 'action' ? 'counterparty:counterparty.purchase.submit' : 'counterparty',
    );
  }
});

it('preserves the literal counterparty_storefront grant, key and history identities', () => {
  const request = {
    permission: 'counterparty.purchase.submit',
    target: {
      counterpartyId: 'counterparty:one',
      kind: 'counterparty_storefront',
      legalEntityId,
      storefrontId: 'storefront-a',
      tenantId,
    },
  } satisfies CustomerPermissionRequest;
  const objectId =
    'ctx_WyJjb3VudGVycGFydHkucHVyY2hhc2Uuc3VibWl0IiwiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAxIiwiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAyIiwiY291bnRlcnBhcnR5X3N0b3JlZnJvbnQiLCJjb3VudGVycGFydHk6b25lIiwic3RvcmVmcm9udC1hIl0';
  const key =
    'counterparty.purchase.submit:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:counterparty_storefront:counterparty:one:storefront-a';
  const alternatives: readonly string[] = [
    'ctx_WyJjb3VudGVycGFydHkucHVyY2hhc2Uuc3VibWl0IiwiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAxIiwiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAyIiwiY291bnRlcnBhcnR5IiwiY291bnRlcnBhcnR5Om9uZSJd',
  ];
  expect(customerPermissionObjectId(request)).toBe(objectId);
  expect(customerPermissionKey(request)).toBe(key);
  for (const transport of ['action', 'read'] as const) {
    const actual = customerOwnerPermissionTarget(request, transport);
    expect(actual.objectId).toBe(objectId);
    expect(actual.key).toBe(key);
    expect(actual.target).toEqual(request.target);
    expect(actual.scope).toEqual({ kind: 'legal_entity', legalEntityId, tenantId });
    expect(actual.requiredStorefrontId).toBe('storefront-a');
    expect(actual.alternativeObjectIds).toEqual(alternatives);
    // Exact Storefront first, then broad Counterparty; separate targets stay conjunctive.
    expect([actual.objectId, ...(actual.alternativeObjectIds ?? [])]).toEqual([objectId, ...alternatives]);
    expect(actual.transportObjectId).toBe('counterparty:one:storefront-a');
    expect(actual.transportModuleKey).toBe(
      transport === 'action' ? 'commerce.customer-context' : 'counterparty.purchase.submit',
    );
    expect(actual.transportResourceType).toBe(
      transport === 'action' ? 'counterparty_storefront:counterparty.purchase.submit' : 'counterparty_storefront',
    );
  }
});
