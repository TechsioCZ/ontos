import { describe, expect, it } from 'effect-rstest';

import { pricingApi } from '../../shared/api.ts';
import {
  executeCommercialFeeResultLookup,
  executeContractualDiscountResultLookup,
  executeCurrencySupportResultLookup,
  executeCurrentPricingDecision,
  executePriceResultLookup,
  executeQuantityTierResultLookup,
  executeQuotationResultLookup,
  executeZeroFloorAuthorizationResultLookup,
} from '../../src/api/pricing-client.ts';
import { pricingManifest } from '../../vertical.manifest.ts';
import { pricingRegistration } from '../../vertical.registration.ts';

describe('Pricing module contract', () => {
  it('publishes the headless governed Pricing management surface', () => {
    expect(pricingManifest.module.id).toBe('commerce.pricing');
    expect(Object.keys(pricingManifest.publicSurface.api)).toEqual([
      'commercial-fee-definition',
      'commercial-fee-result-lookup',
      'commercial-fee-schedule',
      'contractual-discount-result-lookup',
      'currency-support-result-lookup',
      'current-pricing-decision',
      'current-supported-currencies',
      'exact-price-resolution',
      'price-definition',
      'price-result-lookup',
      'price-schedule',
      'quantity-tier-result-lookup',
      'quotation-result-lookup',
      'zero-floor-authorization-result-lookup',
    ]);
    expect(pricingManifest.publicSurface.resourceTypes.map(({ key }) => key)).toEqual(
      expect.arrayContaining(['commerce.pricing.commercial-fee', 'commerce.pricing.price']),
    );
    expect(pricingManifest.publicSurface.actions.map(({ descriptor }) => descriptor.actionKey)).toEqual(
      expect.arrayContaining([
        'commerce.pricing.define-commercial-fee',
        'commerce.pricing.define-price',
        'commerce.pricing.manage-contractual-discount',
        'commerce.pricing.manage-product-commercial-fees-bulk',
        'commerce.pricing.manage-product-prices-bulk',
        'commerce.pricing.manage-quantity-tier',
        'commerce.pricing.manage-quotation',
        'commerce.pricing.manage-zero-floor-authorization',
        'commerce.pricing.revise-commercial-fee',
        'commerce.pricing.revise-price',
        'commerce.pricing.set-supported-currencies',
      ]),
    );
    expect(pricingManifest.publicSurface.shellContributions.pages).toEqual([]);
    expect(pricingRegistration.moduleId).toBe(pricingManifest.module.id);
    for (const client of [
      executeCommercialFeeResultLookup,
      executeContractualDiscountResultLookup,
      executeCurrencySupportResultLookup,
      executeCurrentPricingDecision,
      executePriceResultLookup,
      executeQuantityTierResultLookup,
      executeQuotationResultLookup,
      executeZeroFloorAuthorizationResultLookup,
    ]) {
      expect(client).toBeDefined();
    }
    expect(pricingApi).toBeDefined();
  });
});
