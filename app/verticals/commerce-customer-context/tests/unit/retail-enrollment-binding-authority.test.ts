import type { ActionAuthorizationPreflightInput } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '../../../../packages/core-runtime/src/actions/principal-context.ts';
import { ReadPrincipalBindingResultSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { DateTime, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { BindRetailPortalProfilePayloadSchema } from '../../shared/actions/bind-retail-portal-profile.ts';
import { EnsureRetailCustomerProfileResultSchema } from '../../shared/actions/ensure-retail-customer-profile.ts';
import {
  EnrollmentAttemptSnapshotSchema,
  EnrollmentOwnerOperationSnapshotSchema,
} from '../../shared/enrollment-contracts.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { prepareRetailEnrollmentBinding } from '../../src/integrations/retail-enrollment-binding.ts';
import { retailEnrollmentBindingForPorts } from '../../src/integrations/retail-enrollment-binding-live.ts';
import { profilePersistenceServicesForTransaction } from '../../src/persistence/profile-persistence.ts';
import type { ProfileScopedRoutineInvoker } from '../../src/persistence/profile-persistence.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const actorId = '30000000-0000-4000-8000-000000000001';
const customerId = '40000000-0000-4000-8000-000000000001';
const authBindingId = '50000000-0000-4000-8000-000000000001';
const attemptId = '60000000-0000-4000-8000-000000000001';
const profileId = '70000000-0000-4000-8000-000000000001';
const partyId = '80000000-0000-4000-8000-000000000001';
const invocationId = '90000000-0000-4000-8000-000000000001';
const otherId = '90000000-0000-4000-8000-000000000002';
const storefrontId = '90000000-0000-4000-8000-000000000003';
const effectiveAt = '2026-10-23T12:00:00.000Z';
const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: otherId,
  authContextRef: 'api-key:governed-enrollment',
  authMethod: 'api_key',
  legalEntityId,
  principalId: actorId,
  tenantId,
});
const payload = Schema.decodeUnknownSync(BindRetailPortalProfilePayloadSchema)({
  effectiveAt,
  enrollmentEvidenceRef: attemptId,
  expectedRevision: null,
  expectedState: null,
  principalRef: {
    moduleId: 'core.identity',
    resourceId: customerId,
    resourceType: 'core.identity.principal',
    tenantId,
  },
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: profileId,
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  },
  reason: 'Verified retail enrollment',
  sellingLegalEntityRef: {
    moduleId: 'core.identity',
    resourceId: legalEntityId,
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
});
const input: ActionAuthorizationPreflightInput = {
  actionInvocationId: invocationId,
  actionKey: 'commerce.customer-context.bind-retail-portal-profile',
  correlationId: 'enrollment-binding-proof',
  payload,
  principal,
  scope: { ...principal, correlationId: 'enrollment-binding-proof' },
};
const attempt = Schema.decodeUnknownSync(EnrollmentAttemptSnapshotSchema)({
  accountSubject: {
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    providerSubjectId: 'exact-provider-subject',
    subjectType: 'user',
  },
  compositionRevision: 'a'.repeat(64),
  createdAt: effectiveAt,
  createdByPrincipalId: storefrontId,
  intentDigest: 'b'.repeat(64),
  intentKey: 'retail-binding-proof',
  journey: 'RETAIL_SELF_ENROLLMENT',
  portalEnrollmentAttemptId: attemptId,
  revision: 10,
  state: 'IN_PROGRESS',
  targetLegalEntityId: legalEntityId,
  tenantId,
  updatedAt: effectiveAt,
});
const unused = () => Effect.die('Unexpected owner mutation');
const modes = [
  'valid',
  'wrong-attempt',
  'wrong-tenant',
  'wrong-company',
  'wrong-actor',
  'wrong-provider',
  'wrong-profile',
  'wrong-principal',
  'revoked',
  'disabled',
  'unverified',
] as const;
type Mode = (typeof modes)[number];
const prepareFor = (mode: Mode) =>
  retailEnrollmentBindingForPorts({
    profile: ({ partyId: requestedParty }) => {
      expect(requestedParty).toBe(partyId);
      return Effect.succeed(
        Option.some(
          Schema.decodeUnknownSync(EnsureRetailCustomerProfileResultSchema)({
            outcome: 'PROFILE_CREATED',
            profileRef: {
              ...payload.profileRef,
              kind: 'RETAIL',
              resourceId: mode === 'wrong-profile' ? otherId : profileId,
            },
            revision: 1,
            state: 'ACTIVE',
          }),
        ),
      );
    },
    readBinding: (request) => {
      expect(request).toEqual({
        authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
        lookup: 'subject',
        providerSubjectId: 'exact-provider-subject',
        subjectType: 'user',
      });
      return Effect.succeed(
        Schema.decodeUnknownSync(ReadPrincipalBindingResultSchema)({
          authBindingId,
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          bindingRevision: 2,
          bindingStatus: mode === 'revoked' ? 'revoked' : 'active',
          originalInvocationId: invocationId,
          outcome: 'FOUND',
          principalId: mode === 'wrong-principal' ? otherId : customerId,
          principalStatus: mode === 'disabled' ? 'disabled' : 'active',
          tenantStatus: 'active',
        }),
      );
    },
    store: (requestedTenant) => {
      expect(requestedTenant).toBe(tenantId);
      return {
        claimTransition: unused,
        read: () =>
          Effect.succeed(
            Schema.decodeUnknownSync(Schema.toType(EnrollmentAttemptSnapshotSchema))({
              ...attempt,
              createdByPrincipalId: mode === 'wrong-actor' ? otherId : storefrontId,
              portalEnrollmentAttemptId: mode === 'wrong-attempt' ? otherId : attemptId,
            }),
          ),
        readOwnerOperation: (request) =>
          Effect.succeed(
            Schema.decodeUnknownSync(EnrollmentOwnerOperationSnapshotSchema)({
              actorPrincipalId: storefrontId,
              createdAt: effectiveAt,
              ownerInvocationId: invocationId,
              ownerModuleKey: request.ownerModuleKey,
              portalEnrollmentAttemptId: attemptId,
              portalEnrollmentOwnerOperationId: otherId,
              requestDigest: 'c'.repeat(64),
              required: true,
              resultReference: request.transitionKey === 'party.candidate.submit' ? partyId : profileId,
              revision: 1,
              status: request.transitionKey === input.actionKey ? 'IN_PROGRESS' : 'SUCCEEDED',
              tenantId,
              transitionKey: request.transitionKey,
              updatedAt: effectiveAt,
            }),
          ),
        reconcileOutcome: unused,
        recordOutcome: unused,
      };
    },
    verifiedEmail: (request) => {
      expect(request).toEqual({ ownerInvocationId: invocationId, providerSubjectId: 'exact-provider-subject' });
      return Effect.succeed(mode !== 'unverified' && mode !== 'wrong-provider');
    },
  });

for (const mode of modes) {
  it.effect(`prepares only exact governed customer enrollment authority: ${mode}`, () =>
    Effect.gen(function* exactAuthority() {
      let changed = input;
      if (mode === 'wrong-tenant') {
        changed = { ...input, scope: { ...input.scope, tenantId: otherId } };
      }
      if (mode === 'wrong-company') {
        changed = { ...input, scope: { ...input.scope, legalEntityId: otherId } };
      }
      const result = yield* prepareFor(mode)(changed, payload);
      expect(Option.isSome(result)).toBe(mode === 'valid');
      if (Option.isSome(result)) {
        expect(result.value).toEqual({ authBindingId, principalId: customerId });
      }
    }),
  );
}

it.effect('consumes one invocation-bound target while preserving the service audit actor', () =>
  Effect.gen(function* nativeTarget() {
    const prepared = prepareRetailEnrollmentBinding(prepareFor('valid'));
    expect(yield* prepared.preflight.prepare(input)).toEqual({ outcome: 'not_applicable' });
    const calls: unknown[][] = [];
    const transaction: ProfileScopedRoutineInvoker = {
      invoke: (routine, values) => {
        calls.push([...values]);
        return Effect.succeed(
          Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([
            {
              outcome: 'BINDING_ACTIVATED',
              payload: {
                bindingRef: {
                  moduleId: 'commerce.customer-context',
                  resourceId: otherId,
                  resourceType: 'commerce.customer-context.retail-portal-profile-binding',
                  tenantId,
                },
                effectiveAt,
                outcome: 'BINDING_ACTIVATED',
                revision: 1,
                state: 'ACTIVE',
              },
            },
          ]),
        );
      },
    };
    const service = profilePersistenceServicesForTransaction(
      transaction,
      { authBindingId: otherId, legalEntityId, principalId: actorId, tenantId },
      {
        resolveRetailEnrollmentBinding: prepared.capability.take,
      },
    ).bindRetailPortalProfile;
    yield* service.bind(payload, { actionInvocationId: invocationId, scope: input.scope });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toBe(customerId);
    expect(calls[0]?.[2]).toBe(authBindingId);
    expect(calls[0]?.at(-1)).toBe(actorId);
    yield* Effect.flip(service.bind(payload, { actionInvocationId: invocationId, scope: input.scope }));
    expect(calls).toHaveLength(1);
  }),
);

for (const change of ['invocation', 'actor', 'payload', 'cleared'] as const) {
  it.effect(`rejects transferred or stale prepared evidence: ${change}`, () =>
    Effect.gen(function* witnessBound() {
      const prepared = prepareRetailEnrollmentBinding(prepareFor('valid'));
      yield* prepared.preflight.prepare(input);
      if (change === 'cleared') {
        prepared.clear();
      }
      yield* Effect.flip(
        prepared.capability.take(
          change === 'payload' ? { ...payload, reason: 'Changed immutable request' } : payload,
          change === 'invocation' ? otherId : invocationId,
          change === 'actor' ? otherId : actorId,
        ),
      );
    }),
  );
}

it.effect('keeps ordinary self-service equality and never delegates recovery or revocation', () =>
  Effect.gen(function* selfService() {
    const prepared = prepareRetailEnrollmentBinding();
    expect(
      yield* prepared.preflight.prepare({
        ...input,
        payload: { ...payload, principalRef: { ...payload.principalRef, resourceId: actorId } },
      }),
    ).toEqual({ outcome: 'not_applicable' });
    const transaction: ProfileScopedRoutineInvoker = { invoke: unused };
    const services = profilePersistenceServicesForTransaction(
      transaction,
      { authBindingId: otherId, legalEntityId, principalId: actorId, tenantId },
      {
        resolveRetailEnrollmentBinding: () => Effect.die('Recovery and revocation must retain self-service equality'),
      },
    );
    yield* Effect.flip(
      profilePersistenceServicesForTransaction(transaction, {
        authBindingId: otherId,
        legalEntityId,
        principalId: actorId,
        tenantId,
      }).bindRetailPortalProfile.bind(payload, { actionInvocationId: invocationId, scope: input.scope }),
    );
    yield* Effect.flip(
      services.recoverRetailPortalProfileBinding.recover(payload, {
        actionInvocationId: invocationId,
        scope: input.scope,
      }),
    );
    yield* Effect.flip(
      services.revokeRetailPortalProfileBinding.revoke(payload, {
        actionInvocationId: invocationId,
        scope: input.scope,
      }),
    );
    expect(DateTime.formatIso(attempt.createdAt)).toBe(effectiveAt);
  }),
);
