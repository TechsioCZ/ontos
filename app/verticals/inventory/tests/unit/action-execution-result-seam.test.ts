import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { requireExecutedAction, requireExecutionResult } from '../support/action-execution-result.ts';

/** The seam is generic over any Action's declared result; this stands in for one Inventory execution result. */
const executedResultSchema = Schema.Struct({ items: Schema.Array(Schema.Struct({ status: Schema.String })) });
type ExecutedResult = typeof executedResultSchema.Type;
const parkedProposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2026-10-23T00:00:00.000Z',
  proposalId: '22222222-2222-4222-8222-222222222222',
});
const answers = (answer: ExecutedResult | ActionProposalAccepted) =>
  Effect.succeed<ExecutedResult | ActionProposalAccepted>(answer);

it.effect('refuses a schema-valid parked proposal instead of reading settled Inventory items', () =>
  Effect.gen(function* parkedProposalIsNotSettledItems() {
    const outcome = yield* Effect.result(requireExecutionResult(executedResultSchema, answers(parkedProposal)));
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(Schema.isSchemaError(outcome.failure)).toBe(true);
    }
  }),
);

it.effect('refuses a parked proposal with the caller-supplied tagged failure', () =>
  Effect.gen(function* parkedProposalIsRefusedWithTaggedFailure() {
    const refusal = new Error('the parked proposal never executed');
    const outcome = yield* Effect.result(requireExecutedAction(() => refusal, answers(parkedProposal)));
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(outcome.failure).toBe(refusal);
    }
  }),
);

it.effect('keeps a genuinely executed Inventory result unchanged at the same seam', () =>
  Effect.gen(function* executedInventoryResultAdvances() {
    const executed: ExecutedResult = { items: [{ status: 'INDETERMINATE' }] };
    expect(yield* requireExecutionResult(executedResultSchema, answers(executed))).toEqual(executed);
    expect(
      yield* requireExecutedAction(() => new Error('the executed result must not be refused'), answers(executed)),
    ).toEqual(executed);
  }),
);
