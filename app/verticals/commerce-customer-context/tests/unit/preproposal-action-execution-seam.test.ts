import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { CreateCounterpartyPurchasingProfileResultSchema } from '../../shared/actions/create-counterparty-purchasing-profile.ts';
import type { CreateCounterpartyPurchasingProfileResult } from '../../shared/actions/create-counterparty-purchasing-profile.ts';
import { requireExecutedAction, requireExecutionResult } from '../support/action-execution-result.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';

/** A parked proposal the Action transport may answer with when the caller asks for one (O80/O85). */
const parkedProposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2026-10-23T00:00:00.000Z',
  proposalId: '22222222-2222-4222-8222-222222222222',
});
const executedProfile: CreateCounterpartyPurchasingProfileResult = Schema.decodeUnknownSync(
  CreateCounterpartyPurchasingProfileResultSchema,
)({
  outcome: 'PROFILE_CREATED',
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
    tenantId,
  },
  revision: 1,
  state: 'ACTIVE',
});
/** The declared success union of a `result-or-proposal` Action transport. */
type ProfileAnswer = CreateCounterpartyPurchasingProfileResult | ActionProposalAccepted;
const answers = (answer: ProfileAnswer) => Effect.succeed<ProfileAnswer>(answer);

it.effect('refuses a schema-valid parked proposal instead of advancing an execution-only consumer', () =>
  Effect.gen(function* parkedProposalIsNotAnOwnerResult() {
    expect(Schema.is(ActionProposalAcceptedSchema)(parkedProposal)).toBe(true);
    const outcome = yield* Effect.result(
      requireExecutionResult(CreateCounterpartyPurchasingProfileResultSchema, answers(parkedProposal)),
    );
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(Schema.isSchemaError(outcome.failure)).toBe(true);
    }
  }),
);

it.effect('refuses a schema-valid parked proposal where the Action publishes no execution-result schema', () =>
  Effect.gen(function* parkedProposalIsNotACartRevision() {
    const refusal = new Error('the parked proposal never executed');
    const outcome = yield* Effect.result(requireExecutedAction(() => refusal, answers(parkedProposal)));
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(outcome.failure).toBe(refusal);
    }
  }),
);

it.effect('keeps a genuinely executed owner result unchanged at the same seam', () =>
  Effect.gen(function* executedOwnerResultAdvances() {
    const applied = yield* requireExecutionResult(
      CreateCounterpartyPurchasingProfileResultSchema,
      answers(executedProfile),
    );
    expect(applied).toEqual(executedProfile);
    const appliedWithoutSchema = yield* requireExecutedAction(
      () => new Error('the executed result must not be refused'),
      answers(executedProfile),
    );
    expect(appliedWithoutSchema).toEqual(executedProfile);
  }),
);
