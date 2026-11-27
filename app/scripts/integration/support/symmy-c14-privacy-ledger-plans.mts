import type { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import { expect } from 'effect-rstest';

/** On the disposable C14 database only: copy the installed indexes, not customer data. 32,768 source identities and 512 routes with 64 ended grants apiece. */
export const verifySourceLedgerPlans = (admin: PgClient.PgClient, tenantId: string, legalEntityId: string) =>
  admin.withTransaction(
    Effect.gen(function* plans() {
      yield* admin`create temporary table admission_plan_fixture (like privacy.source_processing_admissions including indexes) on commit drop`;
      yield* admin`create temporary table route_plan_fixture (like privacy.source_processing_authorizations including indexes) on commit drop`;
      yield* admin`insert into admission_plan_fixture(tenant_id,legal_entity_id,authorization_id,first_admitted_at,last_action_invocation_id,last_admitted_at,privacy_subject_id,role,source_identity_key,source_record) select ${tenantId},${legalEntityId},gen_random_uuid(),now(),gen_random_uuid(),now(),gen_random_uuid(),'SUBJECT','source:'||n,'{}'::jsonb from generate_series(1,32768) n`;
      yield* admin`insert into route_plan_fixture(tenant_id,legal_entity_id,authorization_id,authorization_record,created_at,created_by_action_invocation_id,lifecycle,recorded_at,revision,source_issuer,source_namespace,source_route_ref) select ${tenantId},${legalEntityId},gen_random_uuid(),'{}'::jsonb,now(),gen_random_uuid(),'ENDED',now(),2,'erp','customers','route:'||(n%512) from generate_series(1,32768) n`;
      yield* admin`analyze admission_plan_fixture`;
      yield* admin`analyze route_plan_fixture`;
      const admissions = yield* admin<{
        'QUERY PLAN': string;
      }>`explain (analyze,buffers) select privacy_subject_id from admission_plan_fixture where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and source_identity_key in ('source:21000','source:24500')`;
      const history = yield* admin<{
        'QUERY PLAN': string;
      }>`explain (analyze,buffers) select authorization_record from route_plan_fixture where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and source_issuer='erp' and source_namespace='customers' and source_route_ref='route:255'`;
      for (const [result, column] of [
        [admissions, 'source_identity_key'],
        [history, 'source_route_ref'],
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
