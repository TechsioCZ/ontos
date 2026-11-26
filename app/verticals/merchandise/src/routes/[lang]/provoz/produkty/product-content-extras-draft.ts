// Extra storefront content of a product: additional categories, homepage order, brand, SEO, documents and related
// products. Empty values are sent as '' / [] because a patch cannot delete a key.
import { Option } from 'effect';
import type { ProductPatch } from '../../../../../shared/actions/apply-command.ts';
import type { CategoryTrail, ProductRecord } from '../../../../../shared/apis/records.ts';
import { CatalogCategoryIdSchema, ProductIdReferenceSchema } from '../../../../../shared/domain/merchandise-model.ts';

export interface DocumentDraft {
  readonly key: number;
  readonly label: string;
  readonly url: string;
}

export interface ContentExtras {
  readonly additionalCategories: readonly CategoryTrail[];
  readonly brand: string;
  readonly documents: readonly DocumentDraft[];
  readonly featuredText: string;
  /** Related product ids in display order. */
  readonly related: readonly string[];
  readonly seoDescription: string;
  readonly seoTitle: string;
}

export const contentExtrasOf = (product: ProductRecord): ContentExtras => ({
  additionalCategories: (product.additionalCategoryIds ?? []).map((id) => ({ id, trail: id })),
  brand: product.brand ?? '',
  documents: (product.documents ?? []).map((document, index) => ({ ...document, key: index })),
  featuredText: Option.match(product.featuredPosition ?? Option.none(), { onNone: () => '', onSome: String }),
  related: product.relatedProductIds ?? [],
  seoDescription: product.seoDescription ?? '',
  seoTitle: product.seoTitle ?? '',
});

export const documentUrlInvalid = (url: string) => {
  const trimmed = url.trim();
  return !(trimmed.startsWith('https://') || trimmed.startsWith('/'));
};

const featuredOf = (text: string): number | null => {
  const trimmed = text.trim().replace(',', '.');
  return trimmed === '' ? null : Number(trimmed);
};

export const featuredInvalid = (text: string) => {
  const value = featuredOf(text);
  return value !== null && !Number.isFinite(value);
};

export const contentExtrasInvalid = (extras: ContentExtras): boolean =>
  featuredInvalid(extras.featuredText) ||
  extras.brand.trim().length > 120 ||
  extras.seoTitle.trim().length > 200 ||
  extras.seoDescription.trim().length > 500 ||
  extras.documents.length > 20 ||
  extras.documents.some(
    (document) =>
      document.label.trim() === '' ||
      document.label.trim().length > 200 ||
      document.url.trim().length > 1000 ||
      documentUrlInvalid(document.url),
  ) ||
  extras.related.length > 12;

const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const sameDocuments = (
  left: readonly { readonly label: string; readonly url: string }[],
  right: readonly { readonly label: string; readonly url: string }[],
) =>
  left.length === right.length &&
  left.every((document, index) => document.label === right[index]?.label && document.url === right[index]?.url);

type MutablePatch = { -readonly [Key in keyof ProductPatch]: ProductPatch[Key] };

/** Adds the changed extra fields to `patch`. Additional categories need a primary category on the server. */
export const addContentExtrasPatch = (patch: MutablePatch, extras: ContentExtras, product: ProductRecord): void => {
  const categoryIds = extras.additionalCategories.map((category) => category.id);
  if (!sameIds(categoryIds, product.additionalCategoryIds ?? [])) {
    patch.additionalCategoryIds = categoryIds.map((id) => CatalogCategoryIdSchema.make(id));
  }
  const featured = featuredOf(extras.featuredText);
  const currentFeatured = Option.getOrNull(product.featuredPosition ?? Option.none());
  if (featured !== currentFeatured) {
    patch.featuredPosition = Option.fromNullOr(featured);
  }
  if (extras.brand.trim() !== (product.brand ?? '')) {
    patch.brand = extras.brand.trim();
  }
  if (extras.seoTitle.trim() !== (product.seoTitle ?? '')) {
    patch.seoTitle = extras.seoTitle.trim();
  }
  if (extras.seoDescription.trim() !== (product.seoDescription ?? '')) {
    patch.seoDescription = extras.seoDescription.trim();
  }
  const documents = extras.documents.map((document) => ({ label: document.label.trim(), url: document.url.trim() }));
  if (!sameDocuments(documents, product.documents ?? [])) {
    patch.documents = documents;
  }
  if (!sameIds(extras.related, product.relatedProductIds ?? [])) {
    patch.relatedProductIds = extras.related.map((id) => ProductIdReferenceSchema.make(id));
  }
};
