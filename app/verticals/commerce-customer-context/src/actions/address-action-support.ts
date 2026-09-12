import type { OperationalScope } from '@app/core-runtime';
import type { AddressBookProfile } from '../../shared/domain/address-book.ts';

export const manageAddressPermissionTarget = (
  payload: { readonly profile: AddressBookProfile },
  scope: OperationalScope,
) => {
  const legalEntityId = scope.legalEntityId ?? 'missing-required-legal-entity-scope';
  return payload.profile.kind === 'COUNTERPARTY'
    ? {
        permission: 'counterparty.address_book.manage' as const,
        target: {
          counterpartyId: payload.profile.counterpartyRef.resourceId,
          kind: 'counterparty' as const,
          legalEntityId,
          tenantId: scope.tenantId,
        },
      }
    : {
        permission: 'retail.address_book.manage' as const,
        target: {
          kind: 'retail_profile' as const,
          legalEntityId,
          profileId: payload.profile.profileRef.resourceId,
          tenantId: scope.tenantId,
        },
      };
};
