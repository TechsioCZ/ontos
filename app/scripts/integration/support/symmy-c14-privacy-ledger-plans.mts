import type { PgClient } from '@effect/sql-pg';
import { Effect, Schema } from 'effect';
import { expect } from 'effect-rstest';

interface PlanRow {
  readonly 'QUERY PLAN': string;
}

/**
 * On the disposable C14 database only: copy the installed indexes, not customer data. 32,768 source identities, 512
 * routes with 64 ended grants apiece, and 32,768 source bindings of as many Commerce profiles.
 */
export const verifySourceLedgerPlans = (admin: PgClient.PgClient, tenantId: string, legalEntityId: string) =>
  admin.withTransaction(
    Effect.gen(function* plans() {
      yield* admin`create temporary table admission_plan_fixture (like privacy.source_processing_admissions including indexes) on commit drop`;
      yield* admin`create temporary table route_plan_fixture (like privacy.source_processing_authorizations including indexes) on commit drop`;
      yield* admin`insert into admission_plan_fixture(tenant_id,legal_entity_id,authorization_id,first_admitted_at,last_action_invocation_id,last_admitted_at,privacy_subject_id,role,source_identity_key,source_record) select ${tenantId},${legalEntityId},gen_random_uuid(),now(),gen_random_uuid(),now(),gen_random_uuid(),'SUBJECT','source:'||n,'{}'::jsonb from generate_series(1,32768) n`;
      yield* admin`insert into route_plan_fixture(tenant_id,legal_entity_id,authorization_id,authorization_record,created_at,created_by_action_invocation_id,lifecycle,recorded_at,revision,source_issuer,source_namespace,source_route_ref) select ${tenantId},${legalEntityId},gen_random_uuid(),'{}'::jsonb,now(),gen_random_uuid(),'ENDED',now(),2,'erp','customers','route:'||(n%512) from generate_series(1,32768) n`;
      yield* admin`create temporary table binding_plan_fixture (like commerce_customer_context.customer_profile_source_bindings including indexes) on commit drop`;
      yield* admin`insert into binding_plan_fixture(tenant_id,legal_entity_id,issuer,namespace,record_type,record_id,customer_profile_id,profile_kind,party_resource_id,source_order,source_revision,source_occurrence_id,source_intent,recorded_at) select ${tenantId},${legalEntityId},'erp','customers','customer','record:'||n,gen_random_uuid(),'RETAIL',gen_random_uuid()::text,1,'r1','occurrence:'||n,'{}'::jsonb,now() from generate_series(1,32768) n`;
      yield* admin`create temporary table subject_plan_fixture (like privacy.privacy_subjects including indexes including defaults) on commit drop`;
      yield* admin`insert into subject_plan_fixture(tenant_id,legal_entity_id,subject_kind,subject_record) select ${tenantId},${legalEntityId},'DATA_SUBJECT',jsonb_build_object('subject',jsonb_build_object('partyRef',jsonb_build_object('resourceId','party:'||n))) from generate_series(1,32768) n`;
      yield* admin`analyze subject_plan_fixture`;
      yield* admin`analyze binding_plan_fixture`;
      yield* admin`analyze admission_plan_fixture`;
      yield* admin`analyze route_plan_fixture`;
      const admissions =
        yield* admin<PlanRow>`explain (analyze,buffers) select privacy_subject_id from admission_plan_fixture where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and source_identity_key in ('source:21000','source:24500')`;
      const history =
        yield* admin<PlanRow>`explain (analyze,buffers) select authorization_record from route_plan_fixture where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and source_issuer='erp' and source_namespace='customers' and source_route_ref='route:255'`;
      // The owner proof of one profile reads every binding of that profile, as read_source_profile_subject does.
      const bindings =
        yield* admin<PlanRow>`explain (analyze,buffers) select record_id from binding_plan_fixture where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and customer_profile_id=(select customer_profile_id from binding_plan_fixture where record_id='record:21000') and profile_kind='RETAIL' order by recorded_at,issuer,namespace,record_type,record_id`;
      const subjects =
        yield* admin<PlanRow>`explain (analyze,buffers) select subject_record from subject_plan_fixture where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and subject_kind='DATA_SUBJECT' and subject_record->'subject'->'partyRef'->>'resourceId'='party:21000' limit 2`;
      for (const [result, column] of [
        [admissions, 'source_identity_key'],
        [history, 'source_route_ref'],
        [bindings, 'customer_profile_id'],
        [subjects, 'partyRef'],
      ] as const) {
        const lines = result.map((row) => row['QUERY PLAN']);
        expect(
          lines.some((line) => line.includes('Index Cond:') && line.includes(column)),
          lines.join('\n'),
        ).toBe(true);
        yield* Effect.logInfo({ lookup: column, plan: lines });
      }
    }),
  );

/** Explain Party's committedPersonReference receipt correlation on real native fixture rows, after filling the page.
 * The page timing is the runtime-role measurement; this isolated admin plan only explains where query time goes. */
export const measurePartyReceiptCorrelation = Effect.fn('C14.measurePartyReceiptCorrelation')(function* measure(
  admin: PgClient.PgClient,
  tenantId: string,
  legalEntityId: string,
  recordId: string,
  source: {
    readonly issuer: string;
    readonly namespace: string;
    readonly recordType: string;
    readonly routeRef: string;
  },
) {
  const plan = yield* admin<{
    readonly 'QUERY PLAN': unknown;
  }>`explain (analyze, buffers, format json) select d.party_id, min(d.match_decision_id::text)
    from party.party_match_decisions d join party.party_create_source_receipts r
      on r.tenant_id=d.tenant_id and r.action_invocation_id=d.action_invocation_id and r.match_decision_id=d.match_decision_id
    where d.tenant_id=${tenantId} and r.legal_entity_id=${legalEntityId} and d.outcome in ('CREATED','MATCHED')
      and d.evidence_evaluation->'evidence' @> jsonb_build_array(jsonb_build_object('kind','CLIENT_SOURCE_ASSERTION',
        'recordId',${recordId}::text,'source',jsonb_build_object('issuer',${source.issuer}::text,'namespace',${source.namespace}::text,
          'recordType',${source.recordType}::text,'routeRef',${source.routeRef}::text))) group by d.party_id limit 2`;
  const [measurement] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([
      Schema.Struct({
        'Execution Time': Schema.Number,
        Plan: Schema.Struct({
          'Actual Rows': Schema.Number,
          'Shared Hit Blocks': Schema.Number,
          'Shared Read Blocks': Schema.Number,
        }),
      }),
    ]),
  )(plan[0]?.['QUERY PLAN']);
  // An empty or ambiguous owner lookup is not a receipt benchmark.
  expect(measurement.Plan['Actual Rows']).toBe(1);
  // This is the isolated synthetic fixture only. Keep the plan nodes so slow correlation can be distinguished
  // from page transport; the numeric empty/ambiguous guard above is independent of PostgreSQL's text format.
  yield* Effect.logInfo({ lookup: 'party-receipt-correlation', plan: plan[0]?.['QUERY PLAN'] });
});
