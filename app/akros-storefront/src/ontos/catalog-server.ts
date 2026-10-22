import "server-only";
import { cache } from "react";
import type { CatalogCategory, CatalogProduct } from "@/mock-storefront/types";
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
export interface CatalogPage {
  model: CatalogModel;
  products: CatalogProduct[];
  total: number;
  page: number;
  pageSize: number;
}

/** Admin edits in OntOS are visible on a page view at most this long after they were read. */
export const CATALOG_CACHE_MS = 10_000;
/** The navigation tree changes rarely; one owner read per minute (and per detailed category). */
export const CATEGORY_CACHE_MS = 60_000;
/** How long a page waits for a refresh before it renders the previous catalog values. */
export const CATALOG_REFRESH_WAIT_MS = 800;
// Kai's model shows 16 cards and skips placeholder groups (e.g. one named "AKCE"): read a few spares.
const homeQuery: CatalogQuery = { featured: true, pageSize: 20 };

const productPages = catalogCache<ProductPage>("products", {
  freshMs: CATALOG_CACHE_MS,
  keepMs: 15 * 60_000,
  refreshWaitMs: CATALOG_REFRESH_WAIT_MS,
  limit: 100,
});
const categoryTrees = catalogCache<CatalogCategory[]>("categories", {
  freshMs: CATEGORY_CACHE_MS,
  keepMs: 60 * 60_000,
  refreshWaitMs: CATALOG_REFRESH_WAIT_MS,
  limit: 20,
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
  const key = JSON.stringify({ ...compact(query), fields, includeCategories: false });
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

/**
 * The navigation tree (navigation fields only, root categories with content). With `categorySlug` the
 * tree also carries the content of that category and its direct children (category page heading/grid).
 */
export const getCategoryTree = cache(
  async (categorySlug?: string): Promise<CatalogCategory[]> =>
    await categoryTrees.get(categorySlug ?? "", async () =>
      projectCategories(
        await readCatalog({
          pageSize: 1,
          fields: "card",
          includeCategories: true,
          ...(categorySlug ? { categorySlug } : {}),
        }),
      ),
    ),
);

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
