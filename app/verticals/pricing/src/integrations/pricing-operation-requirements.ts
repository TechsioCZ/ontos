import { requireModuleOperation } from '@app/core-runtime';
import { Effect } from 'effect';

import { PricingCatalogSelectionUnavailable } from '../../shared/domain/catalog-selection-gateway-credential.ts';
import { PricingCommercialContextUnavailable } from '../../shared/domain/commercial-context-gateway-credential.ts';
import {
  CurrentPricingDecisionSubjectAuthority,
  CurrentPricingDecisionSubjectAuthorityUnavailable,
} from '../services/current-pricing-decision-subject-authority.service.ts';
import type { CurrentPricingDecisionSubjectAuthorityInput } from '../services/current-pricing-decision-subject-authority.service.ts';
import { PriceGroupInterpretationDependencyFailure } from '../services/price-group-interpretation.service.ts';
import { PricingOwnerMaterialEvidenceFenceGatewayUnavailable } from './material-evidence-owner-final-fence.ts';

/** Fixed by the genuine Read factory, never by the request's business input. */
export const currentPricingDecisionRequirements = {
  assignedGroupCompatibility: 'commerce.pricing.requirement.current-pricing-decision-assigned-group-compatibility',
  marketFinalFence: 'commerce.pricing.requirement.current-pricing-decision-market-final-fence',
  profilePriceGroup: 'commerce.pricing.requirement.current-pricing-decision-profile-price-group',
  purchaseContext: 'commerce.pricing.requirement.current-pricing-decision-purchase-context',
  purposeEquivalence: 'commerce.pricing.requirement.current-pricing-decision-purpose-equivalence',
  quantityBasis: 'commerce.pricing.requirement.current-pricing-decision-quantity-basis',
} as const;

/** Fixed by the genuine Action factory, independently from the Read's requirements. */
export const manageQuotationRequirements = {
  assignedGroupCompatibility: 'commerce.pricing.requirement.manage-quotation-assigned-group-compatibility',
  marketFinalFence: 'commerce.pricing.requirement.manage-quotation-market-final-fence',
  profilePriceGroup: 'commerce.pricing.requirement.manage-quotation-profile-price-group',
  purchaseContext: 'commerce.pricing.requirement.manage-quotation-purchase-context',
  purposeEquivalence: 'commerce.pricing.requirement.manage-quotation-purpose-equivalence',
  quantityBasis: 'commerce.pricing.requirement.manage-quotation-quantity-basis',
} as const;

export type PricingWholeEvaluationRequirements =
  | typeof currentPricingDecisionRequirements
  | typeof manageQuotationRequirements;

type CatalogRequirement =
  | 'commerce.pricing.requirement.define-price-catalog'
  | 'commerce.pricing.requirement.manage-product-prices-bulk-catalog'
  | 'commerce.pricing.requirement.define-commercial-fee-catalog'
  | 'commerce.pricing.requirement.revise-commercial-fee-catalog'
  | 'commerce.pricing.requirement.manage-product-commercial-fees-bulk-catalog'
  | PricingWholeEvaluationRequirements['quantityBasis' | 'purposeEquivalence'];

export const requirePricingCatalogOperation = (key: CatalogRequirement) =>
  requireModuleOperation(key).pipe(
    Effect.mapError((cause) =>
      Object.defineProperty(
        new PricingCatalogSelectionUnavailable({
          code: 'pricing_catalog_selection_unavailable',
          reason: 'The required Catalog operation is unavailable in the admitted composition',
          retryable: true,
        }),
        'cause',
        { value: cause },
      ),
    ),
  );

export const requirePricingCommercialContextOperation = (
  key:
    | 'commerce.pricing.requirement.define-price-market'
    | 'commerce.pricing.requirement.manage-product-prices-bulk-market',
) =>
  requireModuleOperation(key).pipe(
    Effect.mapError((cause) =>
      Object.defineProperty(
        new PricingCommercialContextUnavailable({
          code: 'pricing_commercial_context_unavailable',
          reason: 'The required Market operation is unavailable in the admitted composition',
          retryable: true,
        }),
        'cause',
        { value: cause },
      ),
    ),
  );

export const requirePricingSubjectOperation = (
  key:
    | PricingWholeEvaluationRequirements['purchaseContext']
    | 'commerce.pricing.requirement.quotation-verify-purchase-context',
) =>
  requireModuleOperation(key).pipe(
    Effect.mapError((cause) =>
      Object.defineProperty(
        new CurrentPricingDecisionSubjectAuthorityUnavailable({
          reason: 'OWNER_VERIFICATION_UNAVAILABLE',
          retryable: true,
        }),
        'cause',
        { value: cause },
      ),
    ),
  );

export const requirePricingPriceGroupOperation = (
  key: PricingWholeEvaluationRequirements['profilePriceGroup' | 'assignedGroupCompatibility'],
  owner: 'COMMERCE_ASSIGNMENT' | 'PRICE_GROUP_COMPATIBILITY',
) =>
  requireModuleOperation(key).pipe(
    Effect.mapError((cause) =>
      Object.defineProperty(
        new PriceGroupInterpretationDependencyFailure({
          kind: 'UNAVAILABLE',
          owner,
          reason: 'The required Price Group owner operation is unavailable in the admitted composition',
        }),
        'cause',
        { value: cause },
      ),
    ),
  );

export const requirePricingMarketFenceOperation = (key: PricingWholeEvaluationRequirements['marketFinalFence']) =>
  requireModuleOperation(key).pipe(
    Effect.mapError((cause) =>
      Object.defineProperty(
        new PricingOwnerMaterialEvidenceFenceGatewayUnavailable({
          ownerModuleId: 'commerce.market-catalog',
          reason: 'The required Market final-fence operation is unavailable in the admitted composition',
          retryable: true,
        }),
        'cause',
        { value: cause },
      ),
    ),
  );

/** Use the owner authority only after the genuine execution satisfies its fixed requirement. */
export const verifyPricingSubjectForRequirement = (
  requirement: Parameters<typeof requirePricingSubjectOperation>[0],
  input: CurrentPricingDecisionSubjectAuthorityInput,
) =>
  requirePricingSubjectOperation(requirement).pipe(
    Effect.andThen(CurrentPricingDecisionSubjectAuthority),
    Effect.flatMap((authority) => authority.verify(input)),
  );
