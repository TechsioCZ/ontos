import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  CatalogLocaleSchema,
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
  it('accepts only canonical locale tags within the localized persistence boundary', () => {
    for (const locale of [
      'x',
      'cs-cz',
      ' cs-CZ',
      'cs-CZ ',
      'en_US',
      'en-a-12345678-12345678-12345678-12345678-12345678-12345678-12345678',
    ]) {
      expect(Schema.is(CatalogLocaleSchema)(locale)).toBe(false);
    }
    for (const locale of ['cs', 'cs-CZ', 'en-US', 'zh-Hant-TW']) {
      expect(Schema.decodeUnknownSync(CatalogLocaleSchema)(locale)).toBe(locale);
    }
  });

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
});
