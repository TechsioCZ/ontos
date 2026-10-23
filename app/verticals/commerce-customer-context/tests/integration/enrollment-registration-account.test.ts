import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import {
  ENROLLMENT_TEST_COMPOSITION_REVISION,
  installEnrollmentTestAuthority,
} from '../support/enrollment-composition-authority.ts';

/** All DDL and fixture data are rolled back, including when an assertion fails. */
it.live('persists immutable credential-free registration and admits only exact live scoped account bindings', () =>
  Effect.scoped(
    Effect.gen(function* registrationAccountAcceptance() {
      yield* installEnrollmentTestAuthority(ENROLLMENT_TEST_COMPOSITION_REVISION);
      const connections = yield* loadDatabaseConnectionPair();
      const client = yield* makeTestPgClient(connections.admin.connectionString);
      const admin = yield* makeTestDatabaseFromClient(client, commerceCustomerContextRelations);
      const tenantId = randomUUID();
      const legalEntityId = randomUUID();
      const attemptId = randomUUID();
      const partyId = randomUUID();
      const bindingId = randomUUID();
      const authBindingId = randomUUID();
      const profileId = randomUUID();
      const principalId = randomUUID();
      const subject = `provider-registration-${randomUUID()}`;
      const registration = JSON.stringify({
        displayName: 'Real Customer',
        email: 'real@example.test',
        phone: '+420777123456',
      });
      const rollback = new Error('registration acceptance rollback');
      yield* admin
        .transaction((transaction) =>
          Effect.gen(function* registrationTransaction() {
            const execute = (statement: Parameters<typeof transaction.execute>[0]) =>
              transaction.execute(statement, 'objects');
            const existing = yield* execute(
              sql`select exists(select 1 from information_schema.columns where table_schema = 'commerce_customer_context' and table_name = 'portal_enrollment_attempts' and column_name = 'retail_registration') as installed`,
            );
            if (
              !Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ installed: Schema.Boolean })))(existing)[0]
                ?.installed
            ) {
              const migration = readFileSync(
                new URL('../../drizzle/20261023123000_retail-enrollment-registration/migration.sql', import.meta.url),
                'utf-8',
              );
              for (const statement of migration.split('--> statement-breakpoint')) {
                yield* execute(sql.raw(statement));
              }
            }
            const authorityMigration = readFileSync(
              new URL('../../drizzle/20261023230000_current-customer-authority/migration.sql', import.meta.url),
              'utf-8',
            );
            for (const statement of authorityMigration.split('--> statement-breakpoint')) {
              yield* execute(sql.raw(statement));
            }
            yield* execute(
              sql`select set_config('ontos.tenant_id', ${tenantId}, true), set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
            );
            yield* execute(sql`insert into commerce_customer_context.portal_enrollment_attempts
        (portal_enrollment_attempt_id, tenant_id, target_legal_entity_id, journey, intent_key, intent_digest, composition_revision, created_by_principal_id, state, authentication_namespace_id, subject_type, provider_subject_id)
        values (${attemptId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, 'RETAIL_SELF_ENROLLMENT', ${attemptId}, ${'a'.repeat(64)}, ${ENROLLMENT_TEST_COMPOSITION_REVISION}, ${principalId}::uuid, 'COMPLETE', 'ontos.commerce.portal.better-auth.v1', 'user', ${subject})`);
            yield* execute(
              sql`insert into commerce_customer_context.customer_profiles (customer_profile_id, tenant_id, legal_entity_id, profile_kind) values (${profileId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, 'RETAIL')`,
            );
            yield* execute(
              sql`insert into commerce_customer_context.retail_customer_profiles (retail_customer_profile_id, tenant_id, legal_entity_id, party_resource_id) values (${profileId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, ${partyId})`,
            );
            yield* execute(sql`insert into commerce_customer_context.retail_portal_profile_bindings
        (retail_portal_profile_binding_id, tenant_id, legal_entity_id, auth_binding_id, principal_id, retail_customer_profile_id, enrollment_evidence_ref, action_invocation_id, actor_principal_id)
        values (${bindingId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, ${authBindingId}::uuid, ${principalId}::uuid, ${profileId}::uuid, 'registration-acceptance', ${randomUUID()}::uuid, ${principalId}::uuid)`);
            for (const operation of [
              { owner: 'party.registry', result: partyId, transition: 'party.candidate.submit' },
              { owner: 'core.identity', result: authBindingId, transition: 'core.principal-binding.activate' },
              {
                owner: 'commerce.customer-context',
                result: bindingId,
                transition: 'commerce.customer-context.bind-retail-portal-profile',
              },
            ]) {
              yield* execute(sql`insert into commerce_customer_context.portal_enrollment_owner_operations
        (tenant_id, portal_enrollment_attempt_id, owner_module_key, transition_key, owner_invocation_id, request_digest, actor_principal_id, status, completed_at, result_reference)
        values (${tenantId}::uuid, ${attemptId}::uuid, ${operation.owner}, ${operation.transition}, ${randomUUID()}::uuid, ${'b'.repeat(64)}, ${principalId}::uuid, 'SUCCEEDED', now(), ${operation.result})`);
            }
            yield* execute(sql`set local role ontos_runtime`);
            const write = (body: string) =>
              execute(
                sql`select * from commerce_customer_context.write_retail_enrollment_registration(${tenantId}::uuid, ${attemptId}::uuid, ${body})`,
              );
            yield* write(registration);
            yield* write(registration);
            const stored = yield* execute(
              sql`select * from commerce_customer_context.read_retail_enrollment_registration(${tenantId}::uuid, ${attemptId}::uuid)`,
            );
            expect(stored).toEqual([{ registration: JSON.parse(registration) }]);
            yield* execute(sql`savepoint changed_registration`);
            const changedRegistration = yield* write(
              JSON.stringify({ displayName: 'Changed Customer', email: 'real@example.test' }),
            ).pipe(Effect.result);
            yield* execute(sql`rollback to savepoint changed_registration`);
            expect(Result.isFailure(changedRegistration)).toBe(true);
            yield* execute(sql`savepoint credential_registration`);
            const credentialRegistration = yield* write(
              JSON.stringify({ displayName: 'Real Customer', email: 'real@example.test', password: randomUUID() }),
            ).pipe(Effect.result);
            yield* execute(sql`rollback to savepoint credential_registration`);
            expect(Result.isFailure(credentialRegistration)).toBe(true);
            const account = (
              lookupTenant = tenantId,
              lookupLegalEntity = legalEntityId,
              lookupSubject = subject,
              lookupPrincipal = principalId,
              lookupBinding = authBindingId,
            ) =>
              execute(
                sql`select * from commerce_customer_context.read_retail_enrollment_account_party(${lookupTenant}::uuid, ${lookupLegalEntity}::uuid, ${lookupSubject}, ${lookupPrincipal}::uuid, ${lookupBinding}::uuid)`,
              );
            expect(yield* account()).toEqual([{ party_id: partyId, profile_id: profileId }]);
            expect(yield* account(tenantId, legalEntityId, 'unknown-provider-subject')).toEqual([]);
            expect(yield* account(tenantId, legalEntityId, subject, randomUUID())).toEqual([]);
            expect(yield* account(tenantId, legalEntityId, subject, principalId, randomUUID())).toEqual([]);
            for (const wrong of [
              { entity: legalEntityId, tenant: randomUUID() },
              { entity: randomUUID(), tenant: tenantId },
            ]) {
              yield* execute(sql`savepoint account_scope`);
              const result = yield* account(wrong.tenant, wrong.entity).pipe(Effect.result);
              yield* execute(sql`rollback to savepoint account_scope`);
              expect(Result.isFailure(result)).toBe(true);
            }
            yield* execute(sql`select set_config('ontos.legal_entity_id', ${randomUUID()}, true)`);
            expect(
              yield* execute(
                sql`select * from commerce_customer_context.read_retail_enrollment_registration(${tenantId}::uuid, ${attemptId}::uuid)`,
              ),
            ).toEqual([]);
            yield* execute(sql`savepoint foreign_registration`);
            const foreignRegistration = yield* write(registration).pipe(Effect.result);
            yield* execute(sql`rollback to savepoint foreign_registration`);
            expect(Result.isFailure(foreignRegistration)).toBe(true);
            yield* execute(sql`select set_config('ontos.legal_entity_id', ${legalEntityId}, true)`);
            yield* execute(sql`reset role`);
            for (const state of ['PENDING_REVOKE', 'REVOKED', 'RECONCILIATION_REQUIRED']) {
              yield* execute(
                sql`update commerce_customer_context.retail_portal_profile_bindings set authorization_state = ${state} where retail_portal_profile_binding_id = ${bindingId}::uuid`,
              );
              yield* execute(sql`set local role ontos_runtime`);
              expect(yield* account()).toEqual([]);
              yield* execute(sql`reset role`);
            }
            yield* execute(
              sql`update commerce_customer_context.retail_portal_profile_bindings set authorization_state = 'ACTIVE' where retail_portal_profile_binding_id = ${bindingId}::uuid`,
            );
            yield* execute(
              sql`update commerce_customer_context.customer_profiles set lifecycle = 'SUSPENDED' where customer_profile_id = ${profileId}::uuid`,
            );
            yield* execute(sql`set local role ontos_runtime`);
            expect(yield* account()).toEqual([]);
            yield* execute(sql`reset role`);
            yield* execute(
              sql`update commerce_customer_context.customer_profiles set lifecycle = 'ACTIVE' where customer_profile_id = ${profileId}::uuid`,
            );
            yield* execute(
              sql`update commerce_customer_context.portal_enrollment_attempts set state = 'IN_PROGRESS' where portal_enrollment_attempt_id = ${attemptId}::uuid`,
            );
            yield* execute(sql`set local role ontos_runtime`);
            expect(yield* account()).toEqual([]);
            return yield* Effect.fail(rollback);
          }),
        )
        .pipe(
          Effect.catchIf(
            (failure) => failure === rollback,
            () => Effect.void,
          ),
        );
    }),
  ),
);
