import { Schema, Predicate, Option } from 'effect';
import { expect, it } from 'effect-rstest';
import { ActionCoreErrorSchema } from '../../src/actions/core-error-schema.ts';
import {
  OperationAuthenticationRequired,
  OperationContextDenied,
  OperationContextInvalid,
  OperationContextUnavailable,
} from '../../src/operations/errors.ts';

import {
  ACTION_CORE_ERROR_TAGS,
  ActionAlreadyCommitted,
  ActionCollectorError,
  ActionCommitIndeterminate,
  ActionHandlerExecutionError,
  ActionIdempotencyKeyRequired,
  ActionInvocationNotFound,
  ActionInvocationPersistenceError,
  ActionInvocationStateError,
  ActionPermissionCheckError,
  ActionPermissionDenied,
  ActionPayloadValidationError,
  ActionPolicyDenied,
  ActionPolicyEvaluationError,
  ActionRequestHashConflict,
  ActionResultValidationError,
  ActionTransactionError,
  ActionTrustedContextValidationError,
} from '../../src/actions/errors.ts';
import {
  ModuleStateCheckUnavailableError,
  ModuleStateDeniedError,
} from '../../src/modules/module-state-gate-errors.ts';

it('publishes the exhaustive stable Core Action error tags', () => {
  const errors = [
    new ActionPayloadValidationError({
      code: 'action_payload_invalid',
      reason: 'Invalid payload',
    }),
    new ActionResultValidationError({
      code: 'action_result_invalid',
      reason: 'Invalid result',
    }),
    new ActionTrustedContextValidationError({
      code: 'action_trusted_context_invalid',
      reason: 'Invalid trusted context',
    }),
    new ActionIdempotencyKeyRequired({
      code: 'action_idempotency_key_required',
      reason: 'Idempotency key required',
    }),
    new ActionPermissionDenied({
      code: 'action_permission_denied',
      reason: 'The principal is not permitted to execute this Action',
    }),
    new ActionPermissionCheckError({
      code: 'action_permission_check_failed',
      reason: 'The authorization service could not determine permission safely',
    }),
    new ActionAlreadyCommitted({
      code: 'action_already_committed',
      invocationId: 'invocation-id',
      reason: 'Already committed',
    }),
    new ActionRequestHashConflict({
      code: 'action_request_hash_conflict',
      reason: 'Request hash conflict',
    }),
    new ActionInvocationNotFound({
      code: 'action_invocation_not_found',
      reason: 'Invocation not found',
    }),
    new ActionInvocationPersistenceError({
      code: 'action_invocation_persistence_failed',
      reason: 'Invocation persistence failed',
    }),
    new ActionInvocationStateError({
      code: 'action_invocation_state_invalid',
      reason: 'Invocation state invalid',
    }),
    new ActionCollectorError({
      code: 'action_collector_invalid',
      reason: 'Collector input invalid',
    }),
    new ActionHandlerExecutionError({
      code: 'action_handler_execution_failed',
      reason: 'Handler execution failed',
    }),
    new ActionPolicyDenied({
      code: 'action_policy_denied',
      policyReasonCode: 'tenant_suspended',
      reason: 'This tenant is suspended',
    }),
    new ActionPolicyEvaluationError({
      code: 'action_policy_evaluation_failed',
      reason: 'A required Policy could not be evaluated',
    }),
    new ActionTransactionError({
      code: 'action_transaction_failed',
      reason: 'Transaction failed',
    }),
    new ActionCommitIndeterminate({
      code: 'action_commit_indeterminate',
      invocationId: 'invocation-id',
      reason: 'Commit outcome is indeterminate',
    }),
    new ModuleStateDeniedError({
      code: 'module_state_denied',
      reason: 'Module state denied execution',
    }),
    new ModuleStateCheckUnavailableError({
      code: 'module_state_check_unavailable',
      reason: 'Module state could not be checked',
    }),
  ];

  expect(errors.length).toBe(ACTION_CORE_ERROR_TAGS.length);
  for (const [index, tag] of ACTION_CORE_ERROR_TAGS.entries()) {
    expect(Predicate.isTagged(errors[index], tag)).toBe(true);
  }
  for (const error of errors) {
    expect(Schema.is(ActionCoreErrorSchema)(error)).toBe(true);
    expect(Option.isSome(Schema.decodeUnknownOption(ActionCoreErrorSchema)(error))).toBe(true);
    expect(error.reason.includes('postgresql://')).toBe(false);
    expect(error.reason.includes('ontos-local-development-key')).toBe(false);
    expect('status' in error).toBe(false);
  }
  const denial = errors.find(Schema.is(ActionPolicyDenied));
  expect(denial?.reason).toBe('This tenant is suspended');
  expect(denial?.policyReasonCode).toBe('tenant_suspended');
  expect('payload' in (denial ?? {})).toBe(false);
  expect('cause' in (denial ?? {})).toBe(false);
});

it('retains operational authentication and scope failures in the Core error channel', () => {
  const errors = [
    new OperationAuthenticationRequired({
      code: 'operation_authentication_required',
      reason: 'Authentication required',
    }),
    new OperationContextDenied({ code: 'operation_context_denied', reason: 'Context denied' }),
    new OperationContextInvalid({ code: 'operation_context_invalid', reason: 'Context invalid' }),
    new OperationContextUnavailable({ code: 'operation_context_unavailable', reason: 'Context unavailable' }),
  ];
  for (const error of errors) {
    expect(Option.isSome(Schema.decodeUnknownOption(ActionCoreErrorSchema)(error))).toBe(true);
  }
});

it('does not classify undeclared domain failures or malformed Core-shaped values as Core errors', () => {
  expect(Schema.is(ActionCoreErrorSchema)({ _tag: 'BusinessDenied', code: 'business_denied', reason: 'Denied' })).toBe(
    false,
  );
  expect(
    Schema.is(ActionCoreErrorSchema)({ _tag: 'ActionPermissionDenied', code: 'wrong_code', reason: 'Denied' }),
  ).toBe(false);
  expect(Schema.is(ActionCoreErrorSchema)({ _tag: 'ActionPermissionDenied', code: 'action_permission_denied' })).toBe(
    false,
  );
});
