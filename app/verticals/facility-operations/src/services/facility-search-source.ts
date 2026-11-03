import { CoreSearchWorkerSnapshot, ReadHandlerUnavailable } from '@app/core-runtime';
import type {
  CoreSearchSnapshotReadExecutor,
  CoreSearchWorkerSnapshotView,
  OutboxWorkerHandlerContext,
} from '@app/core-runtime';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';
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
  text: Schema.Array(Schema.OptionFromNullOr(Schema.String)),
  title: Schema.String,
  type: Schema.Literals(['asset', 'device', 'document', 'meter']),
});

/** Optional owner evidence is omitted, never published as an empty Core search term. */
export const cleanFacilitySearchTerm = (term: string): readonly string[] => {
  const value = term.trim();
  return value.length > 0 ? [value] : [];
};

const cleanDecodedFacilitySearchTerm = (term: Option.Option<string>): readonly string[] =>
  Option.isNone(term) ? [] : cleanFacilitySearchTerm(term.value);

export interface FacilitySearchSnapshot {
  readonly projectionVersion: string;
  readonly rows: readonly (Omit<typeof SearchRowSchema.Type, 'text'> & {
    readonly legalEntityId: string;
    readonly tenantId: string;
    readonly text: readonly string[];
  })[];
  readonly tenantId: string;
}

/**
 * Owner-local allowlist only: asset identity/location and service title/due date, device name/serial,
 * document title/category/current filename; meter serial/supply-point/medium/unit.
 * No readings, costs, photos, private people, notes, file bytes or security configuration.
 * Location labels are stored owner snapshots; search never joins private Property state.
 */
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
        'text', jsonb_build_array(
          item->>'name', item->>'inventoryNumber', item->>'category',
          item->>'serialNumber', item->'location'->>'label'
        ) || (select coalesce(jsonb_agg(term), '[]'::jsonb)
          from jsonb_array_elements(coalesce(item->'services', '[]'::jsonb)) service
          cross join lateral jsonb_array_elements(
            jsonb_build_array(service->>'title', service->>'nextDueOn')
          ) term)
      )), '[]'::jsonb) from jsonb_array_elements(${agendaStates.state}->'assets') item)
      when 'security' then (select coalesce(jsonb_agg(jsonb_build_object(
        'id', item->>'id', 'type', 'device', 'title', item->>'name',
        'archived', coalesce(item->>'state' = 'decommissioned', false),
        'text', jsonb_build_array(item->>'name', item->>'serialNumber')
      )), '[]'::jsonb) from jsonb_array_elements(${agendaStates.state}->'devices') item)
      when 'documents' then (select coalesce(jsonb_agg(jsonb_build_object(
        'id', item->>'id', 'type', 'document', 'title', item->>'title', 'archived', false,
        'text', jsonb_build_array(
          item->>'title', item->>'category', item->'versions'->-1->'file'->>'name'
        )
      )), '[]'::jsonb) from jsonb_array_elements(${agendaStates.state}->'documents') item)
      when 'meters' then (select coalesce(jsonb_agg(jsonb_build_object(
        'id', item->>'id', 'type', 'meter', 'title', item->>'serialNumber',
        'archived', coalesce(item->>'status' = 'RETIRED', false),
        'text', jsonb_build_array(
          item->>'serialNumber', item->>'supplyPoint', item->>'medium', item->>'unit'
        )
      )), '[]'::jsonb) from jsonb_array_elements(${agendaStates.state}->'meters') item)
    end`,
      tenantId: agendaStates.tenantId,
    })
    .from(agendaStates)
    .where(
      and(
        eq(agendaStates.tenantId, tenantId),
        eq(agendaStates.legalEntityId, legalEntityId),
        inArray(agendaStates.agenda, ['assets', 'security', 'documents', 'meters']),
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
        Effect.map((values) =>
          values.map((record) => ({
            ...record,
            legalEntityId,
            tenantId,
            text: record.text.flatMap(cleanDecodedFacilitySearchTerm),
          })),
        ),
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
