import { definePageData } from '@app/shared-contracts/page-data';
import { Data, Effect, Schedule } from 'effect';
import { loadAgentEntities } from './agent-entities-client.ts';
import type { AgentFailure } from './agent-entities-client.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';

export class AgentEntitiesLoadFailed extends Data.TaggedError('AgentEntitiesLoadFailed')<{
  readonly detail: string | null;
  readonly reason: AgentFailure;
}> {}

/** Retry only unavailable reads, never permission/session failures or mutations. */
export const loadAgentEntitiesWithRetry = loadAgentEntities.pipe(
  Effect.flatMap((outcome) =>
    outcome.status === 'ok'
      ? Effect.succeed(outcome.value)
      : Effect.fail(new AgentEntitiesLoadFailed({ detail: outcome.detail, reason: outcome.reason })),
  ),
  Effect.retry({
    schedule: Schedule.exponential('1 second'),
    times: 3,
    while: (failure) => failure.reason === 'error',
  }),
);

/** Agent entities of the selected company with their operators, connections and history. */
export const agentEntitiesData = definePageData({
  key: (legalEntityId: string) => legalEntityId,
  load: () => loadAgentEntitiesWithRetry,
  runtime: browserRuntime,
});
