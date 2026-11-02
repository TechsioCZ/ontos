// Market settings and product exceptions in PostgreSQL (schema `demo_merchandise`): bounded reads for staff screens,
// the storefront offer predicate, and the writes of the market commands. Every statement is company-scoped.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';
import { MarketExceptionItemSchema } from '../../shared/apis/records.ts';
import type { MarketExceptionPage } from '../../shared/apis/records.ts';
import {
  ExchangeRateSchema,
  MarketCurrencySchema,
  MarketIdSchema,
  MarketOfferModeSchema,
  MarketSettingsSchema,
  RoundingMinorSchema,
  isOfferedInMarket,
  normalizeExchangeRate,
} from '../../shared/domain/market-offers.ts';
import type { MarketId, MarketOfferMode, MarketSettings, OrderMarket } from '../../shared/domain/market-offers.ts';
import { marketProductOffers, marketSettings, products } from '../database/schema.ts';
import { query, whereScope } from './merchandise-store.ts';
import type { MerchandiseDb, MerchandiseStoreFailure, StoreScope } from './merchandise-store.ts';
import type { OrderMarketContext } from './market-pricing.ts';

/** A market's settings without its exception counts. */
export const StoredMarketSchema = Schema.Struct({
  currency: MarketCurrencySchema,
  exchangeRate: ExchangeRateSchema,
  marketCode: Schema.String,
  marketId: MarketIdSchema,
  offerMode: MarketOfferModeSchema,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  roundingMinor: RoundingMinorSchema,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type StoredMarket = typeof StoredMarketSchema.Type;

const STORED_MARKET_REASON = 'Stored market settings do not decode';
const EXCEPTIONS_READ = 'Market exceptions could not be read';
const EXCEPTIONS_WRITTEN = 'Market exceptions could not be written';
const SETTINGS_WRITTEN = 'Market settings could not be written';
const decodeStoredMarket = Schema.decodeUnknownEffect(StoredMarketSchema);
const decodeMarketSettings = Schema.decodeUnknownEffect(MarketSettingsSchema);
const decodeExceptionItems = Schema.decodeUnknownEffect(Schema.Array(MarketExceptionItemSchema));

const marketColumns = {
  currency: marketSettings.currency,
  exchangeRate: marketSettings.exchangeRate,
  marketCode: marketSettings.marketCode,
  marketId: marketSettings.marketId,
  offerMode: marketSettings.offerMode,
  revision: marketSettings.revision,
  roundingMinor: marketSettings.roundingMinor,
  updatedAt: marketSettings.updatedAt,
};
type MarketRow = { readonly [Key in keyof typeof marketColumns]: (typeof marketSettings.$inferSelect)[Key] };

const encodedMarket = (row: MarketRow) => ({
  ...row,
  exchangeRate: normalizeExchangeRate(row.exchangeRate),
  updatedAt: row.updatedAt.toISOString(),
});
const storedMarketOf = (row: MarketRow) => query(decodeStoredMarket(encodedMarket(row)), STORED_MARKET_REASON);

/** The order snapshot (price list) of a stored market. */
export const orderMarketOf = (market: StoredMarket): OrderMarket => ({
  currency: market.currency,
  exchangeRate: market.exchangeRate,
  marketCode: market.marketCode,
  marketId: market.marketId,
  roundingMinor: market.roundingMinor,
});

/** One market of the company; `lock` holds its row for the rest of the transaction. */
export const loadMarket = Effect.fn('MarketStore.loadMarket')(function* loadMarket(
  db: MerchandiseDb,
  scope: StoreScope,
  marketId: string,
): Effect.fn.Return<Option.Option<StoredMarket>, MerchandiseStoreFailure> {
  const rows = yield* query(
    db
      .select(marketColumns)
      .from(marketSettings)
      .where(and(whereScope(marketSettings, scope), eq(marketSettings.marketId, marketId)))
      .limit(1),
    'Market settings could not be read',
  );
  const [row] = rows;
  return row === undefined ? Option.none() : Option.some(yield* storedMarketOf(row));
});

const outerMarketId = sql.raw('"market_settings"."market_id"');
/** Exception count of the outer market row; the scope is bound as parameters (no outer-column ambiguity). */
const exceptionCount = (scope: StoreScope, offered: boolean) =>
  sql<number>`(select count(*)::int from ${marketProductOffers} o
    where o.tenant_id = ${scope.tenantId}::uuid and o.legal_entity_id = ${scope.legalEntityId}::uuid
      and o.market_id = ${outerMarketId} and o.offered = ${offered})`;

/** Every configured market of the company with its exception counts, by market code. */
export const listMarkets = Effect.fn('MarketStore.listMarkets')(function* listMarkets(
  db: MerchandiseDb,
  scope: StoreScope,
): Effect.fn.Return<readonly MarketSettings[], MerchandiseStoreFailure> {
  const rows = yield* query(
    db
      .select({ ...marketColumns, notOffered: exceptionCount(scope, false), offered: exceptionCount(scope, true) })
      .from(marketSettings)
      .where(whereScope(marketSettings, scope))
      .orderBy(asc(marketSettings.marketCode), asc(marketSettings.marketId)),
    'Markets could not be read',
  );
  return yield* query(
    Effect.forEach(
      rows,
      ({ notOffered, offered, ...row }) =>
        decodeMarketSettings({ ...encodedMarket(row), exceptionCounts: { notOffered, offered } }),
      { concurrency: 1 },
    ),
    STORED_MARKET_REASON,
  );
});

export const DEFAULT_EXCEPTION_LIMIT = 50;

/** One page of a market's product exceptions with product name and SKU, by product name. */
export const marketExceptionPage = Effect.fn('MarketStore.marketExceptionPage')(function* marketExceptionPage(
  db: MerchandiseDb,
  scope: StoreScope,
  input: {
    readonly limit?: number | undefined;
    readonly marketId: MarketExceptionPage['marketId'];
    readonly offset?: number | undefined;
  },
): Effect.fn.Return<MarketExceptionPage, MerchandiseStoreFailure> {
  const joined = and(
    eq(products.tenantId, marketProductOffers.tenantId),
    eq(products.legalEntityId, marketProductOffers.legalEntityId),
    eq(products.id, marketProductOffers.productId),
  );
  const where = and(whereScope(marketProductOffers, scope), eq(marketProductOffers.marketId, input.marketId));
  const [counted] = yield* query(
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(marketProductOffers)
      .innerJoin(products, joined)
      .where(where),
    EXCEPTIONS_READ,
  );
  const total = counted?.total ?? 0;
  const rows =
    total === 0
      ? []
      : yield* query(
          db
            .select({
              name: products.name,
              offered: marketProductOffers.offered,
              productId: products.id,
              sku: products.sku,
            })
            .from(marketProductOffers)
            .innerJoin(products, joined)
            .where(where)
            .orderBy(asc(products.nameKey), asc(products.id))
            .limit(input.limit ?? DEFAULT_EXCEPTION_LIMIT)
            .offset(input.offset ?? 0),
          EXCEPTIONS_READ,
        );
  const items = yield* query(decodeExceptionItems(rows), 'Stored market exceptions do not decode');
  return { items, marketId: input.marketId, total };
});

/** Every configured market with this product's exception (undefined = mode default), by market code. */
export const productMarketRows = Effect.fn('MarketStore.productMarketRows')(function* productMarketRows(
  db: MerchandiseDb,
  scope: StoreScope,
  productId: string,
) {
  const rows = yield* query(
    db
      .select({ ...marketColumns, exception: marketProductOffers.offered })
      .from(marketSettings)
      .leftJoin(
        marketProductOffers,
        and(
          eq(marketProductOffers.tenantId, marketSettings.tenantId),
          eq(marketProductOffers.legalEntityId, marketSettings.legalEntityId),
          eq(marketProductOffers.marketId, marketSettings.marketId),
          eq(marketProductOffers.productId, productId),
        ),
      )
      .where(whereScope(marketSettings, scope))
      .orderBy(asc(marketSettings.marketCode), asc(marketSettings.marketId)),
    'Product markets could not be read',
  );
  return yield* Effect.forEach(
    rows,
    ({ exception, ...row }) =>
      storedMarketOf(row).pipe(
        Effect.map((market) => ({
          exception: exception === null ? Option.none<boolean>() : Option.some(exception),
          market,
        })),
      ),
    { concurrency: 1 },
  );
});

/** Stored exceptions of these products in one market. */
export const marketExceptionsFor = Effect.fn('MarketStore.marketExceptionsFor')(function* marketExceptionsFor(
  db: MerchandiseDb,
  scope: StoreScope,
  marketId: string,
  productIds: readonly string[],
): Effect.fn.Return<ReadonlyMap<string, boolean>, MerchandiseStoreFailure> {
  if (productIds.length === 0) {
    return new Map<string, boolean>();
  }
  const rows = yield* query(
    db
      .select({ offered: marketProductOffers.offered, productId: marketProductOffers.productId })
      .from(marketProductOffers)
      .where(
        and(
          whereScope(marketProductOffers, scope),
          eq(marketProductOffers.marketId, marketId),
          inArray(marketProductOffers.productId, [...new Set(productIds)]),
        ),
      ),
    EXCEPTIONS_READ,
  );
  return new Map(rows.map((row) => [row.productId, row.offered] as const));
});

/**
 * What a storefront order needs from its market, resolved before the pure command runs: the price list (none = the
 * market has no settings, nothing is offered) and which of the ordered products the market offers.
 */
export const loadOrderMarketContext = Effect.fn('MarketStore.loadOrderMarketContext')(function* loadOrderMarketContext(
  db: MerchandiseDb,
  scope: StoreScope,
  marketId: MarketId,
  productIds: readonly string[],
): Effect.fn.Return<OrderMarketContext, MerchandiseStoreFailure> {
  const stored = yield* loadMarket(db, scope, marketId);
  if (Option.isNone(stored)) {
    return { market: Option.none(), marketId, offeredProductIds: new Set<string>() };
  }
  const exceptions = yield* marketExceptionsFor(db, scope, marketId, productIds);
  const offeredProductIds = new Set(
    productIds.filter((id) => isOfferedInMarket(stored.value.offerMode, Option.fromUndefinedOr(exceptions.get(id)))),
  );
  return { market: Option.some(orderMarketOf(stored.value)), marketId, offeredProductIds };
});

/**
 * Storefront product predicate of a market (on the `products` table of the consuming statement): WHOLE_CATALOGUE
 * hides `offered: false` exceptions, SELECTED_PRODUCTS shows only `offered: true`, an unknown market shows nothing.
 */
export const marketOfferPredicate = (scope: StoreScope, market: Option.Option<StoredMarket>): SQL =>
  Option.match(market, {
    onNone: () => sql`false`,
    onSome: ({ marketId, offerMode }) => {
      const exception = (offered: boolean) => sql`(select 1 from ${marketProductOffers} o
        where o.tenant_id = ${scope.tenantId}::uuid and o.legal_entity_id = ${scope.legalEntityId}::uuid
          and o.market_id = ${marketId}::uuid and o.product_id = ${sql.raw('"products"."id"')}
          and o.offered = ${offered})`;
      return offerMode === 'WHOLE_CATALOGUE' ? sql`not exists ${exception(false)}` : sql`exists ${exception(true)}`;
    },
  });

/**
 * The market scope of a storefront catalog read: `offer` filters the products (none: no market, the whole catalogue),
 * `pricing` converts the prices (none: CZK).
 */
export interface CatalogMarketScope {
  readonly offer: Option.Option<SQL>;
  readonly pricing: Option.Option<StoredMarket>;
}

export const NO_CATALOG_MARKET: CatalogMarketScope = { offer: Option.none(), pricing: Option.none() };

/** The scope of a read naming a market: its offer (an unknown market offers nothing) and its price list. */
export const catalogMarketScope = (scope: StoreScope, market: Option.Option<StoredMarket>): CatalogMarketScope => ({
  offer: Option.some(marketOfferPredicate(scope, market)),
  pricing: market,
});

/** Ids among `productIds` that are products of the company. */
export const existingProductIds = Effect.fn('MarketStore.existingProductIds')(function* existingProductIds(
  db: MerchandiseDb,
  scope: StoreScope,
  productIds: readonly string[],
): Effect.fn.Return<ReadonlySet<string>, MerchandiseStoreFailure> {
  const rows = yield* query(
    db
      .select({ id: products.id })
      .from(products)
      .where(and(whereScope(products, scope), inArray(products.id, [...new Set(productIds)]))),
    'Products could not be read',
  );
  return new Set(rows.map((row) => row.id));
});

// ------------------------------------------------------------------------------------------------ writes

export interface MarketSettingsWrite {
  readonly currency: StoredMarket['currency'];
  readonly exchangeRate: string;
  readonly marketCode: string;
  readonly marketId: string;
  readonly offerMode: MarketOfferMode;
  readonly revision: number;
  readonly roundingMinor: number;
}

export const writeMarketSettings = (
  db: MerchandiseDb,
  scope: StoreScope,
  value: MarketSettingsWrite,
  now: DateTime.Utc,
) => {
  const set = {
    currency: value.currency,
    exchangeRate: normalizeExchangeRate(value.exchangeRate),
    marketCode: value.marketCode,
    offerMode: value.offerMode,
    revision: value.revision,
    roundingMinor: value.roundingMinor,
    updatedAt: DateTime.toDateUtc(now),
  };
  return query(
    db
      .insert(marketSettings)
      .values({ ...scope, ...set, marketId: value.marketId })
      .onConflictDoUpdate({
        set,
        target: [marketSettings.tenantId, marketSettings.legalEntityId, marketSettings.marketId],
      }),
    SETTINGS_WRITTEN,
  );
};

/** Drops the market's exceptions whose value became the default of a changed offer mode. */
export const deleteExceptionsEqualTo = (db: MerchandiseDb, scope: StoreScope, marketId: string, offered: boolean) =>
  query(
    db
      .delete(marketProductOffers)
      .where(
        and(
          whereScope(marketProductOffers, scope),
          eq(marketProductOffers.marketId, marketId),
          eq(marketProductOffers.offered, offered),
        ),
      ),
    EXCEPTIONS_WRITTEN,
  );

/** Stores `offered` for these products (`store`) or removes their exceptions (the value equals the mode default). */
export const writeOffers = Effect.fn('MarketStore.writeOffers')(function* writeOffers(
  db: MerchandiseDb,
  scope: StoreScope,
  input: {
    readonly marketId: string;
    readonly now: DateTime.Utc;
    readonly offered: boolean;
    readonly productIds: readonly string[];
    readonly store: boolean;
  },
) {
  const ids = [...new Set(input.productIds)];
  if (!input.store) {
    return yield* query(
      db
        .delete(marketProductOffers)
        .where(
          and(
            whereScope(marketProductOffers, scope),
            eq(marketProductOffers.marketId, input.marketId),
            inArray(marketProductOffers.productId, ids),
          ),
        ),
      EXCEPTIONS_WRITTEN,
    );
  }
  const updatedAt = DateTime.toDateUtc(input.now);
  return yield* query(
    db
      .insert(marketProductOffers)
      .values(
        ids.map((productId) => ({ ...scope, marketId: input.marketId, offered: input.offered, productId, updatedAt })),
      )
      .onConflictDoUpdate({
        set: { offered: input.offered, updatedAt },
        target: [
          marketProductOffers.tenantId,
          marketProductOffers.legalEntityId,
          marketProductOffers.marketId,
          marketProductOffers.productId,
        ],
      }),
    EXCEPTIONS_WRITTEN,
  );
});

/** Deletes the market's settings and every exception of it. */
export const deleteMarket = Effect.fn('MarketStore.deleteMarket')(function* deleteMarket(
  db: MerchandiseDb,
  scope: StoreScope,
  marketId: string,
) {
  yield* query(
    db
      .delete(marketProductOffers)
      .where(and(whereScope(marketProductOffers, scope), eq(marketProductOffers.marketId, marketId))),
    EXCEPTIONS_WRITTEN,
  );
  return yield* query(
    db.delete(marketSettings).where(and(whereScope(marketSettings, scope), eq(marketSettings.marketId, marketId))),
    SETTINGS_WRITTEN,
  );
});
