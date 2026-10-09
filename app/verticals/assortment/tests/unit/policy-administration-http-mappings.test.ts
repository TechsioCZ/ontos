import {
  ActionPermissionCheckError,
  ActionPermissionDenied,
  OperationAuthenticationRequired,
  OperationContextUnavailable,
} from '@app/core-runtime';
import { expect, it } from 'effect-rstest';
import {
  AssortmentPolicyConflict,
  AssortmentPolicyLifecycleConflict,
  AssortmentPolicyNotFound,
  AssortmentPolicyPersistenceUnavailable,
  AssortmentPolicyStaleBasis,
} from '../../shared/domain/policy-errors.ts';
import { mapCreateApplicabilityBindingActionProblem } from '../../api/create-applicability-binding-action-problems.ts';
import { mapCreateClosedAssortmentBoundaryActionProblem } from '../../api/create-closed-assortment-boundary-action-problems.ts';
import { mapCreateRuleActionProblem } from '../../api/create-rule-action-problems.ts';
import { mapCreateRuleRevisionActionProblem } from '../../api/create-rule-revision-action-problems.ts';
import { mapEndApplicabilityBindingActionProblem } from '../../api/end-applicability-binding-action-problems.ts';
import { mapEndClosedAssortmentBoundaryActionProblem } from '../../api/end-closed-assortment-boundary-action-problems.ts';
import { mapReplaceApplicabilityBindingActionProblem } from '../../api/replace-applicability-binding-action-problems.ts';
import { mapReplaceClosedAssortmentBoundaryActionProblem } from '../../api/replace-closed-assortment-boundary-action-problems.ts';
import { mapRetireRuleActionProblem } from '../../api/retire-rule-action-problems.ts';

const maps = [
  mapCreateClosedAssortmentBoundaryActionProblem,
  mapEndClosedAssortmentBoundaryActionProblem,
  mapReplaceClosedAssortmentBoundaryActionProblem,
];

const ruleMaps = [mapCreateRuleActionProblem, mapCreateRuleRevisionActionProblem, mapRetireRuleActionProblem];

const createBindingMaps = [mapCreateApplicabilityBindingActionProblem];

const bindingLifecycleMaps = [mapEndApplicabilityBindingActionProblem, mapReplaceApplicabilityBindingActionProblem];

it('maps policy conflicts and unavailable persistence consistently for every generated Boundary API', () => {
  const conflict = new AssortmentPolicyConflict({
    code: 'assortment_policy_conflict',
    conflict: 'CONCURRENT_OVERLAP',
    reason: 'The requested Boundary overlaps an existing Boundary',
  });
  const unavailable = new AssortmentPolicyPersistenceUnavailable({
    code: 'assortment_policy_persistence_unavailable',
    reason: 'The policy store is unavailable',
  });

  for (const map of maps) {
    expect(map(conflict)).toMatchObject({
      code: 'assortment_policy_conflict',
      status: 409,
    });
    expect(map(unavailable)).toMatchObject({
      code: 'assortment_policy_persistence_unavailable',
      retryable: true,
      status: 503,
    });
  }
});

it('keeps not-found, stale-basis, forbidden, authentication and authorization-unavailable mappings fail-closed', () => {
  const errors = [
    {
      error: new AssortmentPolicyNotFound({
        code: 'assortment_policy_not_found',
        reason: 'The Boundary does not exist',
      }),
      status: 404,
    },
    {
      error: new AssortmentPolicyStaleBasis({
        code: 'assortment_policy_stale_basis',
        reason: 'The Boundary basis is stale',
      }),
      status: 409,
    },
    {
      error: new ActionPermissionDenied({ code: 'action_permission_denied', reason: 'Permission denied' }),
      status: 403,
    },
    {
      error: new OperationAuthenticationRequired({
        code: 'operation_authentication_required',
        reason: 'Authentication required',
      }),
      status: 401,
    },
    {
      error: new ActionPermissionCheckError({
        code: 'action_permission_check_failed',
        reason: 'Permission check unavailable',
      }),
      status: 503,
    },
    {
      error: new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Operational context unavailable',
      }),
      status: 503,
    },
  ] as const;

  for (const map of maps) {
    for (const { error, status } of errors) {
      expect(map(error).status).toBe(status);
    }
  }
});

it('maps generated Rule HTTP domain and Core failures to declared statuses', () => {
  const errors = [
    {
      error: new AssortmentPolicyConflict({
        code: 'assortment_policy_conflict',
        conflict: 'BUSINESS_CODE',
        reason: 'The rule business code is already in use',
      }),
      status: 409,
    },
    {
      error: new AssortmentPolicyNotFound({
        code: 'assortment_policy_not_found',
        reason: 'The stable rule does not exist',
      }),
      status: 404,
    },
    {
      error: new AssortmentPolicyStaleBasis({
        code: 'assortment_policy_stale_basis',
        reason: 'The rule basis is stale',
      }),
      status: 409,
    },
    {
      error: new AssortmentPolicyPersistenceUnavailable({
        code: 'assortment_policy_persistence_unavailable',
        reason: 'The policy store is unavailable',
      }),
      status: 503,
    },
  ] as const;

  for (const map of ruleMaps) {
    for (const { error, status } of errors) {
      expect(map(error).status).toBe(status);
    }
  }
});

it('maps generated Binding HTTP lifecycle failures and shared authorization failures', () => {
  const createErrors = [
    {
      error: new AssortmentPolicyConflict({
        code: 'assortment_policy_conflict',
        conflict: 'CONCURRENT_OVERLAP',
        reason: 'The binding overlaps an existing binding',
      }),
      status: 409,
    },
    {
      error: new AssortmentPolicyNotFound({
        code: 'assortment_policy_not_found',
        reason: 'The referenced rule revision does not exist',
      }),
      status: 404,
    },
    {
      error: new AssortmentPolicyPersistenceUnavailable({
        code: 'assortment_policy_persistence_unavailable',
        reason: 'The policy store is unavailable',
      }),
      status: 503,
    },
  ] as const;
  const lifecycleErrors = [
    ...createErrors,
    {
      error: new AssortmentPolicyLifecycleConflict({
        code: 'assortment_policy_lifecycle_conflict',
        reason: 'The binding lifecycle conflicts with durable state',
      }),
      status: 409,
    },
    {
      error: new AssortmentPolicyStaleBasis({
        code: 'assortment_policy_stale_basis',
        reason: 'The binding basis is stale',
      }),
      status: 409,
    },
  ] as const;

  for (const { error, status } of createErrors) {
    expect(mapCreateApplicabilityBindingActionProblem(error).status).toBe(status);
  }
  for (const map of bindingLifecycleMaps) {
    for (const { error, status } of lifecycleErrors) {
      expect(map(error).status).toBe(status);
    }
  }

  const sharedFailures = [
    {
      error: new ActionPermissionDenied({ code: 'action_permission_denied', reason: 'Permission denied' }),
      status: 403,
    },
    {
      error: new OperationAuthenticationRequired({
        code: 'operation_authentication_required',
        reason: 'Authentication required',
      }),
      status: 401,
    },
    {
      error: new ActionPermissionCheckError({
        code: 'action_permission_check_failed',
        reason: 'Permission check unavailable',
      }),
      status: 503,
    },
    {
      error: new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Operational context unavailable',
      }),
      status: 503,
    },
  ] as const;
  for (const map of [...ruleMaps, ...createBindingMaps, ...bindingLifecycleMaps]) {
    for (const { error, status } of sharedFailures) {
      expect(map(error).status).toBe(status);
    }
  }
});
