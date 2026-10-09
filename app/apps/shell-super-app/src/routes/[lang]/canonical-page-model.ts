import { notFound } from '@modern-js/plugin-tanstack/runtime';
import type { NotFoundError } from '@modern-js/plugin-tanstack/runtime';

import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { loadModulePageModel } from './modules/[moduleId]/module-page-model.ts';
import type { ModuleTargetPageModel } from './modules/[moduleId]/module-page-model.ts';
import { routeMeta } from './route.meta.ts';

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

export const loader = ({
  params,
  request,
}: CanonicalPageLoaderArguments): Promise<ModuleTargetPageModel | NotFoundError> => {
  const canonicalPath = canonicalPathFromRequest(request, params.lang);
  if (canonicalPath === undefined) {
    return Promise.resolve().then(() => notFound({ throw: true }));
  }
  return browserRuntime
    .runPromise(loadModulePageModel({ canonicalPath, request }), { signal: request.signal })
    .then((model) => (model.state === 'not_found' ? notFound({ throw: true }) : model));
};
