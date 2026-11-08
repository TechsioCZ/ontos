import { Match, Schema } from 'effect';
import type { Cause, Effect } from 'effect';

import type {
  AccessApproval,
  DecideAccessApprovalPayload,
  ExecuteAccessApprovalPayload,
  ListAccessApprovalsResponse,
} from '../../../../shared/access-admin-api.ts';

export type ApprovalItem = AccessApproval;
export type ApprovalsList = ListAccessApprovalsResponse;
export type ApprovalDecision = DecideAccessApprovalPayload['decision'];

export class ApprovalClientFailure extends Schema.TaggedError<
  ApprovalClientFailure,
  { readonly brand: unique symbol }
>()('ApprovalClientFailure', {
  reason: Schema.Literals(['unauthenticated', 'forbidden', 'conflict', 'invalid', 'unavailable']),
}) {}

export const approvalFailureState = (
  error: ApprovalClientFailure | Cause.TimeoutError,
): ApprovalClientFailure['reason'] =>
  Match.value(error).pipe(
    Match.tag('ApprovalClientFailure', (failure) => failure.reason),
    Match.tag('TimeoutError', () => 'unavailable' as const),
    Match.exhaustive,
  );

/** The BFF alone resolves authority and the frozen command. The browser sends only revision-bound decisions. */
export interface ApprovalsClient {
  readonly decide: (
    command: DecideAccessApprovalPayload,
    request: Request,
    idempotencyKey: string,
  ) => Effect.Effect<void, ApprovalClientFailure>;
  readonly execute: (
    command: ExecuteAccessApprovalPayload,
    request: Request,
    idempotencyKey: string,
  ) => Effect.Effect<void, ApprovalClientFailure>;
  readonly list: (request: Request, cursor?: string) => Effect.Effect<ApprovalsList, ApprovalClientFailure>;
}
