import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';

import {
  SubmitCommunicationRequestPayloadSchema,
  SubmitCommunicationRequestResultSchema,
} from '../communication-intake.ts';

export {
  SubmitCommunicationRequestPayloadSchema,
  SubmitCommunicationRequestResultSchema,
} from '../communication-intake.ts';
export type { SubmitCommunicationRequestPayload, SubmitCommunicationRequestResult } from '../communication-intake.ts';

/**
 * Communications' public Action that admits ONE Communication Request, as a source MicroVertical calls it. The same
 * endpoint Communications serves through its generated Action HTTP API; the request, the stored decision and the
 * problems live here so a source never imports the Communications deployment.
 */
export const SubmitCommunicationRequestActionInvalidProblemSchema = makeProblemDetailsSchema(
  'SubmitCommunicationRequestActionInvalidProblem',
  400,
);
export const SubmitCommunicationRequestActionAuthenticationProblemSchema = makeProblemDetailsSchema(
  'SubmitCommunicationRequestActionAuthenticationProblem',
  401,
);
export const SubmitCommunicationRequestActionForbiddenProblemSchema = makeProblemDetailsSchema(
  'SubmitCommunicationRequestActionForbiddenProblem',
  403,
  {
    code: Schema.Literals([
      'action_approval_required',
      'action_permission_denied',
      'module_state_denied',
      'operation_context_denied',
      'operation_context_invalid',
      'communication_request_scope_mismatch',
      'communication_request_source_mismatch',
    ]),
    reasons: Schema.optionalKey(Schema.Array(Schema.String)),
  },
);
export const SubmitCommunicationRequestActionNotFoundProblemSchema = makeProblemDetailsSchema(
  'SubmitCommunicationRequestActionNotFoundProblem',
  404,
  { code: Schema.Literal('action_invocation_not_found') },
);
export const SubmitCommunicationRequestActionConflictProblemSchema = makeProblemDetailsSchema(
  'SubmitCommunicationRequestActionConflictProblem',
  409,
  { code: Schema.Literals(['action_request_hash_conflict', 'action_invocation_state_invalid']) },
);
export const SubmitCommunicationRequestActionIneligibleProblemSchema = makeProblemDetailsSchema(
  'SubmitCommunicationRequestActionIneligibleProblem',
  422,
  { code: Schema.Literal('action_policy_denied') },
);
export const SubmitCommunicationRequestActionPreconditionProblemSchema = makeProblemDetailsSchema(
  'SubmitCommunicationRequestActionPreconditionProblem',
  428,
);
export const SubmitCommunicationRequestActionUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'SubmitCommunicationRequestActionUnavailableProblem',
  503,
  {
    code: Schema.Literals([
      'action_invocation_persistence_failed',
      'action_permission_check_failed',
      'action_policy_evaluation_failed',
      'action_transaction_failed',
      'module_state_check_unavailable',
      'operation_context_unavailable',
      'communication_decision_unavailable',
    ]),
  },
);
export const SubmitCommunicationRequestActionAlreadyCommittedProblemSchema = makeProblemDetailsSchema(
  'SubmitCommunicationRequestActionAlreadyCommittedProblem',
  409,
  {
    code: Schema.Literal('action_already_committed'),
    invocationId: Schema.String,
    resolution: Schema.Literal('REFRESH_GOVERNED_READS'),
    retryCommand: Schema.Literal(false),
  },
);
export const SubmitCommunicationRequestActionCommitIndeterminateProblemSchema = makeProblemDetailsSchema(
  'SubmitCommunicationRequestActionCommitIndeterminateProblem',
  503,
  {
    invocationId: Schema.String,
    resolution: Schema.Literal('RESOLVE_COMMIT'),
    retryCommand: Schema.Literal(false),
  },
);
export const SubmitCommunicationRequestActionInternalProblemSchema = makeProblemDetailsSchema(
  'SubmitCommunicationRequestActionInternalProblem',
  500,
);

export type SubmitCommunicationRequestActionProblem =
  | typeof SubmitCommunicationRequestActionInvalidProblemSchema.Type
  | typeof SubmitCommunicationRequestActionAuthenticationProblemSchema.Type
  | typeof SubmitCommunicationRequestActionForbiddenProblemSchema.Type
  | typeof SubmitCommunicationRequestActionNotFoundProblemSchema.Type
  | typeof SubmitCommunicationRequestActionConflictProblemSchema.Type
  | typeof SubmitCommunicationRequestActionIneligibleProblemSchema.Type
  | typeof SubmitCommunicationRequestActionPreconditionProblemSchema.Type
  | typeof SubmitCommunicationRequestActionUnavailableProblemSchema.Type
  | typeof SubmitCommunicationRequestActionAlreadyCommittedProblemSchema.Type
  | typeof SubmitCommunicationRequestActionCommitIndeterminateProblemSchema.Type
  | typeof SubmitCommunicationRequestActionInternalProblemSchema.Type;

const actionErrors = [
  SubmitCommunicationRequestActionInvalidProblemSchema,
  SubmitCommunicationRequestActionAuthenticationProblemSchema,
  SubmitCommunicationRequestActionForbiddenProblemSchema,
  SubmitCommunicationRequestActionNotFoundProblemSchema,
  SubmitCommunicationRequestActionConflictProblemSchema,
  SubmitCommunicationRequestActionIneligibleProblemSchema,
  SubmitCommunicationRequestActionPreconditionProblemSchema,
  SubmitCommunicationRequestActionUnavailableProblemSchema,
  SubmitCommunicationRequestActionAlreadyCommittedProblemSchema,
  SubmitCommunicationRequestActionCommitIndeterminateProblemSchema,
  SubmitCommunicationRequestActionInternalProblemSchema,
] as const;

export const SubmitCommunicationRequestApi = HttpApi.make('SubmitCommunicationRequestApi').add(
  HttpApiGroup.make('submitCommunicationRequest').add(
    HttpApiEndpoint.post('execute', '/communications/actions/submit-communication-request', {
      error: actionErrors,
      payload: Schema.toEncoded(SubmitCommunicationRequestPayloadSchema),
      success: SubmitCommunicationRequestResultSchema,
    }),
  ),
);
