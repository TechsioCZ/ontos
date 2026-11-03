import { CoreSearchWorkerSnapshot } from '@app/core-runtime';
import type {
  CoreSearchSnapshotReadExecutor,
  CoreSearchWorkerSnapshotView,
  OutboxWorkerHandlerContext,
} from '@app/core-runtime';
import { and, eq, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { TaskRefSchema } from '../../shared/resources/task.ts';
import { TaskPrioritySchema, TaskSchema, TaskStateSchema } from '../../shared/apis/records.ts';
import { workStates } from '../database/schema.ts';
import { searchUnavailable } from './search-read.ts';

const RecordSchema = Schema.Struct({
  archived: Schema.Boolean,
  dueDate: TaskSchema.fields.dueDate,
  ownerPrincipalRef: TaskSchema.fields.ownerPrincipalRef,
  priority: Schema.optionalKey(TaskPrioritySchema),
  projectId: TaskSchema.fields.projectId,
  ref: TaskRefSchema,
  state: Schema.optionalKey(TaskStateSchema),
  title: TaskSchema.fields.title,
});
const RecordsSchema = Schema.Array(RecordSchema);
export type SearchSourceRecord = typeof RecordSchema.Type & { readonly legalEntityId: string };
export interface SearchSnapshot {
  readonly projectionVersion: string;
  readonly records: readonly SearchSourceRecord[];
  readonly tenantId: string;
}
const decodeRecords = Effect.fn('WorkTasks.decodeSearchRecords')(function* decodeRecords(
  records: typeof RecordsSchema.Type,
  tenantId: string,
  legalEntityId: string,
) {
  return yield* Effect.forEach(
    records,
    Effect.fn('WorkTasks.decodeSearchRecord')(function* decodeRecord(item) {
      const ref = yield* Schema.decodeEffect(TaskRefSchema)(item.ref).pipe(Effect.mapError(searchUnavailable));
      if (
        ref.tenantId !== tenantId ||
        (item.ownerPrincipalRef !== undefined && item.ownerPrincipalRef.tenantId !== tenantId)
      ) {
        return yield* searchUnavailable();
      }
      return { ...item, legalEntityId, ref };
    }),
    { concurrency: 1 },
  );
});

const readCompany = Effect.fn('WorkTasks.readSearchCompany')(function* readCompany(
  db: CoreSearchSnapshotReadExecutor,
  tenantId: string,
  legalEntityId: string,
) {
  // JSON-array projection cannot use column selection: whitelist only approved task fields here.
  // No description, comments, history, inquiry contacts or foreign-owner joins. projectId is work.tasks-local.
  const rows = yield* db
    .select({
      legalEntityId: workStates.legalEntityId,
      records: sql<unknown>`case when jsonb_typeof(${workStates.state}->'tasks') = 'array' then coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('ref', item->'ref', 'title', item->>'title', 'archived', item ? 'archivedAt', 'dueDate', item->'dueDate', 'ownerPrincipalRef', item->'ownerPrincipalRef', 'projectId', item->'projectId', 'state', item->'state', 'priority', item->'priority'))) from jsonb_array_elements(${workStates.state}->'tasks') as item), '[]'::jsonb) else null end`,
      tenantId: workStates.tenantId,
    })
    .from(workStates)
    .where(and(eq(workStates.tenantId, tenantId), eq(workStates.legalEntityId, legalEntityId)));
  const records = yield* Effect.forEach(
    rows,
    Effect.fn('WorkTasks.decodeSearchRow')(function* decodeRow(row) {
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
const readSnapshot = Effect.fn('WorkTasks.readSearchSnapshot')(function* readSnapshot(
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
export const loadSearchSnapshot = Effect.fn('WorkTasks.searchSnapshot')(function* loadSearchSnapshot(
  context: OutboxWorkerHandlerContext,
) {
  const reader = yield* CoreSearchWorkerSnapshot;
  return yield* reader
    .read(context, (view) => readSnapshot(view, context.tenantId))
    .pipe(Effect.mapError(searchUnavailable));
});
