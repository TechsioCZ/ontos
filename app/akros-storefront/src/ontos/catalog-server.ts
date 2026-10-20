import "server-only";
import { cache } from "react";
import type { CatalogProduct } from "@/mock-storefront/types";
import { createCatalog } from "./catalog-model";
import { isOntos } from "./config";
import { readRecords } from "./gateway";
import { project, type CatalogSnapshot } from "./catalog-projection";
export type { CatalogSnapshot } from "./catalog-projection";

/** Exact `view.storefrontCatalog` read shape published by lane akros-sync-backend (STATUS.md 23:14). */
export interface CatalogQuery {
  page?: number;
  pageSize?: number;
  slug?: string;
  categorySlug?: string;
  q?: string;
  featured?: boolean;
  productIds?: string[];
  minMinor?: number;
  maxMinor?: number;
  availability?: "in-stock" | "out-of-stock";
  sort?: "name" | "price-asc" | "price-desc";
  /** Requested from backend at 23:35; the storefront also filters locally, so ignoring it is safe. */
  flag?: "new" | "promotion" | "recommended";
}
export type CatalogModel = ReturnType<typeof createCatalog>;
export interface CatalogPage {
  snapshot: CatalogSnapshot;
  model: CatalogModel;
  products: CatalogProduct[];
  total: number;
  page: number;
  pageSize: number;
}

/** Admin edits in OntOS are visible after at most this delay plus a page refresh. */
export const CATALOG_CACHE_MS = 10_000;
const CACHE_LIMIT = 100;
const homeQuery: CatalogQuery = { featured: true, pageSize: 16 };
const snapshots = new Map<string, { at: number; snapshot: CatalogSnapshot }>();

/** Drop unset keys so the owner schema never sees `undefined`/"" and equal queries share a cache key. */
const compact = (query: CatalogQuery): CatalogQuery =>
  Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined && value !== ""),
  ) as CatalogQuery;

async function mockSnapshot(): Promise<CatalogSnapshot> {
  const [{ default: catalog }, { default: categories }] = await Promise.all([
    import("@/mock-storefront/generated/catalog.generated.json"),
    import("@/mock-storefront/generated/categories.generated.json"),
  ]);
  return {
    mode: "mock",
    revision: 0,
    catalog: catalog as CatalogSnapshot["catalog"],
    categories: categories as CatalogSnapshot["categories"],
  };
}

/** Bounded owner read. `fresh` bypasses (and refreshes) the cache: checkout/quote/revision reads. */
export async function getSnapshot(
  fresh = false,
  query: CatalogQuery = homeQuery,
): Promise<CatalogSnapshot> {
  if (!isOntos()) return mockSnapshot();
  const storefrontCatalog = compact(query);
  const key = JSON.stringify(storefrontCatalog);
  const cached = snapshots.get(key);
  if (!fresh && cached && Date.now() - cached.at < CATALOG_CACHE_MS) return cached.snapshot;
  const body = (await readRecords("merchandise", "records", {
    view: { storefront: true, storefrontCatalog },
  })) as Record<string, unknown>;
  const snapshot = project(body);
  // Bounded process-local cache; never retain an unbounded number of user search terms.
  snapshots.delete(key);
  if (snapshots.size >= CACHE_LIMIT) {
    const oldest = snapshots.keys().next().value;
    if (oldest !== undefined) snapshots.delete(oldest);
  }
  snapshots.set(key, { at: Date.now(), snapshot });
  return snapshot;
}

/** Root-layout payload for the client provider: featured products + slim category tree. */
export async function getShellSnapshot(): Promise<CatalogSnapshot> {
  const snapshot = await getSnapshot();
  if (snapshot.mode === "mock") return snapshot;
  return {
    ...snapshot,
    categories: {
      ...snapshot.categories,
      categories: snapshot.categories.categories.map(
        ({ id, parentId, hasChildren, slug, name, position, imageSrc, imageAlt }) => ({
          id,
          parentId,
          hasChildren,
          slug,
          name,
          position,
          imageSrc,
          imageAlt,
        }),
      ),
    },
  };
}

export const getCatalog = cache(async (query?: CatalogQuery): Promise<CatalogModel> => {
  const snapshot = await getSnapshot(false, query);
  return createCatalog(snapshot.catalog, snapshot.categories);
});

/** One owner page (category, search, slug, flag). Use only when `isOntos()`; mock pages keep Kai's code. */
export async function getCatalogPage(query: CatalogQuery): Promise<CatalogPage> {
  const snapshot = await getSnapshot(false, query);
  return {
    snapshot,
    model: createCatalog(snapshot.catalog, snapshot.categories),
    products: snapshot.catalog.products,
    total: snapshot.total ?? snapshot.catalog.products.length,
    page: snapshot.page ?? 1,
    pageSize: snapshot.pageSize ?? snapshot.catalog.products.length,
  };
}
