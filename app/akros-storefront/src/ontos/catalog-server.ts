import "server-only";
import { cache } from "react";
import type { CatalogCategory, CatalogProduct } from "@/ontos/catalog-types";
import { catalogCache } from "./catalog-cache";
import { createCatalog } from "./catalog-model";
import { readRecords } from "./gateway";
import {
  projectCategories,
  projectProducts,
  type CatalogSnapshot,
  type ProductPage,
} from "./catalog-projection";
export type { CatalogSnapshot } from "./catalog-projection";

/** `view.storefrontCatalog` product filters (merchandise `StorefrontCatalogQuerySchema`). */
export interface CatalogQuery {
  page?: number;
  pageSize?: number;
  slug?: string;
  categorySlug?: string;
  q?: string;
  featured?: boolean;
  productIds?: string[];
  /** With `fields: "full"`: each product's variant records hold only these variants (cart reads). */
  variantIds?: string[];
  minMinor?: number;
  maxMinor?: number;
  availability?: "in-stock" | "out-of-stock";
  sort?: "name" | "price-asc" | "price-desc";
  label?: "action" | "recommended" | "sale" | "new";
  /** Storefront section: sent to OntOS as `label` (promotion = action + sale). Never sent as-is. */
  flag?: "new" | "promotion" | "recommended";
}
/** `card` = listing rows (no variant records, parameters or description); `full` = product detail. */
export type CatalogFields = "card" | "full";
export type CatalogModel = ReturnType<typeof createCatalog>;
interface CategoryPage {
  /** The category and its direct children, with their content (merged into the root tree). */
  categories: CatalogCategory[];
  page: ProductPage;
}
export interface CatalogPage {
  model: CatalogModel;
  products: CatalogProduct[];
  total: number;
  page: number;
  pageSize: number;
}

/** Price/stock-bearing values may render only within this window; expired reads block on OntOS. */
export const CATALOG_CACHE_MS = 10_000;
/** Price-free category/navigation data can refresh in the background. */
export const CATEGORY_CACHE_MS = 15 * 60_000;
const CATEGORY_STALE_MS = 60 * 60_000;
const CATEGORY_KEEP_MS = 24 * 60 * 60_000;
/** Category listing page size. */
export const CATEGORY_PAGE_SIZE = 24;
// Kai's model shows 16 cards and skips placeholder groups (e.g. one named "AKCE"): read a few spares.
const homeQuery: CatalogQuery = { featured: true, pageSize: 20 };

const productPages = catalogCache<ProductPage>("products", {
  storage: "isolate",
  freshMs: CATALOG_CACHE_MS,
  staleMs: CATALOG_CACHE_MS,
  keepMs: CATALOG_CACHE_MS,
  limit: 100,
});
const categoryTrees = catalogCache<CatalogCategory[]>("categories", {
  storage: "shared",
  freshMs: CATEGORY_CACHE_MS,
  staleMs: CATEGORY_STALE_MS,
  keepMs: CATEGORY_KEEP_MS,
  limit: 4,
});
/** Only price-free active-category/child content is retained for the navigation window. */
const categoryContent = catalogCache<CatalogCategory[]>("category-details", {
  storage: "isolate",
  freshMs: CATEGORY_CACHE_MS,
  staleMs: CATEGORY_STALE_MS,
  keepMs: CATEGORY_KEEP_MS,
  limit: 60,
});
/** The first category listing still expires strictly after ten seconds. */
const categoryPages = catalogCache<CategoryPage>("category-content", {
  storage: "isolate",
  freshMs: CATALOG_CACHE_MS,
  staleMs: CATALOG_CACHE_MS,
  keepMs: CATALOG_CACHE_MS,
  limit: 60,
});

const readCatalog = async (storefrontCatalog: Record<string, unknown>) =>
  (await readRecords("merchandise", "records", {
    view: { storefront: true, storefrontCatalog },
  })) as Record<string, unknown>;

/** Drop unset keys (and the storefront-only `flag`, which OntOS rejects) so equal queries share a cache key. */
const compact = (query: CatalogQuery): CatalogQuery =>
  Object.fromEntries(
    Object.entries(query).filter(
      ([key, value]) => key !== "flag" && value !== undefined && value !== "",
    ),
  ) as CatalogQuery;

const productKey = (query: CatalogQuery, fields: CatalogFields) =>
  JSON.stringify({ ...compact(query), fields, includeCategories: false });

const loadProducts = (key: string) => async () =>
  projectProducts(await readCatalog(JSON.parse(key) as Record<string, unknown>));
// One owner read per render for equal queries, keyed by the serialized owner query.
const cachedProducts = cache((key: string): Promise<ProductPage> =>
  productPages.get(key, loadProducts(key)),
);

/** One bounded product read without the category tree. `fresh` reads OntOS now (carts, quotes, orders). */
export async function readProducts(
  query: CatalogQuery,
  fields: CatalogFields,
  fresh = false,
): Promise<ProductPage> {
  const key = productKey(query, fields);
  return fresh ? await loadProducts(key)() : await cachedProducts(key);
}

/** Fresh full records of the cart's products, each carrying only the cart's variants (cart quote). */
export async function readCartProducts(
  lines: readonly { productId: string; variantId?: string }[],
): Promise<ProductPage> {
  const productIds = [...new Set(lines.map((line) => line.productId))];
  const variantIds = [...new Set(lines.flatMap((line) => line.variantId ?? []))];
  return await readProducts({ productIds, variantIds, pageSize: productIds.length }, "full", true);
}

const loadRootTree = async () =>
  projectCategories(await readCatalog({ pageSize: 1, fields: "card", includeCategories: true }));
/** The first listing page of a category, sorted by name and unfiltered, as the category page reads it. */
const firstCategoryPage = (categorySlug: string) => ({
  categorySlug,
  page: 1,
  pageSize: CATEGORY_PAGE_SIZE,
  sort: "name" as const,
  fields: "card" as const,
});
const loadCategoryPage = (categorySlug: string) => async (): Promise<CategoryPage> => {
  let firstPage: ProductPage | undefined;
  const categories = await categoryContent.get(categorySlug, async () => {
    // On a content miss one bounded read supplies fresh prices and only the active branch's text/images.
    // Never retain its products in the fifteen-minute content cache.
    const body = await readCatalog({
      ...firstCategoryPage(categorySlug),
      includeCategories: false,
      includeCategoryContent: true,
    });
    firstPage = projectProducts(body);
    return projectCategories(body);
  });
  return {
    categories,
    page: firstPage ?? (await readProducts(firstCategoryPage(categorySlug), "card")),
  };
};
/** The root tree with one category's own content and its children's content. */
const withCategoryContent = (tree: CatalogCategory[], content: CatalogCategory[]) => {
  if (content.length === 0) return tree;
  const byId = new Map(content.map((node) => [node.id, node]));
  return tree.map((node) => byId.get(node.id) ?? node);
};
const cachedCategoryPage = cache((categorySlug: string): Promise<CategoryPage> =>
  categoryPages.get(categorySlug, loadCategoryPage(categorySlug)),
);

/**
 * The navigation tree (navigation fields only, root categories with content). With `categorySlug` the
 * tree also carries the content of that category and its direct children (category page heading/grid);
 * that read also returns the category's first listing page.
 */
const cachedCategoryTree = cache(async (categorySlug: string): Promise<CatalogCategory[]> =>
  categorySlug
    ? await Promise.all([
        categoryTrees.get("", loadRootTree),
        cachedCategoryPage(categorySlug),
      ]).then(([tree, { categories }]) => withCategoryContent(tree, categories))
    : await categoryTrees.get("", loadRootTree),
);

export async function getCategoryTree(categorySlug = ""): Promise<CatalogCategory[]> {
  // React distinguishes no arguments from one undefined argument. Layout and page must use one key.
  return await cachedCategoryTree(categorySlug);
}

const isFirstCategoryPage = (query: CatalogQuery) => {
  const { categorySlug, page = 1, pageSize, sort = "name", ...filters } = compact(query);
  return (
    categorySlug !== undefined &&
    page === 1 &&
    pageSize === CATEGORY_PAGE_SIZE &&
    sort === "name" &&
    Object.keys(filters).length === 0
  );
};

/**
 * One listing page of a category (cards). The unfiltered first page comes with the category's tree read;
 * other pages, sorts and filters are their own owner read.
 */
export async function getCategoryListing(query: CatalogQuery): Promise<ProductPage> {
  return query.categorySlug !== undefined && isFirstCategoryPage(query)
    ? (await cachedCategoryPage(query.categorySlug)).page
    : await readProducts(query, "card");
}

const slimCategory = ({
  id,
  parentId,
  hasChildren,
  slug,
  name,
  position,
  imageSrc,
  imageAlt,
}: CatalogCategory): CatalogCategory => ({
  id,
  parentId,
  hasChildren,
  slug,
  name,
  position,
  imageSrc,
  imageAlt,
});

/**
 * Root-layout payload for the client provider: only the sidebar navigation (roots and their listed
 * children; no products, no full 2,000+ category tree). Category and product pages add their active
 * branch with `getCategoryBranch`; header search asks the BFF.
 */
export async function getShellSnapshot(): Promise<CatalogSnapshot> {
  const categories = await getCategoryTree();
  const model = createCatalog({ products: [], homepageFeaturedProductIds: [] }, { categories });
  return {
    catalog: { products: [], homepageFeaturedProductIds: [] },
    categories: { categories: model.getSidebarCategories().map(slimCategory) },
  };
}

/** Extra navigation for one active category: its trail and the children of every trail level. */
export async function getCategoryBranch(activeSlug: string): Promise<CatalogCategory[]> {
  const model = createCatalog(
    { products: [], homepageFeaturedProductIds: [] },
    { categories: await getCategoryTree() },
  );
  const base = new Set(model.getSidebarCategories().map((category) => category.id));
  return model
    .getSidebarCategories(activeSlug)
    .filter((category) => !base.has(category.id))
    .map(slimCategory);
}

/** OntOS has no `flag` key: map a storefront section to one or more owner `label` reads. */
const ownerQueries = ({ flag, ...query }: CatalogQuery): CatalogQuery[] =>
  flag === undefined
    ? [query]
    : flag === "promotion"
      ? [
          { ...query, label: "action" },
          { ...query, label: "sale" },
        ]
      : [{ ...query, label: flag }];

const mergePages = (pages: ProductPage[]): ProductPage => {
  const [first, ...rest] = pages;
  if (rest.length === 0) return first;
  const seen = new Set<string>();
  const products = pages
    .flatMap((page) => page.products)
    .filter((product) => !seen.has(product.id) && Boolean(seen.add(product.id)));
  return { ...first, products, total: products.length, page: 1, pageSize: products.length };
};

/**
 * One owner product page (category, search, slug, flag) merged with the cached navigation tree.
 * Listings read `card` rows; only product detail reads `full`. `categorySlug` adds that category's content.
 */
export async function getCatalogPage(
  query: CatalogQuery,
  { fields = "card", categorySlug }: { fields?: CatalogFields; categorySlug?: string } = {},
): Promise<CatalogPage> {
  const [pages, categories] = await Promise.all([
    Promise.all(ownerQueries(query).map((owner) => readProducts(owner, fields))),
    getCategoryTree(categorySlug),
  ]);
  const page = mergePages(pages);
  return {
    model: createCatalog(page, { categories }),
    products: page.products,
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
  };
}

/** Homepage selection (cards) with the navigation tree; `categorySlug` adds that category's content. */
export const getCatalog = cache(
  async (categorySlug?: string): Promise<CatalogModel> =>
    (await getCatalogPage(homeQuery, { categorySlug })).model,
);
