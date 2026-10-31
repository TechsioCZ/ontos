import { readFileSync } from 'node:fs';

import { loadDatabaseConnectionPair, scopedRoutineInvokerFromTransaction } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Crypto, Effect, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { EnrollmentPrincipalIdSchema, ReadEnrollmentAttemptInputSchema } from '../../shared/enrollment-contracts.ts';
import type { CommerceEnrollmentOwnerTransactionRun } from '../../src/enrollment/orchestration/owner-transition-production.ts';
import { enrollmentApplicationCompositionRevision } from '../support/enrollment-application-composition.ts';
import { makeEnrollmentContinuationHarness } from '../support/enrollment-continuation-harness.ts';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import { installEnrollmentTestAuthority } from '../support/enrollment-composition-authority.ts';
import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';

const randomId = Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4()));

it.live('fails only a proven required rejection and releases its original composition marker atomically', () =>
  Effect.scoped(
    Effect.gen(function* terminalFailureAcceptance() {
      const compositionRevision = yield* enrollmentApplicationCompositionRevision;
      yield* installEnrollmentTestAuthority(compositionRevision);
      const connections = yield* loadDatabaseConnectionPair();
      const client = yield* makeTestPgClient(connections.admin.connectionString);
      const admin = yield* makeTestDatabaseFromClient(client, commerceCustomerContextRelations);
      const tenantId = yield* randomId;
      const actorId = yield* randomId;
      const rollback = new Error('terminal failure acceptance rollback');
      yield* admin
        .transaction((transaction) =>
          Effect.gen(function* failureTransaction() {
            const execute = (statement: Parameters<typeof transaction.execute>[0]) =>
              transaction.execute(statement, 'objects');
            const migration = readFileSync(
              new URL('../../drizzle/20261024001000_enrollment-terminal-failure/migration.sql', import.meta.url),
              'utf-8',
            );
            for (const statement of migration.split('--> statement-breakpoint')) {
              yield* execute(sql.raw(statement));
            }
            yield* execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`);
            const attemptId = yield* randomId;
            const invocationId = yield* randomId;
            const owner = 'commerce.customer-context';
            const transition = 'commerce.customer-context.bind-retail-portal-profile';
            yield* execute(sql`insert into commerce_customer_context.portal_enrollment_attempts
        (portal_enrollment_attempt_id, tenant_id, journey, intent_key, intent_digest, composition_revision, created_by_principal_id)
        values (${attemptId}::uuid, ${tenantId}::uuid, 'RETAIL_SELF_ENROLLMENT', ${attemptId}, ${'a'.repeat(64)}, ${compositionRevision}, ${actorId}::uuid)`);
            const marker = `enrollment-attempt:${tenantId}:${attemptId}`;
            const markers = () =>
              execute(sql`select work_id from core.application_composition_durable_work where work_id = ${marker}`);
            const fail = (moduleKey = owner, transitionKey = transition, scope = tenantId) =>
              execute(
                sql`select * from commerce_customer_context.fail_portal_enrollment(${scope}::uuid, ${attemptId}::uuid, ${moduleKey}, ${transitionKey})`,
              );
            expect(yield* markers()).toEqual([{ work_id: marker }]);
            expect(yield* fail()).toEqual([{ failed: false }]);
            yield* execute(sql`savepoint unproven_failure`);
            const unproven = yield* execute(
              sql`update commerce_customer_context.portal_enrollment_attempts set state = 'FAILED' where portal_enrollment_attempt_id = ${attemptId}::uuid`,
            ).pipe(Effect.result);
            yield* execute(sql`rollback to savepoint unproven_failure`);
            expect(Result.isFailure(unproven)).toBe(true);
            yield* execute(sql`insert into commerce_customer_context.portal_enrollment_owner_operations
        (tenant_id, portal_enrollment_attempt_id, owner_module_key, transition_key, owner_invocation_id, request_digest, actor_principal_id, required, status, failure_code, failure_reason, outcome_code, completed_at)
        values (${tenantId}::uuid, ${attemptId}::uuid, ${owner}, 'optional.failure', ${yield* randomId}::uuid, ${'b'.repeat(64)}, ${actorId}::uuid, false, 'FAILED', 'owner_reconciliation_required', 'Owner decision pending', 'commerce_command_rejected', now())`);
            expect(yield* fail()).toEqual([{ failed: false }]);
            yield* execute(
              sql`update commerce_customer_context.portal_enrollment_owner_operations set failure_code = 'owner_rejected', failure_reason = 'The original Commerce Action was terminally rejected' where tenant_id = ${tenantId}::uuid and transition_key = 'optional.failure'`,
            );
            // Optional rejection cannot terminate a required journey.
            expect(yield* fail(owner, 'optional.failure')).toEqual([{ failed: false }]);
            yield* execute(sql`insert into commerce_customer_context.portal_enrollment_owner_operations
        (tenant_id, portal_enrollment_attempt_id, owner_module_key, transition_key, owner_invocation_id, request_digest, actor_principal_id, required, status, failure_code, failure_reason, outcome_code, completed_at)
        values (${tenantId}::uuid, ${attemptId}::uuid, ${owner}, ${transition}, ${invocationId}::uuid, ${'b'.repeat(64)}, ${actorId}::uuid, true, 'FAILED', 'owner_rejected', 'The original Commerce Action was terminally rejected', 'commerce_command_rejected', now())`);
            const unresolvedId = yield* randomId;
            yield* execute(sql`insert into commerce_customer_context.portal_enrollment_owner_operations
        (tenant_id, portal_enrollment_attempt_id, owner_module_key, transition_key, owner_invocation_id, request_digest, actor_principal_id, status, completed_at)
        values (${tenantId}::uuid, ${attemptId}::uuid, 'party.registry', 'party.candidate.submit', ${unresolvedId}::uuid, ${'c'.repeat(64)}, ${actorId}::uuid, 'INDETERMINATE', now())`);
            expect(yield* fail()).toEqual([{ failed: false }]);
            expect(yield* markers()).toEqual([{ work_id: marker }]);
            yield* execute(
              sql`update commerce_customer_context.portal_enrollment_owner_operations set status = 'SUCCEEDED', completed_at = now() where owner_invocation_id = ${unresolvedId}::uuid`,
            );
            yield* execute(
              sql`update commerce_customer_context.portal_enrollment_owner_operations set lease_owner = 'fixture-worker', lease_token = ${yield* randomId}::uuid, lease_expires_at = now() + interval '1 minute' where owner_invocation_id = ${invocationId}::uuid`,
            );
            expect(yield* fail()).toEqual([{ failed: false }]);
            expect(yield* markers()).toEqual([{ work_id: marker }]);
            yield* execute(
              sql`update commerce_customer_context.portal_enrollment_owner_operations set lease_owner = null, lease_token = null, lease_expires_at = null where owner_invocation_id = ${invocationId}::uuid`,
            );
            expect(yield* fail('another.owner')).toEqual([{ failed: false }]);
            expect(yield* fail(owner, 'another.transition')).toEqual([{ failed: false }]);
            yield* execute(sql`set local role ontos_runtime`);
            yield* execute(sql`savepoint foreign_failure`);
            const foreign = yield* fail(owner, transition, yield* randomId).pipe(Effect.result);
            yield* execute(sql`rollback to savepoint foreign_failure`);
            expect(Result.isFailure(foreign)).toBe(true);
            const input = yield* Schema.decodeEffect(ReadEnrollmentAttemptInputSchema)({
              portalEnrollmentAttemptId: attemptId,
              tenantId,
            });
            const run: CommerceEnrollmentOwnerTransactionRun = (scope, operation) =>
              operation(scopedRoutineInvokerFromTransaction(execute, scope));
            const harness = yield* makeEnrollmentContinuationHarness(run, () => Effect.die('No discovery is needed'), {
              actorPrincipalId: yield* Schema.decodeEffect(EnrollmentPrincipalIdSchema)(actorId),
              answers: {},
              subject: {
                partyCandidateDigest: 'd'.repeat(64),
                partyRef: Option.none(),
                portalEnrollmentAttemptId: input.portalEnrollmentAttemptId,
                principalRef: {
                  moduleId: 'core.identity',
                  resourceId: actorId,
                  resourceType: 'core.identity.principal',
                  tenantId: input.tenantId,
                },
                sellingLegalEntityRef: {
                  moduleId: 'core.identity',
                  resourceId: yield* randomId,
                  resourceType: 'core.identity.legal-entity',
                  tenantId: input.tenantId,
                },
              },
            });
            expect(yield* harness.continuation.advance(input)).toEqual({
              halt: { reason: 'ATTEMPT_TERMINAL', transition: Option.none() },
              outcome: 'HALTED',
            });
            expect(harness.owner.log).toEqual({ dispatched: [], reconciled: [] });
            const state = () =>
              execute(
                sql`select distinct state, revision, last_owner_invocation_id, last_failure_code, last_failure_reason from commerce_customer_context.read_portal_enrollment_attempt(${tenantId}::uuid, ${attemptId}::uuid)`,
              );
            const failed = yield* state();
            expect(failed).toEqual([
              {
                last_failure_code: 'commerce_command_rejected',
                last_failure_reason: 'The original Commerce Action was terminally rejected',
                last_owner_invocation_id: invocationId,
                revision: 2,
                state: 'FAILED',
              },
            ]);
            expect(yield* markers()).toEqual([]);
            expect(yield* fail()).toEqual([{ failed: true }]);
            expect(yield* state()).toEqual(failed);
            const terminalCalls = [
              sql`select distinct attempt_outcome from commerce_customer_context.claim_portal_enrollment_transition(${tenantId}::uuid, ${attemptId}::uuid, 2, 'fixture-worker', ${owner}, ${transition}, ${invocationId}::uuid, ${'b'.repeat(64)}, ${actorId}::uuid, true, 1000, null, null)`,
              sql`select distinct attempt_outcome from commerce_customer_context.record_portal_enrollment_outcome(${tenantId}::uuid, ${attemptId}::uuid, 2, 'fixture-worker', ${yield* randomId}::uuid, ${owner}, ${transition}, ${invocationId}::uuid, ${actorId}::uuid, 'SUCCEEDED', null, null, null, null, null, null, null, null)`,
              sql`select distinct attempt_outcome from commerce_customer_context.reconcile_portal_enrollment_outcome(${tenantId}::uuid, ${attemptId}::uuid, 2, ${owner}, ${transition}, ${invocationId}::uuid, ${yield* randomId}::uuid, ${actorId}::uuid, 'SUCCEEDED', null, null, null, null, null, null, null, null)`,
            ];
            for (const call of terminalCalls) {
              expect(yield* execute(call)).toEqual([{ attempt_outcome: 'TERMINAL' }]);
            }
            expect(
              yield* execute(
                sql`select distinct attempt_outcome from commerce_customer_context.terminate_portal_enrollment(${tenantId}::uuid, ${attemptId}::uuid, 2, ${yield* randomId}::uuid, ${actorId}::uuid, 'Cannot overwrite a failed enrollment')`,
              ),
            ).toEqual([{ attempt_outcome: 'ALREADY_TERMINAL' }]);
            expect(yield* harness.continuation.advance(input)).toEqual({
              halt: { reason: 'ATTEMPT_TERMINAL', transition: Option.none() },
              outcome: 'HALTED',
            });
            expect(yield* state()).toEqual(failed);
            // Even an administrator cannot accidentally resurrect a failed Attempt through ordinary DML.
            yield* execute(sql`reset role`);
            yield* execute(sql`savepoint resurrection`);
            const resurrection = yield* execute(
              sql`update commerce_customer_context.portal_enrollment_attempts set state = 'IN_PROGRESS' where portal_enrollment_attempt_id = ${attemptId}::uuid`,
            ).pipe(Effect.result);
            yield* execute(sql`rollback to savepoint resurrection`);
            expect(Result.isFailure(resurrection)).toBe(true);
            return yield* Effect.fail(rollback);
          }),
        )
        .pipe(Effect.catch((error) => (error === rollback ? Effect.void : Effect.fail(error))));
    }),
  ).pipe(Effect.provide(commercePortalAuthPlatformCryptoLive)),
);
