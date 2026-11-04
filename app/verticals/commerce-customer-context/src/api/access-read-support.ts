import { customerOwnerPermissionTarget } from '../permissions/authorization.ts';
import type { OperationalScope } from '@app/core-runtime';
import type { CounterpartyPermissionScope, CounterpartyRef } from '../../shared/domain/access-contract.ts';

export const counterpartyAccessReadPermissionTarget = (
  input: {
    readonly counterpartyRef: CounterpartyRef;
    readonly scope: CounterpartyPermissionScope;
  },
  operationalScope: OperationalScope,
) => {
  if (input.scope.kind === 'counterparty') {
    return {
      kind: 'owner_permission' as const,
      ownerPermission: customerOwnerPermissionTarget({
        permission: 'counterparty.access.read',
        target: {
          counterpartyId: input.counterpartyRef.resourceId,
          kind: 'counterparty' as const,
          legalEntityId: operationalScope.legalEntityId ?? '',
          tenantId: operationalScope.tenantId,
        },
      }),
    };
  }
  const target = {
    kind: 'owner_permission' as const,
    ownerPermission: customerOwnerPermissionTarget({
      permission: 'counterparty.access.read',
      target: {
        counterpartyId: input.counterpartyRef.resourceId,
        kind: 'counterparty_storefront' as const,
        legalEntityId: operationalScope.legalEntityId ?? '',
        storefrontId: input.scope.storefrontKey,
        tenantId: operationalScope.tenantId,
      },
    }),
  };
  if (operationalScope.trustedStorefrontId === undefined) {
    return target;
  }
  return { ...target, trustedStorefrontId: operationalScope.trustedStorefrontId };
};
