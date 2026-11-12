import { ReadPermissionDenied, ReadHandlerUnavailable } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory, ScopedTransactionExecutor } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { ListAccessConditionSchema, evaluateListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import type { ListAccessCondition, ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { PrincipalIdSchema, RecordKeySchema } from '@app/core-runtime/access/ids';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Predicate, Result, Schema, Struct } from 'effect';
import { recordsRead } from '../api/records.read.ts';
import { CrmStateSchema, initialCrmState, withDefaultSlices } from '../../shared/domain/state.ts';
import type { CrmState } from '../../shared/domain/state.ts';
import type { Client } from '../../shared/domain/clients.ts';
import { crmStates } from '../database/schema.ts';
import { searchUnavailable } from './search-unavailable.ts';

const predicateSchema = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      clauses: Schema.NonEmptyArray(Schema.Struct({ conditions: Schema.NonEmptyArray(ListAccessConditionSchema) })),
    }),
  ),
});
export const parseCrmSearchPredicate = Schema.decodeUnknownEffect(predicateSchema, { onExcessProperty: 'error' });
const validPredicate = (predicate: ListAccessPredicate) =>
  Result.isSuccess(Schema.decodeUnknownResult(predicateSchema, { onExcessProperty: 'error' })(predicate));
/** Search admission is scope-wide; its actual owner Records read supplies the client reach. */
export const prepareCrmSearch = Effect.fn('Crm.search.prepare')(function* prepare(scope: OperationalScope) {
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
      reason: 'CRM records authority is unavailable',
    });
  }
  if (listing.decision.outcome !== 'ALLOWED' || listing.predicate === undefined || !validPredicate(listing.predicate)) {
    return yield* new ReadPermissionDenied({
      code: 'read_permission_denied',
      reason: 'CRM search requires its admitted records predicate',
    });
  }
  return listing.predicate;
});
const conditionSql = (condition: ListAccessCondition, client: SQL): SQL =>
  Match.value(condition).pipe(
    Match.tags({
      AllInScope: () => sql`true`,
      AmountWithinCeiling: () => sql`false`,
      AssignedTo: ({ holder }) =>
        Predicate.isTagged(holder, 'Principal')
          ? sql`exists (select 1 from jsonb_array_elements(coalesce(${crmStates.state}->'salespeople','[]'::jsonb)) p where p->>'id' = ${client}->>'ownerSalespersonId' and p->>'active' = 'true' and p->>'principalId' = ${holder.principalId})`
          : sql`false`,
      EntrustedTo: ({ holder }) =>
        Predicate.isTagged(holder, 'Principal')
          ? sql`exists (select 1 from jsonb_array_elements(coalesce(${crmStates.state}->'salespeople','[]'::jsonb)) p where p->>'id' = ${client}->>'ownerSalespersonId' and p->>'active' = 'true' and p->>'principalId' = ${holder.principalId})`
          : sql`false`,
      RecordKeyIn: ({ recordKeys }) => inArray(sql`${client}->>'id'`, [...recordKeys]),
      TeamMemberOf: () => sql`false`,
    }),
    Match.exhaustive,
  );
export const crmSearchReachSql = (predicate: ListAccessPredicate, client: SQL): SQL =>
  validPredicate(predicate)
    ? (and(
        sql`true`,
        ...predicate.groups.map(
          (group) =>
            or(
              ...group.clauses.map(
                (clause) => and(...clause.conditions.map((condition) => conditionSql(condition, client))) ?? sql`false`,
              ),
            ) ?? sql`false`,
        ),
      ) ?? sql`false`)
    : sql`false`;
const clientVisible = (client: Client, state: CrmState, predicate: ListAccessPredicate) => {
  if (client.status !== 'active' || client.archivedAt !== undefined || !validPredicate(predicate)) {
    return false;
  }
  const owner = state.salespeople.find((person) => person.id === client.ownerSalespersonId && person.active);
  const principal = Schema.decodeUnknownOption(PrincipalIdSchema)(owner?.principalId);
  const fact = { recordKey: RecordKeySchema.make(client.id), teamIds: [] };
  const facts = Option.isNone(principal)
    ? fact
    : {
        ...fact,
        assigned: { _tag: 'Principal' as const, principalId: principal.value },
        entrusted: { _tag: 'Principal' as const, principalId: principal.value },
      };
  return evaluateListAccessPredicate(predicate, facts);
};
/** Owner facts, not the actor, identify an assignment. Search never loads notes, Party snapshots or history. */
export const qualifyCrmSearchState = (state: CrmState, predicate: ListAccessPredicate): CrmState => {
  const clients = state.clients.items.filter((client) => clientVisible(client, state, predicate));
  const ids = new Set(clients.map((client) => client.id));
  return {
    ...initialCrmState,
    clients: {
      assignmentHistory: [],
      contacts: state.clients.contacts.flatMap((contact) =>
        ids.has(contact.clientId) && contact.status === 'active' && contact.archivedAt === undefined
          ? [Struct.omit(contact, ['note'])]
          : [],
      ),
      items: clients.map((client) => Struct.omit(client, ['note', 'partyRef', 'segment'])),
    },
    salespeople: [],
  };
};
export const loadCrmSearchRecords = Effect.fn('Crm.search.load')(function* load(
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
  const reach = crmSearchReachSql(predicate, sql`c`);
  const rows = yield* transaction
    .select({
      legalEntityId: crmStates.legalEntityId,
      state: sql<unknown>`(with visible_clients as (select c from jsonb_array_elements(coalesce(${crmStates.state}->'clients'->'items','[]'::jsonb)) c where c->>'status' = 'active' and not (c ? 'archivedAt') and ${reach}) select jsonb_build_object('clients', jsonb_build_object('items',coalesce((select jsonb_agg(c - 'note' - 'partyRef' - 'segment') from visible_clients),'[]'::jsonb),'contacts',coalesce((select jsonb_agg(contact - 'note') from jsonb_array_elements(coalesce(${crmStates.state}->'clients'->'contacts','[]'::jsonb)) contact where contact->>'clientId' in (select c->>'id' from visible_clients) and contact->>'status' = 'active' and not (contact ? 'archivedAt')),'[]'::jsonb),'assignmentHistory','[]'::jsonb),'salespeople',coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',p->'id','name',p->'name','principalId',p->'principalId','active',p->'active'))) from jsonb_array_elements(coalesce(${crmStates.state}->'salespeople','[]'::jsonb)) p where p->>'active' = 'true'),'[]'::jsonb)))`,
      tenantId: crmStates.tenantId,
    })
    .from(crmStates)
    .where(and(eq(crmStates.tenantId, scope.tenantId), eq(crmStates.legalEntityId, scope.legalEntityId)))
    .limit(1)
    .pipe(Effect.mapError(searchUnavailable));
  const [row] = rows;
  if (row === undefined) {
    return initialCrmState;
  }
  if (row.tenantId !== scope.tenantId || row.legalEntityId !== scope.legalEntityId) {
    return yield* searchUnavailable();
  }
  const state = yield* Schema.decodeUnknownEffect(CrmStateSchema)(withDefaultSlices(row.state)).pipe(
    Effect.mapError(searchUnavailable),
  );
  return qualifyCrmSearchState(state, predicate);
});
export interface CrmSearchServices {
  readonly load: (predicate: ListAccessPredicate) => Effect.Effect<CrmState, ReturnType<typeof searchUnavailable>>;
}
export const makeCrmSearchServices: ReadServiceFactory<CrmSearchServices> = (transaction, scope) =>
  Effect.succeed({ load: (predicate) => loadCrmSearchRecords(transaction, scope, predicate) });
