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
import { loadModulePageModel, prepareModuleTarget } from './modules/[moduleId]/module-page-model.ts';
import type { ModuleTargetPageModel } from './modules/[moduleId]/module-page-model.ts';
import { routeMeta } from './route.meta.ts';
import { requireSignedIn } from '../sign-in-return.ts';
import { PEOPLE_ADMIN_PATH, loadPeoplePageModel } from '../people/people-page-model.ts';
import type { PeoplePageModel } from '../people/people-page-model.ts';

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

/**
 * Exact canonical redirects: legacy paths of the domain regroup (customer-named routes) and Czech alias paths,
 * mapped to their current pages. The redirect keeps the query string, so deep links such as `?resourceId=` still
 * open the record.
 */
export const legacyCanonicalRedirects: ReadonlyMap<string, string> = new Map([
  ['/siampark/overview', '/nemovitosti/prehled'],
  ['/siampark/properties', '/nemovitosti'],
  ['/siampark/occupancy', '/najmy'],
  ['/siampark/agreements', '/smlouvy'],
  ['/siampark/finance', '/finance'],
  ['/siampark/work', '/ukoly'],
  ['/siampark/relationships', '/aktivity'],
  ['/siampark/provoz/prehled', '/provoz/prehled'],
  ['/siampark/provoz/agenda', '/provoz/agenda'],
  ['/siampark/provoz/majetek', '/provoz/majetek'],
  ['/siampark/provoz/meridla', '/provoz/meridla'],
  ['/siampark/provoz/nakupy', '/provoz/nakupy'],
  ['/siampark/provoz/bezpecnost', '/provoz/bezpecnost'],
  ['/siampark/provoz/dokumenty', '/provoz/dokumenty'],
  ['/provoz/ukoly', '/ukoly'],
  ['/profil', '/profile'],
]);

const redirectTo = (href: string): never => throwTanstackRedirect(href);

export type CanonicalPageModel =
  | ModuleTargetPageModel
  | AgentPlatformPageModel
  | ConnectionsAdminPageModel
  | PeoplePageModel;

export const loader = ({
  params,
  request,
}: CanonicalPageLoaderArguments): Promise<CanonicalPageModel | NotFoundError> =>
  browserRuntime.runPromise(
    Effect.gen(function* loadCanonicalPage() {
      const canonicalPath = canonicalPathFromRequest(request, params.lang);
      if (canonicalPath === undefined) {
        return notFound({ throw: true });
      }
      const legacyTarget = legacyCanonicalRedirects.get(canonicalPath);
      if (legacyTarget !== undefined) {
        const { search } = new URL(request.url);
        return redirectTo(`/${encodeURIComponent(params.lang)}${legacyTarget}${search}`);
      }
      const platformPage = agentPlatformPageByPath.get(canonicalPath);
      let model: CanonicalPageModel;
      if (platformPage !== undefined) {
        model = yield* loadAgentPlatformPageModel(request, platformPage);
      } else if (canonicalPath === PEOPLE_ADMIN_PATH) {
        model = yield* loadPeoplePageModel(request);
      } else if (canonicalPath === CONNECTIONS_ADMIN_PATH) {
        model = yield* loadConnectionsAdminPageModel(request);
      } else {
        model = yield* loadModulePageModel({ canonicalPath, request }).pipe(
          Effect.tap((target) => prepareModuleTarget(target, request)),
        );
      }
      return requireSignedIn(request, model);
    }),
    { signal: request.signal },
  );
