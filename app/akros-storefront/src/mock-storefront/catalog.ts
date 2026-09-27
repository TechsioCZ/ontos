import { catalogFixture } from "./fixtures/catalog";
import type { CatalogCategory, CatalogProduct } from "./types";

const normalizeSearchTerm = (value: string) =>
  value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("cs-CZ")
    .trim();

const collectCategoryIds = (categoryId: string): Set<string> => {
  const ids = new Set([categoryId]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const category of catalogFixture.categories) {
      if (category.parentId && ids.has(category.parentId) && !ids.has(category.id)) {
        ids.add(category.id);
        changed = true;
      }
    }
  }

  return ids;
};

export const getCategories = (): CatalogCategory[] =>
  [...catalogFixture.categories].sort((left, right) => left.position - right.position);

export const getTopCategories = (): CatalogCategory[] =>
  getCategories().filter((category) => category.parentId === null);

export const getChildCategories = (parentId: string): CatalogCategory[] =>
  getCategories().filter((category) => category.parentId === parentId);

export const getCategoryBySlug = (slug: string): CatalogCategory | undefined =>
  catalogFixture.categories.find((category) => category.slug === slug);

export const getCategoryById = (id: string): CatalogCategory | undefined =>
  catalogFixture.categories.find((category) => category.id === id);

export const getCategoryTrail = (category: CatalogCategory): CatalogCategory[] => {
  const trail: CatalogCategory[] = [category];
  let parentId = category.parentId;

  while (parentId) {
    const parent = catalogFixture.categories.find((candidate) => candidate.id === parentId);
    if (!parent) break;
    trail.unshift(parent);
    parentId = parent.parentId;
  }

  return trail;
};

export const getProducts = (): CatalogProduct[] => [...catalogFixture.products];

export const getFeaturedProducts = (): CatalogProduct[] =>
  getProducts()
    .filter((product) => product.featuredPosition !== null)
    .sort(
      (left, right) =>
        (left.featuredPosition ?? Number.MAX_SAFE_INTEGER) -
        (right.featuredPosition ?? Number.MAX_SAFE_INTEGER),
    );

export const getProductById = (id: string): CatalogProduct | undefined =>
  catalogFixture.products.find((product) => product.id === id);

export const getProductBySlug = (slug: string): CatalogProduct | undefined =>
  catalogFixture.products.find((product) => product.slug === slug);

export const getProductsByCategory = (slug: string): CatalogProduct[] => {
  const category = getCategoryBySlug(slug);
  if (!category) return [];

  const categoryIds = collectCategoryIds(category.id);
  return getProducts().filter((product) => categoryIds.has(product.categoryId));
};

export const searchProducts = (query: string): CatalogProduct[] => {
  const normalizedQuery = normalizeSearchTerm(query);
  if (!normalizedQuery) return [];

  return getProducts().filter((product) =>
    normalizeSearchTerm(`${product.name} ${product.sku} ${product.description}`).includes(
      normalizedQuery,
    ),
  );
};
