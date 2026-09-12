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
