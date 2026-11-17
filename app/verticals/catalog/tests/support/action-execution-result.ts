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
