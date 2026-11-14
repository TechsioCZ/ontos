import {
  assertCurrentExternalIdentityBinding,
  CurrentExternalIdentityBindingSchema,
  readVerifiedGatewayActor,
  readVerifiedGatewayCompositionRevision,
} from '@app/core-runtime';
import type { ActionServicePreparationContext, OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { Context, DateTime, Effect, Option, Schema } from 'effect';
import type { ReadPrincipalBindingResultSchema } from '@app/core-runtime/auth/external-identity-contracts';

import { RetailPortalBindingActionRejected } from '../../shared/actions/bind-retail-portal-profile.ts';
import type { RetailPortalBindingPayload } from '../../shared/actions/bind-retail-portal-profile.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ReadEnrollmentAttemptInputSchema, isEnrollmentAttemptTerminal } from '../../shared/enrollment-contracts.ts';
import type {
  CommercePortalAccountSubject,
  EnrollmentAttemptSnapshot,
  EnrollmentOwnerOperationSnapshot,
} from '../../shared/enrollment-contracts.ts';
import { commerceEnrollmentAttemptPersistenceForTransaction } from '../enrollment/attempts/attempt-persistence.ts';
import {
  BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
  ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  PARTY_REGISTRY_OWNER_MODULE_KEY,
  retailPartyRefFor,
  retailSelfEnrollmentRequestDigest,
  OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE,
} from '../enrollment/journeys/retail-self-enrollment-contracts.ts';
import {
  CORE_IDENTITY_OWNER_MODULE_KEY,
  ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY,
  RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY,
} from '../enrollment/journeys/existing-account.ts';
import {
  readRetailEnrollmentRestartContext,
  retailRestartIdentity,
  RETAIN_RETAIL_RESULTS_TRANSITION,
} from '../enrollment/journeys/retail-enrollment-restart.ts';
import type { RetailEnrollmentRestartContext } from '../enrollment/journeys/retail-enrollment-restart.ts';
import {
  PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  PORTAL_AUTH_OWNER_MODULE_KEY,
} from '../enrollment/orchestration/prepared-owner-authority.ts';
import { readRetailProfileByParty, readRetailProfileLifecycle } from '../persistence/profile-persistence.ts';
import { stableRevision } from '../stable-revision.ts';

export type CurrentRetailEnrollmentIdentity = Extract<
  typeof ReadPrincipalBindingResultSchema.Type,
  { readonly outcome: 'FOUND' }
>;

/** Read-only owner transport. It returns identity evidence, never a customer execution context. */
export class RetailEnrollmentTargetIdentity extends Context.Service<
  RetailEnrollmentTargetIdentity,
  {
    readonly resolve: (input: {
      readonly accountSubject: CommercePortalAccountSubject;
      readonly providerInvocationId: string;
      readonly scope: OperationalScope;
    }) => Effect.Effect<CurrentRetailEnrollmentIdentity, RetailPortalBindingActionRejected>;
  }
>()('@app/commerce-customer-context/integrations/retail-enrollment-binding/RetailEnrollmentTargetIdentity') {}

const rejected = (reason: string) =>
  new RetailPortalBindingActionRejected({ code: 'ENROLLMENT_EVIDENCE_INSUFFICIENT', reason, retryable: false });
const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new RetailPortalBindingActionRejected({
      code: 'DEPENDENCY_UNAVAILABLE',
      reason: 'Current enrollment target identity is unavailable',
      retryable: true,
    }),
    'cause',
    { value: cause },
  );

const bindingScopeMatches = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  revision: string,
  payload: RetailPortalBindingPayload,
) =>
  transaction.scope.tenantId === scope.tenantId &&
  transaction.scope.legalEntityId === scope.legalEntityId &&
  readVerifiedGatewayActor(scope)?.appId === 'commerce-customer-context' &&
  readVerifiedGatewayCompositionRevision(scope) === revision &&
  payload.profileRef.tenantId === scope.tenantId &&
  payload.principalRef.tenantId === scope.tenantId &&
  payload.sellingLegalEntityRef.tenantId === scope.tenantId &&
  payload.sellingLegalEntityRef.resourceId === scope.legalEntityId &&
  payload.expectedState === null &&
  payload.expectedRevision === null;

const attemptMatchesBinding = (
  attempt: EnrollmentAttemptSnapshot,
  scope: OperationalScope,
  revision: string,
  payload: RetailPortalBindingPayload,
  profile: Effect.Success<ReturnType<typeof readRetailProfileLifecycle>>,
) =>
  attempt.portalEnrollmentAttemptId === payload.enrollmentEvidenceRef &&
  attempt.tenantId === scope.tenantId &&
  !isEnrollmentAttemptTerminal(attempt.state) &&
  attempt.targetLegalEntityId === scope.legalEntityId &&
  attempt.createdByPrincipalId === scope.principalId &&
  attempt.compositionRevision === revision &&
  attempt.originatorActionInvocationId !== undefined &&
  payload.effectiveAt === DateTime.formatIso(attempt.createdAt) &&
  Option.isSome(profile) &&
  !profile.value.reconciling &&
  profile.value.state === 'ACTIVE';

const bindingIntentMatches = (
  binding: EnrollmentOwnerOperationSnapshot,
  attempt: EnrollmentAttemptSnapshot,
  scope: OperationalScope,
  partyId: string,
  payload: RetailPortalBindingPayload,
) =>
  binding.actorPrincipalId === scope.principalId &&
  (binding.status === 'IN_PROGRESS' ||
    (binding.status === 'FAILED' && binding.failureCode === OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE)) &&
  binding.requestDigest ===
    retailSelfEnrollmentRequestDigest({
      intent: {
        partyRef: retailPartyRefFor(attempt.tenantId, partyId),
        principalRef: payload.principalRef,
        sellingLegalEntityRef: payload.sellingLegalEntityRef,
        step: 'RETAIL_PORTAL_BINDING',
      },
      ownerModuleKey: binding.ownerModuleKey,
      portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
      transitionKey: binding.transitionKey,
    });

const retainedEnrollmentReferences = (
  succeeded: (moduleKey: string, key: string) => EnrollmentOwnerOperationSnapshot | undefined,
  restart: Option.Option<RetailEnrollmentRestartContext>,
) => {
  const partyId =
    succeeded(PARTY_REGISTRY_OWNER_MODULE_KEY, PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY)?.resultReference ??
    Option.getOrUndefined(restart)?.partyId;
  const ensuredProfileId =
    succeeded(COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY, ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY)
      ?.resultReference ?? Option.getOrUndefined(restart)?.profileId;
  const provider = succeeded(PORTAL_AUTH_OWNER_MODULE_KEY, PORTAL_ACCOUNT_CREATION_TRANSITION_KEY);
  const providerInvocationId = Option.getOrUndefined(restart)?.providerOwnerInvocationId ?? provider?.ownerInvocationId;
  const journalBindingId =
    succeeded(CORE_IDENTITY_OWNER_MODULE_KEY, ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY)?.resultReference ??
    succeeded(CORE_IDENTITY_OWNER_MODULE_KEY, RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY)?.resultReference;
  return { ensuredProfileId, journalBindingId, partyId, providerInvocationId };
};

const ownerJournalForBinding = Effect.fn('RetailEnrollmentBinding.validateJournal')(function* validateJournal(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  payload: RetailPortalBindingPayload,
  attempt: EnrollmentAttemptSnapshot,
  operations: readonly EnrollmentOwnerOperationSnapshot[],
) {
  const succeeded = (moduleKey: string, key: string) =>
    operations.find(
      (operation) =>
        operation.ownerModuleKey === moduleKey &&
        operation.transitionKey === key &&
        operation.status === 'SUCCEEDED' &&
        operation.actorPrincipalId === attempt.createdByPrincipalId,
    );
  const restart = Option.isSome(retailRestartIdentity(attempt))
    ? yield* readRetailEnrollmentRestartContext(transaction, attempt.portalEnrollmentAttemptId, false).pipe(
        Effect.mapError(unavailable),
      )
    : Option.none();
  if (
    attempt.journey !== 'RETAIL_SELF_ENROLLMENT' &&
    (Option.isNone(restart) ||
      succeeded(COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY, RETAIN_RETAIL_RESULTS_TRANSITION)?.resultReference !==
        String(restart.value.sourceAttemptId))
  ) {
    return yield* rejected('The enrollment has no current retained predecessor proof');
  }
  const { ensuredProfileId, journalBindingId, partyId, providerInvocationId } = retainedEnrollmentReferences(
    succeeded,
    restart,
  );
  const binding = operations.find(
    (operation) =>
      operation.ownerModuleKey === COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY &&
      operation.transitionKey === BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  );
  if (
    partyId === undefined ||
    ensuredProfileId !== payload.profileRef.resourceId ||
    providerInvocationId === undefined ||
    binding === undefined ||
    !bindingIntentMatches(binding, attempt, scope, partyId, payload)
  ) {
    return yield* rejected('The binding intent does not match the native owner journal');
  }
  const profile = yield* readRetailProfileByParty(transaction, partyId).pipe(Effect.mapError(unavailable));
  if (
    Option.isNone(profile) ||
    profile.value.state !== 'ACTIVE' ||
    profile.value.profileRef.resourceId !== payload.profileRef.resourceId
  ) {
    return yield* rejected('The ensured profile does not belong to the enrollment Party');
  }
  return {
    binding,
    journalBindingId,
    profile: profile.value,
    providerInvocationId,
  };
});

/** The owner rows remain locked until this SQL phase commits; no remote service is called here. */
export const loadRetailEnrollmentBindingSnapshot = Effect.fn('RetailEnrollmentBinding.loadSnapshot')(function* load(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  compositionRevision: string,
  payload: RetailPortalBindingPayload,
) {
  const { legalEntityId } = scope;
  if (legalEntityId === undefined || !bindingScopeMatches(transaction, scope, compositionRevision, payload)) {
    return yield* rejected('Delegated binding requires the exact verified owner, Tenant and company');
  }
  const identity = yield* Schema.decodeUnknownEffect(ReadEnrollmentAttemptInputSchema)({
    portalEnrollmentAttemptId: payload.enrollmentEvidenceRef,
    tenantId: scope.tenantId,
  }).pipe(Effect.mapError(unavailable));
  // Owner state is read only through its owned routines; the binding routine itself re-verifies the profile and
  // serializes the binding under its own lock when the Action commits.
  const profile = yield* readRetailProfileLifecycle(transaction, payload.profileRef.resourceId).pipe(
    Effect.mapError(unavailable),
  );
  const persistence = commerceEnrollmentAttemptPersistenceForTransaction(transaction, {
    legalEntityId,
    tenantId: scope.tenantId,
  });
  const { attempt, operations } = yield* Effect.all(
    {
      attempt: persistence.read(identity),
      operations: persistence.readOperations(identity),
    },
    { concurrency: 1 },
  ).pipe(
    // An enrollment the Storefront client never started is a definite refusal, not an unavailable owner.
    Effect.catchTag('CommerceEnrollmentAttemptNotFound', () =>
      Effect.fail(rejected('The target must belong to the current open enrollment and Active Retail profile')),
    ),
    Effect.mapError((failure) =>
      Schema.is(RetailPortalBindingActionRejected)(failure) ? failure : unavailable(failure),
    ),
  );
  const { accountSubject } = attempt;
  if (
    accountSubject === undefined ||
    accountSubject.authenticationNamespaceId !== COMMERCE_AUTHENTICATION_NAMESPACE_ID ||
    accountSubject.subjectType !== 'user' ||
    !attemptMatchesBinding(attempt, scope, compositionRevision, payload, profile)
  ) {
    return yield* rejected('The target must belong to the current open enrollment and Active Retail profile');
  }
  const now = yield* DateTime.now;
  if (
    (attempt.lease !== undefined &&
      DateTime.toEpochMillis(attempt.lease.leaseExpiresAt) <= DateTime.toEpochMillis(now)) ||
    operations.some(
      (operation) =>
        operation.status === 'IN_PROGRESS' &&
        operation.lease !== undefined &&
        DateTime.toEpochMillis(operation.lease.leaseExpiresAt) <= DateTime.toEpochMillis(now),
    )
  ) {
    return yield* rejected('The enrollment owner lease has expired');
  }
  const journal = yield* ownerJournalForBinding(transaction, scope, payload, attempt, operations);
  return { accountSubject, attempt, operations, profileRevision: Option.getOrUndefined(profile)?.revision, ...journal };
});

/** Invocation-local target assertion, consumed once inside the actual Action transaction. */
type PreparedRetailEnrollmentTargetAssertion = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  revision: string,
  candidate: RetailPortalBindingPayload,
  actionInvocationId: string,
) => Effect.Effect<
  Pick<typeof CurrentExternalIdentityBindingSchema.Type, 'authBindingId' | 'principalId'>,
  RetailPortalBindingActionRejected
>;

/** Prepared after authorization, outside SQL; consumed only for this actual Action invocation. */
export const prepareRetailEnrollmentTargetBinding = Effect.fn('RetailEnrollmentBinding.prepareTarget')(
  function* prepare(payload: RetailPortalBindingPayload, context: ActionServicePreparationContext) {
    const expectedPayload = stableRevision(payload);
    const snapshot = yield* context.transaction((transaction) =>
      loadRetailEnrollmentBindingSnapshot(transaction, context.scope, context.compositionRevision, payload),
    );
    const targetIdentity = yield* Effect.serviceOption(RetailEnrollmentTargetIdentity);
    if (Option.isNone(targetIdentity)) {
      return yield* unavailable('No current identity evidence transport is composed');
    }
    const identity = yield* targetIdentity.value.resolve({
      accountSubject: snapshot.accountSubject,
      providerInvocationId: snapshot.providerInvocationId,
      scope: context.scope,
    });
    if (
      identity.principalId !== payload.principalRef.resourceId ||
      String(identity.authenticationNamespaceId) !== String(snapshot.accountSubject.authenticationNamespaceId) ||
      identity.bindingStatus !== 'active' ||
      identity.principalStatus !== 'active' ||
      identity.tenantStatus !== 'active' ||
      (snapshot.journalBindingId !== undefined && String(identity.authBindingId) !== String(snapshot.journalBindingId))
    ) {
      return yield* rejected('Current identity does not match the enrollment target');
    }
    const expected = yield* Schema.decodeUnknownEffect(CurrentExternalIdentityBindingSchema)({
      authBindingId: identity.authBindingId,
      authenticationNamespaceId: identity.authenticationNamespaceId,
      bindingRevision: identity.bindingRevision,
      principalId: identity.principalId,
      providerSubjectId: snapshot.accountSubject.providerSubjectId,
      subjectType: snapshot.accountSubject.subjectType,
      tenantId: context.scope.tenantId,
    }).pipe(Effect.mapError(unavailable));
    const snapshotRevision = stableRevision(snapshot);
    let consumed = false;
    const assertPreparedTarget: PreparedRetailEnrollmentTargetAssertion = Effect.fn(
      'RetailEnrollmentBinding.assertTarget',
    )(function* assertTarget(transaction, scope, revision, candidate, actionInvocationId) {
      if (
        consumed ||
        scope !== context.scope ||
        revision !== context.compositionRevision ||
        actionInvocationId !== context.actionInvocationId ||
        stableRevision(candidate) !== expectedPayload
      ) {
        return yield* rejected('Prepared target evidence belongs to another Action invocation or requester');
      }
      consumed = true;
      const current = yield* loadRetailEnrollmentBindingSnapshot(transaction, scope, revision, candidate);
      if (stableRevision(current) !== snapshotRevision) {
        return yield* rejected('The enrollment journal or profile changed during identity preparation');
      }
      yield* assertCurrentExternalIdentityBinding(transaction, expected).pipe(
        Effect.mapError((cause) =>
          cause.code === 'identity_forbidden'
            ? rejected('The target identity is no longer current')
            : unavailable(cause),
        ),
      );
      return { authBindingId: expected.authBindingId, principalId: expected.principalId };
    });
    return assertPreparedTarget;
  },
);
