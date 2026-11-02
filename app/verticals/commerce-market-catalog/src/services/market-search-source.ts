import { CoreSearchWorkerSnapshot } from '@app/core-runtime';
import type {
  CoreSearchSnapshotReadExecutor,
  CoreSearchWorkerSnapshotView,
  OutboxWorkerHandlerContext,
} from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import type { MarketSearchUnavailable } from '../../shared/domain/market-search-unavailable.ts';
import { marketSearchUnavailable } from '../../shared/domain/market-search-unavailable.ts';
import { markets, marketDefinitionRevisions, marketLifecyclePeriods } from '../database/schema.ts';

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

const readMarketPeriods = Effect.fn('MarketSearchSource.readMarketPeriods')(function* readMarketPeriods(
  executor: CoreSearchSnapshotReadExecutor,
  row: Omit<MarketSearchRecord, 'definitions' | 'lifecycles'>,
) {
  // Read sequentially on the same snapshot transaction connection.
  const [definitions, lifecycles] = yield* Effect.all(
    [
      executor
        .select({
          effectiveFrom: marketDefinitionRevisions.effectiveFrom,
          effectiveTo: marketDefinitionRevisions.effectiveTo,
          purpose: marketDefinitionRevisions.purpose,
        })
        .from(marketDefinitionRevisions)
        .where(
          and(
            eq(marketDefinitionRevisions.tenantId, row.tenantId),
            eq(marketDefinitionRevisions.sellingLegalEntityId, row.sellingLegalEntityId),
            eq(marketDefinitionRevisions.marketId, row.marketId),
          ),
        ),
      executor
        .select({
          effectiveFrom: marketLifecyclePeriods.effectiveFrom,
          effectiveTo: marketLifecyclePeriods.effectiveTo,
          lifecycle: marketLifecyclePeriods.lifecycle,
        })
        .from(marketLifecyclePeriods)
        .where(
          and(
            eq(marketLifecyclePeriods.tenantId, row.tenantId),
            eq(marketLifecyclePeriods.sellingLegalEntityId, row.sellingLegalEntityId),
            eq(marketLifecyclePeriods.marketId, row.marketId),
          ),
        ),
    ],
    { concurrency: 1 },
  );
  return { ...row, definitions, lifecycles } satisfies MarketSearchRecord;
});

const readCompany = Effect.fn('MarketSearchSource.readCompany')(function* readCompany(
  snapshot: CoreSearchWorkerSnapshotView,
  legalEntityId: string,
  target: MarketSearchTarget,
) {
  return yield* snapshot.forLegalEntity(
    legalEntityId,
    Effect.fn('MarketSearchSource.companySnapshot')(function* companySnapshot(executor) {
      const rows = yield* executor
        .select({
          businessCode: markets.businessCode,
          marketId: markets.marketId,
          sellingLegalEntityId: markets.sellingLegalEntityId,
          tenantId: markets.tenantId,
        })
        .from(markets)
        .where(
          and(
            eq(markets.tenantId, snapshot.tenantId),
            eq(markets.sellingLegalEntityId, legalEntityId),
            'marketId' in target ? eq(markets.marketId, target.marketId) : undefined,
          ),
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
      return yield* Effect.forEach(rows, (row) => readMarketPeriods(executor, row), { concurrency: 1 });
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
