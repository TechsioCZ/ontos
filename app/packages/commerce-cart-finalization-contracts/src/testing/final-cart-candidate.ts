const customerContextModule = 'commerce.customer-context';
const catalogModule = 'commerce.catalog';

/** Cart's immutable final candidate wire, consistent for one buyer, Tenant and Selling Legal Entity. */
export const makeFinalCartCandidateWire = (input: {
  readonly buyerPrincipalId: string;
  readonly candidateHash: string;
  readonly candidateId: string;
  readonly legalEntityId: string;
  readonly tenantId: string;
}) => {
  const scope = input;
  const businessTime = '2026-10-24T11:59:00.000Z';
  const validUntil = '2099-01-01T00:00:00.000Z';
  const ref = (moduleId: string, resourceType: string, resourceId: string) => ({
    moduleId,
    resourceId,
    resourceType,
    tenantId: scope.tenantId,
  });
  const profileRef = ref(
    customerContextModule,
    'commerce.customer-context.retail-customer-profile',
    '44444444-4444-4444-8444-444444444444',
  );
  const subject = { authorizationSubject: { kind: 'RETAIL' }, kind: 'PROFILE', profileRef } as const;
  const unitRef = ref(catalogModule, 'commerce.catalog.product-unit', '55555555-5555-4555-8555-555555555555');
  const selection = {
    productRef: ref(catalogModule, 'commerce.catalog.product', '66666666-6666-4666-8666-666666666666'),
    variantRef: ref(catalogModule, 'commerce.catalog.variant', '77777777-7777-4777-8777-777777777777'),
  };
  const decision = {
    commercialScope: { channelId: 'B2C', marketId: 'CZ', sellingLegalEntityId: scope.legalEntityId },
    currencyCode: 'CZK',
    lines: [
      {
        catalog: {
          completeness: {
            observedAt: businessTime,
            ownerRevision: 'catalog:1',
            scope: { kind: 'EXACT_PREDICATE', predicateRef: 'catalog:selection' },
          },
          divisible: false,
          equivalentSelectionKey: 'pricing-purpose:variant:1',
          evidence: {
            assessedAt: businessTime,
            basis: [
              { role: 'PRODUCT', source: { resourceRef: selection.productRef, revision: 1 } },
              { role: 'VARIANT', source: { resourceRef: selection.variantRef, revision: 1 } },
              {
                provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
                role: 'PRODUCT_TYPE_UNTYPED_DECISION',
                source: { resourceRef: selection.productRef, revision: 1 },
              },
            ],
            membership: {
              attestationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              observedAt: businessTime,
              productRef: selection.productRef,
              source: 'CATALOG_OWNER_CURRENT_READ',
              variant: { resourceRef: selection.variantRef, revision: 1 },
            },
            purpose: 'PRICING',
            selection,
            status: 'VALID',
            validUntil,
          },
          hierarchyRevision: 'hierarchy:1',
          ownerRevision: 'catalog:1',
          quantity: {
            changed: false,
            notice: null,
            requested: '1',
            resulting: '1',
            rounding: 'HALF_UP',
            status: 'VALID',
            step: '1',
            targetId: selection.variantRef.resourceId,
            tenantId: scope.tenantId,
            unitId: unitRef.resourceId,
            unitRuleRevision: 1,
          },
          quantityBasis: {
            targetDivisibilityRevision: 1,
            targetRef: selection.variantRef,
            unitRef,
            unitRuleRevision: 1,
          },
          selection,
          status: 'READY',
          unitRef,
        },
        occurrenceId: 'line:1',
        pricingBasis: { quantity: '1', unitRef },
      },
    ],
    monetaryBoundary: 'PRE_TAX',
    operationTime: businessTime,
    purchasingContext: {
      accessDecision: { decisionRef: 'access:1', decisionRevision: '1' },
      actor: { kind: 'PRINCIPAL', principalId: scope.buyerPrincipalId },
      commercialSettingsDecision: { decisionRef: 'settings:1', decisionRevision: '1' },
      contextRef: 'purchase-context:1',
      contextRevision: '1',
      currencyResolution: { currencyCode: 'CZK', resolutionRef: 'currency:1', resolutionRevision: '1' },
      subject,
    },
    tenantId: scope.tenantId,
  };
  const cartRef = ref('commerce.cart', 'commerce.cart.cart', '88888888-8888-4888-8888-888888888888');
  return {
    approval: {
      proposalHash: 'a'.repeat(64),
      proposalRevisionRef: ref(
        customerContextModule,
        'commerce.customer-context.purchase-proposal-revision',
        'proposal:1',
      ),
      requestRef: ref(customerContextModule, 'commerce.customer-context.purchase-approval-request', 'request:1'),
    },
    buyerPrincipalId: scope.buyerPrincipalId,
    candidateHash: input.candidateHash,
    candidateRef: ref('commerce.cart', 'commerce.cart.final-cart-candidate', input.candidateId),
    finalCartRevision: { cartRef, revision: 2, revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    legalEntityId: scope.legalEntityId,
    orderCommitmentTime: businessTime,
    pricing: { decision, subject },
    sourceCart: { cartRef, revision: 1, revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    storefrontId: 'unit-storefront',
    tenantId: scope.tenantId,
    version: 'FINAL_CART_CANDIDATE.v1',
  };
};
