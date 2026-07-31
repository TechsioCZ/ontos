import assert from 'node:assert/strict';
import test from 'node:test';
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

test('publishes the exhaustive stable Core Action error tags', () => {
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
  ];

  assert.deepEqual(
    errors.map((error) => error._tag),
    ACTION_CORE_ERROR_TAGS,
  );
  for (const error of errors) {
    assert.equal(error.reason.includes('postgresql://'), false);
    assert.equal(error.reason.includes('ontos-local-development-key'), false);
    assert.equal('status' in error, false);
  }
  const denial = errors.find(
    (error): error is ActionPolicyDenied => error._tag === 'ActionPolicyDenied',
  );
  assert.equal(denial?.reason, 'This tenant is suspended');
  assert.equal(denial?.policyReasonCode, 'tenant_suspended');
  assert.equal('payload' in (denial ?? {}), false);
  assert.equal('cause' in (denial ?? {}), false);
});
