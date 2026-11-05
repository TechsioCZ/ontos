import { AccessPortalError } from '@app/core-runtime/access/portal';
import type { AccessPortalGrantInput, AccessPortalReceipt, AccessPortalWrites } from '@app/core-runtime/access/portal';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { BindRetailPortalProfilePayloadSchema } from '../../shared/actions/bind-retail-portal-profile.ts';
import type { RetailPortalBindingPayload } from '../../shared/actions/bind-retail-portal-profile.ts';
import {
  BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  PARTY_REGISTRY_OWNER_MODULE_KEY,
  retailPartyRefFor,
  retailSelfEnrollmentRequestDigest,
} from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import { profilePersistenceServicesForTransaction } from '../../src/persistence/profile-persistence.ts';
import type {
  ProfilePersistenceScope,
  ProfileScopedRoutineInvoker,
} from '../../src/persistence/profile-persistence.ts';

/*
 * A Retail Portal binding and the bound person's portal access commit in one owner transaction: Core gives the
 * person the Retail customer role when the binding activates and ends exactly that activation when it is
 * revoked. The binding is the bound person's own, except for the one BIND this module's enrollment
 * continuation makes for the subject that started an open Retail self-enrollment in this company.
 */
const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '10000000-0000-4000-8000-000000000002';
const customer = '10000000-0000-4000-8000-000000000003';
const storefront = '10000000-0000-4000-8000-000000000004';
const authBindingId = '10000000-0000-4000-8000-000000000005';
const bindingId = '10000000-0000-4000-8000-000000000006';
const attemptId = '10000000-0000-4000-8000-000000000007';
const profileId = '10000000-0000-4000-8000-000000000008';
const invocationId = '10000000-0000-4000-8000-000000000009';
const effectiveAt = '2026-11-05T10:00:00.000Z';

/** The current state a RECOVER or REVOKE names; a BIND names none. */
interface ExpectedBinding {
  readonly expectedRevision?: number;
  readonly expectedState?: 'ACTIVE' | 'REVOKED';
}

const payloadOf = (input: ExpectedBinding = {}): RetailPortalBindingPayload =>
  Schema.decodeUnknownSync(BindRetailPortalProfilePayloadSchema)({
    effectiveAt,
    enrollmentEvidenceRef: attemptId,
    expectedRevision: null,
    expectedState: null,
    principalRef: {
      moduleId: 'core.identity',
      resourceId: customer,
      resourceType: 'core.identity.principal',
      tenantId,
    },
    profileRef: {
      moduleId: 'commerce.customer-context',
      resourceId: profileId,
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId,
    },
    reason: 'Retail self-enrollment',
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
    ...input,
  });

const bindingRow = (outcome: 'BINDING_ACTIVATED' | 'BINDING_RECOVERED' | 'BINDING_REVOKED', revision: number) => {
  const state = outcome === 'BINDING_REVOKED' ? 'REVOKED' : 'ACTIVE';
  return {
    outcome,
    payload: {
      authorizationOperation: state === 'ACTIVE' ? 'grant' : 'revoke',
      authorizationState: state,
      bindingRef: {
        moduleId: 'commerce.customer-context',
        resourceId: bindingId,
        resourceType: 'commerce.customer-context.retail-portal-profile-binding',
        tenantId,
      },
      effectiveAt,
      outcome,
      revision,
      state,
    },
  };
};

/** What an enrollment the evidence names may differ in from the open Retail one this company's Storefront started. */
interface AttemptVariation {
  readonly created_by_principal_id?: string;
  readonly journey?: 'EXISTING_ACCOUNT' | 'RETAIL_SELF_ENROLLMENT';
  readonly state?: 'COMPLETE' | 'IN_PROGRESS';
  readonly target_legal_entity_id?: string;
}

const attemptRow = (overrides: AttemptVariation = {}) => ({
  attempt_outcome: 'FOUND',
  authentication_namespace_id: null,
  completed_at: null,
  composition_revision: 'a'.repeat(64),
  created_at: '2026-11-05T09:00:00.000Z',
  created_by_principal_id: storefront,
  failure_code: null,
  failure_reason: null,
  intent_digest: 'a'.repeat(64),
  intent_key: 'retail-portal-binding-test',
  invitation_id: null,
  journey: 'RETAIL_SELF_ENROLLMENT',
  last_failure_code: null,
  last_failure_reason: null,
  last_owner_invocation_id: null,
  lease_expires_at: null,
  lease_owner: null,
  lease_token: null,
  operation_actor_principal_id: null,
  operation_id: null,
  operation_lease_expires_at: null,
  operation_lease_owner: null,
  operation_lease_token: null,
  operation_revision: null,
  operation_status: null,
  outcome_code: null,
  owner_invocation_id: null,
  owner_module_key: null,
  portal_enrollment_attempt_id: attemptId,
  provider_subject_id: null,
  reconciliation_ref: null,
  request_digest: null,
  required: null,
  result_digest: null,
  result_reference: null,
  revision: 3,
  state: 'IN_PROGRESS',
  subject_type: null,
  target_legal_entity_id: legalEntityId,
  target_resource_id: null,
  tenant_id: tenantId,
  terminated_at: null,
  transition_key: null,
  updated_at: '2026-11-05T09:00:00.000Z',
  ...overrides,
});

const partyId = '10000000-0000-4000-8000-000000000011';
const somebodyElse = '10000000-0000-4000-8000-000000000012';

/** One owner transition the Attempt journaled, projected beside the Attempt as its read returns it. */
const operationRow = (
  operationId: string,
  transition: { readonly ownerModuleKey: string; readonly transitionKey: string },
  requestDigest: string,
  completed?: { readonly resultReference: string },
) => ({
  ...attemptRow(),
  operation_actor_principal_id: storefront,
  operation_id: operationId,
  operation_revision: 1,
  operation_status: completed === undefined ? 'IN_PROGRESS' : 'SUCCEEDED',
  owner_invocation_id: operationId,
  owner_module_key: transition.ownerModuleKey,
  request_digest: requestDigest,
  required: true,
  result_reference: completed?.resultReference ?? null,
  transition_key: transition.transitionKey,
});

/**
 * The Attempt as the continuation journaled it before dispatching the BIND: the Party its candidate submission
 * established, then the binding transition whose request digest names the Principal it resolved.
 */
const enrollmentRows = (attempt: ReturnType<typeof attemptRow> = attemptRow(), resolvedPrincipal = customer) => {
  const payload = payloadOf();
  return [
    attempt,
    operationRow(
      '10000000-0000-4000-8000-000000000021',
      { ownerModuleKey: PARTY_REGISTRY_OWNER_MODULE_KEY, transitionKey: PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY },
      'b'.repeat(64),
      { resultReference: partyId },
    ),
    operationRow(
      '10000000-0000-4000-8000-000000000022',
      {
        ownerModuleKey: COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
        transitionKey: BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
      },
      retailSelfEnrollmentRequestDigest({
        intent: {
          partyRef: retailPartyRefFor(tenantId, partyId),
          principalRef: { ...payload.principalRef, resourceId: resolvedPrincipal },
          sellingLegalEntityRef: payload.sellingLegalEntityRef,
          step: 'RETAIL_PORTAL_BINDING',
        },
        ownerModuleKey: COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
        portalEnrollmentAttemptId: attemptId,
        transitionKey: BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
      }),
    ),
  ];
};

/** The scoped routines of one owner transaction, answered per routine name and recorded in call order. */
const transactionWith = (answers: Readonly<Record<string, readonly object[]>>) => {
  const calls: { readonly name: string; readonly values: readonly unknown[] }[] = [];
  const transaction: ProfileScopedRoutineInvoker = {
    invoke: (routine, values) =>
      Effect.sync(() => {
        calls.push({ name: routine.name, values: [...values] });
        return Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))(answers[routine.name] ?? []);
      }),
  };
  return { calls, transaction };
};

const recordingPortalAccess = (refuse?: AccessPortalError) => {
  const calls: string[] = [];
  const write =
    (operation: 'grant' | 'revoke') =>
    (input: AccessPortalGrantInput): Effect.Effect<AccessPortalReceipt, AccessPortalError> =>
      Effect.sync(() =>
        calls.push(`${operation}:${input.role.key}:${input.principalId}:${input.legalEntityId}:${input.source}`),
      ).pipe(
        Effect.andThen(
          refuse === undefined
            ? Effect.succeed({ assignmentIncarnationId: input.source, changed: true })
            : Effect.fail(refuse),
        ),
      );
  const portalAccess: AccessPortalWrites = { grant: write('grant'), revoke: write('revoke') };
  return { calls, portalAccess };
};

const customerScope: ProfilePersistenceScope = { authBindingId, legalEntityId, principalId: customer, tenantId };
const continuationScope: ProfilePersistenceScope = {
  authBindingId: '10000000-0000-4000-8000-000000000010',
  enrollmentContinuation: true,
  legalEntityId,
  principalId: storefront,
  tenantId,
};
const context = { actionInvocationId: invocationId, scope: { legalEntityId, tenantId } };
const activation = (revision: number) =>
  `commerce.customer-context.retail-customer:${customer}:${legalEntityId}:commerce.customer-context.retail-portal-binding:${bindingId}:${String(revision)}`;

describe('Retail Portal binding persistence', () => {
  it.effect('gives the bound person the Retail customer role with the activation it commits', () =>
    Effect.gen(function* bindsOwnProfile() {
      const { calls, transaction } = transactionWith({
        mutate_retail_portal_binding: [bindingRow('BINDING_ACTIVATED', 1)],
      });
      const portal = recordingPortalAccess();
      const services = profilePersistenceServicesForTransaction(transaction, customerScope, {
        portalAccess: portal.portalAccess,
      });
      const result = yield* services.bindRetailPortalProfile.bind(payloadOf(), context);
      expect(result.state).toBe('ACTIVE');
      expect(portal.calls).toEqual([`grant:${activation(1)}`]);
      expect(calls.map(({ name }) => name)).toEqual(['mutate_retail_portal_binding']);
      // The binding is the bound person's own, through its own authentication binding.
      expect(calls[0]?.values).toContain(authBindingId);
    }),
  );

  it.effect('ends exactly the activation a REVOKE revokes, and a RECOVER is an activation of its own', () =>
    Effect.gen(function* revokesAndRecovers() {
      const revoked = transactionWith({ mutate_retail_portal_binding: [bindingRow('BINDING_REVOKED', 2)] });
      const recovered = transactionWith({ mutate_retail_portal_binding: [bindingRow('BINDING_RECOVERED', 3)] });
      const portal = recordingPortalAccess();
      yield* profilePersistenceServicesForTransaction(revoked.transaction, customerScope, {
        portalAccess: portal.portalAccess,
      }).revokeRetailPortalProfileBinding.revoke(payloadOf({ expectedRevision: 1, expectedState: 'ACTIVE' }), context);
      yield* profilePersistenceServicesForTransaction(recovered.transaction, customerScope, {
        portalAccess: portal.portalAccess,
      }).recoverRetailPortalProfileBinding.recover(
        payloadOf({ expectedRevision: 2, expectedState: 'REVOKED' }),
        context,
      );
      expect(portal.calls).toEqual([`revoke:${activation(1)}`, `grant:${activation(3)}`]);
    }),
  );

  it.effect('binds the enrolled person for the continuation of an open Retail self-enrollment in this company', () =>
    Effect.gen(function* bindsForEnrollment() {
      const { calls, transaction } = transactionWith({
        mutate_retail_portal_binding: [bindingRow('BINDING_ACTIVATED', 1)],
        read_portal_enrollment_attempt: enrollmentRows(),
      });
      const portal = recordingPortalAccess();
      const result = yield* profilePersistenceServicesForTransaction(transaction, continuationScope, {
        portalAccess: portal.portalAccess,
      }).bindRetailPortalProfile.bind(payloadOf(), context);
      expect(result.state).toBe('ACTIVE');
      expect(calls.map(({ name }) => name)).toContain('read_portal_enrollment_attempt');
      expect(portal.calls).toEqual([`grant:${activation(1)}`]);
    }),
  );

  for (const [label, rows] of [
    ['another journey', enrollmentRows(attemptRow({ journey: 'EXISTING_ACCOUNT' }))],
    ['another company', enrollmentRows(attemptRow({ target_legal_entity_id: '10000000-0000-4000-8000-000000000099' }))],
    ['another originator', enrollmentRows(attemptRow({ created_by_principal_id: customer }))],
    ['a finished enrollment', enrollmentRows(attemptRow({ state: 'COMPLETE' }))],
    // The Attempt resolved somebody else: the continuation never binds a person its journal does not name.
    ['an enrollment of another person', enrollmentRows(attemptRow(), somebodyElse)],
    ['an enrollment that resolved nobody yet', [attemptRow()]],
  ] as const) {
    it.effect(`refuses an enrollment bind whose evidence is ${label}`, () =>
      Effect.gen(function* refusesEvidence() {
        const { calls, transaction } = transactionWith({
          mutate_retail_portal_binding: [bindingRow('BINDING_ACTIVATED', 1)],
          read_portal_enrollment_attempt: rows,
        });
        const portal = recordingPortalAccess();
        const failure = yield* Effect.flip(
          profilePersistenceServicesForTransaction(transaction, continuationScope, {
            portalAccess: portal.portalAccess,
          }).bindRetailPortalProfile.bind(payloadOf(), context),
        );
        expect(failure.code).toBe('ENROLLMENT_EVIDENCE_INSUFFICIENT');
        expect(calls.map(({ name }) => name)).not.toContain('mutate_retail_portal_binding');
        expect(portal.calls).toEqual([]);
      }),
    );
  }

  it.effect('refuses a binding of somebody else outside an enrollment continuation', () =>
    Effect.gen(function* refusesOthers() {
      const { calls, transaction } = transactionWith({ read_portal_enrollment_attempt: [attemptRow()] });
      const portal = recordingPortalAccess();
      const services = profilePersistenceServicesForTransaction(
        transaction,
        { ...customerScope, principalId: storefront },
        { portalAccess: portal.portalAccess },
      );
      const failure = yield* Effect.flip(services.bindRetailPortalProfile.bind(payloadOf(), context));
      expect(failure.code).toBe('BINDING_CONFLICT');
      // A continuation may BIND only; it never recovers or revokes somebody else's binding.
      const revoke = yield* Effect.flip(
        profilePersistenceServicesForTransaction(transaction, continuationScope, {
          portalAccess: portal.portalAccess,
        }).revokeRetailPortalProfileBinding.revoke(
          payloadOf({ expectedRevision: 1, expectedState: 'ACTIVE' }),
          context,
        ),
      );
      expect(revoke.code).toBe('BINDING_CONFLICT');
      expect(calls).toEqual([]);
    }),
  );

  it.effect('never commits a binding without Core portal access, and rolls back when Core refuses it', () =>
    Effect.gen(function* failsWithoutPortalAccess() {
      const { calls, transaction } = transactionWith({
        mutate_retail_portal_binding: [bindingRow('BINDING_ACTIVATED', 1)],
      });
      const missing = yield* Effect.flip(
        profilePersistenceServicesForTransaction(transaction, customerScope).bindRetailPortalProfile.bind(
          payloadOf(),
          context,
        ),
      );
      expect(missing.code).toBe('DEPENDENCY_UNAVAILABLE');
      expect(calls).toEqual([]);

      const unavailable = yield* Effect.flip(
        profilePersistenceServicesForTransaction(transaction, customerScope, {
          portalAccess: recordingPortalAccess(
            new AccessPortalError({ code: 'access_portal_unavailable', reason: 'engine down' }),
          ).portalAccess,
        }).bindRetailPortalProfile.bind(payloadOf(), context),
      );
      expect(unavailable).toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE', retryable: true });
      const refused = yield* Effect.flip(
        profilePersistenceServicesForTransaction(transaction, customerScope, {
          portalAccess: recordingPortalAccess(
            new AccessPortalError({ code: 'access_portal_role_unreleased', reason: 'no release' }),
          ).portalAccess,
        }).bindRetailPortalProfile.bind(payloadOf(), context),
      );
      expect(refused).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', retryable: false });
    }),
  );
});
