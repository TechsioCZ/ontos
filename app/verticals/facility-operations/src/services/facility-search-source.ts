import { CoreSearchWorkerSnapshot, ReadHandlerUnavailable } from '@app/core-runtime';
import type {
  CoreSearchSnapshotReadExecutor,
  CoreSearchWorkerSnapshotView,
  OutboxWorkerHandlerContext,
} from '@app/core-runtime';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { agendaStates } from '../database/schema.ts';

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Facility search snapshot is temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );

const SearchRowSchema = Schema.Struct({
  archived: Schema.Boolean,
  id: Schema.String.check(Schema.isMinLength(1)),
  text: Schema.Array(Schema.String),
  title: Schema.String,
  type: Schema.Literals(['asset', 'device', 'document']),
});
export interface FacilitySearchSnapshot {
  readonly projectionVersion: string;
  readonly rows: readonly (typeof SearchRowSchema.Type & {
    readonly legalEntityId: string;
    readonly tenantId: string;
  })[];
  readonly tenantId: string;
}

/** SQL projects only business labels. Notes, people, files, contracts and security details never leave owner SQL. */
const readCompany = Effect.fn('FacilitySearch.readCompany')(function* readCompany(
  db: CoreSearchSnapshotReadExecutor,
  tenantId: string,
  legalEntityId: string,
) {
  const rows = yield* db
    .select({
      legalEntityId: agendaStates.legalEntityId,
      records: sql<unknown>`case ${agendaStates.agenda}
      when 'assets' then (select coalesce(jsonb_agg(jsonb_build_object(
        'id', item->>'id', 'type', 'asset', 'title', item->>'name',
        'archived', item ? 'archive',
        'text', jsonb_build_array(item->>'name', item->>'inventoryNumber', item->>'category')
      )), '[]'::jsonb) from jsonb_array_elements(${agendaStates.state}->'assets') item)
      when 'security' then (select coalesce(jsonb_agg(jsonb_build_object(
        'id', item->>'id', 'type', 'device', 'title', item->>'name',
        'archived', coalesce(item->>'state' = 'decommissioned', false),
        'text', jsonb_build_array(item->>'name', coalesce(item->>'serialNumber', ''))
      )), '[]'::jsonb) from jsonb_array_elements(${agendaStates.state}->'devices') item)
      when 'documents' then (select coalesce(jsonb_agg(jsonb_build_object(
        'id', item->>'id', 'type', 'document', 'title', item->>'title', 'archived', false,
        'text', jsonb_build_array(item->>'title', item->>'category')
      )), '[]'::jsonb) from jsonb_array_elements(${agendaStates.state}->'documents') item)
    end`,
      tenantId: agendaStates.tenantId,
    })
    .from(agendaStates)
    .where(
      and(
        eq(agendaStates.tenantId, tenantId),
        eq(agendaStates.legalEntityId, legalEntityId),
        inArray(agendaStates.agenda, ['assets', 'security', 'documents']),
      ),
    );
  const records = yield* Effect.forEach(
    rows,
    (row) => {
      if (row.tenantId !== tenantId || row.legalEntityId !== legalEntityId) {
        return Effect.fail(unavailable());
      }
      return Schema.decodeUnknownEffect(Schema.Array(SearchRowSchema))(row.records).pipe(
        Effect.mapError(unavailable),
        Effect.map((values) => values.map((record) => ({ ...record, legalEntityId, tenantId }))),
      );
    },
    { concurrency: 1 },
  );
  return records.flat();
});

const readSnapshot = Effect.fn('FacilitySearch.readSnapshot')(function* readSnapshot(
  view: CoreSearchWorkerSnapshotView,
  context: OutboxWorkerHandlerContext,
) {
  if (view.tenantId !== context.tenantId) {
    return yield* unavailable();
  }
  const companies = yield* Effect.forEach(
    view.legalEntityIds,
    (legalEntityId) => view.forLegalEntity(legalEntityId, (db) => readCompany(db, view.tenantId, legalEntityId)),
    { concurrency: 1 },
  );
  return {
    projectionVersion: view.projectionVersion,
    rows: companies.flat(),
    tenantId: view.tenantId,
  } satisfies FacilitySearchSnapshot;
});

export const loadFacilitySearchSnapshot = Effect.fn('FacilitySearch.snapshot')(function* loadSnapshot(
  context: OutboxWorkerHandlerContext,
) {
  const reader = yield* CoreSearchWorkerSnapshot;
  return yield* reader.read(context, (view) => readSnapshot(view, context)).pipe(Effect.mapError(unavailable));
});
