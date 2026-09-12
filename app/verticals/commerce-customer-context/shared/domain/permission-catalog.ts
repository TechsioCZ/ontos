import { BusinessPermissionCodeSchema, defineBusinessPermissionCatalog } from '@app/core-runtime';
import { Result, Schema } from 'effect';

const COUNTERPARTY_APPROVAL_DECIDE_PERMISSION = 'counterparty.approval.decide' as const;
const PURCHASING_APPROVAL_CAPABILITY = 'commerce.customer-context.purchasing-approval' as const;

export const COUNTERPARTY_PERMISSION_CODES = [
  // oxlint-disable-next-line sonarjs/no-duplicate-string -- Exact #328 catalog key repeated in its descriptor and bundle; remove-when: catalog generation owns canonical bundle derivation.
  'counterparty.profile.read',
  // oxlint-disable-next-line sonarjs/no-duplicate-string -- Exact #328 catalog key repeated in its descriptor and bundle; remove-when: catalog generation owns canonical bundle derivation.
  'counterparty.purchase.prepare',
  // oxlint-disable-next-line sonarjs/no-duplicate-string -- Exact #328 catalog key repeated in its descriptor and bundle; remove-when: catalog generation owns canonical bundle derivation.
  'counterparty.purchase.submit',
  COUNTERPARTY_APPROVAL_DECIDE_PERMISSION,
  'counterparty.approval.request.manage',
  // oxlint-disable-next-line sonarjs/no-duplicate-string -- Exact #328 catalog key repeated in its descriptor and bundle; remove-when: catalog generation owns canonical bundle derivation.
  'counterparty.access.read',
  // oxlint-disable-next-line sonarjs/no-duplicate-string -- Exact #328 catalog key repeated in its descriptor and bundle; remove-when: catalog generation owns canonical bundle derivation.
  'counterparty.access.manage',
  'counterparty.settings.price_group.manage',
  'counterparty.settings.payment_terms.manage',
  // oxlint-disable-next-line sonarjs/no-duplicate-string -- Exact #328 catalog key repeated in its descriptor and bundle; remove-when: catalog generation owns canonical bundle derivation.
  'counterparty.address_book.use',
  'counterparty.address_book.manage',
  'counterparty.history.read_own',
  'counterparty.history.read_all',
  'counterparty.purchase_limit.manage',
  'counterparty.approval_hierarchy.manage',
] as const;

export const CounterpartyPermissionCodeSchema = Schema.Literals(COUNTERPARTY_PERMISSION_CODES);
export type CounterpartyPermissionCode = typeof CounterpartyPermissionCodeSchema.Type;

export const COUNTERPARTY_AUTHORITY_GROUPS = {
  COUNTERPARTY_ACCESS_ADMINISTRATOR: ['counterparty.access.read', 'counterparty.access.manage'],
  COUNTERPARTY_APPROVER: [COUNTERPARTY_APPROVAL_DECIDE_PERMISSION],
  COUNTERPARTY_BUYER: [
    'counterparty.profile.read',
    'counterparty.purchase.prepare',
    'counterparty.purchase.submit',
    'counterparty.address_book.use',
  ],
} as const satisfies Record<string, readonly CounterpartyPermissionCode[]>;

const CounterpartyAuthorityGroupSchema = Schema.Literals([
  'COUNTERPARTY_BUYER',
  'COUNTERPARTY_APPROVER',
  'COUNTERPARTY_ACCESS_ADMINISTRATOR',
]);
type CounterpartyAuthorityGroup = typeof CounterpartyAuthorityGroupSchema.Type;

export interface CounterpartyPermissionDescriptor {
  readonly allowedScopes: readonly ('counterparty' | 'storefront')[];
  readonly authorityGroups: readonly CounterpartyAuthorityGroup[];
  readonly customerDelegable: boolean;
  readonly evidenceSensitivity: 'standard' | 'sensitive' | 'critical';
  readonly internalGrantable: boolean;
  readonly meaning: string;
  readonly owningCapability: string;
  readonly permission: CounterpartyPermissionCode;
  readonly protectedEntrypoints: readonly string[];
  readonly reasonRequired: boolean;
}

const descriptor = (value: CounterpartyPermissionDescriptor): Readonly<CounterpartyPermissionDescriptor> =>
  Object.freeze(value);

export const COUNTERPARTY_PERMISSION_CATALOG = Object.freeze({
  [COUNTERPARTY_APPROVAL_DECIDE_PERMISSION]: descriptor({
    allowedScopes: ['counterparty', 'storefront'],
    authorityGroups: ['COUNTERPARTY_APPROVER'],
    customerDelegable: true,
    evidenceSensitivity: 'critical',
    internalGrantable: true,
    meaning: 'Read an eligible request and perform its approve, return, or reject decision.',
    owningCapability: PURCHASING_APPROVAL_CAPABILITY,
    permission: COUNTERPARTY_APPROVAL_DECIDE_PERMISSION,
    protectedEntrypoints: ['commerce.customer-context.decide-purchase-approval-request'],
    reasonRequired: true,
  }),
  'counterparty.access.manage': descriptor({
    allowedScopes: ['counterparty', 'storefront'],
    authorityGroups: ['COUNTERPARTY_ACCESS_ADMINISTRATOR'],
    customerDelegable: true,
    evidenceSensitivity: 'critical',
    internalGrantable: true,
    meaning: 'Grant, revoke, and invite for explicitly delegable permissions in scope.',
    owningCapability: 'commerce.customer-context.access',
    permission: 'counterparty.access.manage',
    protectedEntrypoints: [
      'commerce.customer-context.grant-counterparty-commerce-access',
      'commerce.customer-context.revoke-counterparty-commerce-access',
      'commerce.customer-context.create-counterparty-access-invitation',
      'commerce.customer-context.resend-counterparty-access-invitation',
      'commerce.customer-context.revoke-counterparty-access-invitation',
    ],
    reasonRequired: true,
  }),
  'counterparty.access.read': descriptor({
    allowedScopes: ['counterparty', 'storefront'],
    authorityGroups: ['COUNTERPARTY_ACCESS_ADMINISTRATOR'],
    customerDelegable: true,
    evidenceSensitivity: 'sensitive',
    internalGrantable: true,
    meaning: 'Read current Counterparty Commerce Access in the authorized scope.',
    owningCapability: 'commerce.customer-context.access',
    permission: 'counterparty.access.read',
    protectedEntrypoints: [
      'commerce.customer-context.api.counterparty-commerce-access-check',
      'commerce.customer-context.api.counterparty-commerce-access-list',
      'commerce.customer-context.api.counterparty-commerce-access-detail',
      'commerce.customer-context.api.counterparty-access-invitation-read',
    ],
    reasonRequired: false,
  }),
  'counterparty.address_book.manage': descriptor({
    allowedScopes: ['counterparty'],
    authorityGroups: [],
    customerDelegable: false,
    evidenceSensitivity: 'sensitive',
    internalGrantable: true,
    meaning: 'Manage shared Counterparty address-book entries and defaults.',
    owningCapability: 'commerce.customer-context.address-book',
    permission: 'counterparty.address_book.manage',
    protectedEntrypoints: [
      'commerce.customer-context.add-saved-address',
      'commerce.customer-context.update-saved-address',
      'commerce.customer-context.remove-saved-address',
      'commerce.customer-context.set-default-billing-address',
      'commerce.customer-context.clear-default-billing-address',
      'commerce.customer-context.set-default-delivery-destination',
      'commerce.customer-context.clear-default-delivery-destination',
    ],
    reasonRequired: true,
  }),
  'counterparty.address_book.use': descriptor({
    allowedScopes: ['counterparty', 'storefront'],
    authorityGroups: ['COUNTERPARTY_BUYER'],
    customerDelegable: true,
    evidenceSensitivity: 'standard',
    internalGrantable: true,
    meaning: 'Use permitted Counterparty address-book candidates for a purchase.',
    owningCapability: 'commerce.customer-context.address-book',
    permission: 'counterparty.address_book.use',
    protectedEntrypoints: [
      'commerce.customer-context.api.saved-address-list',
      'commerce.customer-context.api.saved-address-detail',
      'commerce.customer-context.api.saved-address-defaults',
      'commerce.customer-context.api.delivery-destination-resolution',
      'commerce.customer-context.api.invoice-recipient-resolution',
    ],
    reasonRequired: false,
  }),
  'counterparty.approval_hierarchy.manage': descriptor({
    allowedScopes: ['counterparty', 'storefront'],
    authorityGroups: [],
    customerDelegable: false,
    evidenceSensitivity: 'critical',
    internalGrantable: true,
    meaning: 'Manage Approval Hierarchy and routing policy in the authorized scope.',
    owningCapability: PURCHASING_APPROVAL_CAPABILITY,
    permission: 'counterparty.approval_hierarchy.manage',
    protectedEntrypoints: ['commerce.customer-context.create-approval-hierarchy'],
    reasonRequired: true,
  }),
  'counterparty.approval.request.manage': descriptor({
    allowedScopes: ['storefront'],
    authorityGroups: [],
    customerDelegable: false,
    evidenceSensitivity: 'sensitive',
    internalGrantable: false,
    meaning: 'Manage the lifecycle and owner handoff of a submitted Approval Request.',
    owningCapability: PURCHASING_APPROVAL_CAPABILITY,
    permission: 'counterparty.approval.request.manage',
    protectedEntrypoints: [
      'commerce.customer-context.consume-purchase-approval',
      'commerce.customer-context.reroute-purchase-approval-request',
      'commerce.customer-context.revalidate-purchase-approval',
    ],
    reasonRequired: true,
  }),
  'counterparty.history.read_all': descriptor({
    allowedScopes: ['counterparty', 'storefront'],
    authorityGroups: [],
    customerDelegable: true,
    evidenceSensitivity: 'sensitive',
    internalGrantable: true,
    meaning: 'Read all customer-facing Counterparty Orders allowed by record visibility.',
    owningCapability: 'commerce.customer-context.history',
    permission: 'counterparty.history.read_all',
    protectedEntrypoints: [
      'commerce.customer-context.api.counterparty-all-order-history',
      'commerce.customer-context.api.counterparty-all-order-history-detail',
      'commerce.customer-context.api.counterparty-all-customer-archive',
      'commerce.customer-context.api.customer-archive',
    ],
    reasonRequired: true,
  }),
  'counterparty.history.read_own': descriptor({
    allowedScopes: ['counterparty', 'storefront'],
    authorityGroups: [],
    customerDelegable: true,
    evidenceSensitivity: 'sensitive',
    internalGrantable: true,
    meaning: 'Read customer-facing Orders submitted by the current Principal.',
    owningCapability: 'commerce.customer-context.history',
    permission: 'counterparty.history.read_own',
    protectedEntrypoints: [
      'commerce.customer-context.api.counterparty-order-history',
      'commerce.customer-context.api.counterparty-order-history-detail',
    ],
    reasonRequired: false,
  }),
  'counterparty.profile.read': descriptor({
    allowedScopes: ['counterparty', 'storefront'],
    authorityGroups: ['COUNTERPARTY_BUYER'],
    customerDelegable: true,
    evidenceSensitivity: 'sensitive',
    internalGrantable: true,
    meaning: 'Read the permitted current Commerce Counterparty Purchasing Profile view.',
    owningCapability: 'commerce.customer-context.profile',
    permission: 'counterparty.profile.read',
    protectedEntrypoints: [
      'commerce.customer-context.api.customer-profile-read',
      'commerce.customer-context.api.purchase-currency-resolution',
    ],
    reasonRequired: false,
  }),
  'counterparty.purchase_limit.manage': descriptor({
    allowedScopes: ['counterparty', 'storefront'],
    authorityGroups: [],
    customerDelegable: false,
    evidenceSensitivity: 'critical',
    internalGrantable: true,
    meaning: 'Manage Counterparty and Principal Purchase Limit Policies in scope.',
    owningCapability: 'commerce.customer-context.purchasing-limits',
    permission: 'counterparty.purchase_limit.manage',
    protectedEntrypoints: [
      'commerce.customer-context.api.purchase-limit-policy-read',
      'commerce.customer-context.change-counterparty-purchase-limit',
      'commerce.customer-context.change-principal-purchase-limit-override',
    ],
    reasonRequired: true,
  }),
  'counterparty.purchase.prepare': descriptor({
    allowedScopes: ['counterparty', 'storefront'],
    authorityGroups: ['COUNTERPARTY_BUYER'],
    customerDelegable: true,
    evidenceSensitivity: 'standard',
    internalGrantable: true,
    meaning: 'Create and modify a Cart in the Counterparty context.',
    owningCapability: 'commerce.cart',
    permission: 'counterparty.purchase.prepare',
    protectedEntrypoints: [
      'commerce.customer-context.api.repeat-order-preparation',
      'commerce.customer-context.repeat-counterparty-order',
    ],
    reasonRequired: false,
  }),
  'counterparty.purchase.submit': descriptor({
    allowedScopes: ['counterparty', 'storefront'],
    authorityGroups: ['COUNTERPARTY_BUYER'],
    customerDelegable: true,
    evidenceSensitivity: 'critical',
    internalGrantable: true,
    meaning: 'Submit a current purchase directly or into Purchasing Approval.',
    owningCapability: 'commerce.checkout',
    permission: 'counterparty.purchase.submit',
    protectedEntrypoints: [
      'commerce.checkout.submit-counterparty-purchase',
      'commerce.customer-context.api.purchase-limit-evaluation',
      'commerce.customer-context.trigger-purchase-approval',
      'commerce.customer-context.create-purchase-proposal-revision',
      'commerce.customer-context.submit-purchase-approval-request',
      'commerce.customer-context.api.customer-profile-trading-gate',
    ],
    reasonRequired: true,
  }),
  'counterparty.settings.payment_terms.manage': descriptor({
    allowedScopes: ['counterparty'],
    authorityGroups: [],
    customerDelegable: false,
    evidenceSensitivity: 'critical',
    internalGrantable: true,
    meaning: 'Manage Counterparty Payment Term entitlements and preferences.',
    owningCapability: 'commerce.customer-context.customer-payment-terms',
    permission: 'counterparty.settings.payment_terms.manage',
    protectedEntrypoints: [
      'commerce.customer-context.change-customer-payment-terms',
      'commerce.customer-context.remove-customer-payment-term',
    ],
    reasonRequired: true,
  }),
  'counterparty.settings.price_group.manage': descriptor({
    allowedScopes: ['counterparty'],
    authorityGroups: [],
    customerDelegable: false,
    evidenceSensitivity: 'critical',
    internalGrantable: true,
    meaning: 'Manage the Counterparty Customer Price Group Assignment.',
    owningCapability: 'commerce.customer-context.customer-price-group',
    permission: 'counterparty.settings.price_group.manage',
    protectedEntrypoints: [
      'commerce.customer-context.assign-counterparty-price-group',
      'commerce.customer-context.migrate-counterparty-price-group',
      'commerce.customer-context.remove-counterparty-price-group',
    ],
    reasonRequired: true,
  }),
} satisfies Record<CounterpartyPermissionCode, CounterpartyPermissionDescriptor>);

export const permissionDescriptor = (
  permission: CounterpartyPermissionCode,
): Readonly<CounterpartyPermissionDescriptor> => COUNTERPARTY_PERMISSION_CATALOG[permission];

export const permissionAllowsScope = (
  permission: CounterpartyPermissionCode,
  scope: 'counterparty' | 'storefront',
): boolean => permissionDescriptor(permission).allowedScopes.includes(scope);

const businessPermissionCode = (permission: CounterpartyPermissionCode) =>
  Result.getOrThrow(Schema.decodeResult(BusinessPermissionCodeSchema)(permission));

/**
 * Core-compatible catalog boundary. This is the only adapter from Commerce's
 * domain scope names to the authorization runtime scope vocabulary.
 */
export const COUNTERPARTY_BUSINESS_PERMISSION_CATALOG = defineBusinessPermissionCatalog({
  authorityGroups: Object.fromEntries(
    Object.entries(COUNTERPARTY_AUTHORITY_GROUPS).map(([group, permissions]) => [
      group,
      permissions.map(businessPermissionCode),
    ]),
  ),
  catalogVersion: '1',
  permissions: COUNTERPARTY_PERMISSION_CODES.map((permission) => {
    const metadata = permissionDescriptor(permission);
    return {
      allowedScopeKinds: metadata.allowedScopes.map((scope) =>
        scope === 'counterparty' ? 'counterparty' : 'counterparty_storefront',
      ),
      auditSensitivity: metadata.evidenceSensitivity === 'standard' ? ('standard' as const) : ('sensitive' as const),
      authorityGroups: [...metadata.authorityGroups],
      customerDelegable: metadata.customerDelegable,
      internalGrantable: metadata.internalGrantable,
      key: businessPermissionCode(permission),
      meaning: metadata.meaning,
      owningCapability: metadata.owningCapability,
      protectedEntrypoints: [...metadata.protectedEntrypoints],
      schemaVersion: '1',
    };
  }),
});
