import type { ActionAuthorizationPreflightInput } from '@app/core-runtime';
import type {
  EnrollmentAttemptSnapshot,
  EnrollmentOwnerOperationSnapshot,
  ReadEnrollmentAttemptInput,
} from '../../shared/enrollment-contracts.ts';
import type { RetailPortalBindingPayload } from '../../shared/actions/bind-retail-portal-profile.ts';
import { ActionPermissionCheckError } from '@app/core-runtime';
import { ReadPrincipalBindingPayloadSchema } from '@app/core-runtime/auth/external-identity-contracts';
import type {
  ExternalIdentityClientPort,
  ReadPrincipalBindingRequest,
} from '@app/shared-contracts/server/external-identity-client';
import type { CommerceEnrollmentOwnerAttemptStore } from '../enrollment/orchestration/owner-transition-driver.ts';
import type { CommerceEnrollmentAttemptError } from '../enrollment/attempts/errors.ts';
import type { EnsureRetailCustomerProfileResult } from '../../shared/actions/ensure-retail-customer-profile.ts';
import type { CommercePortalAuthAccountLookup } from '../../api/portal-auth/provider/account-lookup-service.ts';
import { ExternalIdentityClient } from '@app/shared-contracts/server/external-identity-client';
import { DateTime, Effect, Layer, Option, Schema } from 'effect';
import {
  CommerceCoreIdentityClientConfig,
  commerceCoreIdentityClientOptions,
} from '../../api/portal-auth/provider/core-identity-client-config.ts';
import { CommercePortalAuthAccountLookupService } from '../../api/portal-auth/provider/account-lookup-service.ts';
import {
  EnrollmentAttemptIdSchema,
  EnrollmentTenantIdSchema,
  ReadEnrollmentOwnerOperationInputSchema,
} from '../../shared/enrollment-contracts.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import {
  CommerceEnrollmentOwnerTransactionRunner,
  commerceEnrollmentOwnerAttemptStoreForRun,
} from '../enrollment/orchestration/owner-transition-production.ts';
import {
  readRetailEnrollmentRestartContext,
  retailRestartIdentity,
  RETAIN_RETAIL_RESULTS_TRANSITION,
} from '../enrollment/journeys/retail-enrollment-restart.ts';
import type { RetailEnrollmentRestartContext } from '../enrollment/journeys/retail-enrollment-restart.ts';
import { attemptUnavailable } from '../enrollment/attempts/errors.ts';
import { readRetailProfileByParty } from '../persistence/profile-persistence.ts';
import { RetailEnrollmentBindingAuthority } from './retail-enrollment-binding.ts';
import type { RetailEnrollmentBindingPreparer } from './retail-enrollment-binding.ts';

export interface RetailEnrollmentBindingPorts {
  readonly predecessor: (
    attempt: EnrollmentAttemptSnapshot,
  ) => Effect.Effect<Option.Option<RetailEnrollmentRestartContext>, CommerceEnrollmentAttemptError>;
  readonly profile: (input: {
    readonly legalEntityId: string;
    readonly partyId: string;
    readonly tenantId: string;
  }) => Effect.Effect<Option.Option<EnsureRetailCustomerProfileResult>, CommerceEnrollmentAttemptError>;
  readonly readBinding: (
    request: ReadPrincipalBindingRequest,
    correlation: string,
  ) => ReturnType<ExternalIdentityClientPort['readPrincipalBinding']>;
  readonly store: (tenantId: typeof EnrollmentTenantIdSchema.Type) => CommerceEnrollmentOwnerAttemptStore;
  readonly verifiedEmail: CommercePortalAuthAccountLookup['verifiedEmailForOwnerInvocation'];
}

const requestMatchesCaller = (
  input: ActionAuthorizationPreflightInput,
  payload: RetailPortalBindingPayload,
): boolean => {
  const { legalEntityId, tenantId } = input.scope;
  return !(
    legalEntityId === undefined ||
    input.principal.authMethod !== 'api_key' ||
    input.principal.principalId !== input.scope.principalId ||
    input.principal.tenantId !== tenantId ||
    input.principal.legalEntityId !== legalEntityId ||
    payload.sellingLegalEntityRef.resourceId !== legalEntityId ||
    payload.sellingLegalEntityRef.tenantId !== tenantId ||
    payload.profileRef.tenantId !== tenantId ||
    payload.principalRef.tenantId !== tenantId ||
    payload.expectedState !== null ||
    payload.expectedRevision !== null
  );
};
const attemptMatchesRequest = (
  attempt: EnrollmentAttemptSnapshot,
  identity: ReadEnrollmentAttemptInput,
  input: ActionAuthorizationPreflightInput,
  payload: RetailPortalBindingPayload,
): boolean => {
  const { legalEntityId } = input.scope;
  const subject = attempt.accountSubject;
  return !(
    attempt.portalEnrollmentAttemptId !== identity.portalEnrollmentAttemptId ||
    attempt.tenantId !== identity.tenantId ||
    (attempt.journey !== 'RETAIL_SELF_ENROLLMENT' && Option.isNone(retailRestartIdentity(attempt))) ||
    attempt.state === 'FAILED' ||
    attempt.state === 'TERMINATED' ||
    attempt.state === 'COMPLETE' ||
    attempt.targetLegalEntityId !== legalEntityId ||
    subject === undefined ||
    subject.authenticationNamespaceId !== COMMERCE_AUTHENTICATION_NAMESPACE_ID ||
    subject.subjectType !== 'user' ||
    payload.effectiveAt !== DateTime.formatIso(attempt.createdAt)
  );
};

const CUSTOMER_CONTEXT_OWNER = 'commerce.customer-context';
const BIND_RETAIL_TRANSITION = 'commerce.customer-context.bind-retail-portal-profile';

const succeededOwnerReference = (value: Option.Option<EnrollmentOwnerOperationSnapshot>, actorId: string) =>
  Option.isSome(value) && value.value.status === 'SUCCEEDED' && value.value.actorPrincipalId === actorId
    ? value.value.resultReference
    : undefined;

const retainedResultsMatch = (
  retention: Option.Option<EnrollmentOwnerOperationSnapshot>,
  attempt: EnrollmentAttemptSnapshot,
  restart: Option.Option<RetailEnrollmentRestartContext>,
) =>
  Option.isSome(retention) &&
  Option.isSome(restart) &&
  retention.value.status === 'SUCCEEDED' &&
  retention.value.actorPrincipalId === attempt.createdByPrincipalId &&
  String(retention.value.resultReference) === String(restart.value.sourceAttemptId);

const bindingOwnerProof = Effect.fn('RetailEnrollmentBinding.ownerProof')(function* bindingOwnerProof(
  store: CommerceEnrollmentOwnerAttemptStore,
  identity: ReadEnrollmentAttemptInput,
  attempt: EnrollmentAttemptSnapshot,
  restart: Option.Option<RetailEnrollmentRestartContext>,
) {
  const operation = (ownerModuleKey: string, transitionKey: string) =>
    Schema.decodeEffect(ReadEnrollmentOwnerOperationInputSchema)({
      ...identity,
      ownerModuleKey,
      transitionKey,
    }).pipe(Effect.flatMap((request) => store.readOwnerOperation(request)));
  const isRestart = Option.isSome(retailRestartIdentity(attempt));
  if (isRestart && Option.isNone(restart)) {
    return Option.none();
  }
  const optionalOperation = (owner: string, transition: string) =>
    operation(owner, transition).pipe(
      Effect.asSome,
      Effect.catchTag('CommerceEnrollmentAttemptNotFound', () => Effect.succeedNone),
    );
  const { binding, ensured, party, provider, retention } = yield* Effect.all(
    {
      binding: operation(CUSTOMER_CONTEXT_OWNER, BIND_RETAIL_TRANSITION),
      ensured: optionalOperation(CUSTOMER_CONTEXT_OWNER, 'commerce.customer-context.ensure-retail-customer-profile'),
      party: optionalOperation('party.registry', 'party.candidate.submit'),
      provider: operation('commerce.portal-auth', isRestart ? 'provider.account.verify' : 'provider.account.create'),
      retention: isRestart
        ? optionalOperation(CUSTOMER_CONTEXT_OWNER, RETAIN_RETAIL_RESULTS_TRANSITION)
        : Effect.succeedNone,
    },
    { concurrency: 1 },
  );
  if (
    provider.status !== 'SUCCEEDED' ||
    provider.actorPrincipalId !== attempt.createdByPrincipalId ||
    binding.actorPrincipalId !== attempt.createdByPrincipalId ||
    !['IN_PROGRESS', 'INDETERMINATE', 'RECONCILIATION_REQUIRED'].includes(binding.status) ||
    (isRestart && !retainedResultsMatch(retention, attempt, restart))
  ) {
    return Option.none();
  }
  const partyId =
    succeededOwnerReference(party, attempt.createdByPrincipalId) ?? Option.getOrUndefined(restart)?.partyId;
  const profileId =
    succeededOwnerReference(ensured, attempt.createdByPrincipalId) ?? Option.getOrUndefined(restart)?.profileId;
  if (partyId === undefined || profileId === undefined) {
    return Option.none();
  }
  const providerInvocationId = Option.isSome(restart)
    ? restart.value.providerOwnerInvocationId
    : provider.ownerInvocationId;
  return Option.some({ partyId, profileId, providerInvocationId });
});

export const retailEnrollmentBindingForPorts = (ports: RetailEnrollmentBindingPorts): RetailEnrollmentBindingPreparer =>
  Effect.fn('RetailEnrollmentBinding.verifyAttempt')(
    function* verifyAttempt(input, payload) {
      const { legalEntityId, tenantId } = input.scope;
      if (legalEntityId === undefined || !requestMatchesCaller(input, payload)) {
        return Option.none();
      }
      const identity = yield* Schema.decodeEffect(
        Schema.Struct({
          portalEnrollmentAttemptId: EnrollmentAttemptIdSchema,
          tenantId: EnrollmentTenantIdSchema,
        }),
      )({ portalEnrollmentAttemptId: payload.enrollmentEvidenceRef, tenantId });
      const store = ports.store(identity.tenantId);
      const attempt = yield* store.read(identity);
      const subject = attempt.accountSubject;
      if (!attemptMatchesRequest(attempt, identity, input, payload) || subject === undefined) {
        return Option.none();
      }
      const restart = yield* ports.predecessor(attempt);
      const proof = yield* bindingOwnerProof(ports.store(identity.tenantId), identity, attempt, restart);
      if (Option.isNone(proof) || proof.value.profileId !== payload.profileRef.resourceId) {
        return Option.none();
      }
      const { partyId, providerInvocationId } = proof.value;
      const profile = yield* ports.profile({ legalEntityId, partyId: String(partyId), tenantId });
      if (
        Option.isNone(profile) ||
        profile.value.profileRef.resourceId !== payload.profileRef.resourceId ||
        profile.value.state !== 'ACTIVE'
      ) {
        return Option.none();
      }
      if (
        !(yield* ports.verifiedEmail({
          ownerInvocationId: providerInvocationId,
          providerSubjectId: subject.providerSubjectId,
        }))
      ) {
        return Option.none();
      }
      const request = yield* Schema.decodeEffect(ReadPrincipalBindingPayloadSchema)({
        authenticationNamespaceId: subject.authenticationNamespaceId,
        lookup: 'subject',
        providerSubjectId: subject.providerSubjectId,
        subjectType: subject.subjectType,
      });
      const current = yield* ports.readBinding(request, input.correlationId);
      if (
        current.outcome !== 'FOUND' ||
        String(current.authenticationNamespaceId) !== String(subject.authenticationNamespaceId) ||
        current.principalStatus !== 'active' ||
        current.tenantStatus !== 'active' ||
        current.bindingStatus !== 'active' ||
        current.principalId !== payload.principalRef.resourceId
      ) {
        return Option.none();
      }
      return Option.some({ authBindingId: current.authBindingId, principalId: current.principalId });
    },
    Effect.mapError((cause) =>
      Object.assign(
        new ActionPermissionCheckError({
          code: 'action_permission_check_failed',
          reason: 'Current enrollment binding authority is unavailable',
        }),
        { cause },
      ),
    ),
  );

/** Proof is assembled before the Action transaction from the exact durable Attempt and live Core admission. */
export const retailEnrollmentBindingAuthorityLive = Layer.effect(
  RetailEnrollmentBindingAuthority,
  Effect.gen(function* bindingAuthority() {
    const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
    const client = yield* ExternalIdentityClient;
    const configuration = yield* CommerceCoreIdentityClientConfig;
    const accounts = yield* CommercePortalAuthAccountLookupService;
    return retailEnrollmentBindingForPorts({
      predecessor: (attempt) =>
        attempt.targetLegalEntityId === undefined || Option.isNone(retailRestartIdentity(attempt))
          ? Effect.succeedNone
          : runner.run({ legalEntityId: attempt.targetLegalEntityId, tenantId: attempt.tenantId }, (transaction) =>
              readRetailEnrollmentRestartContext(transaction, attempt.portalEnrollmentAttemptId, false),
            ),
      profile: ({ legalEntityId, partyId, tenantId }) =>
        runner.run({ legalEntityId, tenantId }, (transaction) =>
          readRetailProfileByParty(transaction, partyId).pipe(
            Effect.mapError((cause) => attemptUnavailable(cause.reason, undefined, cause)),
          ),
        ),
      readBinding: (request, correlation) =>
        client.readPrincipalBinding(request, commerceCoreIdentityClientOptions(configuration, correlation)),
      store: (tenantId) => commerceEnrollmentOwnerAttemptStoreForRun({ tenantId }, runner.run),
      verifiedEmail: accounts.verifiedEmailForOwnerInvocation,
    });
  }),
);
