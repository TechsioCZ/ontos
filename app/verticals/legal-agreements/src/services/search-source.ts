import { CoreSearchWorkerSnapshot } from '@app/core-runtime';
import type { CoreSearchWorkerSnapshotView, OutboxWorkerHandlerContext } from '@app/core-runtime';
import { Context, Effect, Layer, Schema } from 'effect';
import { and, eq } from 'drizzle-orm';
import { AgreementsStateSchema } from '../../shared/apis/records.ts';
import type { AgreementsState } from '../../shared/apis/records.ts';
import { agreementsState } from '../database/schema.ts';
import type { SearchProjectionUnavailable } from '../../shared/domain/search-projection-error.ts';
import { searchUnavailable } from '../../shared/domain/search-projection-error.ts';
import type { SearchSnapshot } from './search-projection.ts';

export class SearchSource extends Context.Service<
  SearchSource,
  { readonly load: (context: OutboxWorkerHandlerContext) => Effect.Effect<SearchSnapshot, SearchProjectionUnavailable> }
>()('@app/legal-agreements/services/search-source/SearchSource') {}
const readCompany = (view: CoreSearchWorkerSnapshotView, legalEntityId: string) =>
  view.forLegalEntity(legalEntityId, (executor) =>
    executor
      .select({ state: agreementsState.snapshot })
      .from(agreementsState)
      .where(and(eq(agreementsState.tenantId, view.tenantId), eq(agreementsState.legalEntityId, legalEntityId)))
      .pipe(
        Effect.flatMap((rows) =>
          rows.length === 0
            ? Effect.succeed({ contracts: [], documents: [] } satisfies AgreementsState)
            : Schema.decodeUnknownEffect(AgreementsStateSchema)(rows[0]?.state),
        ),
        Effect.map((state) => ({ legalEntityId, state })),
      ),
  );
export const SearchSourceLive = Layer.effect(
  SearchSource,
  Effect.gen(function* sourceLayer() {
    const snapshot = yield* CoreSearchWorkerSnapshot;
    return {
      load: Effect.fn('Agreements.loadSearchSnapshot')(function* load(context: OutboxWorkerHandlerContext) {
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
