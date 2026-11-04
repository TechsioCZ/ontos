import { describe, expect, it } from 'effect-rstest';
import {
  COUNTERPARTY_PERMISSION_CATALOG,
  COUNTERPARTY_PERMISSION_CODES,
} from '../../shared/domain/permission-catalog.ts';
import { counterpartyAccessManagePermission } from '../../shared/permissions/counterparty-access-manage.ts';
import { counterpartyAccessReadPermission } from '../../shared/permissions/counterparty-access-read.ts';
import { counterpartyAddressBookManagePermission } from '../../shared/permissions/counterparty-address-book-manage.ts';
import { counterpartyAddressBookUsePermission } from '../../shared/permissions/counterparty-address-book-use.ts';
import { counterpartyApprovalDecidePermission } from '../../shared/permissions/counterparty-approval-decide.ts';
import { counterpartyApprovalHierarchyManagePermission } from '../../shared/permissions/counterparty-approval-hierarchy-manage.ts';
import { counterpartyApprovalRequestManagePermission } from '../../shared/permissions/counterparty-approval-request-manage.ts';
import { counterpartyHistoryReadAllPermission } from '../../shared/permissions/counterparty-history-read-all.ts';
import { counterpartyHistoryReadOwnPermission } from '../../shared/permissions/counterparty-history-read-own.ts';
import { counterpartyProfileReadPermission } from '../../shared/permissions/counterparty-profile-read.ts';
import { counterpartyPurchaseLimitManagePermission } from '../../shared/permissions/counterparty-purchase-limit-manage.ts';
import { counterpartyPurchasePreparePermission } from '../../shared/permissions/counterparty-purchase-prepare.ts';
import { counterpartyPurchaseSubmitPermission } from '../../shared/permissions/counterparty-purchase-submit.ts';
import { counterpartySettingsPaymentTermsManagePermission } from '../../shared/permissions/counterparty-settings-payment-terms-manage.ts';
import { counterpartySettingsPriceGroupManagePermission } from '../../shared/permissions/counterparty-settings-price-group-manage.ts';
import { retailAddressBookManagePermission } from '../../shared/permissions/retail-address-book-manage.ts';
import { retailAddressBookUsePermission } from '../../shared/permissions/retail-address-book-use.ts';
import { retailAftercareReadPermission } from '../../shared/permissions/retail-aftercare-read.ts';
import { retailClaimCreatePermission } from '../../shared/permissions/retail-claim-create.ts';
import { retailConsentManagePermission } from '../../shared/permissions/retail-consent-manage.ts';
import { retailHistoryReadPermission } from '../../shared/permissions/retail-history-read.ts';
import { retailNotificationsManagePermission } from '../../shared/permissions/retail-notifications-manage.ts';
import { retailProfileReadPermission } from '../../shared/permissions/retail-profile-read.ts';
import { retailRepeatOrderPermission } from '../../shared/permissions/retail-repeat-order.ts';
import { retailSettingsPaymentTermPreferenceManagePermission } from '../../shared/permissions/retail-settings-payment-term-preference-manage.ts';
import { assignCounterpartyPriceGroupAction } from '../../src/actions/assign-counterparty-price-group.action.ts';
import { migrateCounterpartyPriceGroupAction } from '../../src/actions/migrate-counterparty-price-group.action.ts';
import { removeCounterpartyPriceGroupAction } from '../../src/actions/remove-counterparty-price-group.action.ts';
import { changeRetailPaymentTermPreferenceAction } from '../../src/actions/change-retail-payment-term-preference.action.ts';
import { repeatCounterpartyOrderAction } from '../../src/actions/repeat-counterparty-order.action.ts';
import { repeatRetailOrderAction } from '../../src/actions/repeat-retail-order.action.ts';
import { consumePurchaseApprovalAction } from '../../src/actions/consume-purchase-approval.action.ts';
import { decidePurchaseApprovalRequestAction } from '../../src/actions/decide-purchase-approval-request.action.ts';
import { reroutePurchaseApprovalRequestAction } from '../../src/actions/reroute-purchase-approval-request.action.ts';
import { revalidatePurchaseApprovalAction } from '../../src/actions/revalidate-purchase-approval.action.ts';
import { triggerPurchaseApprovalAction } from '../../src/actions/trigger-purchase-approval.action.ts';
import { purchaseLimitEvaluationRead } from '../../src/api/purchase-limit-evaluation.read.ts';
import { purchaseLimitPolicyReadRead } from '../../src/api/purchase-limit-policy-read.read.ts';
import { counterpartyAllOrderHistoryDetailRead } from '../../src/api/counterparty-all-order-history-detail.read.ts';
import { counterpartyOrderHistoryDetailRead } from '../../src/api/counterparty-order-history-detail.read.ts';
import { retailOrderHistoryDetailRead } from '../../src/api/retail-order-history-detail.read.ts';

const counterpartyPermissions = [
  counterpartyProfileReadPermission,
  counterpartyPurchasePreparePermission,
  counterpartyPurchaseSubmitPermission,
  counterpartyApprovalDecidePermission,
  counterpartyApprovalRequestManagePermission,
  counterpartyAccessReadPermission,
  counterpartyAccessManagePermission,
  counterpartySettingsPriceGroupManagePermission,
  counterpartySettingsPaymentTermsManagePermission,
  counterpartyAddressBookUsePermission,
  counterpartyAddressBookManagePermission,
  counterpartyHistoryReadOwnPermission,
  counterpartyHistoryReadAllPermission,
  counterpartyPurchaseLimitManagePermission,
  counterpartyApprovalHierarchyManagePermission,
] as const;

const retailPermissions = [
  retailProfileReadPermission,
  retailSettingsPaymentTermPreferenceManagePermission,
  retailAddressBookUsePermission,
  retailAddressBookManagePermission,
  retailHistoryReadPermission,
  retailRepeatOrderPermission,
  retailAftercareReadPermission,
  retailClaimCreatePermission,
  retailConsentManagePermission,
  retailNotificationsManagePermission,
] as const;

describe('generated Commerce customer permission descriptors', () => {
  it('matches every Counterparty descriptor to the canonical #328 catalog', () => {
    expect(counterpartyPermissions).toHaveLength(15);
    for (const code of COUNTERPARTY_PERMISSION_CODES) {
      const canonical = COUNTERPARTY_PERMISSION_CATALOG[code];
      const generated = counterpartyPermissions.find((candidate) => candidate.key === code);
      expect(generated).toBeDefined();
      if (generated === undefined) {
        continue;
      }
      expect(generated.allowedScopeKinds).toEqual(
        canonical.allowedScopes.map((scope) => (scope === 'counterparty' ? 'counterparty' : 'counterparty_storefront')),
      );
      expect(generated.authorityGroups).toEqual(canonical.authorityGroups);
      expect(generated.customerDelegable).toBe(canonical.customerDelegable);
      expect(generated.internalGrantable).toBe(canonical.internalGrantable);
      expect(generated.meaning).toBe(canonical.meaning);
      expect(generated.owningCapability).toBe(canonical.owningCapability);
      expect(generated.protectedEntrypoints).toEqual(canonical.protectedEntrypoints);
    }
  });

  it('publishes the exact #332 retail baseline without silently bundling optional permissions', () => {
    expect(retailPermissions).toHaveLength(10);
    expect(
      retailPermissions
        .filter(({ authorityGroups }) => authorityGroups.includes('RETAIL_PORTAL_SELF_SERVICE'))
        .map(({ key }) => key),
    ).toEqual([
      'retail.profile.read',
      'retail.address_book.use',
      'retail.address_book.manage',
      'retail.history.read',
      'retail.repeat_order',
      'retail.aftercare.read',
      'retail.claim.create',
      'retail.consent.manage',
    ]);
    for (const descriptor of retailPermissions) {
      expect(descriptor.allowedScopeKinds).toEqual(['retail_profile']);
      expect(descriptor.customerDelegable).toBe(false);
      expect(descriptor.internalGrantable).toBe(true);
      expect(descriptor.protectedEntrypoints.length).toBeGreaterThan(0);
    }
  });

  it('protects the exact Counterparty price-group Action inventory', () => {
    expect(counterpartySettingsPriceGroupManagePermission.protectedEntrypoints).toEqual(
      [assignCounterpartyPriceGroupAction, migrateCounterpartyPriceGroupAction, removeCounterpartyPriceGroupAction].map(
        ({ descriptor }) => descriptor.actionKey,
      ),
    );
    expect(counterpartySettingsPriceGroupManagePermission.protectedEntrypoints).not.toContain(
      'commerce.customer-context.assign-customer-price-group',
    );
  });

  it('inventories Counterparty and Retail profile authorization at the Launch currency Read', () => {
    expect(counterpartyProfileReadPermission.protectedEntrypoints).toContain(
      'commerce.customer-context.api.purchase-currency-resolution',
    );
    expect(retailProfileReadPermission.protectedEntrypoints).toContain(
      'commerce.customer-context.api.purchase-currency-resolution',
    );
  });

  it('keeps Retail preference authorization separate from Counterparty entitlements', () => {
    expect(retailSettingsPaymentTermPreferenceManagePermission.protectedEntrypoints).toEqual([
      changeRetailPaymentTermPreferenceAction.descriptor.actionKey,
    ]);
    expect(retailSettingsPaymentTermPreferenceManagePermission.protectedEntrypoints).not.toContain(
      'commerce.customer-context.change-customer-payment-terms',
    );
  });

  it('inventories history preparation Reads and their exact mutation Actions', () => {
    expect(counterpartyPurchasePreparePermission.protectedEntrypoints).toContain(
      repeatCounterpartyOrderAction.descriptor.actionKey,
    );
    expect(retailRepeatOrderPermission.protectedEntrypoints).toContain(repeatRetailOrderAction.descriptor.actionKey);
    expect(counterpartyPurchasePreparePermission.protectedEntrypoints).toContain(
      'commerce.customer-context.api.repeat-order-preparation',
    );
  });

  it('inventories purchasing-limit Reads and approval triggering under exact permissions', () => {
    expect(counterpartyPurchaseLimitManagePermission.protectedEntrypoints).toContain(
      purchaseLimitPolicyReadRead.descriptor.readKey,
    );
    expect(counterpartyPurchaseSubmitPermission.protectedEntrypoints).toContain(
      purchaseLimitEvaluationRead.descriptor.readKey,
    );
    expect(counterpartyPurchaseSubmitPermission.protectedEntrypoints).toContain(
      triggerPurchaseApprovalAction.descriptor.actionKey,
    );
  });

  it('protects every governed Purchasing Approval Action under its exact permission', () => {
    expect(counterpartyPurchaseSubmitPermission.protectedEntrypoints).toEqual(
      expect.arrayContaining([
        'commerce.customer-context.create-purchase-proposal-revision',
        'commerce.customer-context.submit-purchase-approval-request',
        triggerPurchaseApprovalAction.descriptor.actionKey,
      ]),
    );
    expect(counterpartyApprovalDecidePermission.protectedEntrypoints).toEqual([
      decidePurchaseApprovalRequestAction.descriptor.actionKey,
    ]);
    expect(counterpartyApprovalRequestManagePermission.protectedEntrypoints).toEqual([
      consumePurchaseApprovalAction.descriptor.actionKey,
      reroutePurchaseApprovalRequestAction.descriptor.actionKey,
      revalidatePurchaseApprovalAction.descriptor.actionKey,
    ]);
  });

  it('inventories the exact history detail Reads', () => {
    expect(counterpartyHistoryReadOwnPermission.protectedEntrypoints).toContain(
      counterpartyOrderHistoryDetailRead.descriptor.readKey,
    );
    expect(counterpartyHistoryReadAllPermission.protectedEntrypoints).toContain(
      counterpartyAllOrderHistoryDetailRead.descriptor.readKey,
    );
    expect(retailHistoryReadPermission.protectedEntrypoints).toContain(retailOrderHistoryDetailRead.descriptor.readKey);
  });
});

it('freezes every published owner descriptor including canonical capability and dormant entrypoints', () => {
  expect([
    counterpartyAccessManagePermission,
    counterpartyAccessReadPermission,
    counterpartyAddressBookManagePermission,
    counterpartyAddressBookUsePermission,
    counterpartyApprovalDecidePermission,
    counterpartyApprovalHierarchyManagePermission,
    counterpartyApprovalRequestManagePermission,
    counterpartyHistoryReadAllPermission,
    counterpartyHistoryReadOwnPermission,
    counterpartyProfileReadPermission,
    counterpartyPurchaseLimitManagePermission,
    counterpartyPurchasePreparePermission,
    counterpartyPurchaseSubmitPermission,
    counterpartySettingsPaymentTermsManagePermission,
    counterpartySettingsPriceGroupManagePermission,
    retailAddressBookManagePermission,
    retailAddressBookUsePermission,
    retailAftercareReadPermission,
    retailClaimCreatePermission,
    retailConsentManagePermission,
    retailHistoryReadPermission,
    retailNotificationsManagePermission,
    retailProfileReadPermission,
    retailRepeatOrderPermission,
    retailSettingsPaymentTermPreferenceManagePermission,
  ]).toEqual([
    {
      allowedScopeKinds: ['counterparty', 'counterparty_storefront'],
      auditSensitivity: 'sensitive',
      authorityGroups: ['COUNTERPARTY_ACCESS_ADMINISTRATOR'],
      customerDelegable: true,
      internalGrantable: true,
      key: 'counterparty.access.manage',
      meaning: 'Grant, revoke, and invite for explicitly delegable permissions in scope.',
      owningCapability: 'commerce.customer-context.access',
      protectedEntrypoints: [
        'commerce.customer-context.grant-counterparty-commerce-access',
        'commerce.customer-context.revoke-counterparty-commerce-access',
        'commerce.customer-context.create-counterparty-access-invitation',
        'commerce.customer-context.resend-counterparty-access-invitation',
        'commerce.customer-context.revoke-counterparty-access-invitation',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['counterparty', 'counterparty_storefront'],
      auditSensitivity: 'sensitive',
      authorityGroups: ['COUNTERPARTY_ACCESS_ADMINISTRATOR'],
      customerDelegable: true,
      internalGrantable: true,
      key: 'counterparty.access.read',
      meaning: 'Read current Counterparty Commerce Access in the authorized scope.',
      owningCapability: 'commerce.customer-context.access',
      protectedEntrypoints: [
        'commerce.customer-context.api.counterparty-commerce-access-check',
        'commerce.customer-context.api.counterparty-commerce-access-list',
        'commerce.customer-context.api.counterparty-commerce-access-detail',
        'commerce.customer-context.api.counterparty-access-invitation-read',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['counterparty'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: true,
      key: 'counterparty.address_book.manage',
      meaning: 'Manage shared Counterparty address-book entries and defaults.',
      owningCapability: 'commerce.customer-context.address-book',
      protectedEntrypoints: [
        'commerce.customer-context.add-saved-address',
        'commerce.customer-context.update-saved-address',
        'commerce.customer-context.remove-saved-address',
        'commerce.customer-context.set-default-billing-address',
        'commerce.customer-context.clear-default-billing-address',
        'commerce.customer-context.set-default-delivery-destination',
        'commerce.customer-context.clear-default-delivery-destination',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['counterparty', 'counterparty_storefront'],
      auditSensitivity: 'standard',
      authorityGroups: ['COUNTERPARTY_BUYER'],
      customerDelegable: true,
      internalGrantable: true,
      key: 'counterparty.address_book.use',
      meaning: 'Use permitted Counterparty address-book candidates for a purchase.',
      owningCapability: 'commerce.customer-context.address-book',
      protectedEntrypoints: [
        'commerce.customer-context.api.saved-address-list',
        'commerce.customer-context.api.saved-address-detail',
        'commerce.customer-context.api.saved-address-defaults',
        'commerce.customer-context.api.delivery-destination-resolution',
        'commerce.customer-context.api.invoice-recipient-resolution',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['counterparty', 'counterparty_storefront'],
      auditSensitivity: 'sensitive',
      authorityGroups: ['COUNTERPARTY_APPROVER'],
      customerDelegable: true,
      internalGrantable: true,
      key: 'counterparty.approval.decide',
      meaning: 'Read an eligible request and perform its approve, return, or reject decision.',
      owningCapability: 'commerce.customer-context.purchasing-approval',
      protectedEntrypoints: ['commerce.customer-context.decide-purchase-approval-request'],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['counterparty', 'counterparty_storefront'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: true,
      key: 'counterparty.approval_hierarchy.manage',
      meaning: 'Manage Approval Hierarchy and routing policy in the authorized scope.',
      owningCapability: 'commerce.customer-context.purchasing-approval',
      protectedEntrypoints: ['commerce.customer-context.create-approval-hierarchy'],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['counterparty_storefront'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: false,
      key: 'counterparty.approval.request.manage',
      meaning: 'Manage the lifecycle and owner handoff of a submitted Approval Request.',
      owningCapability: 'commerce.customer-context.purchasing-approval',
      protectedEntrypoints: [
        'commerce.customer-context.consume-purchase-approval',
        'commerce.customer-context.reroute-purchase-approval-request',
        'commerce.customer-context.revalidate-purchase-approval',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['counterparty', 'counterparty_storefront'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: true,
      internalGrantable: true,
      key: 'counterparty.history.read_all',
      meaning: 'Read all customer-facing Counterparty Orders allowed by record visibility.',
      owningCapability: 'commerce.customer-context.history',
      protectedEntrypoints: [
        'commerce.customer-context.api.counterparty-all-order-history',
        'commerce.customer-context.api.counterparty-all-order-history-detail',
        'commerce.customer-context.api.counterparty-all-customer-archive',
        'commerce.customer-context.api.customer-archive',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['counterparty', 'counterparty_storefront'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: true,
      internalGrantable: true,
      key: 'counterparty.history.read_own',
      meaning: 'Read customer-facing Orders submitted by the current Principal.',
      owningCapability: 'commerce.customer-context.history',
      protectedEntrypoints: [
        'commerce.customer-context.api.counterparty-order-history',
        'commerce.customer-context.api.counterparty-order-history-detail',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['counterparty', 'counterparty_storefront'],
      auditSensitivity: 'sensitive',
      authorityGroups: ['COUNTERPARTY_BUYER'],
      customerDelegable: true,
      internalGrantable: true,
      key: 'counterparty.profile.read',
      meaning: 'Read the permitted current Commerce Counterparty Purchasing Profile view.',
      owningCapability: 'commerce.customer-context.profile',
      protectedEntrypoints: [
        'commerce.customer-context.api.customer-profile-read',
        'commerce.customer-context.api.market-subject-restrictions-current',
        'commerce.customer-context.api.purchase-currency-resolution',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['counterparty', 'counterparty_storefront'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: true,
      key: 'counterparty.purchase_limit.manage',
      meaning: 'Manage Counterparty and Principal Purchase Limit Policies in scope.',
      owningCapability: 'commerce.customer-context.purchasing-limits',
      protectedEntrypoints: [
        'commerce.customer-context.api.purchase-limit-policy-read',
        'commerce.customer-context.change-counterparty-purchase-limit',
        'commerce.customer-context.change-principal-purchase-limit-override',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['counterparty', 'counterparty_storefront'],
      auditSensitivity: 'standard',
      authorityGroups: ['COUNTERPARTY_BUYER'],
      customerDelegable: true,
      internalGrantable: true,
      key: 'counterparty.purchase.prepare',
      meaning: 'Create and modify a Cart in the Counterparty context.',
      owningCapability: 'commerce.cart',
      protectedEntrypoints: [
        'commerce.customer-context.api.repeat-order-preparation',
        'commerce.customer-context.repeat-counterparty-order',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['counterparty', 'counterparty_storefront'],
      auditSensitivity: 'sensitive',
      authorityGroups: ['COUNTERPARTY_BUYER'],
      customerDelegable: true,
      internalGrantable: true,
      key: 'counterparty.purchase.submit',
      meaning: 'Submit a current purchase directly or into Purchasing Approval.',
      owningCapability: 'commerce.checkout',
      protectedEntrypoints: [
        'commerce.checkout.submit-counterparty-purchase',
        'commerce.customer-context.api.purchase-limit-evaluation',
        'commerce.customer-context.trigger-purchase-approval',
        'commerce.customer-context.create-purchase-proposal-revision',
        'commerce.customer-context.submit-purchase-approval-request',
        'commerce.customer-context.api.customer-profile-trading-gate',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['counterparty'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: true,
      key: 'counterparty.settings.payment_terms.manage',
      meaning: 'Manage Counterparty Payment Term entitlements and preferences.',
      owningCapability: 'commerce.customer-context.customer-payment-terms',
      protectedEntrypoints: [
        'commerce.customer-context.change-customer-payment-terms',
        'commerce.customer-context.remove-customer-payment-term',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['counterparty'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: true,
      key: 'counterparty.settings.price_group.manage',
      meaning: 'Manage the Counterparty Customer Price Group Assignment.',
      owningCapability: 'commerce.customer-context.customer-price-group',
      protectedEntrypoints: [
        'commerce.customer-context.assign-counterparty-price-group',
        'commerce.customer-context.migrate-counterparty-price-group',
        'commerce.customer-context.remove-counterparty-price-group',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['retail_profile'],
      auditSensitivity: 'sensitive',
      authorityGroups: ['RETAIL_PORTAL_SELF_SERVICE'],
      customerDelegable: false,
      internalGrantable: true,
      key: 'retail.address_book.manage',
      meaning: 'Add, update, or remove saved addresses and persistent defaults for the bound profile.',
      owningCapability: 'commerce.customer-context.address-book',
      protectedEntrypoints: [
        'commerce.customer-context.add-saved-address',
        'commerce.customer-context.update-saved-address',
        'commerce.customer-context.remove-saved-address',
        'commerce.customer-context.set-default-billing-address',
        'commerce.customer-context.clear-default-billing-address',
        'commerce.customer-context.set-default-delivery-destination',
        'commerce.customer-context.clear-default-delivery-destination',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['retail_profile'],
      auditSensitivity: 'sensitive',
      authorityGroups: ['RETAIL_PORTAL_SELF_SERVICE'],
      customerDelegable: false,
      internalGrantable: true,
      key: 'retail.address_book.use',
      meaning: 'Select permitted saved or one-time address candidates in the bound profile purchase.',
      owningCapability: 'commerce.customer-context.address-book',
      protectedEntrypoints: [
        'commerce.customer-context.api.saved-address-list',
        'commerce.customer-context.api.saved-address-detail',
        'commerce.customer-context.api.saved-address-defaults',
        'commerce.customer-context.api.delivery-destination-resolution',
        'commerce.customer-context.api.invoice-recipient-resolution',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['retail_profile'],
      auditSensitivity: 'sensitive',
      authorityGroups: ['RETAIL_PORTAL_SELF_SERVICE'],
      customerDelegable: false,
      internalGrantable: true,
      key: 'retail.aftercare.read',
      meaning: 'Read customer-facing Claims and aftercare records visible to the bound profile.',
      owningCapability: 'commerce.claim',
      protectedEntrypoints: ['commerce.claim.api.customer-claim-history'],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['retail_profile'],
      auditSensitivity: 'sensitive',
      authorityGroups: ['RETAIL_PORTAL_SELF_SERVICE'],
      customerDelegable: false,
      internalGrantable: true,
      key: 'retail.claim.create',
      meaning: 'Create a Claim for an eligible Order line of the bound profile.',
      owningCapability: 'commerce.claim',
      protectedEntrypoints: ['commerce.claim.create-customer-claim'],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['retail_profile'],
      auditSensitivity: 'sensitive',
      authorityGroups: ['RETAIL_PORTAL_SELF_SERVICE'],
      customerDelegable: false,
      internalGrantable: true,
      key: 'retail.consent.manage',
      meaning: 'Read or change Principal/Profile-scoped consent preferences owned by Consent and Privacy.',
      owningCapability: 'privacy.consent',
      protectedEntrypoints: ['privacy.consent.manage-retail-profile-consent'],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['retail_profile'],
      auditSensitivity: 'sensitive',
      authorityGroups: ['RETAIL_PORTAL_SELF_SERVICE'],
      customerDelegable: false,
      internalGrantable: true,
      key: 'retail.history.read',
      meaning: 'Read customer-facing Orders visible to the bound profile.',
      owningCapability: 'commerce.customer-context.history',
      protectedEntrypoints: [
        'commerce.customer-context.api.retail-order-history',
        'commerce.customer-context.api.retail-order-history-detail',
        'commerce.customer-context.api.customer-archive',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['retail_profile'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: true,
      key: 'retail.notifications.manage',
      meaning: 'Manage optional notification preferences when that capability is enabled.',
      owningCapability: 'commerce.notification',
      protectedEntrypoints: ['commerce.notification.manage-retail-profile-notifications'],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['retail_profile'],
      auditSensitivity: 'sensitive',
      authorityGroups: ['RETAIL_PORTAL_SELF_SERVICE'],
      customerDelegable: false,
      internalGrantable: true,
      key: 'retail.profile.read',
      meaning: 'Read the permitted current Commerce Retail Customer Profile view.',
      owningCapability: 'commerce.customer-context.profile',
      protectedEntrypoints: [
        'commerce.customer-context.api.customer-profile-read',
        'commerce.customer-context.api.market-subject-restrictions-current',
        'commerce.customer-context.api.purchase-currency-resolution',
        'commerce.customer-context.api.retail-access-decision',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['retail_profile'],
      auditSensitivity: 'sensitive',
      authorityGroups: ['RETAIL_PORTAL_SELF_SERVICE'],
      customerDelegable: false,
      internalGrantable: true,
      key: 'retail.repeat_order',
      meaning: 'Create a new Cart from an eligible visible historical Order.',
      owningCapability: 'commerce.cart',
      protectedEntrypoints: [
        'commerce.customer-context.api.repeat-order-preparation',
        'commerce.customer-context.repeat-retail-order',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['retail_profile'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: true,
      key: 'retail.settings.payment_term_preference.manage',
      meaning: 'Select or clear a preference among Payment Terms already entitled to the bound profile.',
      owningCapability: 'commerce.customer-context.customer-payment-terms',
      protectedEntrypoints: ['commerce.customer-context.change-retail-payment-term-preference'],
      schemaVersion: '1',
    },
  ]);
});
