import { CoreSearchWorkerSnapshot } from '@app/core-runtime';
import type { CoreSearchWorkerSnapshotView, OutboxWorkerHandlerContext } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { PropertyStateSchema } from '../../shared/apis/records.ts';
import { propertyState } from '../database/schema.ts';
import { invalidSearchSource } from '../search/projection.ts';

interface SearchRow {
  readonly legalEntityId: string;
  readonly payload: typeof PropertyStateSchema.Encoded;
  readonly tenantId: string;
}
const decodeRow = (snapshot: CoreSearchWorkerSnapshotView, legalEntityId: string, row: SearchRow) =>
  row.tenantId === snapshot.tenantId && row.legalEntityId === legalEntityId
    ? Schema.decodeEffect(PropertyStateSchema)(row.payload).pipe(
        Effect.mapError(invalidSearchSource),
        Effect.map((state) => ({ legalEntityId, state })),
      )
    : Effect.fail(invalidSearchSource());

const readCompany = (snapshot: CoreSearchWorkerSnapshotView, legalEntityId: string) =>
  snapshot.forLegalEntity(legalEntityId, (executor) =>
    executor
      .select({
        legalEntityId: propertyState.legalEntityId,
        payload: propertyState.payload,
        tenantId: propertyState.tenantId,
      })
      .from(propertyState)
      .where(and(eq(propertyState.tenantId, snapshot.tenantId), eq(propertyState.legalEntityId, legalEntityId)))
      .pipe(
        Effect.flatMap((rows) =>
          rows.length > 1
            ? Effect.fail(invalidSearchSource())
            : Effect.forEach(rows, (row) => decodeRow(snapshot, legalEntityId, row), { concurrency: 1 }),
        ),
      ),
  );

/** Core reserves a generation around this coherent owner-local, RLS-scoped snapshot. */
export const loadSearchSnapshot = Effect.fn('PropertySearch.loadSnapshot')(function* loadSnapshot(
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
