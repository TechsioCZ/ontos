import { definePageData, modulePagePreload } from '@app/shared-contracts/page-data';
import { Data, Effect } from 'effect';
import { loadAgentEntities } from '../../../../api/agent-entities-client.ts';
import type { AgentFailure } from '../../../../api/agent-entities-client.ts';
import { loadPeopleOverview } from '../../../../api/people-admin-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { legalEntityOf } from '../../../../runtime/use-page-data.ts';

/**
 * Datasets of the Lidé a role page, one entry per legal entity. `preloadPeoplePage` fills both before the Shell reveals
 * the page, so the access check, the people, the history and the agents arrive together in the first commit.
 */

/** Accounts, roles, company and history; a refused or failed read is the page's typed failure reason. */
export const peopleData = definePageData({
  key: (legalEntityId: string) => legalEntityId,
  load: () =>
    loadPeopleOverview.pipe(
      Effect.flatMap((outcome) =>
        outcome.status === 'ok' ? Effect.succeed(outcome.value) : Effect.fail(outcome.reason),
      ),
    ),
  runtime: browserRuntime,
});

export class AgentEntitiesLoadFailed extends Data.TaggedError('AgentEntitiesLoadFailed')<{
  readonly detail: string | null;
  readonly reason: AgentFailure;
}> {}

/** Agent entities of the selected company with their operators, connections and history. */
export const agentEntitiesData = definePageData({
  key: (legalEntityId: string) => legalEntityId,
  load: () =>
    loadAgentEntities.pipe(
      Effect.flatMap((outcome) =>
        outcome.status === 'ok'
          ? Effect.succeed(outcome.value)
          : Effect.fail(new AgentEntitiesLoadFailed({ detail: outcome.detail, reason: outcome.reason })),
      ),
    ),
  runtime: browserRuntime,
});

export const preloadPeoplePage = modulePagePreload(
  (props) => peopleData.preload(legalEntityOf(props)),
  (props) => agentEntitiesData.preload(legalEntityOf(props)),
);
