import { Schema } from 'effect';

import { PrepareOrderCommitmentPayloadSchema } from '../../shared/actions/prepare-order-commitment.ts';
import type { OrderTaxCandidateSchema } from '../../shared/domain/order-finalization-evidence.ts';
import { orderLegalEntityId, orderTenantId } from './order-revalidation-work.ts';

/** The buyer that submits the preparation; the Action harness principal uses the same id. */
export const orderBuyerPrincipalId = '20000000-0000-4000-8000-000000000001';
const quotationRef = 'quotation:final';
const candidateId = '90000000-0000-4000-8000-000000000001';
const counterpartyId = '70000000-0000-4000-8000-000000000001';
const taxRelevantTime = '2026-10-29T10:00:00.000Z';
/** Caller-chosen purchase identities; each must agree with the candidate, Quotation and storefront. */
export interface OrderPreparationIdentities {
  readonly pricingResultId: string;
  readonly purchaseCandidateRef: string;
  readonly storefrontRef: string;
}
const consistent: OrderPreparationIdentities = {
  pricingResultId: quotationRef,
  purchaseCandidateRef: candidateId,
  storefrontRef: 'storefront-1',
};
const purchase = ({
  pricingResultId,
  purchaseCandidateRef,
  storefrontRef,
}: OrderPreparationIdentities): OrderTaxCandidateEncoded['purchase'] => ({
  currency: 'CZK',
  pricingResultRef: { pricingResultId, revision: 1 },
  purchaseCandidateRef,
  purchaseDemandOccurrences: [
    {
      catalogSelection: { productRef: 'product-1', variantRef: 'variant-1' },
      occurrenceId: 'o1',
      quantity: { amount: '1', unitRef: 'piece' },
    },
  ],
  purchasingSubject: { _tag: 'COUNTERPARTY', counterpartyRef: counterpartyId },
  sellingLegalEntityRef: orderLegalEntityId,
  tenantId: orderTenantId,
  traceabilityContext: { actingPrincipalRef: orderBuyerPrincipalId, channel: 'B2B', storefrontRef },
});

/**
 * An Order-local, schema-valid preparation input. Its Tax candidate carries labelled caller-side
 * owner evidence only; nothing here claims Tax, Cart or Pricing issued it.
 */
/** The encoded Tax candidate a caller submits; a change is still decoded by the Order contract. */
export type OrderTaxCandidateEncoded = typeof OrderTaxCandidateSchema.Encoded;
export type OrderTaxCandidateChange = (candidate: OrderTaxCandidateEncoded) => OrderTaxCandidateEncoded;
export const orderPreparationInput = (
  changed: Partial<OrderPreparationIdentities> = {},
  changeTaxCandidate: OrderTaxCandidateChange = (candidate) => candidate,
) => {
  const identities = { ...consistent, ...changed };
  return Schema.decodeUnknownSync(PrepareOrderCommitmentPayloadSchema)({
    candidateHash: 'c'.repeat(64),
    candidateRef: {
      moduleId: 'commerce.cart',
      resourceId: candidateId,
      resourceType: 'commerce.cart.final-cart-candidate',
      tenantId: orderTenantId,
    },
    commitmentCorrelationId: 'commitment-correlation',
    counterpartyRef: {
      moduleId: 'party.registry',
      resourceId: counterpartyId,
      resourceType: 'party.registry.counterparty',
      tenantId: orderTenantId,
    },
    quotationRef,
    requestRef: {
      moduleId: 'commerce.customer-context',
      resourceId: '80000000-0000-4000-8000-000000000001',
      resourceType: 'commerce.customer-context.purchase-approval-request',
      tenantId: orderTenantId,
    },
    storefrontId: 'storefront-1',
    taxCandidate: changeTaxCandidate({
      catalog: [
        {
          classificationInput: {
            catalogSelection: { productRef: 'product-1', variantRef: 'variant-1' },
            evidencePurpose: 'TAX',
            materialCatalogEvidence: [
              {
                _tag: 'CURRENT',
                catalogFactRef: 'o1:tax-category',
                catalogFactRevisionRef: 'r1',
                factKind: 'TAX_CATEGORY',
                factValue: 'cz-standard-goods',
                ownerEvidenceRef: 'catalog-evidence:o1:r1',
              },
            ],
            materialEvidenceCompleteness: { _tag: 'OWNER_VERIFIED_COMPLETE', ownerEvidenceRef: 'catalog-complete' },
          },
          occurrenceId: 'o1',
        },
      ],
      decompositionNeed: 'PER_TAXABLE_SUPPLY_UNIT',
      eligibility: {
        _tag: 'CURRENT',
        authorityContractRef: 'order-fixture:purchase-tax-scope-authority',
        contract: 'TAX_LAUNCH_ELIGIBILITY_V1',
        evidencePurpose: 'TAX',
        materialEvidenceCompleteness: { _tag: 'OWNER_QUALIFIED_COMPLETE', ownerEvidenceRef: 'scope-complete' },
        ownerEvidenceRef: 'order-fixture:purchase-tax-scope',
        ownerEvidenceRevisionRef: 'r1',
        purchase: purchase(identities),
        requiredTaxRegimes: ['ORDINARY_DOMESTIC'],
        requiredTaxTreatments: ['TAXABLE'],
        sourceOwner: 'commerce.order',
        taxRelevantTime,
      },
      places: {
        deliveryDestination: { _tag: 'OWNER_RESOLVED', countryCode: 'CZ', ownerEvidenceRef: 'delivery-evidence' },
        invoiceRecipient: { _tag: 'NOT_MATERIAL' },
        sellingLegalEntity: { _tag: 'OWNER_RESOLVED', countryCode: 'CZ', ownerEvidenceRef: 'seller-place-evidence' },
      },
      pricing: {
        pricingResultRef: { pricingResultId: quotationRef, revision: 1 },
        publishedLines: [
          {
            breakdown: [],
            lineCommercialValue: {
              amount: { denominator: '1', numerator: '1000' },
              amountBasis: 'NET',
              currency: 'CZK',
            },
            occurrenceId: 'o1',
            pricingLineRef: 'pricing-line-o1',
          },
        ],
      },
      purchase: purchase(identities),
    }),
  });
};
