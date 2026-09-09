import type { OperationalScope } from '@app/core-runtime';
import type {
  CounterpartyPermissionScope,
  CounterpartyRef,
} from '../../shared/domain/access-contract.ts';

export const counterpartyAccessReadPermissionTarget = (
  input: {
    readonly counterpartyRef: CounterpartyRef;
    readonly scope: CounterpartyPermissionScope;
  },
  operationalScope: OperationalScope,
) => {
  if (input.scope.kind === 'counterparty') {
    return {
      businessPermission: {
        permission: 'counterparty.access.read',
        target: {
          counterpartyId: input.counterpartyRef.resourceId,
          kind: 'counterparty' as const,
          legalEntityId: operationalScope.legalEntityId ?? '',
          tenantId: operationalScope.tenantId,
        },
      },
      kind: 'business_permission' as const,
    };
  }
  const target = {
    businessPermission: {
      permission: 'counterparty.access.read',
      target: {
        counterpartyId: input.counterpartyRef.resourceId,
        kind: 'counterparty_storefront' as const,
        legalEntityId: operationalScope.legalEntityId ?? '',
        storefrontId: input.scope.storefrontKey,
        tenantId: operationalScope.tenantId,
      },
    },
    kind: 'business_permission' as const,
  };
  if (operationalScope.trustedStorefrontId === undefined) {
    return target;
  }
  return { ...target, trustedStorefrontId: operationalScope.trustedStorefrontId };
};
