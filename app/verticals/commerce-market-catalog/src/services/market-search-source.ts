import { CoreSearchWorkerSnapshot } from '@app/core-runtime';
import type { CoreSearchWorkerSnapshotView, OutboxWorkerHandlerContext } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Context, Effect, Layer, Option, Schema } from 'effect';

import type { MarketSearchUnavailable } from '../../shared/domain/market-search-unavailable.ts';
import { marketSearchUnavailable } from '../../shared/domain/market-search-unavailable.ts';

export const MARKET_SEARCH_MODULE = 'commerce.market-catalog';
export const MARKET_SEARCH_RESOURCE = 'commerce.market-catalog.market';

export { MarketSearchUnavailable, marketSearchUnavailable } from '../../shared/domain/market-search-unavailable.ts';

export type MarketSearchTarget = { readonly marketId: string } | { readonly rebuild: true };

export interface MarketSearchRecord {
  readonly businessCode: string;
  readonly definitions: readonly {
    readonly effectiveFrom: Date;
    readonly effectiveTo: Date | null;
    readonly purpose: string;
  }[];
  readonly lifecycles: readonly {
    readonly effectiveFrom: Date;
    readonly effectiveTo: Date | null;
    readonly lifecycle: string;
  }[];
  readonly marketId: string;
  readonly sellingLegalEntityId: string;
  readonly tenantId: string;
}

export interface MarketSearchSnapshot {
  readonly projectionVersion: string;
  readonly records: readonly MarketSearchRecord[];
  readonly tenantId: string;
}

export interface MarketSearchSourceService {
  readonly load: (
    context: OutboxWorkerHandlerContext,
    target: MarketSearchTarget,
  ) => Effect.Effect<MarketSearchSnapshot, MarketSearchUnavailable>;
}

export class MarketSearchSource extends Context.Service<MarketSearchSource, MarketSearchSourceService>()(
  '@app/commerce-market-catalog/services/market-search-source/MarketSearchSource',
) {}

const UuidSchema = Schema.String.check(Schema.isUUID());
const MarketIdSchema = UuidSchema.pipe(Schema.brand('MarketSearchMarketId'));
const SellerIdSchema = UuidSchema.pipe(Schema.brand('MarketSearchSellerId'));
const TenantIdSchema = UuidSchema.pipe(Schema.brand('MarketSearchTenantId'));
const SearchInputSchema = Schema.Struct({ marketId: Schema.optionalKey(MarketIdSchema) });
const periodFields = {
  effectiveFrom: Schema.DateFromString,
  effectiveTo: Schema.OptionFromNullOr(Schema.DateFromString),
};
const MarketSearchRecordSchema = Schema.Struct({
  businessCode: Schema.String,
  definitions: Schema.Array(Schema.Struct({ ...periodFields, purpose: Schema.String })),
  lifecycles: Schema.Array(
    Schema.Struct({ ...periodFields, lifecycle: Schema.Literals(['ACTIVE', 'SUSPENDED', 'RETIRED']) }),
  ),
  marketId: MarketIdSchema,
  sellingLegalEntityId: SellerIdSchema,
  tenantId: TenantIdSchema,
});

const readCompany = Effect.fn('MarketSearchSource.readCompany')(function* readCompany(
  snapshot: CoreSearchWorkerSnapshotView,
  legalEntityId: string,
  target: MarketSearchTarget,
) {
  return yield* snapshot.forLegalEntity(
    legalEntityId,
    Effect.fn('MarketSearchSource.companySnapshot')(function* companySnapshot(executor) {
      // Invoke the owner routine through Core's restricted read executor. Do not acquire a
      // separate connection: all companies and all periods share Core's versioned snapshot.
      const payload = 'marketId' in target ? { marketId: target.marketId } : {};
      const input = yield* Schema.decodeEffect(SearchInputSchema)(payload).pipe(
        Effect.mapError(marketSearchUnavailable),
      );
      const encodedInput = yield* Schema.encodeEffect(Schema.fromJsonString(SearchInputSchema))(input).pipe(
        Effect.mapError(marketSearchUnavailable),
      );
      const result = yield* executor.select({ payload: sql<unknown>`payload` }).from(
        sql`commerce_market_catalog.read_market_search_snapshot(
            ${snapshot.tenantId}::uuid, ${legalEntityId}::uuid, ${encodedInput}::jsonb
          )`,
      );
      const rows = yield* Effect.forEach(
        result,
        (row) =>
          Schema.decodeUnknownEffect(MarketSearchRecordSchema)(row.payload).pipe(
            Effect.mapError(marketSearchUnavailable),
          ),
        { concurrency: 1 },
      );
      if (
        rows.some(
          (row) =>
            row.tenantId !== snapshot.tenantId ||
            row.sellingLegalEntityId !== legalEntityId ||
            ('marketId' in target && row.marketId !== target.marketId),
        )
      ) {
        return yield* marketSearchUnavailable();
      }
      return rows.map((row) => ({
        ...row,
        definitions: row.definitions.map((definition) => ({
          ...definition,
          effectiveTo: Option.getOrNull(definition.effectiveTo),
        })),
        lifecycles: row.lifecycles.map((lifecycle) => ({
          ...lifecycle,
          effectiveTo: Option.getOrNull(lifecycle.effectiveTo),
        })),
      }));
    }),
  );
});

const readSnapshot = Effect.fn('MarketSearchSource.readSnapshot')(function* readSnapshot(
  snapshot: CoreSearchWorkerSnapshotView,
  tenantId: string,
  target: MarketSearchTarget,
) {
  if (snapshot.tenantId !== tenantId) {
    return yield* marketSearchUnavailable();
  }
  const companies = yield* Effect.forEach(
    snapshot.legalEntityIds,
    (legalEntityId) => readCompany(snapshot, legalEntityId, target),
    { concurrency: 1 },
  );
  return {
    projectionVersion: snapshot.projectionVersion,
    records: companies.flat(),
    tenantId: snapshot.tenantId,
  };
});

export const makeMarketSearchSource = Effect.gen(function* makeMarketSearchSource() {
  const reader = yield* CoreSearchWorkerSnapshot;
  return {
    load: Effect.fn('MarketSearchSource.load')((context: OutboxWorkerHandlerContext, target: MarketSearchTarget) =>
      reader
        .read(context, (snapshot) => readSnapshot(snapshot, context.tenantId, target))
        .pipe(Effect.mapError(marketSearchUnavailable)),
    ),
  } satisfies MarketSearchSourceService;
});

export const MarketSearchSourceLive = Layer.effect(MarketSearchSource, makeMarketSearchSource);
