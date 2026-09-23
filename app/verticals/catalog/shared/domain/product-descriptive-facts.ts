import { Schema } from 'effect';

import { ProductRefSchema } from '../resources/product.ts';
import { ProductNameSchema } from './product.ts';

/** A locale identifies the language of the supplied fact; it is not a Product identity. */
export const CatalogLocaleSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.isTrimmed(),
);
export type CatalogLocale = typeof CatalogLocaleSchema.Type;

const FactualDescriptionSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4000));

const ProductLocalizedFactsSchema = Schema.Struct({
  description: Schema.optionalKey(FactualDescriptionSchema),
  locale: CatalogLocaleSchema,
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
  | { readonly kind: 'MISSING_TRANSLATION'; readonly requestedLocale: CatalogLocale };

/** Never relabel another locale's value as a translation or persist a presentation fallback. */
export const lookupProductLocalizedFacts = (
  facts: ProductDescriptiveFacts,
  requestedLocale: CatalogLocale,
): LocalizedFactsLookup => {
  const found = facts.localized.find(({ locale }) => locale === requestedLocale);
  return found === undefined ? { kind: 'MISSING_TRANSLATION', requestedLocale } : { facts: found, kind: 'PRESENT' };
};
