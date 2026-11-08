import { defineAccessPortalRole } from '@app/core-runtime/access/portal';

/*
 * The fixed roles of the people this module's portal serves (O70). Core assigns one to a person while this
 * module's own grant for that person is ACTIVE and ends it when the grant ends (`portal-access.ts`); the
 * role only opens the capability, and the module's owner rule still decides every record against the
 * person's own binding or Counterparty grant. Each list is exactly the capabilities whose entrypoints that
 * owner rule governs for that kind of person, so a role never opens an entrypoint the owner rule would not
 * narrow again.
 */

const MODULE_KEY = 'commerce.customer-context';

/**
 * A Retail customer bound to its Retail Customer Profile: every entrypoint whose owner facts name the
 * bound profile and a Retail Portal Permission.
 */
export const RETAIL_CUSTOMER_PORTAL_ROLE = defineAccessPortalRole({
  capabilities: [
    'commerce.customer-context.billing-address.clear-default',
    'commerce.customer-context.billing-address.set-default',
    'commerce.customer-context.customer-archive.read',
    'commerce.customer-context.customer-payment-term-entitlement.read',
    'commerce.customer-context.customer-price-group-assignment.read',
    'commerce.customer-context.customer-price-group.resolve',
    'commerce.customer-context.customer-profile.check-trading',
    'commerce.customer-context.customer-profile.read',
    'commerce.customer-context.customer-record-visibility.read',
    'commerce.customer-context.delivery-destination.clear-default',
    'commerce.customer-context.delivery-destination.resolve',
    'commerce.customer-context.delivery-destination.set-default',
    'commerce.customer-context.invoice-recipient.resolve',
    'commerce.customer-context.market-subject-restrictions.read',
    'commerce.customer-context.payment-terms.resolve',
    'commerce.customer-context.purchase-currency.resolve',
    'commerce.customer-context.repeat-order-preparation.read',
    'commerce.customer-context.retail-access.check',
    'commerce.customer-context.retail-order-history.read',
    'commerce.customer-context.retail-order-history.read-detail',
    'commerce.customer-context.retail-order.repeat',
    'commerce.customer-context.retail-payment-term-preference.change',
    'commerce.customer-context.retail-portal-profile-binding.read',
    'commerce.customer-context.retail-principal.resolve',
    'commerce.customer-context.saved-address-detail.personal.read',
    'commerce.customer-context.saved-address-list.personal.read',
    'commerce.customer-context.saved-address.add',
    'commerce.customer-context.saved-address.defaults-read',
    'commerce.customer-context.saved-address.list',
    'commerce.customer-context.saved-address.read',
    'commerce.customer-context.saved-address.remove',
    'commerce.customer-context.saved-address.update',
  ],
  key: 'commerce.customer-context.retail-customer',
  moduleKey: MODULE_KEY,
  name: 'Zákazník e-shopu',
});

/**
 * A person who proved they hold a Counterparty Access invitation's secret, until the claim consumes the
 * invitation: the claim itself and nothing else.
 */
export const COUNTERPARTY_INVITEE_PORTAL_ROLE = defineAccessPortalRole({
  capabilities: ['commerce.customer-context.counterparty-access-invitation.claim'],
  key: 'commerce.customer-context.counterparty-invitee',
  moduleKey: MODULE_KEY,
  name: 'Pozvaný zástupce odběratele',
});

/**
 * A person holding an ACTIVE Counterparty Commerce Access grant: every entrypoint of this module that a
 * grantable Counterparty Permission protects. The owner rule allows each one only with an ACTIVE grant of
 * exactly that Permission for the Counterparty it acts on.
 */
export const COUNTERPARTY_CUSTOMER_PORTAL_ROLE = defineAccessPortalRole({
  capabilities: [
    'commerce.customer-context.approval-hierarchy.create',
    'commerce.customer-context.billing-address.clear-default',
    'commerce.customer-context.billing-address.set-default',
    'commerce.customer-context.counterparty-access-invitation.create',
    'commerce.customer-context.counterparty-access-invitation.read',
    'commerce.customer-context.counterparty-access-invitation.resend',
    'commerce.customer-context.counterparty-access-invitation.revoke',
    'commerce.customer-context.counterparty-commerce-access.check',
    'commerce.customer-context.counterparty-commerce-access.grant',
    'commerce.customer-context.counterparty-commerce-access.list',
    'commerce.customer-context.counterparty-commerce-access.read-detail',
    'commerce.customer-context.counterparty-commerce-access.revoke',
    'commerce.customer-context.counterparty-customer-archive.read-all',
    'commerce.customer-context.counterparty-order-history.read-all',
    'commerce.customer-context.counterparty-order-history.read-detail-all',
    'commerce.customer-context.counterparty-order-history.read-detail-own',
    'commerce.customer-context.counterparty-order-history.read-own',
    'commerce.customer-context.counterparty-order.repeat',
    'commerce.customer-context.counterparty-price-group.assign',
    'commerce.customer-context.counterparty-price-group.migrate',
    'commerce.customer-context.counterparty-price-group.remove',
    'commerce.customer-context.counterparty-purchase-limit.change',
    'commerce.customer-context.customer-archive.read',
    'commerce.customer-context.customer-payment-term-entitlement.read',
    'commerce.customer-context.customer-payment-term.remove',
    'commerce.customer-context.customer-payment-terms.change',
    'commerce.customer-context.customer-price-group-assignment.read',
    'commerce.customer-context.customer-price-group.resolve',
    'commerce.customer-context.customer-profile.check-trading',
    'commerce.customer-context.customer-profile.read',
    'commerce.customer-context.delivery-destination.clear-default',
    'commerce.customer-context.delivery-destination.resolve',
    'commerce.customer-context.delivery-destination.set-default',
    'commerce.customer-context.invoice-recipient.resolve',
    'commerce.customer-context.market-subject-restrictions.read',
    'commerce.customer-context.order-commitment-approval.read-evidence',
    'commerce.customer-context.payment-terms.resolve',
    'commerce.customer-context.principal-purchase-limit-override.change',
    'commerce.customer-context.purchase-approval-request.decide',
    'commerce.customer-context.purchase-approval-request.submit',
    'commerce.customer-context.purchase-approval.trigger',
    'commerce.customer-context.purchase-currency.resolve',
    'commerce.customer-context.purchase-limit-policy.read',
    'commerce.customer-context.purchase-limit.evaluate',
    'commerce.customer-context.purchase-proposal-revision.create',
    'commerce.customer-context.repeat-order-preparation.read',
    'commerce.customer-context.saved-address-detail.personal.read',
    'commerce.customer-context.saved-address-list.personal.read',
    'commerce.customer-context.saved-address.add',
    'commerce.customer-context.saved-address.defaults-read',
    'commerce.customer-context.saved-address.list',
    'commerce.customer-context.saved-address.read',
    'commerce.customer-context.saved-address.remove',
    'commerce.customer-context.saved-address.update',
  ],
  key: 'commerce.customer-context.counterparty-customer',
  moduleKey: MODULE_KEY,
  name: 'Zástupce odběratele',
});
