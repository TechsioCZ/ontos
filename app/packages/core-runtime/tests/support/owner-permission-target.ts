import { defineBusinessPermission } from '../../src/permissions/business-permission.ts';
import { createOwnerPermissionAccessTarget } from '../../src/permissions/context-access.ts';
import type { OwnerPermissionAccessTarget, OwnerPermissionContract } from '../../src/permissions/context-access.ts';

export const fixtureOwnerModule = 'commerce.fixture';
const permission = (key: string) =>
  defineBusinessPermission({
    allowedScopeKinds: ['fixture_target'],
    auditSensitivity: 'sensitive',
    authorityGroups: [],
    customerDelegable: false,
    internalGrantable: false,
    key,
    meaning: 'Protect the exact test-owner target.',
    owningCapability: fixtureOwnerModule,
    protectedEntrypoints: [],
    schemaVersion: '1',
  });
export const fixtureOwnerReadPermission = permission('fixture.read');
export const fixtureOwnerEndPermission = permission('fixture.end');
export const fixtureOwnerCreatePermission = permission('fixture.create');
export const fixtureOwnerContract = Object.freeze({
  owningModuleKey: fixtureOwnerModule,
  permissions: Object.freeze([fixtureOwnerReadPermission, fixtureOwnerEndPermission, fixtureOwnerCreatePermission]),
  schemaVersion: '1',
  targetResourceType: 'fixture_permission',
}) satisfies OwnerPermissionContract;

export const ownerPermissionTarget = (
  scope: Readonly<{ readonly legalEntityId?: string; readonly tenantId: string }>,
  id = 'existing',
  options: Partial<Omit<OwnerPermissionAccessTarget, 'contract'>> = {},
): OwnerPermissionAccessTarget => {
  const targetScope =
    scope.legalEntityId === undefined
      ? { kind: 'tenant' as const, tenantId: scope.tenantId }
      : { kind: 'legal_entity' as const, legalEntityId: scope.legalEntityId, tenantId: scope.tenantId };
  return createOwnerPermissionAccessTarget(fixtureOwnerContract, {
    definition: fixtureOwnerReadPermission,
    key: `${scope.tenantId}:${scope.legalEntityId ?? 'tenant'}:${id}`,
    objectId: `owner-${id}`,
    scope: targetScope,
    scopeKind: 'fixture_target',
    target: Object.freeze({ id }),
    transportModuleKey: fixtureOwnerModule,
    transportObjectId: `owner-${id}`,
    ...options,
  });
};
