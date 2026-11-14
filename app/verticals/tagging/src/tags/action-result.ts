import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import { Effect, Schema } from 'effect';

export const committedResult = <Result extends { readonly revision: number }>(
  result: Result | ActionProposalAccepted,
) => (Schema.is(ActionProposalAcceptedSchema)(result) ? Effect.fail(result) : Effect.succeed(result));

/** Actual pending metadata, not a committed-write message or a retry instruction. */
export const pendingProposalMessage = <Failure>(value: Failure): string | undefined =>
  Schema.is(ActionProposalAcceptedSchema)(value) ? 'Awaiting approval. The change has not been applied.' : undefined;
