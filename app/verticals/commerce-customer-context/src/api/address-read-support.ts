import { ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { Effect } from 'effect';
import type { AddressBookProfile } from '../../shared/domain/address-book.ts';
import {
  deliveryDestinationPortsForTransaction,
  composeAddressExternalResolutionPorts,
  invoiceRecipientPortsForTransaction,
} from '../persistence/address-persistence.ts';
import type { AddressExternalResolutionPorts } from '../persistence/address-persistence.ts';
import { partyBackedPostalAddressResolver } from '../integrations/party-address-source.ts';

type DeliveryDestinationReadServices = ReturnType<typeof deliveryDestinationPortsForTransaction>;
type InvoiceRecipientReadServices = ReturnType<typeof invoiceRecipientPortsForTransaction>;

export type AddressExternalResolutionPortsFactory = (
  scope: OperationalScope,
) => Partial<AddressExternalResolutionPorts>;

const partyAddressResolutionPorts: AddressExternalResolutionPortsFactory = (scope) => ({
  resolvePartyPostalAddress: partyBackedPostalAddressResolver(scope.correlationId),
});

export const makeDeliveryDestinationReadServiceFactory =
  (
    externalForScope: AddressExternalResolutionPortsFactory = partyAddressResolutionPorts,
  ): ReadServiceFactory<DeliveryDestinationReadServices> =>
  (transaction, scope) =>
    Effect.succeed(
      deliveryDestinationPortsForTransaction(
        transaction,
        scope,
        composeAddressExternalResolutionPorts(externalForScope(scope)),
      ),
    );

export const deliveryDestinationReadServiceFactory = makeDeliveryDestinationReadServiceFactory();

export const makeInvoiceRecipientReadServiceFactory =
  (
    externalForScope: AddressExternalResolutionPortsFactory = partyAddressResolutionPorts,
  ): ReadServiceFactory<InvoiceRecipientReadServices> =>
  (transaction, scope) =>
    Effect.succeed(
      invoiceRecipientPortsForTransaction(
        transaction,
        scope,
        composeAddressExternalResolutionPorts(externalForScope(scope)),
      ),
    );

export const invoiceRecipientReadServiceFactory = makeInvoiceRecipientReadServiceFactory();

export const unavailableRead = <A>(
  reason = 'Address Book persistence is temporarily unavailable',
): Effect.Effect<A, ReadHandlerUnavailable> =>
  Effect.fail(new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason }));
export const notFoundRead = (reason: string) =>
  new ReadHandlerNotFound({ code: 'read_handler_not_found', reason });
export const profileTarget = (
  input: { readonly profile: AddressBookProfile },
  scope: OperationalScope,
) => {
  const legalEntityId = scope.legalEntityId ?? 'missing-required-legal-entity-scope';
  return {
    businessPermission:
      input.profile.kind === 'COUNTERPARTY'
        ? {
            permission: 'counterparty.address_book.use' as const,
            target: {
              counterpartyId: input.profile.counterpartyRef.resourceId,
              kind: 'counterparty' as const,
              legalEntityId,
              tenantId: scope.tenantId,
            },
          }
        : {
            permission: 'retail.address_book.use' as const,
            target: {
              kind: 'retail_profile' as const,
              legalEntityId,
              profileId: input.profile.profileRef.resourceId,
              tenantId: scope.tenantId,
            },
          },
    kind: 'business_permission' as const,
  };
};
