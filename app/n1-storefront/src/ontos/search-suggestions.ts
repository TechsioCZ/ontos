import { Schema } from "effect";
import { getCatalog } from "./catalog";

const localeSchema = Schema.Literals(["cs", "en"]);
const querySchema = Schema.String.check(Schema.isMaxLength(200));

/** Server read adapter; catalog's server-only boundary protects owner credentials. */
export const readSearchSuggestions = async (locale: string, query: string) => {
  if (!Schema.is(localeSchema)(locale) || !Schema.is(querySchema)(query)) {
    return { state: "unavailable" as const };
  }
  const q = query.trim();
  if (q.length === 0) {
    return { state: "idle" as const };
  }
  const result = await getCatalog(locale, JSON.stringify({ q }));
  if (result.state === "unavailable" || !result.catalog.configured) {
    return { state: "unavailable" as const };
  }
  return { products: result.catalog.products.slice(0, 8), state: "ready" as const };
};
