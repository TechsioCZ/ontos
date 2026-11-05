// Frozen corrected baseline da150f3b. Expected literals never call implementation helpers.
const baselineCustomerContextModuleId = 'commerce.customer-context';
const baselineProfileId = 'profile:one/á';
const baselineRetailProfileObjectId =
  'ctx_WyJyZXRhaWwucHJvZmlsZS5yZWFkIiwiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAxIiwiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAyIiwicmV0YWlsX3Byb2ZpbGUiLCJwcm9maWxlOm9uZS_DoSJd';
const baselineLiteral13 = '070576900fba7f56d344f18e4a4fa6b8c93a19a2ac5d6b56f9bf48105037dbce';
const baselineTenantId = '00000000-0000-4000-8000-000000000001';
const baselineLegalEntityId = '00000000-0000-4000-8000-000000000002';
const baselineCounterpartyId = 'counterparty:one';
const baselineCounterpartyObjectId =
  'ctx_WyJjb3VudGVycGFydHkucHVyY2hhc2Uuc3VibWl0IiwiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAxIiwiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAyIiwiY291bnRlcnBhcnR5IiwiY291bnRlcnBhcnR5Om9uZSJd';
const baselineCounterpartyPermission = 'counterparty.purchase.submit';
const baselineCounterpartyStorefrontObjectId =
  'ctx_WyJjb3VudGVycGFydHkucHVyY2hhc2Uuc3VibWl0IiwiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAxIiwiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAyIiwiY291bnRlcnBhcnR5X3N0b3JlZnJvbnQiLCJjb3VudGVycGFydHk6b25lIiwic3RvcmVmcm9udC1hIl0';
const baselinePriceGroupModuleId = 'pricing.price-group-catalog';
const baselinePricingCatalogId = '50000000-0000-4000-8000-000000000001';
const baselinePricingCatalogObjectId =
  'ctx_WyJwcmljaW5nLnByaWNlX2dyb3VwLmNyZWF0ZSIsIjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsInByaWNpbmdfY2F0YWxvZyIsIjUwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSJd';
const baselinePriceGroupObjectId =
  'ctx_WyJwcmljaW5nLnByaWNlX2dyb3VwLnJlYWQiLCIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJwcmljZV9ncm91cCIsIjUwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsIjYwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSJd';
const baselineInventoryModuleId = 'commerce.inventory';
const baselineInventoryResourceId = '70000000-0000-4000-8000-000000000001';
const baselineInventoryResourceType = 'commerce.inventory.stock-position';
const baselineInventoryResourceObjectId =
  'ctx_WyJpbnZlbnRvcnkuc3RvY2suY29ycmVjdCIsIjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsImludmVudG9yeV9yZXNvdXJjZSIsImNvbW1lcmNlLmludmVudG9yeSIsImNvbW1lcmNlLmludmVudG9yeS5zdG9jay1wb3NpdGlvbiIsIjcwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSJd';
const baselineTaxSellingLegalEntityObjectId =
  'ctx_WyJ0YXgucnVsZS5tYW5hZ2UiLCIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDIiLCJ0YXhfc2VsbGluZ19sZWdhbF9lbnRpdHkiXQ';

export const remainingPermissionBaselines = [
  {
    actionHash: 'e1dffe463325ebbf82071181ed20c4771fd7a866c71e6592fc3af37cd66d5bbd',
    actionTarget: {
      targetModuleKey: baselineCustomerContextModuleId,
      targetResourceId: baselineProfileId,
      targetResourceType: 'retail_profile:retail.profile.read',
    },
    key: 'retail.profile.read:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:retail_profile:profile:one/á',
    objectId: baselineRetailProfileObjectId,
    owner: baselineCustomerContextModuleId,
    permission: 'retail.profile.read',
    readHash: baselineLiteral13,
    readTarget: {
      moduleId: 'retail.profile.read',
      resourceId: baselineProfileId,
      resourceType: 'retail_profile',
    },
    target: {
      kind: 'retail_profile',
      legalEntityId: baselineLegalEntityId,
      profileId: baselineProfileId,
      tenantId: baselineTenantId,
    },
    tenantOnly: false,
    unknownKey:
      'undeclared.permission:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:retail_profile:profile:one/á',
  },
  {
    actionHash: 'abad1088e0ea695d48a93e7afe73abb45ad96be8d65efeb23dd654c513b505e7',
    actionTarget: {
      targetModuleKey: baselineCustomerContextModuleId,
      targetResourceId: baselineCounterpartyId,
      targetResourceType: 'counterparty:counterparty.purchase.submit',
    },
    key: 'counterparty.purchase.submit:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:counterparty:counterparty:one',
    objectId: baselineCounterpartyObjectId,
    owner: baselineCustomerContextModuleId,
    permission: baselineCounterpartyPermission,
    readHash: baselineLiteral13,
    readTarget: {
      moduleId: baselineCounterpartyPermission,
      resourceId: baselineCounterpartyId,
      resourceType: 'counterparty',
    },
    target: {
      counterpartyId: baselineCounterpartyId,
      kind: 'counterparty',
      legalEntityId: baselineLegalEntityId,
      tenantId: baselineTenantId,
    },
    tenantOnly: false,
    unknownKey:
      'undeclared.permission:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:counterparty:counterparty:one',
  },
  {
    actionHash: '1c20cd0ea628df844076f14ea520b8e19b704091b0977cfa5a672d2577b7cdb9',
    actionTarget: {
      targetModuleKey: baselineCustomerContextModuleId,
      targetResourceId: 'counterparty:one:storefront-a',
      targetResourceType: 'counterparty_storefront:counterparty.purchase.submit',
    },
    key: 'counterparty.purchase.submit:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:counterparty_storefront:counterparty:one:storefront-a',
    objectId: baselineCounterpartyStorefrontObjectId,
    owner: baselineCustomerContextModuleId,
    permission: baselineCounterpartyPermission,
    readHash: baselineLiteral13,
    readTarget: {
      moduleId: baselineCounterpartyPermission,
      resourceId: 'counterparty:one:storefront-a',
      resourceType: 'counterparty_storefront',
    },
    target: {
      counterpartyId: baselineCounterpartyId,
      kind: 'counterparty_storefront',
      legalEntityId: baselineLegalEntityId,
      storefrontId: 'storefront-a',
      tenantId: baselineTenantId,
    },
    tenantOnly: false,
    unknownKey:
      'undeclared.permission:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:counterparty_storefront:counterparty:one:storefront-a',
  },
  {
    actionHash: '2c05cba1458e4072845354906ed7122f617bc1ced5da1e2f619a2da84dc2654a',
    actionTarget: {
      targetModuleKey: baselinePriceGroupModuleId,
      targetResourceId: baselinePricingCatalogId,
      targetResourceType: 'pricing_catalog:pricing.price_group.create',
    },
    key: 'pricing.price_group.create:00000000-0000-4000-8000-000000000001:pricing_catalog:50000000-0000-4000-8000-000000000001',
    objectId: baselinePricingCatalogObjectId,
    owner: baselinePriceGroupModuleId,
    permission: 'pricing.price_group.create',
    readHash: baselineLiteral13,
    readTarget: {
      moduleId: 'pricing.price_group.create',
      resourceId: baselinePricingCatalogId,
      resourceType: 'pricing_catalog',
    },
    target: {
      kind: 'pricing_catalog',
      pricingCatalogId: baselinePricingCatalogId,
      tenantId: baselineTenantId,
    },
    tenantOnly: true,
    unknownKey:
      'undeclared.permission:00000000-0000-4000-8000-000000000001:pricing_catalog:50000000-0000-4000-8000-000000000001',
  },
  {
    actionHash: 'db6effc00c2787388ab72afdca8fbadf358c8905bf0a986e0d2fd83e20d6cb6e',
    actionTarget: {
      targetModuleKey: baselinePriceGroupModuleId,
      targetResourceId: '50000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001',
      targetResourceType: 'price_group:pricing.price_group.read',
    },
    key: 'pricing.price_group.read:00000000-0000-4000-8000-000000000001:price_group:50000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001',
    objectId: baselinePriceGroupObjectId,
    owner: baselinePriceGroupModuleId,
    permission: 'pricing.price_group.read',
    readHash: baselineLiteral13,
    readTarget: {
      moduleId: 'pricing.price_group.read',
      resourceId: '50000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001',
      resourceType: 'price_group',
    },
    target: {
      kind: 'price_group',
      priceGroupId: '60000000-0000-4000-8000-000000000001',
      pricingCatalogId: baselinePricingCatalogId,
      tenantId: baselineTenantId,
    },
    tenantOnly: true,
    unknownKey:
      'undeclared.permission:00000000-0000-4000-8000-000000000001:price_group:50000000-0000-4000-8000-000000000001:60000000-0000-4000-8000-000000000001',
  },
  {
    actionHash: '094c36b73ead47cc8e9c42df75bacf5a74cea96c333fa40f34d0722739c2ebdd',
    actionTarget: {
      targetModuleKey: baselineInventoryModuleId,
      targetResourceId: baselineInventoryResourceId,
      targetResourceType: baselineInventoryResourceType,
    },
    key: 'inventory.stock.correct:00000000-0000-4000-8000-000000000001:inventory_resource:commerce.inventory:commerce.inventory.stock-position:70000000-0000-4000-8000-000000000001',
    objectId: baselineInventoryResourceObjectId,
    owner: baselineInventoryModuleId,
    permission: 'inventory.stock.correct',
    readHash: baselineLiteral13,
    readTarget: {
      moduleId: baselineInventoryModuleId,
      resourceId: baselineInventoryResourceId,
      resourceType: baselineInventoryResourceType,
    },
    target: {
      kind: 'inventory_resource',
      resource: {
        moduleId: baselineInventoryModuleId,
        resourceId: baselineInventoryResourceId,
        resourceType: baselineInventoryResourceType,
      },
      tenantId: baselineTenantId,
    },
    tenantOnly: true,
    unknownKey:
      'undeclared.permission:00000000-0000-4000-8000-000000000001:inventory_resource:commerce.inventory:commerce.inventory.stock-position:70000000-0000-4000-8000-000000000001',
  },
  {
    actionHash: '844f2afa9d76676963e51de8f68f6547db4a05f5a80bb94a666aef290a1140bf',
    actionTarget: {
      targetModuleKey: 'commerce.tax',
      targetResourceId: baselineLegalEntityId,
      targetResourceType: 'tax_selling_legal_entity:tax.rule.manage',
    },
    key: 'tax.rule.manage:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:tax_selling_legal_entity',
    objectId: baselineTaxSellingLegalEntityObjectId,
    owner: 'commerce.tax',
    permission: 'tax.rule.manage',
    readHash: null,
    readTarget: {
      moduleId: 'tax.rule.manage',
      resourceId: baselineLegalEntityId,
      resourceType: 'tax_selling_legal_entity',
    },
    target: {
      kind: 'tax_selling_legal_entity',
      legalEntityId: baselineLegalEntityId,
      tenantId: baselineTenantId,
    },
    tenantOnly: false,
    unknownKey:
      'undeclared.permission:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:tax_selling_legal_entity',
  },
] as const;
