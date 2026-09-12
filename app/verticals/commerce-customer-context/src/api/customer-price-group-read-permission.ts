import { defineReadConditionalPermission } from '@app/core-runtime';
import type {
  CommerceCustomerProfileTarget,
  PriceGroupAuthorizationSubject,
} from '../../shared/domain/price-group-contracts.ts';

export interface CustomerPriceGroupReadPermissionInput {
  readonly authorizationSubject: PriceGroupAuthorizationSubject;
  readonly profile: CommerceCustomerProfileTarget;
}

const profileResourceRead = (input: CustomerPriceGroupReadPermissionInput) => ({
  kind: 'resource_read' as const,
  permission: 'read' as const,
  resource: {
    moduleId: input.profile.moduleId,
    resourceId: input.profile.resourceId,
    resourceType: input.profile.resourceType,
  },
});

export const customerPriceGroupReadPermission = defineReadConditionalPermission<
  CustomerPriceGroupReadPermissionInput,
  PriceGroupAuthorizationSubject
>({
  branches: {
    COUNTERPARTY: {
      requiredKinds: ['business_permission', 'resource_read'],
      resolve: (input, selected, scope) => [
        {
          businessPermission: {
            permission: 'counterparty.profile.read',
            target: {
              counterpartyId: selected.counterpartyRef.resourceId,
              kind: 'counterparty',
              legalEntityId: scope.legalEntityId ?? '',
              tenantId: scope.tenantId,
            },
          },
          kind: 'business_permission',
        },
        profileResourceRead(input),
      ],
    },
    RETAIL: {
      requiredKinds: ['business_permission', 'resource_read'],
      resolve: (input, _selected, scope) => [
        {
          businessPermission: {
            permission: 'retail.profile.read',
            target: {
              kind: 'retail_profile',
              legalEntityId: scope.legalEntityId ?? '',
              profileId: input.profile.resourceId,
              tenantId: scope.tenantId,
            },
          },
          kind: 'business_permission',
        },
        profileResourceRead(input),
      ],
    },
  },
  permissionKey: 'module.access',
  select: (input) => input.authorizationSubject,
});
