export const customerPriceGroupCatalogRejectedProblemByReasonCode = {
  INCOMPATIBLE: { code: 'customer_price_group_catalog_rejected', kind: 'ineligible' },
  MISSING: { code: 'customer_price_group_catalog_rejected', kind: 'notFound' },
  RETIRED: { code: 'customer_price_group_catalog_rejected', kind: 'ineligible' },
  UNUSABLE: { code: 'customer_price_group_catalog_rejected', kind: 'ineligible' },
} as const;
