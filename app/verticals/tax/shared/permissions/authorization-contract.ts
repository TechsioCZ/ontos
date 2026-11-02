import type { OwnerPermissionContract } from '@app/core-runtime';
import { taxRuleManagePermission } from './tax-rule-manage.ts';

export const taxRuleAuthorizationContract = Object.freeze({
  ownerStateRequired: false,
  owningModuleKey: 'commerce.tax',
  permissions: Object.freeze([taxRuleManagePermission]),
  schemaVersion: '1',
  targetResourceType: 'business_permission',
}) satisfies OwnerPermissionContract;
