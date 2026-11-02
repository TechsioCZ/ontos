import type { OwnerPermissionContract } from '@app/core-runtime';
import { counterpartyAccessManagePermission } from './counterparty-access-manage.ts';
import { counterpartyAccessReadPermission } from './counterparty-access-read.ts';
import { counterpartyAddressBookManagePermission } from './counterparty-address-book-manage.ts';
import { counterpartyAddressBookUsePermission } from './counterparty-address-book-use.ts';
import { counterpartyApprovalDecidePermission } from './counterparty-approval-decide.ts';
import { counterpartyApprovalHierarchyManagePermission } from './counterparty-approval-hierarchy-manage.ts';
import { counterpartyApprovalRequestManagePermission } from './counterparty-approval-request-manage.ts';
import { counterpartyHistoryReadAllPermission } from './counterparty-history-read-all.ts';
import { counterpartyHistoryReadOwnPermission } from './counterparty-history-read-own.ts';
import { counterpartyProfileReadPermission } from './counterparty-profile-read.ts';
import { counterpartyPurchaseLimitManagePermission } from './counterparty-purchase-limit-manage.ts';
import { counterpartyPurchasePreparePermission } from './counterparty-purchase-prepare.ts';
import { counterpartyPurchaseSubmitPermission } from './counterparty-purchase-submit.ts';
import { counterpartySettingsPaymentTermsManagePermission } from './counterparty-settings-payment-terms-manage.ts';
import { counterpartySettingsPriceGroupManagePermission } from './counterparty-settings-price-group-manage.ts';
import { retailAddressBookManagePermission } from './retail-address-book-manage.ts';
import { retailAddressBookUsePermission } from './retail-address-book-use.ts';
import { retailAftercareReadPermission } from './retail-aftercare-read.ts';
import { retailClaimCreatePermission } from './retail-claim-create.ts';
import { retailConsentManagePermission } from './retail-consent-manage.ts';
import { retailHistoryReadPermission } from './retail-history-read.ts';
import { retailNotificationsManagePermission } from './retail-notifications-manage.ts';
import { retailProfileReadPermission } from './retail-profile-read.ts';
import { retailRepeatOrderPermission } from './retail-repeat-order.ts';
import { retailSettingsPaymentTermPreferenceManagePermission } from './retail-settings-payment-term-preference-manage.ts';

/** Publisher identity is independent of each definition's canonical business capability. */
export const commerceCustomerContextAuthorizationContract = Object.freeze({
  owningModuleKey: 'commerce.customer-context',
  permissions: Object.freeze([
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
  ]),
  schemaVersion: '1',
  targetResourceType: 'business_permission',
}) satisfies OwnerPermissionContract;
