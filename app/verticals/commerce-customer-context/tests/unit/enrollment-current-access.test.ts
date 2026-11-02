import { Cause, DateTime, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CommerceActionCommitResolutionFailed,
  retailPortalBindingOwnerEffect,
} from '../../src/enrollment/journeys/retail-self-enrollment-profile-owners.ts';
import {
  profilePersistenceServicesForTransaction,
  retailEnrollmentBindingIsCurrentForPrincipal,
} from '../../src/persistence/profile-persistence.ts';
import type { ProfileScopedRoutineInvoker } from '../../src/persistence/profile-persistence.ts';
import { RetailPortalProfileBindingReadResponseSchema } from '../../shared/apis/retail-portal-profile-binding-read.ts';
import { CommerceEnrollmentOwnerEffectUnavailable } from '../../src/enrollment/orchestration/owner-transition-errors.ts';
import type { RetailPortalBindingOwnerExecutors } from '../../src/enrollment/journeys/retail-self-enrollment-profile-owners.ts';
import { CommerceEnrollmentOwnerTransitionSchema } from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import { RetailPortalBindingResultSchema } from '../../shared/actions/bind-retail-portal-profile.ts';
import {
  RETAIL_PORTAL_SELF_SERVICE_BASELINE,
  SellingLegalEntityRefSchema,
} from '../../shared/domain/profile-contracts.ts';
import { RetailCustomerProfileRefSchema } from '../../shared/resources/retail-customer-profile.ts';
import { RetailPortalPrincipalRefSchema } from '../../shared/resources/retail-portal-profile-binding.ts';

const tenantId = '10000000-0000-4000-8000-000000000032';
const principalId = '20000000-0000-4000-8000-000000000032';
const profileId = '30000000-0000-4000-8000-000000000032';
const bindingId = '40000000-0000-4000-8000-000000000032';
const at = '2026-10-19T12:00:00.000Z';
const principalRef = Schema.decodeSync(RetailPortalPrincipalRefSchema)({
  moduleId: 'core.identity',
  resourceId: principalId,
  resourceType: 'core.identity.principal',
  tenantId,
});
const profileRef = Schema.decodeSync(RetailCustomerProfileRefSchema)({
  moduleId: 'commerce.customer-context',
  resourceId: profileId,
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
});
const sellingLegalEntityRef = Schema.decodeSync(SellingLegalEntityRefSchema)({
  moduleId: 'core.identity',
  resourceId: '50000000-0000-4000-8000-000000000032',
  resourceType: 'core.identity.legal-entity',
  tenantId,
});
const input = {
  compositionRevision: 'a'.repeat(64),
  effectiveAt: DateTime.makeUnsafe(at),
  enrollmentEvidenceRef: '60000000-0000-4000-8000-000000000032',
  principalRef,
  profileRef,
  reason: 'Current baseline unit scenario',
  requestCorrelation: 'current-baseline-unit',
  sellingLegalEntityRef,
};
const active = Schema.decodeSync(RetailPortalBindingResultSchema)({
  authorizationOperation: 'grant',
  authorizationState: 'ACTIVE',
  bindingRef: {
    moduleId: 'commerce.customer-context',
    resourceId: bindingId,
    resourceType: 'commerce.customer-context.retail-portal-profile-binding',
    tenantId,
  },
  effectiveAt: at,
  outcome: 'BINDING_ACTIVATED',
  revision: 1,
  state: 'ACTIVE',
});
const transition = Schema.decodeSync(CommerceEnrollmentOwnerTransitionSchema)({
  actorPrincipalId: principalId,
  compositionRevision: input.compositionRevision,
  correlationId: input.requestCorrelation,
  expectedRevision: 1,
  ownerInvocationId: '70000000-0000-4000-8000-000000000032',
  ownerModuleKey: 'commerce.customer-context',
  portalEnrollmentAttemptId: input.enrollmentEvidenceRef,
  requestDigest: 'b'.repeat(64),
  tenantId,
  transitionKey: 'commerce.customer-context.bind-retail-portal-profile',
});
const executors = (
  confirmCurrentBinding?: RetailPortalBindingOwnerExecutors['confirmCurrentBinding'],
): RetailPortalBindingOwnerExecutors => {
  const base = {
    bindProfile: () => Effect.succeed(active),
    commitResolution: () => Effect.succeed({ result: active, state: 'COMMITTED' as const }),
  };
  return confirmCurrentBinding === undefined ? base : { ...base, confirmCurrentBinding };
};

it.effect('finishes dispatch and lost-response recovery only with the owner Current baseline', () =>
  Effect.gen(function* currentBaseline() {
    const owner = retailPortalBindingOwnerEffect(
      input,
      executors(() => Effect.succeed(true)),
    );
    expect((yield* owner.dispatch(transition)).status).toBe('SUCCEEDED');
    expect((yield* owner.reconcile({ ...transition, observedRevision: 1, ownerOperationRevision: 1 })).status).toBe(
      'SUCCEEDED',
    );
  }),
);

for (const current of [undefined, false]) {
  it.effect(`keeps aggregate ACTIVE pending when Current baseline observation is ${String(current)}`, () =>
    Effect.gen(function* missingCurrentBaseline() {
      const owner = retailPortalBindingOwnerEffect(
        input,
        executors(current === undefined ? undefined : () => Effect.succeed(current)),
      );
      const outcome = yield* owner.dispatch(transition);
      expect(outcome.status).toBe('FAILED');
      expect(outcome.nextState).toBe('RECONCILIATION_REQUIRED');
      expect((yield* owner.reconcile({ ...transition, observedRevision: 1, ownerOperationRevision: 1 })).status).toBe(
        'FAILED',
      );
    }),
  );
}

it.effect('preserves a typed Current read outage as owner unavailability', () =>
  Effect.gen(function* unavailableCurrent() {
    const error = yield* retailPortalBindingOwnerEffect(
      input,
      executors(() =>
        Effect.fail(
          new CommerceActionCommitResolutionFailed({
            code: 'commit_resolution_unavailable',
            reason: 'Current read unavailable',
          }),
        ),
      ),
    )
      .dispatch(transition)
      .pipe(Effect.flip);
    expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(error)).toBe(true);
  }),
);

it.effect('preserves unexpected Current reader defects', () =>
  Effect.gen(function* defectiveCurrent() {
    const defect = new Error('Current reader defect control');
    const result = yield* retailPortalBindingOwnerEffect(
      input,
      executors(() => Effect.die(defect)),
    )
      .dispatch(transition)
      .pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(result.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect)).toBe(true);
      expect(Cause.hasFails(result.cause)).toBe(false);
    }
  }),
);

it.effect('preserves Current read interruption', () =>
  Effect.gen(function* interruptedCurrent() {
    const result = yield* retailPortalBindingOwnerEffect(
      input,
      executors(() => Effect.interrupt),
    )
      .dispatch(transition)
      .pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(Cause.hasInterrupts(result.cause)).toBe(true);
      expect(Cause.hasDies(result.cause)).toBe(false);
      expect(Cause.hasFails(result.cause)).toBe(false);
    }
  }),
);

it.effect('requires the exact reviewed intent set even when a Current reader allows', () =>
  Effect.gen(function* partialIntents() {
    const partial = {
      ...active,
      permissionMutations: RETAIL_PORTAL_SELF_SERVICE_BASELINE.slice(1).map((permission, index) => ({
        mutationId: `80000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        operation: 'grant' as const,
        permission,
        staged: true,
      })),
    };
    const outcome = yield* retailPortalBindingOwnerEffect(input, {
      ...executors(() => Effect.succeed(true)),
      bindProfile: () => Effect.succeed(partial),
    }).dispatch(transition);
    expect(outcome.status).toBe('FAILED');
  }),
);

const currentProjection = {
  outcome: 'BINDING_AVAILABLE',
  payload: {
    actionInvocationId: transition.ownerInvocationId,
    authorizationMutationId: transition.ownerInvocationId,
    authorizationOperation: 'grant',
    authorizationState: 'ACTIVE',
    bindingId,
    createdAt: at,
    enrollmentEvidenceRef: input.enrollmentEvidenceRef,
    principalId,
    profileId,
    reason: input.reason,
    revision: 1,
    revokedAt: null,
    state: 'ACTIVE',
    updatedAt: at,
  },
};
const reconciliationProjection = {
  outcome: 'BINDING_RECONCILIATION_REQUIRED',
  payload: { caseId: input.enrollmentEvidenceRef, observedAt: at, profileId, revision: 1 },
};

for (const projection of [currentProjection, reconciliationProjection]) {
  it.effect(`strictly validates the actual ${projection.outcome} public resource projection`, () =>
    Effect.gen(function* strictRetailBindingProjection() {
      const transaction: ProfileScopedRoutineInvoker = {
        invoke: (routine) =>
          Schema.decodeUnknownEffect(Schema.Array(routine.resultSchema))([projection]).pipe(Effect.orDie),
      };
      const services = profilePersistenceServicesForTransaction(
        transaction,
        {
          legalEntityId: sellingLegalEntityRef.resourceId,
          principalId,
          tenantId,
        },
        {
          readRetailPermissions: () =>
            Effect.succeed({ observedAt: at, permissions: RETAIL_PORTAL_SELF_SERVICE_BASELINE, revision: '1' }),
        },
      );
      const response = yield* services.retailPortalProfileBindingRead.readBinding(
        { bindingRef: active.bindingRef, profileRef },
        principalId,
        tenantId,
      );
      const publicResponse = yield* Schema.decodeUnknownEffect(
        Schema.toType(RetailPortalProfileBindingReadResponseSchema),
        {
          onExcessProperty: 'error',
        },
      )(response);
      expect(publicResponse).toEqual(response);
    }),
  );
}

for (const control of [
  'valid',
  'different-resolved-binding',
  'different-binding',
  'different-profile',
  'different-principal',
  'different-evidence',
  'pending-authorization',
  'revoked-binding',
  'revoke-operation',
  'partial-permissions',
  'duplicate-permissions',
  'absent-permissions',
] as const) {
  it.effect(`observes only the exact original Retail enrollment binding: ${control}`, () =>
    Effect.gen(function* exactRetailCurrentReader() {
      const payload = { ...currentProjection.payload };
      if (control === 'different-binding') {
        payload.bindingId = transition.ownerInvocationId;
      }
      if (control === 'different-profile') {
        payload.profileId = transition.ownerInvocationId;
      }
      if (control === 'different-principal') {
        payload.principalId = transition.ownerInvocationId;
      }
      if (control === 'different-evidence') {
        payload.enrollmentEvidenceRef = transition.ownerInvocationId;
      }
      if (control === 'pending-authorization') {
        payload.authorizationState = 'PENDING_GRANT';
      }
      if (control === 'revoked-binding') {
        payload.state = 'REVOKED';
      }
      if (control === 'revoke-operation') {
        payload.authorizationOperation = 'revoke';
      }
      const transaction: ProfileScopedRoutineInvoker = {
        invoke: (routine) => {
          const row =
            routine.routineKey === 'profile.resolve-principal'
              ? {
                  outcome: 'RETAIL_PRINCIPAL_BOUND',
                  payload: {
                    bindingId: control === 'different-resolved-binding' ? transition.ownerInvocationId : bindingId,
                    observedAt: at,
                    profileId,
                    revision: 1,
                  },
                }
              : { outcome: 'BINDING_AVAILABLE', payload };
          return Schema.decodeUnknownEffect(Schema.Array(routine.resultSchema))([row]).pipe(Effect.orDie);
        },
      };
      const current = yield* retailEnrollmentBindingIsCurrentForPrincipal(
        transaction,
        {
          legalEntityId: sellingLegalEntityRef.resourceId,
          principalId,
          tenantId,
        },
        { bindingId, enrollmentEvidenceRef: input.enrollmentEvidenceRef, profileId },
        (scope) => {
          expect(scope.tenantId).toBe(tenantId);
          expect(scope.legalEntityId).toBe(sellingLegalEntityRef.resourceId);
          expect(scope.profileId).toBe(profileId);
          let permissions: readonly (typeof RETAIL_PORTAL_SELF_SERVICE_BASELINE)[number][] =
            RETAIL_PORTAL_SELF_SERVICE_BASELINE;
          if (control === 'partial-permissions') {
            permissions = RETAIL_PORTAL_SELF_SERVICE_BASELINE.slice(1);
          }
          if (control === 'duplicate-permissions') {
            permissions = [...RETAIL_PORTAL_SELF_SERVICE_BASELINE, ...RETAIL_PORTAL_SELF_SERVICE_BASELINE];
          }
          if (control === 'absent-permissions') {
            permissions = [];
          }
          return Effect.succeed({ observedAt: at, permissions, revision: '1' });
        },
      );
      expect(current).toBe(control === 'valid');
    }),
  );
}
