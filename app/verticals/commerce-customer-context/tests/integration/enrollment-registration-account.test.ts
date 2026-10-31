import { readFileSync } from 'node:fs';

import { v1 } from '@authzed/authzed-node';
import {
  BusinessPermissionCodeSchema,
  ContextAccessLive,
  loadDatabaseConnectionPair,
  toBusinessPermissionAccessObjectId,
} from '@app/core-runtime';
import { GatewayAssertionRedemptionService } from '@app/core-runtime/auth/gateway-assertion-redemption';
import { ResolveExternalSubjectResultSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { GatewayPrincipalVerifierLive } from '@app/gateway-principal-verifier/server';
import { ExternalIdentityClient } from '@app/shared-contracts/server/external-identity-client';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { eq, sql } from 'drizzle-orm';
import { Crypto, Config, Context, Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import { loadSpiceDbConfig } from '../../../../packages/core-runtime/src/permissions/config.ts';
import { newSpiceDbGrpcClient } from '../../../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { CommercePortalAuthEnrollmentStartInputSchema } from '../../api/portal-auth/enrollment/contracts.ts';
import { commercePortalAuthEnrollmentAccountCreationOutcome } from '../../api/portal-auth/enrollment/http.ts';
import {
  commercePortalAuthEnrollmentAccountCreationClaim,
  commercePortalAuthEnrollmentIntent,
} from '../../api/portal-auth/enrollment/intent.ts';
import { CommerceCoreIdentityClientConfig } from '../../api/portal-auth/provider/core-identity-client-config.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import {
  makeCommercePortalAuth,
  COMMERCE_PORTAL_ACCOUNT_CORRELATION_HEADERS,
} from '../../api/portal-auth/provider/auth.ts';
import { CommercePortalAuthAccountLookupService } from '../../api/portal-auth/provider/account-lookup-service.ts';
import { CommercePortalAuthRecoveryRateLimitService } from '../../api/portal-auth/rate-limit-service.ts';
import { commerceCustomerAuthorityLive } from '../../api/portal-auth/session/customer-authority.ts';
import { CommercePortalAuthService, portalAuthSessionApiLive } from '../../api/portal-auth/session/http.ts';
import {
  CommercePortalAuthSessionLifecycle,
  makeCommercePortalAuthSessionLifecycle,
} from '../../api/portal-auth/session/lifecycle.ts';
import { makeCommercePortalAuthSessionProvider } from '../../api/portal-auth/session/provider.ts';
import { CommercePortalAuthAudit, unauditedCommercePortalAuthRecorder } from '../../src/portal-auth/audit/audit.ts';
import {
  makeCommercePortalAuthDatabase,
  CommercePortalAuthDatabase,
} from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { CommercePortalAuthAccountLookupLive } from '../../src/portal-auth/persistence/portal-auth-account-lookup.ts';
import { makeCommercePortalAuthSessionStore } from '../../src/portal-auth/persistence/portal-auth-session-store.ts';
import { user, verification } from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import {
  CommerceEnrollmentContinuation,
  CommerceEnrollmentContinuationLive,
} from '../../src/enrollment/continuation/enrollment-continuation.ts';
import {
  CommerceEnrollmentOwnerEffectRegistry,
  retailEnrollmentVerificationRequired,
} from '../../src/enrollment/orchestration/owner-effect-registry.ts';
import { CommerceEnrollmentOwnerTransactionRunner } from '../../src/enrollment/orchestration/owner-transition-production.ts';
import { CommerceEnrollmentPreparationSubjectResolver } from '../../src/enrollment/orchestration/preparation-subject.ts';
import { commerceEnrollmentAttemptPersistenceForTransaction } from '../../src/enrollment/attempts/attempt-persistence.ts';
import {
  BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  RETAIL_CUSTOMER_DIRECTORY_TRANSITION_KEY,
  retailPartyCandidateDigest,
} from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import {
  ClaimEnrollmentTransitionInputSchema,
  EnrollmentActionInvocationIdSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
  enrollmentDigest,
} from '../../shared/enrollment-contracts.ts';
import { CommercePortalAuthSessionApi } from '../../shared/portal-auth/session-api.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import {
  makeEnrollmentAcceptanceFixture,
  startEnrollmentAcceptanceAttempt,
} from '../support/enrollment-acceptance-fixture.ts';
import { enrollmentAcceptanceScriptedOwner } from '../support/enrollment-acceptance-owner-script.ts';
import {
  enrollmentApplicationCompositionLayer,
  enrollmentApplicationCompositionRevision,
} from '../support/enrollment-application-composition.ts';
import {
  issueAcceptanceGatewayAssertion,
  makeAcceptanceGatewayIssuer,
} from '../support/enrollment-acceptance-identity-gateway-assertion.ts';
import {
  ENROLLMENT_TEST_COMPOSITION_REVISION,
  installEnrollmentTestAuthority,
} from '../support/enrollment-composition-authority.ts';
import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';

const randomId = Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4()));

/** All DDL and fixture data are rolled back, including when an assertion fails. */
it.live('persists immutable credential-free registration and admits only exact live scoped account bindings', () =>
  Effect.scoped(
    Effect.gen(function* registrationAccountAcceptance() {
      yield* installEnrollmentTestAuthority(ENROLLMENT_TEST_COMPOSITION_REVISION);
      const connections = yield* loadDatabaseConnectionPair();
      const client = yield* makeTestPgClient(connections.admin.connectionString);
      const admin = yield* makeTestDatabaseFromClient(client, commerceCustomerContextRelations);
      const tenantId = yield* randomId;
      const legalEntityId = yield* randomId;
      const attemptId = yield* randomId;
      const partyId = yield* randomId;
      const bindingId = yield* randomId;
      const authBindingId = yield* randomId;
      const profileId = yield* randomId;
      const principalId = yield* randomId;
      const subject = `provider-registration-${yield* randomId}`;
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
              new URL(
                '../../drizzle/20261023233000_retail-enrollment-binding-authority/migration.sql',
                import.meta.url,
              ),
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
        values (${bindingId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, ${authBindingId}::uuid, ${principalId}::uuid, ${profileId}::uuid, 'registration-acceptance', ${yield* randomId}::uuid, ${principalId}::uuid)`);
            for (const operation of [
              { owner: 'party.registry', result: partyId, transition: 'party.candidate.submit' },
              { owner: 'commerce.portal-auth', result: subject, transition: 'provider.account.create' },
              {
                owner: 'commerce.customer-context',
                result: bindingId,
                transition: 'commerce.customer-context.bind-retail-portal-profile',
              },
            ]) {
              yield* execute(sql`insert into commerce_customer_context.portal_enrollment_owner_operations
        (tenant_id, portal_enrollment_attempt_id, owner_module_key, transition_key, owner_invocation_id, request_digest, actor_principal_id, status, completed_at, result_reference)
        values (${tenantId}::uuid, ${attemptId}::uuid, ${operation.owner}, ${operation.transition}, ${yield* randomId}::uuid, ${'b'.repeat(64)}, ${principalId}::uuid, 'SUCCEEDED', now(), ${operation.result})`);
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
              JSON.stringify({ displayName: 'Real Customer', email: 'real@example.test', password: yield* randomId }),
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
            expect(yield* account(tenantId, legalEntityId, subject, yield* randomId)).toEqual([]);
            expect(yield* account(tenantId, legalEntityId, subject, principalId, yield* randomId)).toEqual([]);
            for (const wrong of [
              { entity: legalEntityId, tenant: yield* randomId },
              { entity: yield* randomId, tenant: tenantId },
            ]) {
              yield* execute(sql`savepoint account_scope`);
              const result = yield* account(wrong.tenant, wrong.entity).pipe(Effect.result);
              yield* execute(sql`rollback to savepoint account_scope`);
              expect(Result.isFailure(result)).toBe(true);
            }
            yield* execute(sql`select set_config('ontos.legal_entity_id', ${yield* randomId}, true)`);
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
  ).pipe(Effect.provide(commercePortalAuthPlatformCryptoLive)),
);

const unusedAccountMutation = () => Effect.die('Account admission may only resolve the presented provider session');

/** Real provider, native park/wake/journal/mapping and native permission checks; only remote owners are scripted. */
it.live('admits the new provider account immediately after verification and one parked enrollment resume', () =>
  Effect.scoped(
    Effect.gen(function* immediatelyAdmitsVerifiedEnrollment() {
      const origin = 'http://localhost:3020';
      const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)(yield* randomId);
      const legalEntityId = yield* randomId;
      const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)(yield* randomId);
      const principalId = yield* randomId;
      const authBindingId = yield* randomId;
      const partyId = yield* randomId;
      const profileId = yield* randomId;
      const bindingId = yield* randomId;
      const email = `enrollment-account-${yield* randomId}@example.test`;
      const password = Redacted.make(yield* randomId);
      const fixture = yield* makeEnrollmentAcceptanceFixture(
        { legalEntityId, tenantId },
        yield* enrollmentApplicationCompositionRevision,
      );
      const configuration = yield* parseCommercePortalAuthConfig({
        COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(yield* Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL')),
        COMMERCE_PORTAL_AUTH_SECRET: 'a'.repeat(64),
        COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: origin,
        COMMERCE_PORTAL_AUTH_URL: origin,
      });
      const provider = yield* makeCommercePortalAuthDatabase(configuration);
      const verificationTokens: string[] = [];
      const auth = yield* makeCommercePortalAuth({
        configuration,
        databaseAdapter: provider.adapter,
        emailDelivery: {
          sendOTP: () => Promise.resolve(),
          sendResetPassword: () => Promise.resolve(),
          sendVerificationEmail: ({ token }) => {
            verificationTokens.push(token);
            return Promise.resolve();
          },
        },
      });
      // These are this test's own rows. The isolated provider connection remains open for cleanup.
      yield* Effect.addFinalizer(() =>
        provider.executor
          .transaction((transaction) =>
            Effect.gen(function* removeProviderFixture() {
              yield* transaction.delete(user).where(eq(user.email, email));
              yield* transaction.delete(verification).where(eq(verification.identifier, email));
            }),
          )
          .pipe(Effect.orDie),
      );
      yield* Effect.addFinalizer(() =>
        fixture.admin
          .transaction((transaction) =>
            Effect.gen(function* removeProfileFixture() {
              yield* transaction.execute(
                sql`delete from commerce_customer_context.retail_portal_profile_bindings where tenant_id = ${tenantId}::uuid`,
                'objects',
              );
              yield* transaction.execute(
                sql`delete from commerce_customer_context.retail_customer_profiles where tenant_id = ${tenantId}::uuid`,
                'objects',
              );
              yield* transaction.execute(
                sql`delete from commerce_customer_context.customer_profiles where tenant_id = ${tenantId}::uuid`,
                'objects',
              );
            }),
          )
          .pipe(Effect.orDie),
      );
      const startInput = Schema.decodeUnknownSync(CommercePortalAuthEnrollmentStartInputSchema)({
        displayName: 'Verified enrollment account',
        email,
        journey: 'RETAIL_SELF_ENROLLMENT' as const,
        password,
        sellingLegalEntityId: legalEntityId,
      });
      if (startInput.journey !== 'RETAIL_SELF_ENROLLMENT') {
        return yield* Effect.die('The fixture must create a fresh retail account');
      }
      const started = yield* startEnrollmentAcceptanceAttempt(fixture, {
        ...(yield* commercePortalAuthEnrollmentIntent(startInput)),
        actionInvocationId: Schema.decodeSync(EnrollmentActionInvocationIdSchema)(yield* randomId),
        actorPrincipalId,
        compositionRevision: fixture.compositionRevision,
        tenantId,
      });
      const identity = { portalEnrollmentAttemptId: started.portalEnrollmentAttemptId, tenantId };
      const claim = yield* commercePortalAuthEnrollmentAccountCreationClaim(
        startInput,
        started.portalEnrollmentAttemptId,
      );
      const claimed = yield* fixture.ownerStore.claimTransition(
        Schema.decodeUnknownSync(ClaimEnrollmentTransitionInputSchema)({
          actorPrincipalId,
          expectedRevision: started.revision,
          leaseDurationMs: 30_000,
          ownerInvocationId: claim.ownerInvocationId,
          ownerModuleKey: claim.ownerModuleKey,
          portalEnrollmentAttemptId: started.portalEnrollmentAttemptId,
          requestDigest: claim.requestDigest,
          required: true,
          tenantId,
          transitionKey: claim.transitionKey,
          workerId: 'commerce.portal-auth.enrollment-start',
        }),
      );
      if (claimed.outcome !== 'CLAIMED') {
        return yield* Effect.die('Fresh provider creation must own its native transition');
      }
      const authorized = yield* fixture.run(fixture.scope, (transaction) =>
        commerceEnrollmentAttemptPersistenceForTransaction(transaction, fixture.scope).authorizeAccountCreation({
          ownerInvocationId: claim.ownerInvocationId,
          portalEnrollmentAttemptId: started.portalEnrollmentAttemptId,
          tenantId,
        }),
      );
      const signup = yield* Effect.promise(
        async () =>
          await auth.api.signUpEmail({
            body: { email, name: startInput.displayName, password: Redacted.value(password) },
            headers: {
              [COMMERCE_PORTAL_ACCOUNT_CORRELATION_HEADERS.attempt]: started.portalEnrollmentAttemptId,
              [COMMERCE_PORTAL_ACCOUNT_CORRELATION_HEADERS.ownerInvocation]: claim.ownerInvocationId,
              [COMMERCE_PORTAL_ACCOUNT_CORRELATION_HEADERS.tenant]: tenantId,
            },
            returnHeaders: true,
          }),
      );
      const providerSubjectId = signup.response.user.id;
      yield* commercePortalAuthEnrollmentAccountCreationOutcome(claim, claimed.attempt, claimed.operation, {
        enrollmentAttemptId: started.portalEnrollmentAttemptId,
        evidenceRef: authorized.evidenceRef,
        outcome: 'CREATED',
        providerSubjectId,
        revision: authorized.revision,
      }).pipe(Effect.flatMap((outcome) => fixture.ownerStore.recordOutcome(outcome)));
      const lookup = yield* CommercePortalAuthAccountLookupService.pipe(
        Effect.provide(
          CommercePortalAuthAccountLookupLive.pipe(Layer.provide(Layer.succeed(CommercePortalAuthDatabase, provider))),
        ),
      );
      const spice = newSpiceDbGrpcClient(yield* loadSpiceDbConfig());
      yield* Effect.addFinalizer(() => Effect.sync(() => spice.close()));
      const permissionObjectId = toBusinessPermissionAccessObjectId(
        Schema.decodeSync(BusinessPermissionCodeSchema)('retail.profile.read'),
        { kind: 'retail_profile', legalEntityId, profileId, tenantId },
      );
      if (permissionObjectId === undefined) {
        return yield* Effect.die('The exact retail profile permission must have a native identity');
      }
      const relationship = v1.Relationship.create({
        relation: 'self_service_grantee',
        resource: v1.ObjectReference.create({ objectId: permissionObjectId, objectType: 'business_permission' }),
        subject: v1.SubjectReference.create({
          object: v1.ObjectReference.create({ objectId: principalId, objectType: 'principal' }),
        }),
      });
      const grant = (operation: v1.RelationshipUpdate_Operation) =>
        Effect.promise(
          async () =>
            await spice.promises.writeRelationships(
              v1.WriteRelationshipsRequest.create({
                updates: [v1.RelationshipUpdate.create({ operation, relationship })],
              }),
            ),
        );
      yield* Effect.addFinalizer(() => grant(v1.RelationshipUpdate_Operation.DELETE).pipe(Effect.asVoid, Effect.orDie));
      const owner = enrollmentAcceptanceScriptedOwner({
        actorPrincipalId,
        answers: {
          [BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY]: {
            kind: 'SUCCEEDED',
            outcomeCode: 'retail_portal_profile_bound',
            resultReference: bindingId,
          },
          [ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY]: {
            kind: 'SUCCEEDED',
            outcomeCode: 'retail_customer_profile_ensured',
            resultReference: profileId,
          },
          [PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY]: {
            kind: 'SUCCEEDED',
            outcomeCode: 'party_candidate_created',
            resultReference: partyId,
          },
          [RETAIL_CUSTOMER_DIRECTORY_TRANSITION_KEY]: {
            kind: 'SUCCEEDED',
            outcomeCode: 'customer_directory_enrolled',
            resultReference: partyId,
          },
        },
      });
      const commitProfile = fixture.admin
        .transaction((transaction) =>
          Effect.gen(function* profileOwnerCommit() {
            yield* transaction.execute(
              sql`insert into commerce_customer_context.customer_profiles (customer_profile_id, tenant_id, legal_entity_id, profile_kind) values (${profileId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, 'RETAIL')`,
              'objects',
            );
            yield* transaction.execute(
              sql`insert into commerce_customer_context.retail_customer_profiles (retail_customer_profile_id, tenant_id, legal_entity_id, party_resource_id) values (${profileId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, ${partyId})`,
              'objects',
            );
          }),
        )
        .pipe(Effect.orDie);
      const commitBinding = (ownerInvocationId: string) =>
        fixture.admin
          .transaction((transaction) =>
            transaction.execute(
              sql`insert into commerce_customer_context.retail_portal_profile_bindings (retail_portal_profile_binding_id, tenant_id, legal_entity_id, auth_binding_id, principal_id, retail_customer_profile_id, enrollment_evidence_ref, action_invocation_id, actor_principal_id) values (${bindingId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, ${authBindingId}::uuid, ${principalId}::uuid, ${profileId}::uuid, 'verified-account-acceptance', ${ownerInvocationId}::uuid, ${actorPrincipalId}::uuid)`,
              'objects',
            ),
          )
          .pipe(Effect.orDie);
      const registry = Layer.succeed(CommerceEnrollmentOwnerEffectRegistry, {
        resolve: (transition) =>
          Effect.succeed(
            Option.some({
              dispatch: Option.some({
                effect: (operation) =>
                  Effect.gen(function* remoteOwnerCommit() {
                    if (operation.transitionKey === ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY) {
                      yield* commitProfile;
                    }
                    if (operation.transitionKey === BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY) {
                      yield* commitBinding(operation.ownerInvocationId);
                      yield* grant(v1.RelationshipUpdate_Operation.TOUCH);
                    }
                    return yield* owner.effect.dispatch(operation);
                  }),
                requestDigest: enrollmentDigest(transition.transitionKey),
              }),
              reconcile: owner.effect.reconcile,
            }),
          ),
        verificationRequired: (context) => retailEnrollmentVerificationRequired(context, lookup),
      });
      const runner = Layer.succeed(CommerceEnrollmentOwnerTransactionRunner, {
        run: fixture.run,
        runWorker: fixture.runWorker,
      });
      const continuation = yield* CommerceEnrollmentContinuation.pipe(
        Effect.provide(
          CommerceEnrollmentContinuationLive(ultramodernApiMarker).pipe(
            Layer.provide(
              Layer.mergeAll(
                registry,
                runner,
                enrollmentApplicationCompositionLayer,
                Layer.succeed(CommerceEnrollmentPreparationSubjectResolver, {
                  resolve: () =>
                    Effect.succeed({
                      partyCandidateDigest: retailPartyCandidateDigest(['PERSON', email]),
                      partyRef: Option.none(),
                      portalEnrollmentAttemptId: started.portalEnrollmentAttemptId,
                      principalRef: {
                        moduleId: 'core.identity' as const,
                        resourceId: principalId,
                        resourceType: 'core.identity.principal' as const,
                        tenantId,
                      },
                      sellingLegalEntityRef: {
                        moduleId: 'core.identity' as const,
                        resourceId: legalEntityId,
                        resourceType: 'core.identity.legal-entity' as const,
                        tenantId,
                      },
                    }),
                }),
              ),
            ),
          ),
        ),
      );
      const parked = yield* fixture.ownerStore.read(identity);
      expect(parked.state).toBe('VERIFICATION_REQUIRED');
      expect(parked.lease).toBeUndefined();
      expect((yield* continuation.advance(identity)).outcome).toBe('HALTED');
      expect(owner.log.dispatched).toEqual([]);
      yield* Effect.promise(async () => await auth.api.sendVerificationEmail({ body: { email } }));
      const token = verificationTokens.at(-1);
      if (token === undefined) {
        return yield* Effect.die('The fresh provider must send a real verification token');
      }
      yield* Effect.promise(async () => await auth.api.verifyEmail({ query: { token }, returnHeaders: true }));
      const signedIn = yield* Effect.promise(
        async () =>
          await auth.api.signInEmail({
            body: { email, password: Redacted.value(password) },
            headers: new Headers({ origin }),
            returnHeaders: true,
          }),
      );
      const cookie = signedIn.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      expect((yield* continuation.advance(identity)).outcome).toBe('COMPLETE');
      expect((yield* fixture.ownerStore.read(identity)).accountSubject?.providerSubjectId).toBe(providerSubjectId);
      expect(owner.log.dispatched).toHaveLength(4);
      const gateway = yield* makeAcceptanceGatewayIssuer(
        'http://gateway.enrollment-account.test',
        'enrollment-account',
      );
      const resolvedSubjects: string[] = [];
      const core = Layer.succeed(ExternalIdentityClient, {
        activatePrincipalBinding: unusedAccountMutation,
        changePrincipalBindingStatus: unusedAccountMutation,
        issueExternalGatewayContext: unusedAccountMutation,
        readPrincipalBinding: unusedAccountMutation,
        reservePrincipalBinding: unusedAccountMutation,
        resolveExternalSubject: (request) =>
          Effect.sync(() => {
            resolvedSubjects.push(request.providerSubjectId);
            return Schema.decodeUnknownSync(ResolveExternalSubjectResultSchema)({
              authBindingId,
              authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
              bindingRevision: 1,
              bindingStatus: 'active' as const,
              outcome: 'RESOLVED' as const,
              principalId,
              tenantId,
            });
          }),
      });
      const authority = commerceCustomerAuthorityLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            core,
            commercePortalAuthPlatformCryptoLive,
            runner,
            ContextAccessLive,
            enrollmentApplicationCompositionLayer,
            Layer.succeed(CommerceCoreIdentityClientConfig, {
              apiKey: Redacted.make('test-only-external-owner'),
              baseUrl: 'https://core.example.test',
            }),
          ),
        ),
      );
      const lifecycle = makeCommercePortalAuthSessionLifecycle(
        makeCommercePortalAuthSessionStore(provider.executor, yield* Crypto.Crypto),
        makeCommercePortalAuthSessionProvider(auth),
        unauditedCommercePortalAuthRecorder,
      );
      const api = HttpApi.make('CommerceCustomerContextApi').addHttpApi(CommercePortalAuthSessionApi);
      const apiLayer = HttpApiBuilder.layer(api).pipe(
        Layer.provide(portalAuthSessionApiLive),
        Layer.provide(
          Layer.mergeAll(
            authority,
            GatewayPrincipalVerifierLive.pipe(Layer.provide(gateway.verificationLive)),
            enrollmentApplicationCompositionLayer,
            Layer.succeed(GatewayAssertionRedemptionService, { consume: () => Effect.void }),
            Layer.succeed(CommercePortalAuthService, { api: auth.api }),
            Layer.succeed(CommercePortalAuthSessionLifecycle, lifecycle),
            Layer.succeed(CommercePortalAuthConfig, configuration),
            Layer.succeed(CommercePortalAuthAudit, unauditedCommercePortalAuthRecorder),
            Layer.succeed(CommercePortalAuthRecoveryRateLimitService, {
              consume: () => Effect.die('Account GET must not spend a sign-in budget'),
            }),
            HttpServer.layerServices,
          ),
        ),
      );
      const app = yield* Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(apiLayer, { disableLogger: true })),
        (handler) => Effect.promise(handler.dispose.bind(handler)).pipe(Effect.orDie),
      );
      const assertion = yield* issueAcceptanceGatewayAssertion(fixture.admin, gateway, 'commerce-customer-context', {
        authBindingId: yield* randomId,
        authContextRef: 'storefront-workload-session',
        authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
        authMethod: 'session',
        legalEntityId,
        principalId: actorPrincipalId,
        tenantId,
      });
      const response = yield* Effect.promise(
        async () =>
          await app.handler(
            new Request(`${origin}/api/portal-auth/customer-account`, {
              headers: { authorization: `Bearer ${assertion}`, cookie },
            }),
            Context.makeUnsafe<unknown>(new Map()),
          ),
      );
      expect(response.status).toBe(200);
      const body = yield* Effect.promise(async () => await response.json());
      expect(body).toMatchObject({ account: { id: providerSubjectId, partyId, tenantId }, state: 'authenticated' });
      expect(resolvedSubjects).toEqual([providerSubjectId]);
      return yield* Effect.void;
    }),
  ).pipe(Effect.provide(commercePortalAuthPlatformCryptoLive)),
);
