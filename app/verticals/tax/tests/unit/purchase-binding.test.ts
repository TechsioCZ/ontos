import { describe, expect, it } from 'effect-rstest';

import { isSameExactTaxPurchaseBinding, isSamePurchaseIdentity } from '../../src/domain/purchase-binding.ts';
import { decodePurchaseBinding, occurrenceInput, purchaseBindingInput } from './tax-domain-fixtures.ts';

describe('Exact Tax purchase binding', () => {
  it('#937 F1-F6 identical visible values on another purchase are not the same binding', () => {
    const purchaseA = decodePurchaseBinding(purchaseBindingInput(['o-a']));
    const purchaseB = decodePurchaseBinding(purchaseBindingInput(['o-b'], { purchaseCandidateRef: 'purchase-b' }));

    expect(isSameExactTaxPurchaseBinding(purchaseA, purchaseA)).toBe(true);
    expect(isSameExactTaxPurchaseBinding(purchaseA, purchaseB)).toBe(false);
  });

  it('#937 F7 array position is not identity', () => {
    const ordered = decodePurchaseBinding(purchaseBindingInput(['o-1', 'o-2']));
    const reordered = decodePurchaseBinding(purchaseBindingInput(['o-2', 'o-1']));

    expect(isSameExactTaxPurchaseBinding(ordered, reordered)).toBe(true);
  });

  it('#937 F14 Quantity + Unit stay exact-bound', () => {
    const original = decodePurchaseBinding(purchaseBindingInput(['o-1']));
    const changed = decodePurchaseBinding(
      purchaseBindingInput(['o-1'], {
        purchaseDemandOccurrences: [{ ...occurrenceInput('o-1'), quantity: { amount: '2', unitRef: 'piece' } }],
      }),
    );

    expect(isSameExactTaxPurchaseBinding(original, changed)).toBe(false);
  });

  it('#937 F16 rejects a binding that collapses two occurrences into one identity', () => {
    expect(() => decodePurchaseBinding(purchaseBindingInput(['o-1', 'o-1']))).toThrow();
  });

  it('#937 F26-F28 a distinct Pricing Result revision with the same total does not substitute', () => {
    const p1 = decodePurchaseBinding(purchaseBindingInput(['o-1']));
    const p2 = decodePurchaseBinding(
      purchaseBindingInput(['o-1'], { pricingResultRef: { pricingResultId: 'pricing-result-1', revision: 2 } }),
    );

    expect(isSameExactTaxPurchaseBinding(p1, p2)).toBe(false);
  });

  it('#937 F29-F30 Shipping source revision change is a different exact binding', () => {
    const shipping1 = decodePurchaseBinding(
      purchaseBindingInput(['o-1'], { shippingSourceRef: { revision: 1, shippingAmountId: 'shipping-1' } }),
    );
    const shipping2 = decodePurchaseBinding(
      purchaseBindingInput(['o-1'], { shippingSourceRef: { revision: 2, shippingAmountId: 'shipping-1' } }),
    );
    const withoutShipping = decodePurchaseBinding(purchaseBindingInput(['o-1']));

    expect(isSameExactTaxPurchaseBinding(shipping1, shipping2)).toBe(false);
    expect(isSameExactTaxPurchaseBinding(shipping1, withoutShipping)).toBe(false);
  });

  it('#937 F18 F20 Selling Legal Entity and Purchasing Subject are explicit bindings', () => {
    const original = decodePurchaseBinding(purchaseBindingInput(['o-1']));
    const otherSeller = decodePurchaseBinding(
      purchaseBindingInput(['o-1'], { sellingLegalEntityRef: 'selling-legal-entity-2' }),
    );
    const counterparty = decodePurchaseBinding(
      purchaseBindingInput(['o-1'], {
        purchasingSubject: { _tag: 'COUNTERPARTY', counterpartyRef: 'retail-customer-1' },
      }),
    );

    expect(isSameExactTaxPurchaseBinding(original, otherSeller)).toBe(false);
    expect(isSameExactTaxPurchaseBinding(original, counterparty)).toBe(false);
  });

  it('#937 F23-F25 currency is explicit and closed to CZK', () => {
    const { currency: _currency, ...withoutCurrency } = purchaseBindingInput(['o-1']);

    expect(() => decodePurchaseBinding({ ...purchaseBindingInput(['o-1']), currency: 'EUR' })).toThrow();
    expect(() => decodePurchaseBinding(withoutCurrency)).toThrow();
  });

  it('#937 F38 F46-F51 traceability-only context does not change the exact Tax binding', () => {
    const storefront1 = decodePurchaseBinding(purchaseBindingInput(['o-1']));
    const storefront2 = decodePurchaseBinding(
      purchaseBindingInput(['o-1'], {
        traceabilityContext: { channel: 'B2B', locale: 'en', storefrontRef: 'storefront-2' },
      }),
    );

    expect(isSameExactTaxPurchaseBinding(storefront1, storefront2)).toBe(true);
  });

  it('#943 F9 F11-F12 the same purchase/use survives a new candidate, Pricing Result and Shipping source revision', () => {
    const approved = decodePurchaseBinding(purchaseBindingInput(['o-1']));
    const finalCandidate = decodePurchaseBinding(
      purchaseBindingInput(['o-1'], {
        pricingResultRef: { pricingResultId: 'pricing-result-2', revision: 3 },
        purchaseCandidateRef: 'purchase-final',
        shippingSourceRef: { revision: 2, shippingAmountId: 'shipping-1' },
      }),
    );

    expect(isSamePurchaseIdentity(approved, finalCandidate)).toBe(true);
    expect(isSameExactTaxPurchaseBinding(approved, finalCandidate)).toBe(false);
  });

  it('#937 F12-F20 #943 F1 changed quantity, subject or seller is not the same purchase/use', () => {
    const original = decodePurchaseBinding(purchaseBindingInput(['o-1']));
    const changedQuantity = decodePurchaseBinding(
      purchaseBindingInput(['o-1'], {
        purchaseDemandOccurrences: [{ ...occurrenceInput('o-1'), quantity: { amount: '2', unitRef: 'piece' } }],
      }),
    );
    const otherSubject = decodePurchaseBinding(
      purchaseBindingInput(['o-1'], { purchasingSubject: { _tag: 'COUNTERPARTY', counterpartyRef: 'counterparty-1' } }),
    );
    const otherSeller = decodePurchaseBinding(purchaseBindingInput(['o-1'], { sellingLegalEntityRef: 'seller-2' }));

    expect(isSamePurchaseIdentity(original, changedQuantity)).toBe(false);
    expect(isSamePurchaseIdentity(original, otherSubject)).toBe(false);
    expect(isSamePurchaseIdentity(original, otherSeller)).toBe(false);
  });
});
