import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { Crypto, Effect } from 'effect';
import {
  deliveryDestinationPortsForTransaction,
  composeAddressExternalResolutionPorts,
  invoiceRecipientPortsForTransaction,
} from '../persistence/address-persistence.ts';
import type { AddressExternalResolutionPorts } from '../persistence/address-persistence.ts';
import { partyBackedPostalAddressResolverForScope } from '../integrations/party-address-source.ts';

type DeliveryDestinationReadServices = ReturnType<typeof deliveryDestinationPortsForTransaction>;
type InvoiceRecipientReadServices = ReturnType<typeof invoiceRecipientPortsForTransaction>;

type AddressExternalResolutionPortsFactory = (
  scope: OperationalScope,
  crypto: Crypto.Crypto,
  requirementKey:
    | 'commerce.customer-context.requirement.delivery-destination-resolution-party'
    | 'commerce.customer-context.requirement.invoice-recipient-resolution-party',
) => Partial<AddressExternalResolutionPorts>;

const partyAddressResolutionPorts: AddressExternalResolutionPortsFactory = (scope, crypto, requirementKey) => ({
  resolvePartyPostalAddress: partyBackedPostalAddressResolverForScope(scope, crypto, requirementKey),
});

const makeDeliveryDestinationReadServiceFactory = (
  externalForScope: AddressExternalResolutionPortsFactory = partyAddressResolutionPorts,
): ReadServiceFactory<DeliveryDestinationReadServices, Crypto.Crypto> =>
  Effect.fn('AddressReadSupport.makeDeliveryDestinationReadServiceFactory')(
    function* deliveryDestinationServices(transaction, scope) {
      const crypto = yield* Crypto.Crypto;
      return deliveryDestinationPortsForTransaction(
        transaction,
        scope,
        composeAddressExternalResolutionPorts(
          externalForScope(
            scope,
            crypto,
            'commerce.customer-context.requirement.delivery-destination-resolution-party',
          ),
        ),
      );
    },
  );

export const deliveryDestinationReadServiceFactory = makeDeliveryDestinationReadServiceFactory();

const makeInvoiceRecipientReadServiceFactory = (
  externalForScope: AddressExternalResolutionPortsFactory = partyAddressResolutionPorts,
): ReadServiceFactory<InvoiceRecipientReadServices, Crypto.Crypto> =>
  Effect.fn('AddressReadSupport.makeInvoiceRecipientReadServiceFactory')(
    function* invoiceRecipientServices(transaction, scope) {
      const crypto = yield* Crypto.Crypto;
      return invoiceRecipientPortsForTransaction(
        transaction,
        scope,
        composeAddressExternalResolutionPorts(
          externalForScope(scope, crypto, 'commerce.customer-context.requirement.invoice-recipient-resolution-party'),
        ),
      );
    },
  );

export const invoiceRecipientReadServiceFactory = makeInvoiceRecipientReadServiceFactory();
