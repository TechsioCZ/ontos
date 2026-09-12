interface PurchasingApprovalCommercialFixtureOptions {
  readonly money: (amount: string) => Readonly<{ amount: string; currency: string }>;
  readonly tenantId: string;
}

export const purchasingApprovalCommercialFixture = ({
  money,
  tenantId,
}: PurchasingApprovalCommercialFixtureOptions) => ({
  lines: [
    {
      configuration: {},
      discount: money('0'),
      fees: [],
      lineId: 'line-1',
      lineTotal: money('120'),
      pricingRuleRevision: 'pricing-r1',
      productRef: {
        moduleId: 'catalog',
        resourceId: 'product-1',
        resourceType: 'catalog.product',
        tenantId,
      },
      quantity: 1,
      tax: money('20'),
      unitPrice: money('100'),
    },
  ],
  purchaseValue: {
    monetaryAmount: money('120'),
    roundingRuleRevision: 'rounding-r1',
    sourceRef: 'proposal-1',
    sourceRevision: '1',
  },
  sourceCart: {
    cartRef: {
      moduleId: 'commerce.cart',
      resourceId: 'cart-1',
      resourceType: 'commerce.cart.cart',
      tenantId,
    },
    revision: 'cart-r1',
  },
  totals: {
    discount: money('0'),
    fees: [],
    shipping: money('0'),
    subtotal: money('100'),
    tax: money('20'),
    total: money('120'),
  },
});
