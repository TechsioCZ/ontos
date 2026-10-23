import type { ActionAuthorizationPreflightInput } from '@app/core-runtime';
import type { EnrollmentAttemptSnapshot, ReadEnrollmentAttemptInput } from '../../shared/enrollment-contracts.ts';
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
import { attemptUnavailable } from '../enrollment/attempts/errors.ts';
import { readRetailProfileByParty } from '../persistence/profile-persistence.ts';
import { RetailEnrollmentBindingAuthority } from './retail-enrollment-binding.ts';
import type { RetailEnrollmentBindingPreparer } from './retail-enrollment-binding.ts';

export interface RetailEnrollmentBindingPorts {
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
    attempt.journey !== 'RETAIL_SELF_ENROLLMENT' ||
    attempt.state === 'TERMINATED' ||
    attempt.state === 'COMPLETE' ||
    attempt.createdByPrincipalId !== input.principal.principalId ||
    attempt.targetLegalEntityId !== legalEntityId ||
    subject === undefined ||
    subject.authenticationNamespaceId !== COMMERCE_AUTHENTICATION_NAMESPACE_ID ||
    subject.subjectType !== 'user' ||
    payload.effectiveAt !== DateTime.formatIso(attempt.createdAt)
  );
};

type OwnerOperation = Effect.Success<ReturnType<CommerceEnrollmentOwnerAttemptStore['readOwnerOperation']>>;
const journalMatchesRequest = (
  operations: {
    readonly binding: OwnerOperation;
    readonly ensured: OwnerOperation;
    readonly party: OwnerOperation;
    readonly provider: OwnerOperation;
  },
  input: ActionAuthorizationPreflightInput,
  payload: RetailPortalBindingPayload,
): boolean => {
  const { binding, ensured, party, provider } = operations;
  return (
    provider.status === 'SUCCEEDED' &&
    party.status === 'SUCCEEDED' &&
    party.resultReference !== undefined &&
    ensured.status === 'SUCCEEDED' &&
    ensured.resultReference === payload.profileRef.resourceId &&
    binding.actorPrincipalId === input.principal.principalId &&
    ['IN_PROGRESS', 'INDETERMINATE', 'RECONCILIATION_REQUIRED'].includes(binding.status)
  );
};

export const retailEnrollmentBindingForPorts = (ports: RetailEnrollmentBindingPorts): RetailEnrollmentBindingPreparer =>
  Effect.fn('RetailEnrollmentBinding.verifyAttempt')(
    function* verifyAttempt(input, payload) {
      const { legalEntityId, tenantId } = input.scope;
      if (legalEntityId === undefined || !requestMatchesCaller(input, payload)) {
        return Option.none();
      }
      const identity = yield* Schema.decodeUnknownEffect(
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
      const operation = (ownerModuleKey: string, transitionKey: string) =>
        Schema.decodeUnknownEffect(ReadEnrollmentOwnerOperationInputSchema)({
          ...identity,
          ownerModuleKey,
          transitionKey,
        }).pipe(Effect.flatMap((request) => store.readOwnerOperation(request)));
      const { binding, ensured, party, provider } = yield* Effect.all(
        {
          binding: operation('commerce.customer-context', 'commerce.customer-context.bind-retail-portal-profile'),
          ensured: operation('commerce.customer-context', 'commerce.customer-context.ensure-retail-customer-profile'),
          party: operation('party.registry', 'party.candidate.submit'),
          provider: operation('commerce.portal-auth', 'provider.account.create'),
        },
        { concurrency: 1 },
      );
      if (!journalMatchesRequest({ binding, ensured, party, provider }, input, payload)) {
        return Option.none();
      }
      const profile = yield* ports.profile({ legalEntityId, partyId: String(party.resultReference), tenantId });
      if (
        Option.isNone(profile) ||
        profile.value.profileRef.resourceId !== payload.profileRef.resourceId ||
        profile.value.state !== 'ACTIVE'
      ) {
        return Option.none();
      }
      if (
        !(yield* ports.verifiedEmail({
          ownerInvocationId: provider.ownerInvocationId,
          providerSubjectId: subject.providerSubjectId,
        }))
      ) {
        return Option.none();
      }
      const request = yield* Schema.decodeUnknownEffect(ReadPrincipalBindingPayloadSchema)({
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
