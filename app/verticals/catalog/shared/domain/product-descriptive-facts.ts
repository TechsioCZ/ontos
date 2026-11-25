import { Schema } from 'effect';

import { ProductRefSchema } from '@app/catalog-selection-contracts/resources/product';
import { ProductNameSchema } from './product.ts';

/** Stored language value, not an entity identifier; preserve historical spelling without normalization. */
export const StoredCatalogLocaleSchema = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(64),
  Schema.isTrimmed(),
);
export type StoredCatalogLocale = typeof StoredCatalogLocaleSchema.Type;

/** New external locale input must use canonical spelling before any owner write. */
export const CatalogLocaleSchema = StoredCatalogLocaleSchema.check(
  Schema.makeFilter((locale) => {
    try {
      return Intl.getCanonicalLocales(locale)[0] === locale || 'A Catalog locale must be a canonical locale tag';
    } catch {
      return 'A Catalog locale must be a canonical locale tag';
    }
  }),
);
export type CatalogLocale = typeof CatalogLocaleSchema.Type;

const FactualDescriptionSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4000));

const ProductLocalizedFactsSchema = Schema.Struct({
  description: Schema.optionalKey(FactualDescriptionSchema),
  locale: StoredCatalogLocaleSchema,
  name: ProductNameSchema,
});
type ProductLocalizedFacts = typeof ProductLocalizedFactsSchema.Type;

/** Drafts may have no translations; completion requires at least one usable name. */
export const ProductDescriptiveFactsSchema = Schema.Struct({
  localized: Schema.Array(ProductLocalizedFactsSchema),
  productRef: ProductRefSchema,
}).check(
  Schema.makeFilter(({ localized }) =>
    new Set(localized.map(({ locale }) => locale)).size === localized.length
      ? undefined
      : 'A Product may have only one set of descriptive facts per locale',
  ),
);
export type ProductDescriptiveFacts = typeof ProductDescriptiveFactsSchema.Type;

export const hasCatalogTextMinimum = (facts: ProductDescriptiveFacts): boolean =>
  facts.localized.some(({ name }) => name.trim().length > 0);

export type LocalizedFactsLookup =
  | { readonly facts: ProductLocalizedFacts; readonly kind: 'PRESENT' }
  | { readonly kind: 'MISSING_TRANSLATION'; readonly requestedLocale: StoredCatalogLocale };

/** Never relabel another locale's value as a translation or persist a presentation fallback. */
export const lookupProductLocalizedFacts = (
  facts: ProductDescriptiveFacts,
  requestedLocale: StoredCatalogLocale,
): LocalizedFactsLookup => {
  const found = facts.localized.find(({ locale }) => locale === requestedLocale);
  return found === undefined ? { kind: 'MISSING_TRANSLATION', requestedLocale } : { facts: found, kind: 'PRESENT' };
};
