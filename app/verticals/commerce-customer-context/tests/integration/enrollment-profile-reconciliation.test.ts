import { randomUUID } from 'node:crypto';

import { ActionCommitIndeterminate } from '@app/core-runtime';
import { Effect, Layer, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ExternalIdentityClient } from '../../../../packages/shared-contracts/src/external-identity-client.ts';
import type { ExternalIdentityClientPort } from '../../../../packages/shared-contracts/src/external-identity-client.ts';
import { CommercePortalAuthAccountLookupService } from '../../api/portal-auth/provider/account-lookup-service.ts';
import { CommercePortalAuthAccountCreationReconciliationService } from '../../api/portal-auth/provider/account-creation-reconciliation-service.ts';
import { CommerceCoreIdentityClientConfig } from '../../api/portal-auth/provider/core-identity-client-config.ts';
import { BindRetailPortalProfileActionConflictProblemSchema } from '../../shared/apis/bind-retail-portal-profile-action.ts';
import {
  BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
  ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
  RETAIL_PORTAL_GRANTS_INCOMPLETE_OUTCOME_CODE,
} from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import type { JourneyTransitionSpec } from '../../src/enrollment/journeys/journey-contracts.ts';
import {
  CommerceEnrollmentOwnerEffectRegistry,
  CommerceEnrollmentOwnerEffectRegistryLive,
} from '../../src/enrollment/orchestration/owner-effect-registry.ts';
import type { CommerceEnrollmentOwnerEffectContext } from '../../src/enrollment/orchestration/owner-effect-registry.ts';
import { CommerceEnrollmentOwnerTransactionRunner } from '../../src/enrollment/orchestration/owner-transition-production.ts';
import { CommerceEnrollmentOwnerEffectUnavailable } from '../../src/enrollment/orchestration/owner-transition-errors.ts';
import { ProfileRetailPermissionReaderFactory } from '../../src/integrations/retail-permission-reader.ts';
import { CommerceEnrollmentOwnerTransitionSchema } from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import type { CommerceEnrollmentOwnerReconciliationInput } from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentKeySchema,
  EnrollmentLegalEntityIdSchema,
  EnrollmentModuleKeySchema,
  EnrollmentOwnerOperationIdSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentResourceIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
} from '../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptSnapshot, EnrollmentOwnerOperationSnapshot } from '../../shared/enrollment-contracts.ts';
import {
  enrollmentProfileReconciliationLayer,
  makeEnrollmentProfileReconciliationFixture,
} from '../support/enrollment-profile-reconciliation.fixture.ts';

type NativeProfileFixture = Effect.Success<ReturnType<typeof makeEnrollmentProfileReconciliationFixture>>;

/**
 * The real registered Actions and Core invocation recovery establish command authority. The
 * deployed registry then reads the exact owner result. Only the remote Party fact and the
 * bounded Shell issuer are test-owned; neither supplies a command execution verdict.
 */

const REQUEST_DIGEST = 'a'.repeat(64);
const RESULT_DIGEST = 'b'.repeat(64);
const CANDIDATE_DIGEST = 'c'.repeat(64);
const INTENT_DIGEST = 'd'.repeat(64);

const ensureTransition: JourneyTransitionSpec = {
  ownerModuleKey: COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
  required: true,
  transitionKey: ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
};
const bindTransition: JourneyTransitionSpec = {
  ownerModuleKey: COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
  required: true,
  transitionKey: BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
};

const unreachable = (operationName: string) => () => Effect.die(`${operationName} is not part of this scenario`);

/** Neither transition calls the Core identity owner. Native invocation recovery is a separate path. */
const coreClient: ExternalIdentityClientPort = {
  activatePrincipalBinding: unreachable('activatePrincipalBinding'),
  changePrincipalBindingStatus: unreachable('changePrincipalBindingStatus'),
  issueExternalGatewayContext: unreachable('issueExternalGatewayContext'),
  readPrincipalBinding: unreachable('readPrincipalBinding'),
  reservePrincipalBinding: unreachable('reservePrincipalBinding'),
  resolveExternalSubject: unreachable('resolveExternalSubject'),
};

/**
 * The deployed registry reads through real native scoped owner transactions. Its recovery client
 * reaches the actual HTTP handler and Core resolver before any owner result can establish success.
 */
const registryLive = (native: NativeProfileFixture) =>
  CommerceEnrollmentOwnerEffectRegistryLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ExternalIdentityClient, coreClient),
        Layer.succeed(CommerceCoreIdentityClientConfig, {
          apiKey: Redacted.make('enrollment-profile-reconciliation'),
          baseUrl: 'https://core-identity.invalid',
        }),
        Layer.succeed(CommercePortalAuthAccountLookupService, {
          existsByEmail: unreachable('existsByEmail'),
          existsByProviderSubject: unreachable('existsByProviderSubject'),
          subjectForOwnerInvocation: unreachable('subjectForOwnerInvocation'),
          verifiedEmailForOwnerInvocation: () => Effect.succeed(false),
        }),
        Layer.succeed(CommercePortalAuthAccountCreationReconciliationService, {
          reissueVerificationEmail: unreachable('reissueVerificationEmail'),
        }),
        Layer.succeed(CommerceEnrollmentOwnerTransactionRunner, {
          run: native.run,
          runWorker: () => Effect.die('Profile reconciliation must not discover worker work'),
        }),
        Layer.succeed(ProfileRetailPermissionReaderFactory, native.reader),
      ),
    ),
  );

type Scenario = Pick<
  NativeProfileFixture,
  | 'actorPrincipalId'
  | 'at'
  | 'attemptId'
  | 'bindInvocationId'
  | 'compositionRevision'
  | 'ensureInvocationId'
  | 'legalEntityId'
  | 'partyResourceId'
  | 'tenantId'
>;

const operation = (
  identities: Scenario,
  overrides: Pick<
    EnrollmentOwnerOperationSnapshot,
    'ownerInvocationId' | 'portalEnrollmentOwnerOperationId' | 'status' | 'transitionKey'
  > &
    Partial<EnrollmentOwnerOperationSnapshot>,
): EnrollmentOwnerOperationSnapshot => ({
  actorPrincipalId: Schema.decodeSync(EnrollmentPrincipalIdSchema)(identities.actorPrincipalId),
  createdAt: identities.at,
  ownerModuleKey: Schema.decodeSync(EnrollmentModuleKeySchema)(COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY),
  portalEnrollmentAttemptId: Schema.decodeSync(EnrollmentAttemptIdSchema)(identities.attemptId),
  requestDigest: REQUEST_DIGEST,
  required: true,
  revision: 1,
  tenantId: Schema.decodeSync(EnrollmentTenantIdSchema)(identities.tenantId),
  updatedAt: identities.at,
  ...overrides,
});

const attemptFor = (identities: Scenario): EnrollmentAttemptSnapshot => ({
  compositionRevision: identities.compositionRevision,
  createdAt: identities.at,
  createdByPrincipalId: Schema.decodeSync(EnrollmentPrincipalIdSchema)(identities.actorPrincipalId),
  intentDigest: INTENT_DIGEST,
  intentKey: Schema.decodeSync(EnrollmentKeySchema)(
    'commerce.customer-context.portal-enrollment.retail_self_enrollment.reconciliation',
  ),
  journey: 'RETAIL_SELF_ENROLLMENT',
  portalEnrollmentAttemptId: Schema.decodeSync(EnrollmentAttemptIdSchema)(identities.attemptId),
  revision: 5,
  state: 'RECONCILIATION_REQUIRED',
  targetLegalEntityId: Schema.decodeSync(EnrollmentLegalEntityIdSchema)(identities.legalEntityId),
  tenantId: Schema.decodeSync(EnrollmentTenantIdSchema)(identities.tenantId),
  updatedAt: identities.at,
});

/** The durable journey subject, exactly as the preparation resolver rebuilds it from the Attempt. */
const contextFor = (
  identities: Scenario,
  operations: readonly EnrollmentOwnerOperationSnapshot[],
): CommerceEnrollmentOwnerEffectContext => ({
  attempt: attemptFor(identities),
  operations,
  requestCorrelation: `enrollment-profile-reconciliation-${identities.attemptId}`,
  subject: {
    partyCandidateDigest: CANDIDATE_DIGEST,
    partyRef: Option.some({
      moduleId: 'party.registry',
      resourceId: identities.partyResourceId,
      resourceType: 'party.registry.party',
      tenantId: identities.tenantId,
    }),
    portalEnrollmentAttemptId: Schema.decodeSync(EnrollmentAttemptIdSchema)(identities.attemptId),
    principalRef: {
      moduleId: 'core.identity',
      resourceId: identities.actorPrincipalId,
      resourceType: 'core.identity.principal',
      tenantId: identities.tenantId,
    },
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: identities.legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId: identities.tenantId,
    },
  },
});

const reconciliationFor = (identities: Scenario, transition: JourneyTransitionSpec, ownerInvocationId: string) => ({
  ...Schema.decodeUnknownSync(CommerceEnrollmentOwnerTransitionSchema)({
    actorPrincipalId: identities.actorPrincipalId,
    compositionRevision: identities.compositionRevision,
    correlationId: `enrollment-profile-reconciliation-${identities.attemptId}`,
    expectedRevision: 5,
    ownerInvocationId,
    ownerModuleKey: transition.ownerModuleKey,
    portalEnrollmentAttemptId: identities.attemptId,
    requestDigest: REQUEST_DIGEST,
    tenantId: identities.tenantId,
    transitionKey: transition.transitionKey,
  }),
  observedRevision: 5,
  ownerOperationRevision: 1,
});

/** The ensure transition's durable journal entry once its Action response was lost. */
const indeterminateEnsure = (identities: Scenario): EnrollmentOwnerOperationSnapshot =>
  operation(identities, {
    ownerInvocationId: Schema.decodeSync(EnrollmentActionInvocationIdSchema)(identities.ensureInvocationId),
    portalEnrollmentOwnerOperationId: Schema.decodeSync(EnrollmentOwnerOperationIdSchema)(randomUUID()),
    status: 'INDETERMINATE',
    transitionKey: Schema.decodeSync(EnrollmentTransitionKeySchema)(ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY),
  });

const succeededEnsure = (identities: Scenario, profileId: string): EnrollmentOwnerOperationSnapshot =>
  operation(identities, {
    outcomeCode: Schema.decodeSync(EnrollmentKeySchema)('retail_customer_profile_ensured'),
    ownerInvocationId: Schema.decodeSync(EnrollmentActionInvocationIdSchema)(identities.ensureInvocationId),
    portalEnrollmentOwnerOperationId: Schema.decodeSync(EnrollmentOwnerOperationIdSchema)(randomUUID()),
    resultDigest: RESULT_DIGEST,
    resultReference: Schema.decodeSync(EnrollmentResourceIdSchema)(profileId),
    status: 'SUCCEEDED',
    transitionKey: Schema.decodeSync(EnrollmentTransitionKeySchema)(ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY),
  });

const indeterminateBind = (identities: Scenario): EnrollmentOwnerOperationSnapshot =>
  operation(identities, {
    ownerInvocationId: Schema.decodeSync(EnrollmentActionInvocationIdSchema)(identities.bindInvocationId),
    portalEnrollmentOwnerOperationId: Schema.decodeSync(EnrollmentOwnerOperationIdSchema)(randomUUID()),
    status: 'INDETERMINATE',
    transitionKey: Schema.decodeSync(EnrollmentTransitionKeySchema)(BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY),
  });

const reconcileThrough = (
  native: NativeProfileFixture,
  transition: JourneyTransitionSpec,
  context: CommerceEnrollmentOwnerEffectContext,
  reconciliation: CommerceEnrollmentOwnerReconciliationInput,
) =>
  CommerceEnrollmentOwnerEffectRegistry.pipe(
    Effect.flatMap((registry) => registry.resolve(transition, context)),
    Effect.flatMap((resolved) =>
      Option.isNone(resolved)
        ? Effect.die('The registry declares no owner effect for this Commerce-owned transition')
        : resolved.value.reconcile(reconciliation),
    ),
    Effect.tapError(() =>
      Effect.logWarning('ENROLLMENT_PROFILE_RECONCILIATION_HTTP', {
        nativeStates: native.recoveries.map(({ result }) => result.state),
        responses: native.httpRequests.map(({ kind, status }) => ({ kind, status })),
      }),
    ),
    Effect.provide(registryLive(native)),
    Effect.provide(native.transport),
  );

/** Recovery must use the original key and real caller, never merely find a matching owner row. */
const expectNativeRecovery = (
  native: NativeProfileFixture,
  transition: JourneyTransitionSpec,
  idempotencyKey: string,
  retryStatus?: 200 | 409,
) => {
  const requestCount = retryStatus === undefined ? 1 : 2;
  expect(native.issuances).toHaveLength(requestCount);
  expect(new Set(native.issuances).size).toBe(requestCount);
  expect(native.recoveries).toHaveLength(1);
  expect(native.redemptionCount()).toBe(requestCount);
  expect(native.httpRequests).toHaveLength(requestCount);
  expect(native.httpRequests[0]).toMatchObject({
    actionKey: transition.transitionKey,
    idempotencyKey,
    kind: 'recovery',
    status: 200,
  });
  if (retryStatus !== undefined) {
    expect(native.httpRequests[1]).toMatchObject({
      actionKey: transition.transitionKey,
      idempotencyKey,
      kind: 'retry',
      status: retryStatus,
    });
  }
  expect(native.httpRequests.map(({ jti }) => jti)).toEqual(native.issuances);
  expect(native.redeemedAssertions()).toEqual(native.issuances);
  expect(native.recoveries[0]?.input).toMatchObject({
    actionKey: transition.transitionKey,
    idempotencyKey,
    principal: {
      authMethod: 'api_key',
      legalEntityId: native.legalEntityId,
      principalId: native.actorPrincipalId,
      tenantId: native.tenantId,
    },
  });
};

it.layer(enrollmentProfileReconciliationLayer, { excludeTestServices: true })((nativeIt) => {
  nativeIt.effect('reconciles a committed Retail Customer Profile ensure whose response was lost', () =>
    Effect.scoped(
      Effect.gen(function* lostEnsureResponse() {
        const native = yield* makeEnrollmentProfileReconciliationFixture();
        native.loseNextAcknowledgement();
        const lost = yield* Effect.flip(native.ensure());
        expect(Schema.is(ActionCommitIndeterminate)(lost)).toBe(true);
        if (!Schema.is(ActionCommitIndeterminate)(lost)) {
          return yield* Effect.die('The registered ensure did not reach the controlled lost acknowledgement');
        }
        const profile = yield* native.readProfile();
        expect(Option.isSome(profile)).toBe(true);
        if (Option.isNone(profile)) {
          return yield* Effect.die('The native ensure committed no Retail Customer Profile');
        }
        const resolution = yield* reconcileThrough(
          native,
          ensureTransition,
          contextFor(native, [indeterminateEnsure(native)]),
          reconciliationFor(native, ensureTransition, native.ensureInvocationId),
        );

        expectNativeRecovery(native, ensureTransition, native.ensureInvocationId);
        expect(native.recoveries[0]?.result).toMatchObject({
          invocationId: lost.invocationId,
          retryCommand: false,
          state: 'COMMITTED',
        });
        expect(resolution.status).toBe('SUCCEEDED');
        expect(String(resolution.outcomeCode)).toBe('retail_customer_profile_ensured');
        expect(String(resolution.resultReference)).toBe(profile.value.profileRef.resourceId);
        return yield* Effect.void;
      }),
    ),
  );

  nativeIt.effect('retries an uncommitted Retail Customer Profile ensure only under its original command key', () =>
    Effect.scoped(
      Effect.gen(function* ensureNeverCommitted() {
        const native = yield* makeEnrollmentProfileReconciliationFixture();
        // A real profile exists, but another command created it. Its existence cannot prove that
        // the original key committed. Native recovery must answer NOT_STARTED before a real retry.
        const differentKey = randomUUID();
        const differentCommand = yield* native.ensure(differentKey);
        expect(differentCommand.outcome).toBe('PROFILE_CREATED');
        const differentExecution = yield* native.resolveCommand(ensureTransition.transitionKey, differentKey);
        const resolution = yield* reconcileThrough(
          native,
          ensureTransition,
          contextFor(native, [indeterminateEnsure(native)]),
          reconciliationFor(native, ensureTransition, native.ensureInvocationId),
        );
        expectNativeRecovery(native, ensureTransition, native.ensureInvocationId, 200);
        expect(native.recoveries[0]?.result).toEqual({ retryCommand: true, state: 'NOT_STARTED' });
        expect(resolution.status).toBe('SUCCEEDED');
        expect(resolution.resultReference).toBe(differentCommand.profileRef.resourceId);
        const execution = yield* native.resolveCommand(ensureTransition.transitionKey, native.ensureInvocationId);
        expect(execution).toMatchObject({
          actionKey: ensureTransition.transitionKey,
          retryCommand: false,
          state: 'COMMITTED',
        });
        if (execution.state !== 'COMMITTED' || differentExecution.state !== 'COMMITTED') {
          return yield* Effect.die('The exact ensure commands did not commit separately');
        }
        expect(execution.invocationId).not.toBe(differentExecution.invocationId);
        return yield* Effect.void;
      }),
    ),
  );

  nativeIt.effect(
    'retains a committed Retail Portal Profile Binding as pending when its response was lost before grants settled',
    () =>
      Effect.scoped(
        Effect.gen(function* lostBindResponse() {
          const native = yield* makeEnrollmentProfileReconciliationFixture();
          const ensured = yield* native.ensure();
          expect(ensured.outcome).toBe('PROFILE_CREATED');
          native.loseNextAcknowledgement();
          const lost = yield* Effect.flip(native.bind(ensured.profileRef));
          expect(Schema.is(ActionCommitIndeterminate)(lost)).toBe(true);
          if (!Schema.is(ActionCommitIndeterminate)(lost)) {
            return yield* Effect.die('The registered binding did not reach the controlled lost acknowledgement');
          }
          const resolution = yield* reconcileThrough(
            native,
            bindTransition,
            contextFor(native, [succeededEnsure(native, ensured.profileRef.resourceId), indeterminateBind(native)]),
            reconciliationFor(native, bindTransition, native.bindInvocationId),
          );

          expectNativeRecovery(native, bindTransition, native.bindInvocationId);
          expect(native.recoveries[0]?.result).toMatchObject({
            invocationId: lost.invocationId,
            retryCommand: false,
            state: 'COMMITTED',
          });
          // No worker runs here. A committed native binding with pending grants is not Current.
          expect(resolution).toMatchObject({
            actorPrincipalId: native.actorPrincipalId,
            failureCode: 'owner_reconciliation_required',
            nextState: 'RECONCILIATION_REQUIRED',
            outcomeCode: RETAIL_PORTAL_GRANTS_INCOMPLETE_OUTCOME_CODE,
            status: 'FAILED',
          });
          expect(resolution.resultReference).toBeUndefined();
          expect(String(resolution.reconciliationRef).length).toBeGreaterThan(0);
          return yield* Effect.void;
        }),
      ),
  );

  nativeIt.effect('preserves the binding owned by a different command when the original-key retry conflicts', () =>
    Effect.scoped(
      Effect.gen(function* bindNeverCommitted() {
        const native = yield* makeEnrollmentProfileReconciliationFixture();
        const ensured = yield* native.ensure();
        expect(ensured.outcome).toBe('PROFILE_CREATED');
        // Even an exact owner binding created under another key is not this command's result.
        const differentKey = randomUUID();
        const differentCommand = yield* native.bind(ensured.profileRef, differentKey);
        expect(differentCommand.outcome).toBe('BINDING_ACTIVATED');
        const differentExecution = yield* native.resolveCommand(bindTransition.transitionKey, differentKey);
        const bindingBefore = yield* native.readBinding(ensured.profileRef);
        expect(Option.isSome(bindingBefore)).toBe(true);
        if (Option.isNone(bindingBefore)) {
          return yield* Effect.die('The different command committed no binding to preserve');
        }
        expect(bindingBefore.value.bindingRef).toEqual(differentCommand.bindingRef);
        const failure = yield* Effect.flip(
          reconcileThrough(
            native,
            bindTransition,
            contextFor(native, [succeededEnsure(native, ensured.profileRef.resourceId), indeterminateBind(native)]),
            reconciliationFor(native, bindTransition, native.bindInvocationId),
          ),
        );
        expectNativeRecovery(native, bindTransition, native.bindInvocationId, 409);
        expect(native.recoveries[0]?.result).toEqual({ retryCommand: true, state: 'NOT_STARTED' });
        const unavailable = yield* Schema.decodeUnknownEffect(CommerceEnrollmentOwnerEffectUnavailable)(failure);
        expect(unavailable.code).toBe('commerce_profile_unavailable');
        const conflict = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ cause: BindRetailPortalProfileActionConflictProblemSchema }),
        )(failure);
        expect(conflict.cause).toMatchObject({
          code: 'BINDING_CONFLICT',
          status: 409,
        });
        const execution = yield* native.resolveCommand(bindTransition.transitionKey, native.bindInvocationId);
        expect(execution).toMatchObject({
          retryCommand: true,
          state: 'RETRYABLE',
        });
        if (execution.state !== 'RETRYABLE' || differentExecution.state !== 'COMMITTED') {
          return yield* Effect.die('Core did not retain the distinct retryable original and committed binding command');
        }
        expect(execution.invocationId).not.toBe(differentExecution.invocationId);
        expect(yield* native.resolveCommand(bindTransition.transitionKey, differentKey)).toEqual(differentExecution);
        expect(yield* native.readBinding(ensured.profileRef)).toEqual(bindingBefore);
        return yield* Effect.void;
      }),
    ),
  );
});
