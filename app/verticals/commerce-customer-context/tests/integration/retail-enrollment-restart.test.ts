import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadDatabaseConnectionPair, scopedRoutineInvokerFromTransaction } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Effect, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  ClaimEnrollmentTransitionInputSchema,
  CommercePortalAccountSubjectSchema,
  ReadEnrollmentAttemptInputSchema,
  RecordEnrollmentOutcomeInputSchema,
  StartEnrollmentAttemptInputSchema,
} from '../../shared/enrollment-contracts.ts';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import { commerceEnrollmentAttemptPersistenceForTransaction } from '../../src/enrollment/attempts/attempt-persistence.ts';
import {
  readCurrentRetailEnrollment,
  readRetailEnrollmentRegistration,
} from '../../src/enrollment/attempts/registration-persistence.ts';
import {
  readRetailEnrollmentRestartContext,
  retailEnrollmentRestartIntent,
  RETAIN_RETAIL_RESULTS_TRANSITION,
} from '../../src/enrollment/journeys/retail-enrollment-restart.ts';
import {
  commerceEnrollmentCompletionAuthorityForPersistence,
  enrollmentJourneyDefinitionForAttempt,
} from '../../src/enrollment/orchestration/completion.ts';
import { retailEnrollmentRetainedResultsOwnerEffect } from '../../src/enrollment/journeys/retail-enrollment-restart-owner.ts';
import {
  readRestartEnrollmentForIntent,
  recoverEnrollmentAccountVerification,
} from '../../api/portal-auth/enrollment/http.ts';
import { commerceEnrollmentOwnerAttemptStoreForRun } from '../../src/enrollment/orchestration/owner-transition-production.ts';
import { CommerceEnrollmentOwnerTransitionSchema } from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import type { CommerceEnrollmentOwnerTransactionRun } from '../../src/enrollment/orchestration/owner-transition-production.ts';
import type { EnrollmentAttemptSnapshot, CommercePortalAccountSubject } from '../../shared/enrollment-contracts.ts';
import { enrollmentApplicationCompositionRevision } from '../support/enrollment-application-composition.ts';
import { installEnrollmentTestAuthority } from '../support/enrollment-composition-authority.ts';

const failedStepFor = (mask: number) => {
  switch (mask) {
    case 0: {
      return { owner: 'party.registry', transition: 'party.candidate.submit' };
    }
    case 1: {
      return { owner: 'party.registry', transition: 'party.customer.enroll' };
    }
    case 3: {
      return {
        owner: 'commerce.customer-context',
        transition: 'commerce.customer-context.ensure-retail-customer-profile',
      };
    }
    default: {
      return { owner: 'commerce.customer-context', transition: 'commerce.customer-context.bind-retail-portal-profile' };
    }
  }
};

const fixtureReference = (
  transitionKey: string,
  partyId: string,
  attemptId: string,
  profileId: string,
  authBindingId: string,
  bindingId: string,
) => {
  if (transitionKey === 'core.principal-binding.activate') {
    return authBindingId;
  }
  if (transitionKey === 'commerce.customer-context.bind-retail-portal-profile') {
    return bindingId;
  }
  if (transitionKey === 'party.candidate.submit' || transitionKey === 'party.customer.enroll') {
    return partyId;
  }
  return transitionKey === 'provider.account.verify' ? attemptId : profileId;
};

type TestDatabase = Effect.Success<
  ReturnType<typeof makeTestDatabaseFromClient<typeof commerceCustomerContextRelations>>
>;
type TestTransaction = Parameters<Parameters<TestDatabase['transaction']>[0]>[0];
type Execute = Parameters<typeof scopedRoutineInvokerFromTransaction>[0];

const verifyInterruptedAccount = (
  execute: Execute,
  run: CommerceEnrollmentOwnerTransactionRun,
  claim: typeof ClaimEnrollmentTransitionInputSchema.Type,
  attempt: typeof ReadEnrollmentAttemptInputSchema.Type,
  subject: typeof CommercePortalAccountSubjectSchema.Type,
  expire: boolean,
) =>
  Effect.gen(function* interruptedVerification() {
    if (expire) {
      yield* execute(sql`reset role`);
      // Isolated rollback fixture only: simulate a process dying after claim and its real lease expiring.
      yield* execute(
        sql`update commerce_customer_context.portal_enrollment_owner_operations set lease_expires_at = statement_timestamp() - interval '1 second' where tenant_id = ${claim.tenantId}::uuid and portal_enrollment_attempt_id = ${claim.portalEnrollmentAttemptId}::uuid and owner_invocation_id = ${claim.ownerInvocationId}::uuid`,
      );
      yield* execute(
        sql`update commerce_customer_context.portal_enrollment_attempts set lease_expires_at = statement_timestamp() - interval '1 second' where tenant_id = ${claim.tenantId}::uuid and portal_enrollment_attempt_id = ${claim.portalEnrollmentAttemptId}::uuid`,
      );
      yield* execute(sql`set local role ontos_runtime`);
    }
    const store = commerceEnrollmentOwnerAttemptStoreForRun({ tenantId: claim.tenantId }, run);
    const identity = { portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId, tenantId: attempt.tenantId };
    const current = yield* store.read(identity);
    const verified = yield* recoverEnrollmentAccountVerification(store, claim, current, subject, () =>
      Effect.die('An existing native verification must never replay governed claim preparation'),
    );
    expect(verified.accountSubject).toEqual(subject);
    const operation = yield* store.readOwnerOperation({
      ...identity,
      ownerModuleKey: claim.ownerModuleKey,
      transitionKey: claim.transitionKey,
    });
    expect(operation.ownerInvocationId).toBe(claim.ownerInvocationId);
    expect(operation.status).toBe('SUCCEEDED');
    return verified;
  });

const assertRestartAdmission = (input: {
  readonly authBindingId: string;
  readonly bindingId: string;
  readonly creatorId: string;
  readonly customerPrincipalId: string;
  readonly execute: Execute;
  readonly legalEntityId: string;
  readonly partyId: string;
  readonly profileId: string;
  readonly providerSubjectId: string;
  readonly tenantId: string;
}) =>
  Effect.gen(function* nativeRestartAdmission() {
    const {
      authBindingId,
      bindingId,
      creatorId,
      customerPrincipalId,
      execute,
      legalEntityId,
      partyId,
      profileId,
      providerSubjectId,
      tenantId,
    } = input;
    yield* execute(sql`reset role`);
    yield* execute(
      sql`insert into commerce_customer_context.customer_profiles (customer_profile_id, tenant_id, legal_entity_id, profile_kind) values (${profileId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, 'RETAIL')`,
    );
    yield* execute(
      sql`insert into commerce_customer_context.retail_customer_profiles (retail_customer_profile_id, tenant_id, legal_entity_id, party_resource_id) values (${profileId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, ${partyId})`,
    );
    yield* execute(
      sql`insert into commerce_customer_context.retail_portal_profile_bindings (retail_portal_profile_binding_id, tenant_id, legal_entity_id, auth_binding_id, principal_id, retail_customer_profile_id, enrollment_evidence_ref, action_invocation_id, actor_principal_id) values (${bindingId}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid, ${authBindingId}::uuid, ${customerPrincipalId}::uuid, ${profileId}::uuid, 'native-restart-acceptance', ${randomUUID()}::uuid, ${creatorId}::uuid)`,
    );
    const account = (subject = providerSubjectId, principal = customerPrincipalId, binding = authBindingId) =>
      execute(
        sql`select * from commerce_customer_context.read_retail_enrollment_account_party(${tenantId}::uuid, ${legalEntityId}::uuid, ${subject}, ${principal}::uuid, ${binding}::uuid)`,
      );
    yield* execute(sql`set local role ontos_runtime`);
    expect(yield* account()).toEqual([{ party_id: partyId, profile_id: profileId }]);
    expect(yield* account('foreign-provider-subject')).toEqual([]);
    expect(yield* account(providerSubjectId, randomUUID())).toEqual([]);
    expect(yield* account(providerSubjectId, customerPrincipalId, randomUUID())).toEqual([]);
    yield* execute(sql`reset role`);
    yield* execute(
      sql`update commerce_customer_context.retail_portal_profile_bindings set authorization_state = 'REVOKED' where retail_portal_profile_binding_id = ${bindingId}::uuid`,
    );
    yield* execute(sql`set local role ontos_runtime`);
    expect(yield* account()).toEqual([]);
    yield* execute(sql`reset role`);
    yield* execute(
      sql`update commerce_customer_context.retail_portal_profile_bindings set authorization_state = 'ACTIVE' where retail_portal_profile_binding_id = ${bindingId}::uuid`,
    );
    yield* execute(
      sql`update commerce_customer_context.customer_profiles set lifecycle = 'SUSPENDED' where customer_profile_id = ${profileId}::uuid`,
    );
    yield* execute(sql`set local role ontos_runtime`);
    expect(yield* account()).toEqual([]);
  });

const assertRepeatedFailedRestart = (input: {
  readonly attempt: EnrollmentAttemptSnapshot;
  readonly execute: Execute;
  readonly legalEntityId: string;
  readonly mask: number;
  readonly subject: CommercePortalAccountSubject;
}) =>
  Effect.gen(function* repeatedFailedRestart() {
    const { attempt, execute, legalEntityId, mask, subject } = input;
    if (mask !== 1) {
      return;
    }
    yield* execute(sql`savepoint repeat_failed_restart`);
    const scope = { legalEntityId, tenantId: attempt.tenantId };
    const invoker = scopedRoutineInvokerFromTransaction(execute, scope);
    const persistence = commerceEnrollmentAttemptPersistenceForTransaction(invoker, scope);
    const claim = yield* Schema.decodeUnknownEffect(ClaimEnrollmentTransitionInputSchema)({
      actorPrincipalId: attempt.createdByPrincipalId,
      expectedRevision: attempt.revision,
      leaseDurationMs: 60_000,
      ownerInvocationId: randomUUID(),
      ownerModuleKey: 'commerce.portal-auth',
      portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
      requestDigest: 'd'.repeat(64),
      required: true,
      tenantId: attempt.tenantId,
      transitionKey: 'provider.account.verify',
      workerId: 'native-restart-acceptance',
    });
    const claimed = yield* persistence.claim(claim);
    const run: CommerceEnrollmentOwnerTransactionRun = (ownerScope, operation) =>
      operation(scopedRoutineInvokerFromTransaction(execute, ownerScope));
    yield* verifyInterruptedAccount(execute, run, claim, claimed.attempt, subject, false);
    const failedInvocation = randomUUID();
    yield* execute(sql`reset role`);
    yield* execute(
      sql`insert into commerce_customer_context.portal_enrollment_owner_operations (tenant_id, portal_enrollment_attempt_id, owner_module_key, transition_key, owner_invocation_id, request_digest, actor_principal_id, required, status, failure_code, outcome_code, failure_reason, completed_at) values (${attempt.tenantId}::uuid, ${attempt.portalEnrollmentAttemptId}::uuid, 'party.registry', 'party.customer.enroll', ${failedInvocation}::uuid, ${'c'.repeat(64)}, ${attempt.createdByPrincipalId}::uuid, true, 'FAILED', 'owner_rejected', 'owner_rejected', 'Isolated repeated directory rejection', now())`,
    );
    yield* execute(sql`set local role ontos_runtime`);
    expect(
      yield* execute(
        sql`select * from commerce_customer_context.fail_portal_enrollment(${attempt.tenantId}::uuid, ${attempt.portalEnrollmentAttemptId}::uuid, 'party.registry', 'party.customer.enroll')`,
      ),
    ).toEqual([{ failed: true }]);
    const failed = yield* persistence.read(attempt);
    const operations = yield* persistence.readOperations(attempt);
    const proof = Option.getOrThrow(
      yield* readRetailEnrollmentRestartContext(invoker, attempt.portalEnrollmentAttemptId, true),
    );
    expect(proof.sourceAttemptId).toBe(attempt.portalEnrollmentAttemptId);
    expect(proof.retainedMask).toBe(1);
    expect(proof.directoryOwnerInvocationIds).toHaveLength(2);
    expect(proof.directoryOwnerInvocationIds[0]).toBe(failedInvocation);
    const intent = yield* retailEnrollmentRestartIntent(failed, proof);
    const start = yield* Schema.decodeUnknownEffect(StartEnrollmentAttemptInputSchema)({
      ...intent,
      actionInvocationId: randomUUID(),
      actorPrincipalId: attempt.createdByPrincipalId,
      compositionRevision: attempt.compositionRevision,
      tenantId: attempt.tenantId,
    });
    const next = yield* persistence.create(start);
    expect(next.outcome).toBe('CREATED');
    expect(next.attempt.portalEnrollmentAttemptId).not.toBe(attempt.portalEnrollmentAttemptId);
    expect(Option.getOrThrow(yield* readCurrentRetailEnrollment(invoker, attempt.createdByPrincipalId, subject))).toBe(
      next.attempt.portalEnrollmentAttemptId,
    );
    expect(
      Option.getOrThrow(
        yield* readRetailEnrollmentRestartContext(invoker, next.attempt.portalEnrollmentAttemptId, false),
      ),
    ).toEqual(proof);
    expect(yield* persistence.read(attempt)).toEqual(failed);
    expect(yield* persistence.readOperations(attempt)).toEqual(operations);
    yield* execute(sql`rollback to savepoint repeat_failed_restart`);
  });

const assertRestartHttpRecovery = (
  run: CommerceEnrollmentOwnerTransactionRun,
  scope: { readonly legalEntityId: string; readonly tenantId: string },
  attempt: EnrollmentAttemptSnapshot,
  original: EnrollmentAttemptSnapshot,
  subject: CommercePortalAccountSubject,
  intent: Parameters<typeof readRestartEnrollmentForIntent>[4],
) =>
  Effect.gen(function* restartHttpRecovery() {
    const creatorId = attempt.createdByPrincipalId;
    // The HTTP adapter recovers ActionAlreadyCommitted through this exact native reader,
    // before verification exists, without creating or claiming anything again.
    expect((yield* readRestartEnrollmentForIntent(run, scope, creatorId, subject, intent)).attempt).toEqual(attempt);
    const wrongSubject = yield* Schema.decodeEffect(CommercePortalAccountSubjectSchema)({
      ...subject,
      providerSubjectId: 'another-customer',
    });
    for (const mismatch of [
      readRestartEnrollmentForIntent(run, scope, randomUUID(), subject, intent),
      readRestartEnrollmentForIntent(run, scope, creatorId, subject, {
        ...intent,
        intentDigest: original.intentDigest,
      }),
      readRestartEnrollmentForIntent(run, scope, creatorId, wrongSubject, intent),
    ]) {
      expect(Result.isFailure(yield* mismatch.pipe(Effect.result))).toBe(true);
    }
  });

const restartCase = (input: {
  readonly compositionRevision: string;
  readonly creatorId: string;
  readonly execute: Execute;
  readonly legalEntityId: string;
  readonly mask: number;
  readonly tenantId: string;
}) =>
  Effect.gen(function* nativeRestartCase() {
    const { compositionRevision, creatorId, execute, legalEntityId, mask, tenantId } = input;
    const scope = { legalEntityId, tenantId };
    const invoker = () => scopedRoutineInvokerFromTransaction(execute, scope);
    const persistence = () => commerceEnrollmentAttemptPersistenceForTransaction(invoker(), scope);
    yield* execute(sql`reset role`);
    const sourceId = randomUUID();
    const partyId = randomUUID();
    const profileId = randomUUID();
    const authBindingId = randomUUID();
    const bindingId = randomUUID();
    const customerPrincipalId = randomUUID();
    const providerInvocation = randomUUID();
    const rejectedInvocation = randomUUID();
    const subject = Schema.decodeSync(CommercePortalAccountSubjectSchema)({
      authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
      providerSubjectId: `verified-${randomUUID()}`,
      subjectType: 'user',
    });
    const registration = {
      displayName: 'Native restart acceptance',
      email: `restart-${sourceId}@example.test`,
      phone: '+420777123456',
    };
    yield* execute(sql`insert into commerce_customer_context.portal_enrollment_attempts
        (portal_enrollment_attempt_id, tenant_id, journey, intent_key, intent_digest, composition_revision, created_by_principal_id, target_legal_entity_id, authentication_namespace_id, subject_type, provider_subject_id, retail_registration)
        values (${sourceId}::uuid, ${tenantId}::uuid, 'RETAIL_SELF_ENROLLMENT', ${sourceId}, ${'a'.repeat(64)}, ${compositionRevision}, ${creatorId}::uuid, ${legalEntityId}::uuid, ${subject.authenticationNamespaceId}, 'user', ${subject.providerSubjectId}, ${JSON.stringify(registration)}::jsonb)`);
    const success = (owner: string, transition: string, reference: string, invocation = randomUUID()) =>
      execute(sql`insert into commerce_customer_context.portal_enrollment_owner_operations
        (tenant_id, portal_enrollment_attempt_id, owner_module_key, transition_key, owner_invocation_id, request_digest, actor_principal_id, required, status, result_reference, completed_at)
        values (${tenantId}::uuid, ${sourceId}::uuid, ${owner}, ${transition}, ${invocation}::uuid, ${'b'.repeat(64)}, ${creatorId}::uuid, true, 'SUCCEEDED', ${reference}, now())`);
    yield* success('commerce.portal-auth', 'provider.account.create', sourceId, providerInvocation);
    if (mask >= 1) {
      yield* success('party.registry', 'party.candidate.submit', partyId);
    }
    if (mask >= 3) {
      yield* success('party.registry', 'party.customer.enroll', partyId);
    }
    if (mask === 7) {
      yield* success(
        'commerce.customer-context',
        'commerce.customer-context.ensure-retail-customer-profile',
        profileId,
      );
    }
    const { owner: failedOwner, transition: failedTransition } = failedStepFor(mask);
    yield* execute(sql`insert into commerce_customer_context.portal_enrollment_owner_operations
        (tenant_id, portal_enrollment_attempt_id, owner_module_key, transition_key, owner_invocation_id, request_digest, actor_principal_id, required, status, failure_code, outcome_code, failure_reason, completed_at)
        values (${tenantId}::uuid, ${sourceId}::uuid, ${failedOwner}, ${failedTransition}, ${rejectedInvocation}::uuid, ${'c'.repeat(64)}, ${creatorId}::uuid, true, 'FAILED', 'owner_rejected', 'owner_rejected', 'Native fixture rejection', now())`);
    const sourceIdentity = yield* Schema.decodeUnknownEffect(ReadEnrollmentAttemptInputSchema)({
      portalEnrollmentAttemptId: sourceId,
      tenantId,
    });
    yield* execute(sql`set local role ontos_runtime`);
    expect(
      yield* execute(
        sql`select * from commerce_customer_context.fail_portal_enrollment(${tenantId}::uuid, ${sourceId}::uuid, ${failedOwner}, ${failedTransition})`,
      ),
    ).toEqual([{ failed: true }]);
    const original = yield* persistence().read(sourceIdentity);
    const originalOperations = yield* persistence().readOperations(sourceIdentity);
    const sourceProof = yield* readRetailEnrollmentRestartContext(invoker(), sourceId, true);
    expect(Option.isSome(sourceProof)).toBe(true);
    const proof = Option.getOrThrow(sourceProof);
    expect(proof.retainedMask).toBe(mask);
    expect(proof.providerOwnerInvocationId).toBe(providerInvocation);
    expect(proof.partyId).toBe(mask >= 1 ? partyId : undefined);
    expect(proof.directoryPartyId).toBe(mask >= 3 ? partyId : undefined);
    expect(proof.profileId).toBe(mask === 7 ? profileId : undefined);
    if (mask === 1) {
      expect(proof.directoryOwnerInvocationIds).toEqual([rejectedInvocation]);
    }
    const intent = yield* retailEnrollmentRestartIntent(original, proof);
    const start = (actionInvocationId = randomUUID()) =>
      Schema.decodeUnknownEffect(StartEnrollmentAttemptInputSchema)({
        ...intent,
        actionInvocationId,
        actorPrincipalId: creatorId,
        compositionRevision,
        tenantId,
      }).pipe(Effect.flatMap((startInput) => persistence().create(startInput)));
    const created = yield* start();
    expect(created.outcome).toBe('CREATED');
    expect(created.attempt.journey).toBe('EXISTING_ACCOUNT');
    expect(created.attempt.portalEnrollmentAttemptId).not.toBe(sourceId);
    expect(created.attempt.accountSubject).toBeUndefined();
    expect((yield* start()).attempt.portalEnrollmentAttemptId).toBe(created.attempt.portalEnrollmentAttemptId);
    expect((yield* start()).outcome).toBe('EXISTING');
    // A crash before the proof is journalled must not lose the newly started Attempt.
    expect(Option.getOrThrow(yield* readCurrentRetailEnrollment(invoker(), creatorId, subject))).toBe(
      created.attempt.portalEnrollmentAttemptId,
    );
    expect(
      Option.getOrThrow(yield* readRetailEnrollmentRegistration(invoker(), created.attempt.portalEnrollmentAttemptId)),
    ).toEqual(registration);
    const retained = Option.getOrThrow(
      yield* readRetailEnrollmentRestartContext(invoker(), created.attempt.portalEnrollmentAttemptId, false),
    );
    expect(retained).toEqual(proof);
    const definition = yield* enrollmentJourneyDefinitionForAttempt(created.attempt);
    const steps = definition.requiredTransitions.map((step) => step.transitionKey);
    expect(steps).toContain('provider.account.verify');
    expect(steps).toContain(RETAIN_RETAIL_RESULTS_TRANSITION);
    expect(steps).toContain('commerce.customer-context.bind-retail-portal-profile');
    expect(steps).not.toContain('provider.account.create');
    expect(steps.includes('party.candidate.submit')).toBe(mask === 0);
    expect(steps.includes('party.customer.enroll')).toBe(mask <= 1);
    expect(steps.includes('commerce.customer-context.ensure-retail-customer-profile')).toBe(mask < 7);
    expect(
      yield* persistence().readOperations({
        ...sourceIdentity,
        portalEnrollmentAttemptId: created.attempt.portalEnrollmentAttemptId,
      }),
    ).toEqual([]);
    // Real native claim/lease/outcome phases, with far-owner results confined to isolated fixtures.
    // The retention owner itself is production code and reads PostgreSQL again on dispatch.
    const newIdentity = {
      ...sourceIdentity,
      portalEnrollmentAttemptId: created.attempt.portalEnrollmentAttemptId,
    };
    const run: CommerceEnrollmentOwnerTransactionRun = (ownerScope, operation) =>
      operation(scopedRoutineInvokerFromTransaction(execute, ownerScope));
    yield* assertRestartHttpRecovery(run, scope, created.attempt, original, subject, intent);
    yield* assertRepeatedFailedRestart({ attempt: created.attempt, execute, legalEntityId, mask, subject });
    const completion = commerceEnrollmentCompletionAuthorityForPersistence(persistence());
    let advancing = created.attempt;
    for (const step of definition.requiredTransitions) {
      const claim = yield* Schema.decodeUnknownEffect(ClaimEnrollmentTransitionInputSchema)({
        ...newIdentity,
        actorPrincipalId: creatorId,
        expectedRevision: advancing.revision,
        leaseDurationMs: 60_000,
        ownerInvocationId: randomUUID(),
        ownerModuleKey: step.ownerModuleKey,
        requestDigest: 'd'.repeat(64),
        required: true,
        transitionKey: step.transitionKey,
        workerId: 'native-restart-acceptance',
      });
      if (step.transitionKey === 'provider.account.verify') {
        if (mask === 0) {
          const store = commerceEnrollmentOwnerAttemptStoreForRun({ tenantId: claim.tenantId }, run);
          const verified = yield* recoverEnrollmentAccountVerification(store, claim, advancing, subject, (unclaimed) =>
            persistence()
              .claim({ ...claim, expectedRevision: unclaimed.revision })
              .pipe(
                // Another authenticated owner may settle the proof before the governed claim returns.
                Effect.andThen(() => verifyInterruptedAccount(execute, run, claim, newIdentity, subject, false)),
              ),
          );
          expect(verified.accountSubject).toEqual(subject);
          expect(verified.revision).toBeGreaterThan(advancing.revision);
        } else {
          yield* persistence().claim(claim);
        }
        // Both settled and expired verification bypass governed claim preparation on retry.
        advancing = yield* verifyInterruptedAccount(execute, run, claim, newIdentity, subject, mask !== 0);
        continue;
      }
      const claimed = yield* persistence().claim(claim);
      if (claimed.outcome === 'INDETERMINATE' || claimed.operation.lease === undefined) {
        return yield* Effect.die('The isolated native claim must carry its lease');
      }
      const transition = yield* Schema.decodeUnknownEffect(CommerceEnrollmentOwnerTransitionSchema)({
        ...claim,
        compositionRevision,
        correlationId: 'native-restart-acceptance',
        expectedRevision: claimed.attempt.revision,
      });
      const retainedOutcome =
        step.transitionKey === RETAIN_RETAIL_RESULTS_TRANSITION
          ? yield* retailEnrollmentRetainedResultsOwnerEffect(run, claimed.attempt).dispatch(transition)
          : undefined;
      const resultReference =
        retainedOutcome?.resultReference ??
        fixtureReference(
          step.transitionKey,
          partyId,
          created.attempt.portalEnrollmentAttemptId,
          profileId,
          authBindingId,
          bindingId,
        );
      const outcome = yield* Schema.decodeUnknownEffect(RecordEnrollmentOutcomeInputSchema)({
        ...claim,
        expectedRevision: claimed.attempt.revision,
        leaseToken: claimed.operation.lease.leaseToken,
        outcomeCode: retainedOutcome?.outcomeCode ?? 'native_fixture_committed',
        resultReference,
        status: 'SUCCEEDED',
      });
      const derived = yield* completion.derive(claimed.attempt, outcome);
      advancing = (yield* persistence().record(outcome, derived)).attempt;
    }
    expect(advancing.state).toBe('COMPLETE');
    yield* assertRestartAdmission({
      authBindingId,
      bindingId,
      creatorId,
      customerPrincipalId,
      execute,
      legalEntityId,
      partyId,
      profileId,
      providerSubjectId: subject.providerSubjectId,
      tenantId,
    });
    const newOperations = yield* persistence().readOperations(newIdentity);
    expect(newOperations).toHaveLength(definition.requiredTransitions.length);
    expect(
      newOperations.find((operation) => operation.transitionKey === RETAIN_RETAIL_RESULTS_TRANSITION)?.resultReference,
    ).toBe(sourceId);
    expect(
      newOperations.every(
        (operation) =>
          !originalOperations.some((previous) => previous.ownerInvocationId === operation.ownerInvocationId),
      ),
    ).toBe(true);
    expect(yield* persistence().read(sourceIdentity)).toEqual(original);
    expect(yield* persistence().readOperations(sourceIdentity)).toEqual(originalOperations);
    expect(Option.isNone(yield* readCurrentRetailEnrollment(invoker(), randomUUID(), subject))).toBe(true);
    const otherSubject = Schema.decodeSync(CommercePortalAccountSubjectSchema)({
      ...subject,
      providerSubjectId: 'another-customer',
    });
    expect(Option.isNone(yield* readCurrentRetailEnrollment(invoker(), creatorId, otherSubject))).toBe(true);
    yield* execute(sql`savepoint forged_scope`);
    const forged = yield* execute(
      sql`select * from commerce_customer_context.read_retail_enrollment_restart_context(${randomUUID()}::uuid, ${legalEntityId}::uuid, ${sourceId}::uuid, true)`,
    ).pipe(Effect.result);
    yield* execute(sql`rollback to savepoint forged_scope`);
    expect(Result.isFailure(forged)).toBe(true);
    yield* execute(sql`reset role`);
    yield* execute(sql`savepoint resurrect_source`);
    const resurrected = yield* execute(
      sql`update commerce_customer_context.portal_enrollment_attempts set state = 'IN_PROGRESS' where portal_enrollment_attempt_id = ${sourceId}::uuid`,
    ).pipe(Effect.result);
    yield* execute(sql`rollback to savepoint resurrect_source`);
    expect(Result.isFailure(resurrected)).toBe(true);
    return yield* Effect.void;
  });

const restartTransaction =
  ({
    compositionRevision,
    creatorId,
    legalEntityId,
    rollback,
    tenantId,
  }: {
    readonly compositionRevision: string;
    readonly creatorId: string;
    readonly legalEntityId: string;
    readonly rollback: Error;
    readonly tenantId: string;
  }) =>
  (transaction: TestTransaction) =>
    Effect.gen(function* nativeRestartTransaction() {
      const execute = (statement: Parameters<typeof transaction.execute>[0]) =>
        transaction.execute(statement, 'objects');
      for (const name of ['20261024005000_existing-account-retail-restart']) {
        const migration = readFileSync(
          new URL(`../../drizzle/${name}/migration.sql`, import.meta.url),
          'utf-8',
        ).replaceAll('CREATE FUNCTION ', 'CREATE OR REPLACE FUNCTION ');
        for (const statement of migration.split('--> statement-breakpoint')) {
          yield* execute(sql.raw(statement));
        }
      }
      yield* execute(
        sql`select set_config('ontos.tenant_id', ${tenantId}, true), set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
      );
      for (const mask of [0, 1, 3, 7]) {
        yield* restartCase({ compositionRevision, creatorId, execute, legalEntityId, mask, tenantId });
      }
      return yield* Effect.fail(rollback);
    });

const restartAcceptance = () =>
  Effect.scoped(
    Effect.gen(function* nativeRestartAcceptance() {
      const compositionRevision = yield* enrollmentApplicationCompositionRevision;
      yield* installEnrollmentTestAuthority(compositionRevision);
      const connections = yield* loadDatabaseConnectionPair();
      const client = yield* makeTestPgClient(connections.admin.connectionString);
      const admin = yield* makeTestDatabaseFromClient(client, commerceCustomerContextRelations);
      const tenantId = randomUUID();
      const legalEntityId = randomUUID();
      const creatorId = randomUUID();
      const rollback = new Error('restart acceptance rollback');
      yield* admin
        .transaction(restartTransaction({ compositionRevision, creatorId, legalEntityId, rollback, tenantId }))
        .pipe(Effect.catch((error) => (error === rollback ? Effect.void : Effect.fail(error))));
    }),
  );

it.live(
  'starts new native existing-account Attempts, retains only real predecessor successes, converges and never mutates FAILED history',
  restartAcceptance,
);
