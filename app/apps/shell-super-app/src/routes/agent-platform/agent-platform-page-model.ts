import { Effect, Schema } from 'effect';

import type { CanonicalPageModel } from '../[lang]/canonical-page-model.ts';
import { loadHomePageModel } from '../[lang]/home-page-model.ts';
import type { HomePageModel } from '../[lang]/home-page-model.ts';
import { NAVIGATION_PREPARE_BUDGET } from '../[lang]/modules/[moduleId]/module-page-model.ts';
import { preloadAgentPlatformPage } from './platform-page-data.ts';

export const AgentPlatformPageSchema = Schema.Literals(['approvals', 'activity']);
export type AgentPlatformPage = typeof AgentPlatformPageSchema.Type;

export interface AgentPlatformPageModel {
  readonly agentPlatformPage: AgentPlatformPage;
  readonly shell: HomePageModel;
}

/** Canonical paths of the platform pages (served through the catch-all canonical route). */
export const agentPlatformPageByPath: ReadonlyMap<string, AgentPlatformPage> = new Map([
  ['/sprava/ke-schvaleni', 'approvals'],
  ['/sprava/aktivita-agentu', 'activity'],
]);

export const isAgentPlatformPageModel = (model: CanonicalPageModel) => 'agentPlatformPage' in model;

export const loadAgentPlatformPageModel = Effect.fn('AgentPlatform.loadPageModel')(
  (request: Request, page: AgentPlatformPage) =>
    loadHomePageModel(request).pipe(
      Effect.timeout('30 seconds'),
      Effect.orElseSucceed(() => ({ state: 'unavailable' }) as const),
      // The router keeps the previous page on screen until the panel's list is ready (a no-op on the server).
      Effect.tap((shell) =>
        shell.state === 'authenticated'
          ? preloadAgentPlatformPage(page).pipe(Effect.timeout(NAVIGATION_PREPARE_BUDGET), Effect.ignore)
          : Effect.void,
      ),
      Effect.map((shell): AgentPlatformPageModel => ({ agentPlatformPage: page, shell })),
    ),
);
