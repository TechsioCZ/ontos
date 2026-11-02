import type { OwnerPermissionContract } from '@app/core-runtime';
import { assortmentBindingCreatePermission } from './assortment-binding-create.ts';
import { assortmentBindingEndPermission } from './assortment-binding-end.ts';
import { assortmentBoundaryCreatePermission } from './assortment-boundary-create.ts';
import { assortmentBoundaryEndPermission } from './assortment-boundary-end.ts';
import { assortmentConfigurationReadPermission } from './assortment-configuration-read.ts';
import { assortmentDecisionExplainPermission } from './assortment-decision-explain.ts';
import { assortmentRuleCreatePermission } from './assortment-rule-create.ts';
import { assortmentRuleRetirePermission } from './assortment-rule-retire.ts';
import { assortmentRuleRevisionCreatePermission } from './assortment-rule-revision-create.ts';

export const assortmentAuthorizationContract = Object.freeze({
  owningCapability: 'commerce.assortment',
  permissions: Object.freeze([
    assortmentBindingCreatePermission,
    assortmentBindingEndPermission,
    assortmentBoundaryCreatePermission,
    assortmentBoundaryEndPermission,
    assortmentConfigurationReadPermission,
    assortmentDecisionExplainPermission,
    assortmentRuleCreatePermission,
    assortmentRuleRetirePermission,
    assortmentRuleRevisionCreatePermission,
  ]),
  schemaVersion: '1',
  targetResourceType: 'assortment_permission',
}) satisfies OwnerPermissionContract;
