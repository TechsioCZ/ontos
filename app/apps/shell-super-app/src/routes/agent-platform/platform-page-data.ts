import { definePageData } from '@app/shared-contracts/page-data';
import { AGENT_PAGE_SIZE } from '@app/shared-contracts/agent-proposals';
import type { AgentActivityRequest, AgentQueueRequest } from '@app/shared-contracts/agent-proposals';
import { Effect } from 'effect';

import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { loadAgentActivity, loadAgentQueue } from './agent-platform-client.ts';
import type { AgentPlatformResult } from './agent-platform-client.ts';
import type { AgentPlatformPage } from './agent-platform-page-model.ts';

/** A refused or failed platform read, by its HTTP status (0 when the server did not answer). */
export interface AgentPlatformReadFailure {
  readonly httpStatus: number;
}

const settled = <A>(call: () => Promise<AgentPlatformResult<A>>): Effect.Effect<A, AgentPlatformReadFailure> =>
  Effect.promise(call).pipe(
    // The client answers every HTTP outcome itself; a server that never answers counts as unreachable.
    Effect.timeoutOrElse({
      duration: '30 seconds',
      orElse: () => Effect.succeed<AgentPlatformResult<A>>({ httpStatus: 0, message: '', status: 'failed' }),
    }),
    Effect.flatMap((result) =>
      result.status === 'ok' ? Effect.succeed(result.value) : Effect.fail({ httpStatus: result.httpStatus }),
    ),
  );

/** The approval queue of the signed-in person (one per document; a company switch reloads the document). */
export const agentQueueData = definePageData({
  key: (request: AgentQueueRequest) =>
    [
      request.pendingOnly ?? '',
      request.moduleKey ?? '',
      request.batchKey ?? '',
      request.cursor?.at ?? '',
      request.cursor?.id ?? '',
    ].join('|'),
  load: (request: AgentQueueRequest) => settled(() => loadAgentQueue(request)),
  runtime: browserRuntime,
});

/** The activity the page opens with: every agent, module and outcome. */
export const DEFAULT_ACTIVITY_REQUEST: AgentActivityRequest = { limit: AGENT_PAGE_SIZE };
export const DEFAULT_QUEUE_REQUEST: AgentQueueRequest = { pendingOnly: true };

export const agentActivityData = definePageData({
  key: (request: AgentActivityRequest) =>
    [
      request.agentPrincipalId ?? '',
      request.moduleKey ?? '',
      request.kind ?? '',
      request.limit ?? '',
      request.cursor?.at ?? '',
      request.cursor?.id ?? '',
    ].join('|'),
  load: (request: AgentActivityRequest) => settled(() => loadAgentActivity(request)),
  runtime: browserRuntime,
});

/** Primary data of a platform page, prepared before the router reveals it. */
export const preloadAgentPlatformPage = (page: AgentPlatformPage): Effect.Effect<void> =>
  page === 'approvals'
    ? agentQueueData.preload(DEFAULT_QUEUE_REQUEST)
    : agentActivityData.preload(DEFAULT_ACTIVITY_REQUEST);
