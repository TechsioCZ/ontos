import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import { Effect, Schema } from 'effect';

/**
 * An Action transport may answer a parked proposal, a public 202 success body, instead of business work.
 * Shell tests that read an executed owner result refuse that receipt with the caller's failure before
 * reading any result field.
 */
export const requireExecutedAction = <Result, Failure, Requirements, Rejection>(
  onParkedProposal: () => Rejection,
  outcome: Effect.Effect<Result | ActionProposalAccepted, Failure, Requirements>,
): Effect.Effect<Result, Failure | Rejection, Requirements> =>
  outcome.pipe(
    Effect.flatMap((result) =>
      Schema.is(ActionProposalAcceptedSchema)(result) ? Effect.fail(onParkedProposal()) : Effect.succeed(result),
    ),
  );
