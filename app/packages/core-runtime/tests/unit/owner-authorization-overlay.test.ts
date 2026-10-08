import { DateTime } from 'effect';
import { expect, it } from 'effect-rstest';

import type { OwnerAuthorizationInput } from '../../src/permissions/owner-authorization-overlay.ts';
import { failClosedOwnerAuthorizationDecision } from '../../src/permissions/owner-authorization-overlay.ts';

const input = (target: OwnerAuthorizationInput['targets'][number]): OwnerAuthorizationInput => ({
  operation: 'action',
  operationAt: DateTime.makeUnsafe(0),
  operationKey: 'commerce.assortment.create-closed-assortment-boundary',
  owningModuleKey: 'commerce.assortment',
  scope: {
    authContextRef: 'owner-overlay-test',
    authMethod: 'session',
    correlationId: 'owner-overlay-test',
    legalEntityId: '30000000-0000-4000-8000-000000000001',
    principalId: '20000000-0000-4000-8000-000000000001',
    tenantId: '10000000-0000-4000-8000-000000000001',
  },
  targets: [target],
});

it('fails closed for Assortment owner targets while keeping owner-neutral targets available', () => {
  const assortmentDecision = failClosedOwnerAuthorizationDecision(
    input({
      kind: 'assortment_permission',
      target: {
        admissionSet: { contentHash: 'a'.repeat(64), entries: [{ kind: 'ALL' }], memberCount: 1, setKind: 'ENTRIES' },
        commercialScope: {
          channel: {
            moduleId: 'commerce.channel',
            resourceId: 'web',
            resourceType: 'commerce.channel',
          },
        },
        effectiveFrom: '2026-09-28T00:00:00.000Z',
        kind: 'assortment_boundary',
        mode: 'create',
        permission: 'assortment.boundary.create',
        purpose: 'PURCHASE',
        subject: {
          kind: 'COUNTERPARTY',
          ref: {
            moduleId: 'party.registry',
            resourceId: 'counterparty-1',
            resourceType: 'party.registry.counterparty',
          },
        },
      },
    }),
  );

  const neutralDecision = failClosedOwnerAuthorizationDecision(
    input({ kind: 'module', moduleId: 'commerce.assortment' }),
  );

  expect(assortmentDecision).toBe('unavailable');
  expect(neutralDecision).toBe('allowed');
});

it('lets Core decide a TAX Selling Legal Entity target only for the exact trusted Legal Entity', () => {
  const { scope } = input({ kind: 'module', moduleId: 'commerce.tax' });
  const taxDecision = (legalEntityId: string | undefined, tenantId = scope.tenantId, permission = 'tax.rule.manage') =>
    failClosedOwnerAuthorizationDecision(
      input({
        kind: 'business_permission',
        permission,
        target: { kind: 'tax_selling_legal_entity', legalEntityId: legalEntityId ?? '', tenantId },
      }),
    );
  const ownerHeldDecision = failClosedOwnerAuthorizationDecision(
    input({
      kind: 'business_permission',
      permission: 'retail.profile.read',
      target: {
        kind: 'retail_profile',
        legalEntityId: scope.legalEntityId ?? '',
        profileId: 'profile-1',
        tenantId: scope.tenantId,
      },
    }),
  );

  expect(taxDecision(scope.legalEntityId)).toBe('allowed');
  expect(taxDecision(scope.legalEntityId, scope.tenantId, 'tax.source_assertion.record')).toBe('allowed');
  expect(taxDecision('30000000-0000-4000-8000-000000000002', scope.tenantId, 'tax.source_assertion.record')).toBe(
    'unavailable',
  );
  expect(taxDecision('30000000-0000-4000-8000-000000000002')).toBe('unavailable');
  expect(taxDecision(scope.legalEntityId, '10000000-0000-4000-8000-000000000002')).toBe('unavailable');
  expect(ownerHeldDecision).toBe('unavailable');
});
