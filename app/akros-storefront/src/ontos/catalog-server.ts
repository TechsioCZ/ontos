import { Effect } from "effect";
import { createOperation } from "@ontos/storefront-runtime";
import type { Operation, OperationOptions } from "@ontos/storefront-runtime";
import { hasRenderLifetime, renderOperation } from "./render-operation";
import "server-only";
import { cache } from "react";
import type { CatalogCategory, CatalogProduct } from "@/ontos/catalog-types";
import { getActiveMarket, marketReadsFor } from "./active-market";
import { createCatalog } from "./catalog-model";
import { getConfig } from "./config";
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

/** Category listing page size. */
export const CATEGORY_PAGE_SIZE = 24;
// Kai's model shows 16 cards and skips placeholder groups (e.g. one named "AKCE"): read a few spares.
const homeQuery: CatalogQuery = { featured: true, pageSize: 20 };

const catalogWork = async <A>(
  options: OperationOptions,
  work: (operation: Operation) => Promise<A>,
): Promise<A> => {
  const standalone = options.operation === undefined && !hasRenderLifetime();
  const base =
    options.operation ?? (standalone ? Effect.runSync(createOperation()) : renderOperation());
  const operation = options.signal
    ? Effect.runSync(
        createOperation({
          signal: AbortSignal.any([base.signal, options.signal]),
          parent: base,
        }),
      )
    : base;
  try {
    return await Effect.runPromise(
      operation.run(Effect.tryPromise({ try: () => work(operation), catch: (cause) => cause })),
    );
  } finally {
    if (operation !== base) operation.dispose();
    if (standalone) base.dispose();
  }
};

/**
 * Every storefront catalog read is answered for one market: its offer and its currency. Without a market id
 * (no market exists yet, see market.ts) merchandise answers with the whole published CZK catalogue.
 */
const readCatalog = async (
  marketId: string | undefined,
  storefrontCatalog: Record<string, unknown>,
  operation: Operation,
) => {
  // Merchandise applies the company's saved listing policy for this e-shop.
  const query = { ...storefrontCatalog, storefrontAppId: getConfig().appId };
  return (await readRecords(
    "merchandise",
    "records",
    {
      view: {
        storefront: true,
        storefrontCatalog: marketId === undefined ? query : { ...query, marketId },
      },
    },
    { operation },
  )) as Record<string, unknown>;
};
/** The request's market (resolved from the path locale; see active-market.ts). */
const marketIdOf = async (operation: Operation) =>
  (await getActiveMarket(marketReadsFor(operation))).marketId;

/** Drop unset keys (and the storefront-only `flag`, which OntOS rejects) so equal queries share a cache key. */
const compact = (query: CatalogQuery): CatalogQuery =>
  Object.fromEntries(
    Object.entries(query).filter(
      ([key, value]) => key !== "flag" && value !== undefined && value !== "",
    ),
  ) as CatalogQuery;

const productKey = (marketId: string | undefined, query: CatalogQuery, fields: CatalogFields) =>
  JSON.stringify({ ...compact(query), fields, includeCategories: false, marketId });

const loadProducts = (key: string, operation: Operation) => async () => {
  const { marketId, ...query }: Record<string, unknown> = JSON.parse(key);
  return projectProducts(
    await readCatalog(typeof marketId === "string" ? marketId : undefined, query, operation),
  );
};
// One owner read per render for equal queries, keyed by the serialized owner query.
const cachedProducts = cache((operation: Operation, key: string): Promise<ProductPage> =>
  loadProducts(key, operation)(),
);

/**
 * One bounded product read without the category tree. Equal reads share only the current render.
 * `fresh` bypasses even that memoization for carts/quotes/orders.
 */
export async function readProducts(
  query: CatalogQuery,
  fields: CatalogFields,
  fresh = false,
  options: OperationOptions = {},
): Promise<ProductPage> {
  return catalogWork(options, async (operation) => {
    const key = productKey(await marketIdOf(operation), query, fields);
    return fresh ? await loadProducts(key, operation)() : await cachedProducts(operation, key);
  });
}

/** Fresh full records of the cart's products, each carrying only the cart's variants (cart quote). */
export async function readCartProducts(
  lines: readonly { productId: string; variantId?: string }[],
  options: OperationOptions = {},
): Promise<ProductPage> {
  const productIds = [...new Set(lines.map((line) => line.productId))];
  const variantIds = [...new Set(lines.flatMap((line) => line.variantId ?? []))];
  return await readProducts(
    { productIds, variantIds, pageSize: productIds.length },
    "full",
    true,
    options,
  );
}

const loadRootTree = (marketId: string | undefined, operation: Operation) => async () =>
  projectCategories(
    await readCatalog(marketId, { mode: "categories", includeCategories: true }, operation),
  );
/** The first listing page of a category, sorted by name and unfiltered, as the category page reads it. */
const firstCategoryPage = (categorySlug: string) => ({
  categorySlug,
  page: 1,
  pageSize: CATEGORY_PAGE_SIZE,
  sort: "name" as const,
  fields: "card" as const,
});
const loadCategoryPage =
  (marketId: string | undefined, categorySlug: string, operation: Operation) =>
  async (): Promise<CategoryPage> => {
    const body = await readCatalog(
      marketId,
      {
        ...firstCategoryPage(categorySlug),
        includeCategories: false,
        includeCategoryContent: true,
      },
      operation,
    );
    return { categories: projectCategories(body), page: projectProducts(body) };
  };

/** The root tree with one category's own content and its children's content. */
const withCategoryContent = (tree: CatalogCategory[], content: CatalogCategory[]) => {
  if (content.length === 0) return tree;
  const byId = new Map(tree.map((node) => [node.id, node]));
  for (const node of content) byId.set(node.id, node);
  return [...byId.values()];
};
const cachedCategoryPage = cache(
  async (operation: Operation, categorySlug: string): Promise<CategoryPage> => {
    const marketId = await marketIdOf(operation);
    return await loadCategoryPage(marketId, categorySlug, operation)();
  },
);
// Category publication is request-time state, not a fifteen-minute process snapshot.
// React cache joins equal tree reads within one render without hiding new categories on the next request.
const rootTree = cache(
  async (operation: Operation) => await loadRootTree(await marketIdOf(operation), operation)(),
);

/**
 * The navigation tree (navigation fields only, root categories with content). With `categorySlug` the
 * tree also carries the content of that category and its direct children (category page heading/grid);
 * that read also returns the category's first listing page.
 */
const cachedCategoryTree = cache(
  async (operation: Operation, categorySlug: string): Promise<CatalogCategory[]> =>
    categorySlug
      ? await Promise.all([rootTree(operation), cachedCategoryPage(operation, categorySlug)]).then(
          ([tree, { categories }]) => withCategoryContent(tree, categories),
        )
      : await rootTree(operation),
);

export async function getCategoryTree(
  categorySlug = "",
  options: OperationOptions = {},
): Promise<CatalogCategory[]> {
  // React distinguishes no arguments from one undefined argument. Layout and page must use one key.
  return catalogWork(options, (operation) => cachedCategoryTree(operation, categorySlug));
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
export async function getCategoryListing(
  query: CatalogQuery,
  options: OperationOptions = {},
): Promise<ProductPage> {
  return catalogWork(options, async (operation) =>
    query.categorySlug !== undefined && isFirstCategoryPage(query)
      ? (await cachedCategoryPage(operation, query.categorySlug)).page
      : await readProducts(query, "card", false, { operation }),
  );
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
export async function getShellSnapshot(options: OperationOptions = {}): Promise<CatalogSnapshot> {
  const categories = await getCategoryTree("", options);
  const model = createCatalog({ products: [], homepageFeaturedProductIds: [] }, { categories });
  return {
    catalog: { products: [], homepageFeaturedProductIds: [] },
    categories: { categories: model.getSidebarCategories().map(slimCategory) },
  };
}

/** Extra navigation for one active category: its trail and the children of every trail level. */
export async function getCategoryBranch(
  activeSlug: string,
  options: OperationOptions = {},
): Promise<CatalogCategory[]> {
  const model = createCatalog(
    { products: [], homepageFeaturedProductIds: [] },
    { categories: await getCategoryTree("", options) },
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
  {
    fields = "card",
    categorySlug,
    ...options
  }: OperationOptions & { fields?: CatalogFields; categorySlug?: string } = {},
): Promise<CatalogPage> {
  return catalogWork(options, async (operation) => {
    const [pages, categories] = await Promise.all([
      Promise.all(
        ownerQueries(query).map((owner) => readProducts(owner, fields, false, { operation })),
      ),
      getCategoryTree(categorySlug, { operation }),
    ]);
    const page = mergePages(pages);
    return {
      model: createCatalog(page, { categories }),
      products: page.products,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    };
  });
}

/** Homepage selection (cards) with the navigation tree; `categorySlug` adds that category's content. */
export const getCatalog = cache(
  async (categorySlug?: string, options: OperationOptions = {}): Promise<CatalogModel> =>
    (await getCatalogPage(homeQuery, { categorySlug, ...options })).model,
);
