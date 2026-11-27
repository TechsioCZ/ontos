import type { Operation, OperationOptions } from "@ontos/storefront-runtime";
import { withOwnerOperation } from "./owner-operation";
import "server-only";
import { cache } from "react";
import { Effect, Match, Schema } from "effect";
import { readConfiguration } from "./config";
import { readOwner, StorefrontReadUnavailable } from "./gateway";
import { selectMarket } from "./market";
import { readCurrentMarketCatalog } from "./market-catalog-read";
import { CatalogResponseSchema, projectCatalog } from "./catalog-model";
import { storefrontRuntime } from "./runtime";
import { MAX_STALE_MS, sharedRead } from "./shared-read";

export interface CatalogQuery {
  categorySlug?: string;
  featured?: boolean;
  page?: number;
  productId?: string;
  productIds?: readonly string[];
  q?: string;
  slug?: string;
}

const CatalogQuerySchema = Schema.Struct({
  categorySlug: Schema.optionalKey(Schema.String),
  featured: Schema.optionalKey(Schema.Boolean),
  page: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  productId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  ),
  productIds: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300))).check(
      Schema.isMaxLength(24),
    ),
  ),
  q: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  slug: Schema.optionalKey(Schema.String),
});

/** Read-only public channel. No writes, seed catalog or alternate data source lives in this app. */
export const loadCatalog = (locale: string, query: CatalogQuery) =>
  withOwnerOperation(
    Effect.gen(function* loadCatalogProgram() {
      const config = yield* readConfiguration(process.env);
      const { markets, now } = yield* readCurrentMarketCatalog(config);
      const market = yield* selectMarket(markets, config, locale, now);
      const { productId, productIds, ...filters } = query;
      const full = query.slug !== undefined || productId !== undefined;
      const fields: "card" | "full" = full ? "full" : "card";
      const catalogQuery = {
        ...filters,
        fields,
        // Only listings carry the category tree; a product page takes its trail from the layout's read.
        includeCategories: !full && productIds === undefined,
        marketId: market.marketRef.resourceId,
        pageSize: full ? 1 : 24,
        storefrontAppId: config.appId,
      };
      const storefrontCatalog: typeof catalogQuery & { productIds?: readonly string[] } = {
        ...catalogQuery,
      };
      if (productIds !== undefined) {
        storefrontCatalog.productIds = productIds;
      } else if (productId !== undefined) {
        storefrontCatalog.productIds = [productId];
      }
      const body = yield* readOwner(
        config,
        "merchandise",
        "records",
        {
          view: {
            storefront: true,
            storefrontCatalog,
          },
        },
        CatalogResponseSchema,
      );
      if (body.market.marketId !== market.marketRef.resourceId) {
        return yield* new StorefrontReadUnavailable({ reason: "contract" });
      }
      const hosts = (process.env.STOREFRONT_IMAGE_HOSTS ?? "")
        .split(",")
        .map((host) => host.trim())
        .filter(Boolean);
      return projectCatalog(body, hosts);
    }),
  );

/** Framework edge: retain typed failures until they become an explicit page state. */
const readCatalog = async (locale: string, queryKey: string, options: OperationOptions) =>
  await storefrontRuntime.runPromise(
    Schema.decodeUnknownEffect(Schema.fromJsonString(CatalogQuerySchema))(queryKey).pipe(
      Effect.flatMap((query) => withOwnerOperation(loadCatalog(locale, query), options)),
      Effect.tapError((error) =>
        Effect.logWarning("N1 catalog read unavailable").pipe(
          Effect.annotateLogs(
            Match.value(error).pipe(
              Match.tag("StorefrontReadUnavailable", (failure) => ({
                failure: failure._tag,
                reason: failure.reason,
                status: failure.status ?? 0,
              })),
              Match.orElse(() => ({ failure: error._tag })),
            ),
          ),
        ),
      ),
      Effect.match({
        onFailure: (error) => ({
          reason: Match.value(error).pipe(
            Match.tag("OperationError", (failure) => failure.kind),
            Match.orElse((failure) => failure._tag),
          ),
          state: "unavailable" as const,
        }),
        onSuccess: (catalog) => ({ catalog, state: "ready" as const }),
      }),
    ),
  );

// Public catalogue answers are equal for every shopper of a market: shared across requests, served stale while one
// refresh runs. Merchandise advances the company's catalogue revision with every write (product, category, listing
// policy, stock), so an answer belongs to the revision it was read at and the first visit after an admin save waits for
// the new state. The revision check is one head read, shared per process for a second.
const CATALOG_TTL_MS = 15_000;
const REVISION_TTL_MS = 1_000;
const RevisionSchema = Schema.Struct({ revision: Schema.Int });
let lastRevision: { at: number; revision: number } | undefined;
const loadRevision = async (operation: Operation) => {
  const revision = await storefrontRuntime.runPromise(
    withOwnerOperation(
      Effect.gen(function* loadCatalogRevision() {
        const config = yield* readConfiguration(process.env);
        const body = yield* readOwner(
          config,
          "merchandise",
          "records",
          {
            view: {
              storefront: true,
              storefrontCatalog: { includeCategories: false, mode: "categories" },
            },
          },
          RevisionSchema,
        );
        return body.revision;
      }),
      { operation },
    ),
  );
  lastRevision = { at: Date.now(), revision };
  return revision;
};
/** `undefined` while merchandise cannot say: such a read is not shared at all. */
const catalogRevision = (options: OperationOptions) =>
  sharedRead("catalog:revision", REVISION_TTL_MS, loadRevision, { caller: options }).catch(() =>
    // While merchandise is unavailable shoppers keep the catalogue they had, as long as it may still be served.
    lastRevision !== undefined && Date.now() - lastRevision.at < MAX_STALE_MS
      ? lastRevision.revision
      : undefined,
  );

type CatalogResult = Awaited<ReturnType<typeof readCatalog>>;
// Every listing answer of one revision repeats the same category tree (about 1,800 nodes): shared answers keep one copy.
let heldTree: { categories: readonly unknown[]; json: string } | undefined;
const shareTree = (result: CatalogResult): CatalogResult => {
  if (result.state !== "ready" || result.catalog.categories.length === 0) return result;
  const json = JSON.stringify(result.catalog.categories);
  if (heldTree?.json !== json) heldTree = { categories: result.catalog.categories, json };
  return {
    ...result,
    catalog: {
      ...result.catalog,
      categories: heldTree.categories as typeof result.catalog.categories,
    },
  };
};

/** One render (or API request) reads each query once; across requests, equal reads share one owner answer. */
export const getCatalog = cache(
  async (locale: string, queryKey: string, options: OperationOptions = {}) => {
    const revision = await catalogRevision(options);
    if (revision === undefined) return await readCatalog(locale, queryKey, options);
    return await sharedRead(
      `catalog:${locale}:${queryKey}`,
      CATALOG_TTL_MS,
      async (operation) => shareTree(await readCatalog(locale, queryKey, { operation })),
      {
        caller: options,
        generation: revision,
        keep: (result) => result.state === "ready",
        stale: true,
      },
    );
  },
);
