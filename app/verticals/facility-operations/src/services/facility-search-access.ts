import { ReadHandlerUnavailable, ReadPermissionDenied } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory, ScopedTransactionExecutor } from '@app/core-runtime';
import { ListAccessConditionSchema, evaluateListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import type { ListAccessCondition, ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { RecordKeySchema } from '@app/core-runtime/access/ids';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { Effect, Match, Result, Schema } from 'effect';
import { OpsIdSchema } from '../../shared/domain/common.ts';
import { agendaStates } from '../database/schema.ts';
import { facilityOperationsGrants } from './persistence.service.ts';

const predicateSchema = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      clauses: Schema.NonEmptyArray(Schema.Struct({ conditions: Schema.NonEmptyArray(ListAccessConditionSchema) })),
    }),
  ),
});
export const parseFacilitySearchPredicate = Schema.decodeUnknownEffect(predicateSchema, { onExcessProperty: 'error' });
const validPredicate = (predicate: ListAccessPredicate) =>
  Result.isSuccess(Schema.decodeUnknownResult(predicateSchema, { onExcessProperty: 'error' })(predicate));
export const prepareFacilitySearch = Effect.fn('FacilitySearch.prepare')(function* prepare(
  scope: OperationalScope,
  predicate?: ListAccessPredicate,
) {
  if (predicate === undefined || !validPredicate(predicate)) {
    return yield* new ReadPermissionDenied({
      code: 'read_permission_denied',
      reason: 'Facility search requires its admitted record predicate',
    });
  }
  const grants = yield* facilityOperationsGrants(scope).pipe(
    Effect.mapError((cause) =>
      Object.defineProperty(
        new ReadHandlerUnavailable({
          code: 'read_handler_unavailable',
          reason: 'Facility search permissions are unavailable',
        }),
        'cause',
        { value: cause },
      ),
    ),
  );
  return { grants, predicate };
});

const conditionSql = (condition: ListAccessCondition, key: SQL): SQL =>
  Match.value(condition).pipe(
    Match.tags({
      AllInScope: () => sql`true`,
      AmountWithinCeiling: () => sql`false`,
      AssignedTo: () => sql`false`,
      EntrustedTo: () => sql`false`,
      RecordKeyIn: ({ recordKeys }) => inArray(key, [...recordKeys]),
      TeamMemberOf: () => sql`false`,
    }),
    Match.exhaustive,
  );
export const facilitySearchReachSql = (predicate: ListAccessPredicate, key: SQL): SQL =>
  validPredicate(predicate)
    ? (and(
        sql`true`,
        ...predicate.groups.map(
          (group) =>
            or(
              ...group.clauses.map(
                (clause) => and(...clause.conditions.map((condition) => conditionSql(condition, key))) ?? sql`false`,
              ),
            ) ?? sql`false`,
        ),
      ) ?? sql`false`)
    : sql`false`;

const recordSchema = Schema.Struct({ archived: Schema.Boolean, id: OpsIdSchema, title: Schema.String });
const resources = {
  asset: { agenda: 'assets', collection: 'assets', title: 'name' },
  device: { agenda: 'security', collection: 'devices', title: 'name' },
  document: { agenda: 'documents', collection: 'documents', title: 'title' },
  meter: { agenda: 'meters', collection: 'meters', title: 'serialNumber' },
} as const;
export type FacilitySearchResource = keyof typeof resources;
const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Facility search owner projection is unavailable',
    }),
    'cause',
    { value: cause },
  );

/** Only admitted owner identities and public titles leave the owner transaction; no meter/private fields. */
export const loadFacilitySearchRecords = Effect.fn('FacilitySearch.loadRecords')(function* loadRecords(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  resource: FacilitySearchResource,
  prepared: Effect.Success<ReturnType<typeof prepareFacilitySearch>>,
  includeArchived: boolean,
): Effect.fn.Return<readonly (typeof recordSchema.Type)[], ReadHandlerUnavailable> {
  if (
    scope.legalEntityId === undefined ||
    transaction.scope.tenantId !== scope.tenantId ||
    transaction.scope.legalEntityId !== scope.legalEntityId ||
    !validPredicate(prepared.predicate)
  ) {
    return yield* unavailable();
  }
  const allowed = resource === 'meter' ? prepared.grants.readOperational : prepared.grants.readAll;
  if (!allowed) {
    return [];
  }
  const spec = resources[resource];
  let archived = sql`false`;
  if (resource === 'asset') {
    archived = sql`item ? 'archive'`;
  }
  if (resource === 'device') {
    archived = sql`coalesce(item->>'state' = 'decommissioned', false)`;
  }
  if (resource === 'meter') {
    archived = sql`coalesce(item->>'status' = 'RETIRED', false)`;
  }
  const key = sql`(${agendaStates.legalEntityId}::text || '.' || (item->>'id'))`;
  const reach = facilitySearchReachSql(prepared.predicate, key);
  const rows = yield* transaction
    .select({
      legalEntityId: agendaStates.legalEntityId,
      records: sql<unknown>`(select coalesce(jsonb_agg(jsonb_build_object('id', item->>'id', 'title', item->>${spec.title}, 'archived', ${archived})), '[]'::jsonb) from jsonb_array_elements(coalesce(${agendaStates.state}->${spec.collection}, '[]'::jsonb)) item where ${reach} and (${includeArchived} or not (${archived})))`,
      tenantId: agendaStates.tenantId,
    })
    .from(agendaStates)
    .where(
      and(
        eq(agendaStates.tenantId, scope.tenantId),
        eq(agendaStates.legalEntityId, scope.legalEntityId),
        eq(agendaStates.agenda, spec.agenda),
      ),
    )
    .pipe(Effect.mapError(unavailable));
  const records: readonly (readonly (typeof recordSchema.Type)[])[] = yield* Effect.forEach(
    rows,
    (row) => {
      if (row.tenantId !== scope.tenantId || row.legalEntityId !== scope.legalEntityId) {
        return Effect.fail(unavailable());
      }
      return Schema.decodeUnknownEffect(Schema.Array(recordSchema))(row.records).pipe(Effect.mapError(unavailable));
    },
    { concurrency: 1 },
  );
  return records.flat().filter(
    (row: typeof recordSchema.Type) =>
      (includeArchived || !row.archived) &&
      evaluateListAccessPredicate(prepared.predicate, {
        recordKey: RecordKeySchema.make(`${scope.legalEntityId}.${row.id}`),
        teamIds: [],
      }),
  );
});

export type FacilitySearchPreparation = Effect.Success<ReturnType<typeof prepareFacilitySearch>>;
export type FacilitySearchRecords = readonly (typeof recordSchema.Type)[];
export interface FacilitySearchServices {
  readonly load: (
    prepared: FacilitySearchPreparation,
    includeArchived: boolean,
  ) => Effect.Effect<FacilitySearchRecords, ReadHandlerUnavailable>;
}
export const makeFacilitySearchServices =
  (resource: FacilitySearchResource): ReadServiceFactory<FacilitySearchServices> =>
  (transaction, scope) =>
    Effect.succeed({
      load: (prepared, includeArchived) =>
        loadFacilitySearchRecords(transaction, scope, resource, prepared, includeArchived),
    });
