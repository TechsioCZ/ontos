import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Crypto, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import {
  ENROLLMENT_TEST_COMPOSITION_REVISION,
  installEnrollmentTestAuthority,
} from '../support/enrollment-composition-authority.ts';

/*
 * The portal admission (`CommerceCustomerAuthority.admit`) and the portal owner overlay decide which Party a session's
 * account reaches with the SAME owner function, `read_retail_enrollment_account_party`, given the same identity: the
 * provider subject of the live session and the Core principal and auth binding it resolves to (admit reads them from
 * Core; the overlay reads them from the facts the admitted session put in the operation). So for every enrollment
 * journey both answer what this function answers for that journey's completed state, on a real database:
 *   - retail self-enrollment (here): the account reaches its own Party;
 *   - counterparty invitation (here): a counterparty portal user is bound to no retail profile and reaches no Party
 *     through the retail session rule; both refuse it alike;
 *   - an existing provider account restarting a retail enrollment: `retail-enrollment-restart.test.ts` asks the same
 *     function over the real restart chain (predecessor retention and Core binding activation).
 * The answer is the same for the same identity, and nothing for any other subject, principal or binding.
 */

const randomId = Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4()));
const decodeAccountParty = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ party_id: Schema.String, profile_id: Schema.String })),
);

const JOURNEYS = [
  { journey: 'RETAIL_SELF_ENROLLMENT', provider: 'provider.account.create', retailBinding: true },
  { journey: 'COUNTERPARTY_INVITATION', provider: 'provider.account.create', retailBinding: false },
] as const;

it.live('admit and the portal overlay reach the same Party for every enrollment journey', () =>
  Effect.scoped(
    Effect.gen(function* journeys() {
      yield* installEnrollmentTestAuthority(ENROLLMENT_TEST_COMPOSITION_REVISION);
      const connections = yield* loadDatabaseConnectionPair();
      const client = yield* makeTestPgClient(connections.admin.connectionString);
      const admin = yield* makeTestDatabaseFromClient(client, commerceCustomerContextRelations);
      for (const journey of JOURNEYS) {
        const tenantId = yield* randomId;
        const legalEntityId = yield* randomId;
        const attemptId = yield* randomId;
        const partyId = yield* randomId;
        const bindingId = yield* randomId;
        const authBindingId = yield* randomId;
        const profileId = yield* randomId;
        const principalId = yield* randomId;
        const otherId = yield* randomId;
        const subject = `provider-journey-${yield* randomId}`;
        const rollback = new Error('journey rollback');
        yield* admin
          .transaction((transaction) => {
            const execute = (statement: Parameters<typeof transaction.execute>[0]) =>
              transaction.execute(statement, 'objects');
            return Effect.gen(function* journeyState() {
              yield* execute(
                sql`select set_config('ontos.tenant_id', ${tenantId}, true), set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
              );
              yield* execute(sql`insert into commerce_customer_context.portal_enrollment_attempts
        (portal_enrollment_attempt_id, tenant_id, target_legal_entity_id, journey, intent_key, intent_digest, composition_revision, created_by_principal_id, state, authentication_namespace_id, subject_type, provider_subject_id)
        values (${attemptId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, ${journey.journey}, ${attemptId}, ${'a'.repeat(64)}, ${ENROLLMENT_TEST_COMPOSITION_REVISION}, ${principalId}::uuid, 'COMPLETE', 'ontos.commerce.portal.better-auth.v1', 'user', ${subject})`);
              const operations: { owner: string; result: string; transition: string }[] = [
                { owner: 'party.registry', result: partyId, transition: 'party.candidate.submit' },
                { owner: 'commerce.portal-auth', result: subject, transition: journey.provider },
              ];
              if (journey.retailBinding) {
                yield* execute(
                  sql`insert into commerce_customer_context.customer_profiles (customer_profile_id, tenant_id, legal_entity_id, profile_kind) values (${profileId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, 'RETAIL')`,
                );
                yield* execute(
                  sql`insert into commerce_customer_context.retail_customer_profiles (retail_customer_profile_id, tenant_id, legal_entity_id, party_resource_id) values (${profileId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, ${partyId})`,
                );
                yield* execute(sql`insert into commerce_customer_context.retail_portal_profile_bindings
        (retail_portal_profile_binding_id, tenant_id, legal_entity_id, auth_binding_id, principal_id, retail_customer_profile_id, enrollment_evidence_ref, action_invocation_id, actor_principal_id)
        values (${bindingId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, ${authBindingId}::uuid, ${principalId}::uuid, ${profileId}::uuid, 'journey-acceptance', ${otherId}::uuid, ${principalId}::uuid)`);
                operations.push({
                  owner: 'commerce.customer-context',
                  result: bindingId,
                  transition: 'commerce.customer-context.bind-retail-portal-profile',
                });
              }
              for (const operation of operations) {
                yield* execute(sql`insert into commerce_customer_context.portal_enrollment_owner_operations
        (tenant_id, portal_enrollment_attempt_id, owner_module_key, transition_key, owner_invocation_id, request_digest, actor_principal_id, status, completed_at, result_reference)
        values (${tenantId}::uuid, ${attemptId}::uuid, ${operation.owner}, ${operation.transition}, ${yield* randomId}::uuid, ${'b'.repeat(64)}, ${principalId}::uuid, 'SUCCEEDED', now(), ${operation.result})`);
              }
              // As both callers ask it: under the runtime role, with the session's identity.
              yield* execute(sql`set local role ontos_runtime`);
              const account = (lookupSubject: string, lookupPrincipal: string, lookupBinding: string) =>
                execute(
                  sql`select * from commerce_customer_context.read_retail_enrollment_account_party(${tenantId}::uuid, ${legalEntityId}::uuid, ${lookupSubject}, ${lookupPrincipal}::uuid, ${lookupBinding}::uuid)`,
                ).pipe(Effect.map(decodeAccountParty));
              const answer = yield* account(subject, principalId, authBindingId);
              expect({ answer, journey: journey.journey }).toEqual({
                answer: journey.retailBinding ? [{ party_id: partyId, profile_id: profileId }] : [],
                journey: journey.journey,
              });
              // Another subject, principal or binding reaches nothing, whatever the journey.
              for (const other of [
                yield* account(`other-${subject}`, principalId, authBindingId),
                yield* account(subject, otherId, authBindingId),
                yield* account(subject, principalId, otherId),
              ]) {
                expect({ journey: journey.journey, other }).toEqual({ journey: journey.journey, other: [] });
              }
              return yield* Effect.fail(rollback);
            });
          })
          .pipe(
            Effect.catchIf(
              (failure) => failure === rollback,
              () => Effect.void,
            ),
          );
      }
    }),
  ).pipe(Effect.provide(commercePortalAuthPlatformCryptoLive)),
);
