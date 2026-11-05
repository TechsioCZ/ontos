import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { requireExecutedAction, requireExecutionResult } from '../support/action-execution-result.ts';

/** The seam is generic over any Action's declared result; this stands in for one Pricing execution result. */
const executedResultSchema = Schema.Struct({ scheduleRevision: Schema.Int });
type ExecutedResult = typeof executedResultSchema.Type;
const parkedProposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2026-10-23T00:00:00.000Z',
  proposalId: '22222222-2222-4222-8222-222222222222',
});
class ParkedProposalRefused extends Schema.TaggedError<ParkedProposalRefused>()('ParkedProposalRefused', {
  reason: Schema.String,
}) {}
const answers = (answer: ExecutedResult | ActionProposalAccepted) =>
  Effect.succeed<ExecutedResult | ActionProposalAccepted>(answer);

it.effect('refuses a schema-valid parked proposal instead of advancing an execution-only consumer', () =>
  Effect.gen(function* parkedProposalIsNotAnExecutedResult() {
    const outcome = yield* Effect.result(requireExecutionResult(executedResultSchema, answers(parkedProposal)));
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(Schema.isSchemaError(outcome.failure)).toBe(true);
    }
  }),
);

it.effect('refuses a parked proposal with the caller-supplied tagged failure', () =>
  Effect.gen(function* parkedProposalIsRefusedWithTaggedFailure() {
    const refusal = new ParkedProposalRefused({ reason: 'the parked proposal never executed' });
    const outcome = yield* Effect.result(requireExecutedAction(() => refusal, answers(parkedProposal)));
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(outcome.failure).toBe(refusal);
    }
  }),
);

it.effect('keeps a genuinely executed owner result unchanged at the same seam', () =>
  Effect.gen(function* executedOwnerResultAdvances() {
    const executed: ExecutedResult = { scheduleRevision: 3 };
    expect(yield* requireExecutionResult(executedResultSchema, answers(executed))).toEqual(executed);
    expect(
      yield* requireExecutedAction(
        () => new ParkedProposalRefused({ reason: 'the executed result must not be refused' }),
        answers(executed),
      ),
    ).toEqual(executed);
  }),
);
