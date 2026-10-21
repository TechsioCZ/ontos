import { Effect } from 'effect';

import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { loadHomePageModel } from '../[lang]/home-page-model.ts';
import type { HomePageModel } from '../[lang]/home-page-model.ts';
import { requireSignedIn } from '../sign-in-return.ts';

export type AgentPlatformPage = 'approvals' | 'activity';

export interface AgentPlatformPageModel {
  readonly agentPlatformPage: AgentPlatformPage;
  readonly shell: HomePageModel;
}

/** Canonical paths of the platform pages (served through the catch-all canonical route). */
export const agentPlatformPageByPath: ReadonlyMap<string, AgentPlatformPage> = new Map([
  ['/sprava/ke-schvaleni', 'approvals'],
  ['/sprava/aktivita-agentu', 'activity'],
]);

export const isAgentPlatformPageModel = (model: unknown): model is AgentPlatformPageModel =>
  typeof model === 'object' && model !== null && 'agentPlatformPage' in model;

export const loadAgentPlatformPageModel = (request: Request, page: AgentPlatformPage): Promise<AgentPlatformPageModel> =>
  browserRuntime
    .runPromise(
      loadHomePageModel(request).pipe(
        Effect.timeout('30 seconds'),
        Effect.orElseSucceed(() => ({ state: 'unavailable' }) as const),
        Effect.map((shell): AgentPlatformPageModel => ({ agentPlatformPage: page, shell })),
      ),
      { signal: request.signal },
    )
    .then((model) => requireSignedIn(request, model));
