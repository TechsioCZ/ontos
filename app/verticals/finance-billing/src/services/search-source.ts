import { CoreSearchWorkerSnapshot } from '@app/core-runtime';
import type { CoreSearchWorkerSnapshotView, OutboxWorkerHandlerContext } from '@app/core-runtime';
import { Context, Effect, Layer, Schema } from 'effect';
import { and, eq } from 'drizzle-orm';
import { FinanceStateSchema } from '../../shared/apis/records.ts';
import type { FinanceState } from '../../shared/apis/records.ts';
import { financeStates } from '../database/schema.ts';
import type { SearchProjectionUnavailable } from '../../shared/domain/search-projection-error.ts';
import { searchUnavailable } from '../../shared/domain/search-projection-error.ts';
import type { SearchSnapshot } from './search-projection.ts';

export class SearchSource extends Context.Service<
  SearchSource,
  { readonly load: (context: OutboxWorkerHandlerContext) => Effect.Effect<SearchSnapshot, SearchProjectionUnavailable> }
>()('@app/finance-billing/services/search-source/SearchSource') {}
const readCompany = (view: CoreSearchWorkerSnapshotView, legalEntityId: string) =>
  view.forLegalEntity(legalEntityId, (executor) =>
    executor
      .select({ state: financeStates.state })
      .from(financeStates)
      .where(and(eq(financeStates.tenantId, view.tenantId), eq(financeStates.legalEntityId, legalEntityId)))
      .pipe(
        Effect.flatMap((rows) =>
          rows.length === 0
            ? Effect.succeed({ financialPlanEntries: [], invoices: [] } satisfies FinanceState)
            : Schema.decodeUnknownEffect(FinanceStateSchema)(rows[0]?.state),
        ),
        Effect.map((state) => ({ legalEntityId, state })),
      ),
  );
export const SearchSourceLive = Layer.effect(
  SearchSource,
  Effect.gen(function* sourceLayer() {
    const snapshot = yield* CoreSearchWorkerSnapshot;
    return {
      load: Effect.fn('Finance.loadSearchSnapshot')(function* load(context: OutboxWorkerHandlerContext) {
        return yield* snapshot
          .read(context, (view) =>
            Effect.forEach(view.legalEntityIds, (legalEntityId) => readCompany(view, legalEntityId), {
              concurrency: 1,
            }).pipe(
              Effect.map((companies) => ({
                companies,
                projectionVersion: view.projectionVersion,
                tenantId: view.tenantId,
              })),
            ),
          )
          .pipe(Effect.mapError(searchUnavailable));
      }),
    };
  }),
);
