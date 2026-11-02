import { CoreSearchWorkerSnapshot } from '@app/core-runtime';
import type {
  CoreSearchSnapshotReadExecutor,
  CoreSearchWorkerSnapshotView,
  OutboxWorkerHandlerContext,
} from '@app/core-runtime';
import { and, eq, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { OpportunityRefSchema } from '../../shared/resources/opportunity.ts';
import { OpportunityIdSchema } from '../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import { salesPipelineStates } from '../database/schema.ts';
import { searchUnavailable } from './search-read.ts';

const RecordsSchema = Schema.Array(
  Schema.Struct({
    archived: Schema.Boolean,
    id: Schema.toEncoded(OpportunityIdSchema),
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
);
export interface SearchSourceRecord {
  readonly archived: boolean;
  readonly legalEntityId: string;
  readonly ref: typeof OpportunityRefSchema.Type;
  readonly title: string;
}
export interface SearchSnapshot {
  readonly projectionVersion: string;
  readonly records: readonly SearchSourceRecord[];
  readonly tenantId: string;
}
const decodeRecords = Effect.fn('DemoSalesPipeline.decodeSearchRecords')(function* decodeRecords(
  records: typeof RecordsSchema.Type,
  tenantId: string,
  legalEntityId: string,
) {
  return yield* Effect.forEach(
    records,
    Effect.fn('DemoSalesPipeline.decodeSearchRecord')(function* decodeRecord(item) {
      const ref = yield* Schema.decodeEffect(OpportunityRefSchema)({
        moduleId: 'demo.sales-pipeline',
        resourceId: item.id,
        resourceType: 'demo.sales-pipeline.opportunity',
        tenantId,
      }).pipe(Effect.mapError(searchUnavailable));
      if (ref.tenantId !== tenantId) {
        return yield* searchUnavailable();
      }
      return { archived: item.archived, legalEntityId, ref, title: item.title };
    }),
    { concurrency: 1 },
  );
});

const readCompany = Effect.fn('DemoSalesPipeline.readSearchCompany')(function* readCompany(
  db: CoreSearchSnapshotReadExecutor,
  tenantId: string,
  legalEntityId: string,
) {
  // SQL emits only search fields, never raw owner JSON or private contact/comment/note/history fields.
  const rows = yield* db
    .select({
      legalEntityId: salesPipelineStates.legalEntityId,
      records: sql<unknown>`case when jsonb_typeof(${salesPipelineStates.state}->'opportunities') = 'array' then coalesce((select jsonb_agg(jsonb_build_object('id', item->>'id', 'title', item->>'title', 'archived', item ? 'archivedAt')) from jsonb_array_elements(${salesPipelineStates.state}->'opportunities') as item), '[]'::jsonb) else null end`,
      tenantId: salesPipelineStates.tenantId,
    })
    .from(salesPipelineStates)
    .where(and(eq(salesPipelineStates.tenantId, tenantId), eq(salesPipelineStates.legalEntityId, legalEntityId)));
  const records = yield* Effect.forEach(
    rows,
    Effect.fn('DemoSalesPipeline.decodeSearchRow')(function* decodeRow(row) {
      if (row.tenantId !== tenantId || row.legalEntityId !== legalEntityId) {
        return yield* searchUnavailable();
      }
      const decoded = yield* Schema.decodeUnknownEffect(RecordsSchema)(row.records).pipe(
        Effect.mapError(searchUnavailable),
      );
      return yield* decodeRecords(decoded, tenantId, legalEntityId);
    }),
    { concurrency: 1 },
  );
  return records.flat();
});
const readSnapshot = Effect.fn('DemoSalesPipeline.readSearchSnapshot')(function* readSnapshot(
  view: CoreSearchWorkerSnapshotView,
  tenantId: string,
) {
  if (view.tenantId !== tenantId) {
    return yield* searchUnavailable();
  }
  const companies = yield* Effect.forEach(
    view.legalEntityIds,
    (legalEntityId) => view.forLegalEntity(legalEntityId, (db) => readCompany(db, tenantId, legalEntityId)),
    { concurrency: 1 },
  );
  return { projectionVersion: view.projectionVersion, records: companies.flat(), tenantId } satisfies SearchSnapshot;
});
/** Core reserves a generation and closes the consistent tenant snapshot before projection or permission I/O. */
export const loadSearchSnapshot = Effect.fn('DemoSalesPipeline.searchSnapshot')(function* loadSearchSnapshot(
  context: OutboxWorkerHandlerContext,
) {
  const reader = yield* CoreSearchWorkerSnapshot;
  return yield* reader
    .read(context, (view) => readSnapshot(view, context.tenantId))
    .pipe(Effect.mapError(searchUnavailable));
});
