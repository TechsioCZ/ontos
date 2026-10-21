import { notFound, throwTanstackRedirect } from '@modern-js/plugin-tanstack/runtime';
import type { NotFoundError } from '@modern-js/plugin-tanstack/runtime';
import { Effect } from 'effect';

import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { agentPlatformPageByPath, loadAgentPlatformPageModel } from '../agent-platform/agent-platform-page-model.ts';
import type { AgentPlatformPageModel } from '../agent-platform/agent-platform-page-model.ts';
import {
  CONNECTIONS_ADMIN_PATH,
  loadConnectionsAdminPageModel,
} from './sprava/pripojene-aplikace/connections-admin-page-model.ts';
import type { ConnectionsAdminPageModel } from './sprava/pripojene-aplikace/connections-admin-page-model.ts';
import { loadModulePageModel, preloadModuleTarget } from './modules/[moduleId]/module-page-model.ts';
import type { ModuleTargetPageModel } from './modules/[moduleId]/module-page-model.ts';
import { routeMeta } from './route.meta.ts';
import { requireSignedIn } from '../sign-in-return.ts';

interface CanonicalPageLoaderArguments {
  readonly params: { readonly lang: string };
  readonly request: Request;
}

export const canonicalPathFromRequest = (request: Request, language: string): string | undefined => {
  const { pathname } = new URL(request.url);
  const prefix = `/${encodeURIComponent(language)}/`;
  const canonicalPath = pathname.slice(prefix.length - 1);
  const normalizedPath =
    canonicalPath.length > 1 && canonicalPath.endsWith('/') ? canonicalPath.slice(0, -1) : canonicalPath;
  return Object.hasOwn(routeMeta.localisedPaths, language) && pathname.startsWith(prefix) ? normalizedPath : undefined;
};

/** Czech alias paths that open another module's canonical page. The tasks nav item accepts `/provoz/ukoly`. */
const canonicalPathAliases: ReadonlyMap<string, string> = new Map([['/provoz/ukoly', '/siampark/work']]);

export const loader = ({
  params,
  request,
}: CanonicalPageLoaderArguments): Promise<
  ModuleTargetPageModel | AgentPlatformPageModel | ConnectionsAdminPageModel | NotFoundError
> => {
  const canonicalPath = canonicalPathFromRequest(request, params.lang);
  if (canonicalPath === undefined) {
    return Promise.resolve().then(() => notFound({ throw: true }));
  }
  const aliasTarget = canonicalPathAliases.get(canonicalPath);
  if (aliasTarget !== undefined) {
    return Promise.resolve().then(() => throwTanstackRedirect(`/${encodeURIComponent(params.lang)}${aliasTarget}`));
  }
  const platformPage = agentPlatformPageByPath.get(canonicalPath);
  if (platformPage !== undefined) {
    return loadAgentPlatformPageModel(request, platformPage);
  }
  if (canonicalPath === CONNECTIONS_ADMIN_PATH) {
    return loadConnectionsAdminPageModel(request);
  }
  return browserRuntime
    .runPromise(
      loadModulePageModel({ canonicalPath, request }).pipe(
        Effect.tap((model) => preloadModuleTarget(model, new URL(request.url).pathname)),
      ),
      { signal: request.signal },
    )
    .then((model) => requireSignedIn(request, model));
};
