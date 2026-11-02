import { isOwnerPermissionAccessTargetValid } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';
import { taxRuleAuthorizationContract } from '../../shared/permissions/authorization-contract.ts';
import { taxRuleOwnerPermissionTarget } from '../../src/permissions/authorization.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const legalEntityId = '00000000-0000-4000-8000-000000000002';
const scope = {
  authMethod: 'system' as const,
  correlationId: 'tax-owner-contract',
  legalEntityId,
  principalId: 'tax-actor',
  tenantId,
};

it('preserves frozen seller grant and Action history identity without inventing owner state', () => {
  const target = taxRuleOwnerPermissionTarget(scope);
  expect(target.objectId).toBe(
    'ctx_WyJ0YXgucnVsZS5tYW5hZ2UiLCIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDIiLCJ0YXhfc2VsbGluZ19sZWdhbF9lbnRpdHkiXQ',
  );
  expect(target.key).toBe(
    'tax.rule.manage:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:tax_selling_legal_entity',
  );
  expect(target.transportModuleKey).toBe('commerce.tax');
  expect(target.transportObjectId).toBe(legalEntityId);
  expect(target.transportResourceType).toBe('tax_selling_legal_entity:tax.rule.manage');
  expect(taxRuleAuthorizationContract.ownerStateRequired).toBe(false);
  expect(isOwnerPermissionAccessTargetValid(target, scope, 'commerce.tax')).toBe(true);
  expect(isOwnerPermissionAccessTargetValid(target, { ...scope, legalEntityId: tenantId }, 'commerce.tax')).toBe(false);
  expect(isOwnerPermissionAccessTargetValid(target, { ...scope, tenantId: legalEntityId }, 'commerce.tax')).toBe(false);
});

it('cannot construct a rule-management target without the trusted Selling Legal Entity', () => {
  expect(() =>
    taxRuleOwnerPermissionTarget({
      authMethod: scope.authMethod,
      correlationId: scope.correlationId,
      principalId: scope.principalId,
      tenantId,
    }),
  ).toThrow();
});
