import { ReadPermissionDenied, ReadHandlerUnavailable } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { ListAccessConditionSchema } from '@app/core-runtime/access/decision/list-access';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Result, Schema } from 'effect';
import { OpportunitySchema } from '../../shared/model/opportunity.ts';
import { recordsRead } from '../api/records.read.ts';
import { salesPipelineStates } from '../database/schema.ts';
import { opportunityReachSql, opportunityVisible } from './record-reach.ts';
import { searchUnavailable } from './search-read.ts';

const predicateSchema = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      clauses: Schema.NonEmptyArray(Schema.Struct({ conditions: Schema.NonEmptyArray(ListAccessConditionSchema) })),
    }),
  ),
});
export const parsePipelineSearchPredicate = Schema.decodeUnknownEffect(predicateSchema, { onExcessProperty: 'error' });
const validPredicate = (predicate: ListAccessPredicate) =>
  Result.isSuccess(Schema.decodeUnknownResult(predicateSchema, { onExcessProperty: 'error' })(predicate));
export const preparePipelineSearch = Effect.fn('Pipeline.search.prepare')(function* prepare(scope: OperationalScope) {
  const gate = yield* AccessDecisionGate;
  const listing = yield* gate.list({
    carrier: recordsRead.descriptor,
    legalEntityScope: 'required',
    now: yield* DateTime.nowAsDate,
    scope,
  });
  if (listing.decision.outcome === 'UNAVAILABLE') {
    return yield* new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Pipeline records authority is unavailable',
    });
  }
  if (listing.decision.outcome !== 'ALLOWED' || listing.predicate === undefined || !validPredicate(listing.predicate)) {
    return yield* new ReadPermissionDenied({
      code: 'read_permission_denied',
      reason: 'Pipeline search requires its admitted records predicate',
    });
  }
  return listing.predicate;
});
const searchRecordSchema = Schema.Struct({
  amountMinor: OpportunitySchema.fields.amountMinor,
  archivedAt: OpportunitySchema.fields.archivedAt,
  currency: OpportunitySchema.fields.currency,
  entrustedPrincipalRef: OpportunitySchema.fields.entrustedPrincipalRef,
  expectedCloseDate: OpportunitySchema.fields.expectedCloseDate,
  id: OpportunitySchema.fields.id,
  stage: OpportunitySchema.fields.stage,
  title: OpportunitySchema.fields.title,
});
export type PipelineSearchRecord = typeof searchRecordSchema.Type;
export const loadPipelineSearchRecords = Effect.fn('Pipeline.search.load')(function* load(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  predicate: ListAccessPredicate,
) {
  if (
    scope.legalEntityId === undefined ||
    transaction.scope.tenantId !== scope.tenantId ||
    transaction.scope.legalEntityId !== scope.legalEntityId ||
    !validPredicate(predicate)
  ) {
    return yield* searchUnavailable();
  }
  const reach = opportunityReachSql(predicate, sql`item`, scope.tenantId);
  const rows = yield* transaction
    .select({
      legalEntityId: salesPipelineStates.legalEntityId,
      records: sql<unknown>`(select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',item->'id','title',item->'title','stage',item->'stage','expectedCloseDate',item->'expectedCloseDate','currency',item->'currency','amountMinor',item->'amountMinor','entrustedPrincipalRef',item->'entrustedPrincipalRef'))),'[]'::jsonb) from jsonb_array_elements(coalesce(${salesPipelineStates.state}->'opportunities','[]'::jsonb)) item where not(item ? 'archivedAt') and ${reach})`,
      tenantId: salesPipelineStates.tenantId,
    })
    .from(salesPipelineStates)
    .where(
      and(eq(salesPipelineStates.tenantId, scope.tenantId), eq(salesPipelineStates.legalEntityId, scope.legalEntityId)),
    )
    .pipe(Effect.mapError(searchUnavailable));
  const records = yield* Effect.forEach(
    rows,
    (row) => {
      if (row.tenantId !== scope.tenantId || row.legalEntityId !== scope.legalEntityId) {
        return Effect.fail(searchUnavailable());
      }
      return Schema.decodeUnknownEffect(Schema.Array(searchRecordSchema))(row.records).pipe(
        Effect.mapError(searchUnavailable),
      );
    },
    { concurrency: 1 },
  );
  return records
    .flat()
    .filter((record) => record.archivedAt === undefined && opportunityVisible(predicate, record, scope.tenantId));
});
export interface PipelineSearchServices {
  readonly load: (
    predicate: ListAccessPredicate,
  ) => Effect.Effect<readonly PipelineSearchRecord[], ReturnType<typeof searchUnavailable>>;
}
