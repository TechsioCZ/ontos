import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';

import { OwnerExecutionOutcomeRequestSchema, OwnerExecutionOutcomeSchema } from '../domain/privacy-measure-handoff.ts';

/**
 * Privacy's public Action that records the owner's receipt of ONE Privacy Measure, as an owner (Communications) calls it.
 * The same endpoint the Privacy owner serves through its generated Action HTTP API; the owner's request, answer and
 * problems live here so a consumer never imports the Privacy deployment.
 */
export const RecordOwnerExecutionOutcomePayloadSchema = Schema.Struct({ request: OwnerExecutionOutcomeRequestSchema });
export type RecordOwnerExecutionOutcomePayload = typeof RecordOwnerExecutionOutcomePayloadSchema.Type;
export const RecordOwnerExecutionOutcomeResultSchema = OwnerExecutionOutcomeSchema;
export type RecordOwnerExecutionOutcomeResult = typeof RecordOwnerExecutionOutcomeResultSchema.Type;

export const RecordOwnerExecutionOutcomeActionInvalidProblemSchema = makeProblemDetailsSchema(
  'RecordOwnerExecutionOutcomeActionInvalidProblem',
  400,
);
export const RecordOwnerExecutionOutcomeActionAuthenticationProblemSchema = makeProblemDetailsSchema(
  'RecordOwnerExecutionOutcomeActionAuthenticationProblem',
  401,
);
export const RecordOwnerExecutionOutcomeActionForbiddenProblemSchema = makeProblemDetailsSchema(
  'RecordOwnerExecutionOutcomeActionForbiddenProblem',
  403,
  {
    code: Schema.Literals([
      'action_approval_required',
      'action_permission_denied',
      'module_state_denied',
      'operation_context_denied',
      'operation_context_invalid',
    ]),
    reasons: Schema.optionalKey(Schema.Array(Schema.String)),
  },
);
export const RecordOwnerExecutionOutcomeActionNotFoundProblemSchema = makeProblemDetailsSchema(
  'RecordOwnerExecutionOutcomeActionNotFoundProblem',
  404,
  { code: Schema.Literal('action_invocation_not_found') },
);
export const RecordOwnerExecutionOutcomeActionConflictProblemSchema = makeProblemDetailsSchema(
  'RecordOwnerExecutionOutcomeActionConflictProblem',
  409,
  { code: Schema.Literals(['action_request_hash_conflict', 'action_invocation_state_invalid']) },
);
export const RecordOwnerExecutionOutcomeActionIneligibleProblemSchema = makeProblemDetailsSchema(
  'RecordOwnerExecutionOutcomeActionIneligibleProblem',
  422,
  { code: Schema.Literals(['action_policy_denied', 'privacy_action_rejected', 'privacy_action_scope_required']) },
);
export const RecordOwnerExecutionOutcomeActionPreconditionProblemSchema = makeProblemDetailsSchema(
  'RecordOwnerExecutionOutcomeActionPreconditionProblem',
  428,
);
export const RecordOwnerExecutionOutcomeActionUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'RecordOwnerExecutionOutcomeActionUnavailableProblem',
  503,
  {
    code: Schema.Literals([
      'action_invocation_persistence_failed',
      'action_permission_check_failed',
      'action_policy_evaluation_failed',
      'action_transaction_failed',
      'module_state_check_unavailable',
      'operation_context_unavailable',
      'privacy_operation_conflict',
      'privacy_operation_not_found',
      'privacy_operation_persistence_unavailable',
      'privacy_operation_scope_mismatch',
    ]),
  },
);
export const RecordOwnerExecutionOutcomeActionAlreadyCommittedProblemSchema = makeProblemDetailsSchema(
  'RecordOwnerExecutionOutcomeActionAlreadyCommittedProblem',
  409,
  {
    code: Schema.Literal('action_already_committed'),
    invocationId: Schema.String,
    resolution: Schema.Literal('REFRESH_GOVERNED_READS'),
    retryCommand: Schema.Literal(false),
  },
);
export const RecordOwnerExecutionOutcomeActionCommitIndeterminateProblemSchema = makeProblemDetailsSchema(
  'RecordOwnerExecutionOutcomeActionCommitIndeterminateProblem',
  503,
  {
    invocationId: Schema.String,
    resolution: Schema.Literal('RESOLVE_COMMIT'),
    retryCommand: Schema.Literal(false),
  },
);
export const RecordOwnerExecutionOutcomeActionInternalProblemSchema = makeProblemDetailsSchema(
  'RecordOwnerExecutionOutcomeActionInternalProblem',
  500,
);

export type RecordOwnerExecutionOutcomeActionProblem =
  | typeof RecordOwnerExecutionOutcomeActionInvalidProblemSchema.Type
  | typeof RecordOwnerExecutionOutcomeActionAuthenticationProblemSchema.Type
  | typeof RecordOwnerExecutionOutcomeActionForbiddenProblemSchema.Type
  | typeof RecordOwnerExecutionOutcomeActionNotFoundProblemSchema.Type
  | typeof RecordOwnerExecutionOutcomeActionConflictProblemSchema.Type
  | typeof RecordOwnerExecutionOutcomeActionIneligibleProblemSchema.Type
  | typeof RecordOwnerExecutionOutcomeActionPreconditionProblemSchema.Type
  | typeof RecordOwnerExecutionOutcomeActionUnavailableProblemSchema.Type
  | typeof RecordOwnerExecutionOutcomeActionAlreadyCommittedProblemSchema.Type
  | typeof RecordOwnerExecutionOutcomeActionCommitIndeterminateProblemSchema.Type
  | typeof RecordOwnerExecutionOutcomeActionInternalProblemSchema.Type;

const actionErrors = [
  RecordOwnerExecutionOutcomeActionInvalidProblemSchema,
  RecordOwnerExecutionOutcomeActionAuthenticationProblemSchema,
  RecordOwnerExecutionOutcomeActionForbiddenProblemSchema,
  RecordOwnerExecutionOutcomeActionNotFoundProblemSchema,
  RecordOwnerExecutionOutcomeActionConflictProblemSchema,
  RecordOwnerExecutionOutcomeActionIneligibleProblemSchema,
  RecordOwnerExecutionOutcomeActionPreconditionProblemSchema,
  RecordOwnerExecutionOutcomeActionUnavailableProblemSchema,
  RecordOwnerExecutionOutcomeActionAlreadyCommittedProblemSchema,
  RecordOwnerExecutionOutcomeActionCommitIndeterminateProblemSchema,
  RecordOwnerExecutionOutcomeActionInternalProblemSchema,
] as const;

export const RecordOwnerExecutionOutcomeApi = HttpApi.make('RecordOwnerExecutionOutcomeApi').add(
  HttpApiGroup.make('recordOwnerExecutionOutcome').add(
    HttpApiEndpoint.post('execute', '/privacy/actions/record-owner-execution-outcome', {
      error: actionErrors,
      payload: Schema.toEncoded(RecordOwnerExecutionOutcomePayloadSchema),
      success: [ActionProposalAcceptedSchema, RecordOwnerExecutionOutcomeResultSchema],
    }),
  ),
);
