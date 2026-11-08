import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import { Effect, Schema } from 'effect';

/**
 * O85: an Action transport may answer a parked proposal instead of business work, and that parked
 * proposal is a public 202 success body. Every workflow here reads an executed owner result, so the
 * Action's own declared result schema decodes the answer: a proposal receipt fails the seam instead of
 * being read as completed business work.
 *
 * The schema is applied to its type side because the transport already decoded the written shape.
 */
export const requireExecutionResult = <Result, Encoded, Failure, Requirements>(
  schema: Schema.Codec<Result, Encoded>,
  outcome: Effect.Effect<Result | ActionProposalAccepted, Failure, Requirements>,
): Effect.Effect<Result, Failure | Schema.SchemaError, Requirements> =>
  outcome.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.toType(schema))));

/**
 * The same execution-only seam for an Action whose owning vertical publishes no execution-result schema
 * this deployment may import. The caller supplies the failure a parked receipt must produce, and no
 * result field is read before the public proposal shape is refused.
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
