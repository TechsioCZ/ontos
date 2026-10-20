import "server-only";
import { cache } from "react";
import rawCatalog from "@/mock-storefront/generated/catalog.generated.json";
import rawCategories from "@/mock-storefront/generated/categories.generated.json";
import type { CatalogData, CategoryData } from "@/mock-storefront/types";
import { createCatalog } from "./catalog-model";
import { isOntos } from "./config";
import { readRecords } from "./gateway";

import { project, type CatalogSnapshot } from "./catalog-projection";
export type { CatalogSnapshot } from "./catalog-projection";
let cached: { at: number; snapshot: CatalogSnapshot } | undefined;
type Raw = Record<string, unknown>;
export async function getSnapshot(fresh = false): Promise<CatalogSnapshot> {
  if (!isOntos())
    return {
      mode: "mock",
      revision: 0,
      catalog: rawCatalog as CatalogData,
      categories: rawCategories as CategoryData,
    };
  if (!fresh && cached && Date.now() - cached.at < 15_000) return cached.snapshot;
  const body = (await readRecords("merchandise", "records", { view: { storefront: true } })) as Raw;
  const snapshot = project(body);
  if (!fresh) cached = { at: Date.now(), snapshot };
  return snapshot;
}
export const getCatalog = cache(async () => {
  const s = await getSnapshot();
  return createCatalog(s.catalog, s.categories);
});
