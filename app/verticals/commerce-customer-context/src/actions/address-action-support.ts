import type { OperationalScope } from '@app/core-runtime';
import { Effect } from 'effect';
import type { AddressBookProfile } from '../../shared/domain/address-book.ts';
import { AddressBookUnavailable } from '../../shared/domain/address-errors.ts';

export const unavailable = <A>(
  dependency = 'commerce.customer-context.persistence',
): Effect.Effect<A, AddressBookUnavailable> =>
  Effect.fail(
    new AddressBookUnavailable({ code: 'address_book_unavailable', dependency, retryable: true }),
  );
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
