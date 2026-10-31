import { sql } from 'drizzle-orm';
import type { SQL, SQLWrapper } from 'drizzle-orm';

/** Module-neutral input; the owning read validates its public request before constructing SQL. */
export interface AgentHistoryPageRequest {
  readonly agentPrincipalId?: string;
  readonly batchKey?: string;
  readonly cursor?: { readonly at: string; readonly id: string };
  readonly kind?: string;
  readonly mode: 'queue' | 'activity';
  readonly pendingOnly?: boolean;
}

/** Owner-local JSONB history projection. The complete aggregate never crosses the database boundary. */
export const agentHistoryPageSql = (source: SQLWrapper, appId: string, request: AgentHistoryPageRequest): SQL => {
  const { cursor } = request;
  const before = (at: SQL, id: SQL) =>
    cursor === undefined
      ? sql`true`
      : sql`(date_trunc('milliseconds', (${at})::timestamptz), (${id}) collate "C") < (${cursor.at}::timestamptz, ${cursor.id} collate "C")`;
  const batchKey = sql`'legacy:' || ${appId} || ':' || (b->>'id')`;
  const agent =
    request.agentPrincipalId === undefined ? sql`true` : sql`b->>'agentPrincipalId' = ${request.agentPrincipalId}`;
  const target = request.batchKey === undefined ? sql`true` : sql`${batchKey} = ${request.batchKey}`;
  const pending =
    request.pendingOnly === true
      ? sql`exists (select 1 from jsonb_array_elements(coalesce(s.v->'changes', '[]'::jsonb)) c where c->>'batchId' = b->>'id' and c->>'status' = 'pending')`
      : sql`true`;
  const page = 31;
  if (request.mode === 'queue') {
    return sql`(with s as (select coalesce(${source}, '{}'::jsonb) v),
      selected as (select b from s, jsonb_array_elements(coalesce(s.v->'batches', '[]'::jsonb)) b
        where ${agent} and ${target} and ${pending} and ${before(sql`b->>'createdAt'`, batchKey)}
        order by date_trunc('milliseconds', (b->>'createdAt')::timestamptz) desc, (${batchKey}) collate "C" desc limit ${page}),
      changes as (select c from s, jsonb_array_elements(coalesce(s.v->'changes', '[]'::jsonb)) c
        where c->>'batchId' in (select b->>'id' from selected) order by c->>'id' limit ${page * 50})
      select jsonb_build_object('batches', coalesce((select jsonb_agg(b) from selected), '[]'::jsonb),
        'changes', coalesce((select jsonb_agg(c) from changes), '[]'::jsonb), 'log', '[]'::jsonb))`;
  }
  const eventKey = (prefix: string) => sql`${prefix} || ':legacy:' || ${appId} || ':' || (c->>'id')`;
  const proposal = request.kind === undefined || request.kind === 'proposal';
  const decision = request.kind === undefined || request.kind === 'decision';
  return sql`(with s as (select coalesce(${source}, '{}'::jsonb) v),
    candidates as (select c, e.at, e.id from s,
      jsonb_array_elements(coalesce(s.v->'changes', '[]'::jsonb)) c
      join lateral (select b from jsonb_array_elements(coalesce(s.v->'batches', '[]'::jsonb)) b
        where b->>'id' = c->>'batchId' and ${agent} limit 1) owner on true
      join lateral (select at, id from (values
        (case when ${proposal} then c->>'proposedAt' end, ${eventKey('proposal')}),
        (case when ${decision} and c->>'status' <> 'pending' then c->>'decidedAt' end, ${eventKey('decision')}),
        (case when ${decision} then c->>'revertedAt' end, ${eventKey('revert')})
      ) events(at, id) where at is not null and ${before(sql`at`, sql`id`)}
        order by date_trunc('milliseconds', at::timestamptz) desc, id collate "C" desc limit 1) e on true
      order by date_trunc('milliseconds', e.at::timestamptz) desc, e.id collate "C" desc limit ${page}),
    selected as (select b from s, jsonb_array_elements(coalesce(s.v->'batches', '[]'::jsonb)) b
      where b->>'id' in (select c->>'batchId' from candidates) limit ${page}),
    logs as (select l from s, jsonb_array_elements(coalesce(s.v->'log', '[]'::jsonb)) l
      where l->>'action' = 'proposed' and l->>'changeId' in (select c->>'id' from candidates) limit ${page})
    select jsonb_build_object('batches', coalesce((select jsonb_agg(b) from selected), '[]'::jsonb),
      'changes', coalesce((select jsonb_agg(c) from candidates), '[]'::jsonb),
      'log', coalesce((select jsonb_agg(l) from logs), '[]'::jsonb)))`;
};
