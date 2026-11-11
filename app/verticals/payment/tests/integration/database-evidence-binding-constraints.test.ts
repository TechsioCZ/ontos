import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  COMPOSITION_REVISION,
  expectSqlFailure,
  inScope,
  makeTestScope,
  newPaymentInput,
  paymentTestRelations,
  withPersistence,
} from './database-fixture.ts';

/**
 * PostgreSQL itself refuses rows that would lose the evidence these rules depend on, whatever writes
 * them: a Payment without its purchasing context (#1149 "scoped to the exact unchanged purchase"), a
 * source authority revision without bound submitter principals (#1153) and an accepted SOURCE_CORRECTION
 * without its recorded effect on the Current interpretation (#1151/#1152).
 */
it.live('#1149 #1151 #1153 Payment evidence the rules depend on is required by the database', () =>
  Effect.scoped(
    Effect.gen(function* requiredEvidence() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const created = yield* withPersistence(runtime, scope, (persistence) =>
        newPaymentInput(scope).pipe(Effect.flatMap((input) => persistence.insertPayment(input))),
      );
      expect(created.record.purchasingContext.subject.kind).toBe('PROFILE');
      const runtimeSql = (statement: string, parameters: readonly unknown[] = []) =>
        inScope(runtimeClient, scope, runtimeClient.unsafe(statement, [scope.tenantId, ...parameters]));

      // A Payment that does not keep the purchasing context it was created for.
      yield* expectSqlFailure(
        runtimeSql(
          `insert into payment.payments (tenant_id, legal_entity_id, action_invocation_id, actor_principal_id,
             composition_revision, aggregate_version, amount_minor, coverage_revision, created_at, currency,
             customer_configuration_id, execution_binding, intent_key, material_hash, method, payment_term_ref,
             purchase_correlation_id, term_semantic_evidence)
           select tenant_id, legal_entity_id, action_invocation_id, actor_principal_id, composition_revision, 1,
             amount_minor, 1, created_at, currency, customer_configuration_id, execution_binding,
             'intent-without-context', material_hash, method, payment_term_ref, 'purchase-without-context',
             term_semantic_evidence
           from payment.payments where tenant_id = $1`,
        ),
        '23502',
      );

      const authorityValues = `$1, $2, gen_random_uuid(), $3, '${COMPOSITION_REVISION}', 'gopay-account-1', now(),
        'production', 'GATEWAY_OUTCOME', null, 'Configured gateway outcome authority', false, 1, 'PAYMENT_GATEWAY',
        'GOPAY', 'ACTIVE'`;
      const authorityColumns = `tenant_id, legal_entity_id, action_invocation_id, actor_principal_id,
        composition_revision, account_ref, configured_at, environment, fact_family, method, reason, refund_route,
        revision, source_kind, source_system, status`;
      const revisionOf = (submitters: string) =>
        runtimeSql(
          `with authority as (
             insert into payment.source_authorities (${authorityColumns}) values (${authorityValues})
             returning *
           )
           insert into payment.source_authority_revisions (tenant_id, legal_entity_id, action_invocation_id,
             actor_principal_id, composition_revision, reason, recorded_at, refund_route, revision,
             source_authority_id, status, submitter_principal_ids)
           select tenant_id, legal_entity_id, action_invocation_id, actor_principal_id, composition_revision, reason,
             configured_at, refund_route, revision, source_authority_id, status, ${submitters}
           from authority`,
          [scope.legalEntityId, scope.principalId],
        );
      // A source authority revision that binds no submitting principal.
      yield* expectSqlFailure(revisionOf('null'), '23502');
      yield* expectSqlFailure(revisionOf(`'{}'::uuid[]`), '23514', 'payment_source_authority_revisions_submitters_ck');
      yield* expectSqlFailure(
        revisionOf(`array[$3::uuid, null]`),
        '23514',
        'payment_source_authority_revisions_submitters_ck',
      );
      yield* revisionOf('array[$3::uuid]');

      const correctionOf = (effect: string) =>
        runtimeSql(
          `with authority as (
             insert into payment.source_authorities (${authorityColumns}) values (${authorityValues.replace(
               "'gopay-account-1'",
               "'gopay-account-' || gen_random_uuid()",
             )})
             returning *
           )
           insert into payment.observations (tenant_id, legal_entity_id, action_invocation_id, actor_principal_id,
             composition_revision, acceptance_outcome, account_ref, correction_effect, environment, fact_family,
             fact_kind, payment_id, received_at, source_authority_id, source_authority_revision, source_kind,
             source_occurrence_id, source_revision, source_system, statement_hash, verified_at)
           select tenant_id, legal_entity_id, action_invocation_id, actor_principal_id, composition_revision,
             'ACCEPTED_OBSERVATION', account_ref, ${effect}, environment, fact_family, 'SOURCE_CORRECTION', $4::uuid,
             now(), source_authority_id, revision, source_kind, 'correction-' || gen_random_uuid(), 1, source_system,
             repeat('0', 64), now()
           from authority`,
          [scope.legalEntityId, scope.principalId, created.record.paymentId],
        );
      // An accepted correction that does not record what it did to the Current interpretation.
      yield* expectSqlFailure(correctionOf('null'), '23514', 'payment_observations_correction_effect_ck');
      yield* correctionOf(`'REOPEN_TO_CONFLICT'`);
    }),
  ),
);
