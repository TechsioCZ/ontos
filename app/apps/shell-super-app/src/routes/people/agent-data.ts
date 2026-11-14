import { definePageData } from '@app/shared-contracts/page-data';
import { Data, Duration, Effect, Schedule } from 'effect';
import { loadAgentEntities } from './agent-entities-client.ts';
import type { AgentFailure } from './agent-entities-client.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';

export class AgentEntitiesLoadFailed extends Data.TaggedError('AgentEntitiesLoadFailed')<{
  readonly detail: string | null;
  /** How long the failed read took: one that ran this long was a timeout or a stalled Shell, not a blip. */
  readonly elapsed: Duration.Duration;
  readonly reason: AgentFailure;
}> {}

/** A read that failed after this long timed out or met a stalled Shell: asking again would only wait again. */
const QUICK_FAILURE = Duration.seconds(5);

/**
 * Retry only an unavailable read that failed quickly (a refused or dropped request), once soon and once a second
 * later; never a permission or session failure, a mutation, or a read that failed slowly (a timeout). Asked after 1, 2
 * and 4 s, a failing list held the tab for up to 7 s more before it said so.
 */
export const loadAgentEntitiesWithRetry = loadAgentEntities.pipe(
  Effect.timed,
  Effect.flatMap(([elapsed, outcome]) =>
    outcome.status === 'ok'
      ? Effect.succeed(outcome.value)
      : Effect.fail(new AgentEntitiesLoadFailed({ detail: outcome.detail, elapsed, reason: outcome.reason })),
  ),
  Effect.retry({
    schedule: Schedule.exponential('250 millis', 4),
    times: 2,
    while: (failure) => failure.reason === 'error' && Duration.isLessThan(failure.elapsed, QUICK_FAILURE),
  }),
);

/** Agent entities of the selected company with their operators, connections and history. */
export const agentEntitiesData = definePageData({
  changesFrom: ['shell'],
  key: (legalEntityId: string) => legalEntityId,
  load: () => loadAgentEntitiesWithRetry,
  runtime: browserRuntime,
});

/**
 * Starts the selected company's agent list as the People page loads, so the Agents tab finds it read (or reading)
 * instead of asking only when it is clicked. Browser only; detached, so a navigation never waits for it.
 */
export const warmAgentEntities = (legalEntityId?: string): Effect.Effect<void> =>
  legalEntityId === undefined || !('document' in globalThis)
    ? Effect.void
    : Effect.forkDetach(agentEntitiesData.preload(legalEntityId)).pipe(Effect.asVoid);
