import { CoreSearchWorkerSnapshot } from '@app/core-runtime';
import type { CoreSearchWorkerSnapshotView, OutboxWorkerHandlerContext } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { OccupancyStateSchema } from '../../shared/apis/records.ts';
import { occupancyState } from '../database/schema.ts';
import { invalidSearchSource } from './search-projection.ts';

interface SearchRow {
  readonly legalEntityId: string;
  readonly payload: typeof OccupancyStateSchema.Encoded;
  readonly tenantId: string;
}
const decodeRow = (snapshot: CoreSearchWorkerSnapshotView, legalEntityId: string, row: SearchRow) =>
  row.tenantId === snapshot.tenantId && row.legalEntityId === legalEntityId
    ? Schema.decodeEffect(OccupancyStateSchema)(row.payload).pipe(
        Effect.mapError(invalidSearchSource),
        Effect.map((state) => ({ legalEntityId, state })),
      )
    : Effect.fail(invalidSearchSource());

const readCompany = (snapshot: CoreSearchWorkerSnapshotView, legalEntityId: string) =>
  snapshot.forLegalEntity(legalEntityId, (executor) =>
    executor
      .select({
        legalEntityId: occupancyState.legalEntityId,
        payload: occupancyState.snapshot,
        tenantId: occupancyState.tenantId,
      })
      .from(occupancyState)
      .where(and(eq(occupancyState.tenantId, snapshot.tenantId), eq(occupancyState.legalEntityId, legalEntityId)))
      .pipe(
        Effect.flatMap((rows) =>
          rows.length > 1
            ? Effect.fail(invalidSearchSource())
            : Effect.forEach(rows, (row) => decodeRow(snapshot, legalEntityId, row), { concurrency: 1 }),
        ),
      ),
  );

/** Core reserves a generation around this coherent owner-local, RLS-scoped snapshot. */
export const loadSearchSnapshot = Effect.fn('LeaseSearch.loadSnapshot')(function* loadSnapshot(
  context: OutboxWorkerHandlerContext,
) {
  const reader = yield* CoreSearchWorkerSnapshot;
  return yield* reader
    .read(context, (snapshot) =>
      snapshot.tenantId === context.tenantId && new Set(snapshot.legalEntityIds).size === snapshot.legalEntityIds.length
        ? Effect.forEach(snapshot.legalEntityIds, (company) => readCompany(snapshot, company), { concurrency: 1 }).pipe(
            Effect.map((companies) => ({
              companies: companies.flat(),
              projectionVersion: snapshot.projectionVersion,
              tenantId: snapshot.tenantId,
            })),
          )
        : Effect.fail(invalidSearchSource()),
    )
    .pipe(Effect.mapError(invalidSearchSource));
});
