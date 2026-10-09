import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  ProductDescriptiveFactsSchema,
  hasCatalogTextMinimum,
  lookupProductLocalizedFacts,
} from '../../shared/domain/product-descriptive-facts.ts';

const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId: '11111111-1111-4111-8111-111111111111',
} as const;

const decode = Schema.decodeUnknownSync(ProductDescriptiveFactsSchema);

describe('Catalog Product descriptive facts', () => {
  it('allows an incomplete draft and needs one nonblank name, not a long description', () => {
    expect(hasCatalogTextMinimum(decode({ localized: [], productRef }))).toBe(false);
    const facts = decode({ localized: [{ locale: 'cs-CZ', name: '  Police Alfa  ' }], productRef });
    expect(hasCatalogTextMinimum(facts)).toBe(true);
    expect(facts.localized[0]?.name).toBe('Police Alfa');
    expect(facts.localized[0]?.description).toBeUndefined();
    expect(() => decode({ localized: [{ locale: 'cs-CZ', name: '   ' }], productRef })).toThrow();
  });

  it('rejects duplicate locales and empty descriptions when supplied', () => {
    expect(() =>
      decode({
        localized: [
          { locale: 'cs-CZ', name: 'Alfa' },
          { locale: 'cs-CZ', name: 'Beta' },
        ],
        productRef,
      }),
    ).toThrow();
    expect(() => decode({ localized: [{ description: '  ', locale: 'cs-CZ', name: 'Alfa' }], productRef })).toThrow();
  });

  it('reports a missing required locale without substituting or relabeling another value', () => {
    const facts = decode({ localized: [{ locale: 'cs-CZ', name: 'Police Alfa' }], productRef });
    expect(lookupProductLocalizedFacts(facts, 'de-DE')).toEqual({
      kind: 'MISSING_TRANSLATION',
      requestedLocale: 'de-DE',
    });
    expect(lookupProductLocalizedFacts(facts, 'cs-CZ')).toEqual({ facts: facts.localized[0], kind: 'PRESENT' });
    expect(hasCatalogTextMinimum(facts)).toBe(true);
  });

  it('keeps same-name products distinct by their Product reference', () => {
    const first = decode({ localized: [{ locale: 'cs-CZ', name: 'Montážní držák' }], productRef });
    const second = decode({
      localized: [{ locale: 'cs-CZ', name: 'Montážní držák' }],
      productRef: { ...productRef, resourceId: '33333333-3333-4333-8333-333333333333' },
    });
    expect(first.productRef.resourceId).not.toBe(second.productRef.resourceId);
  });
});
