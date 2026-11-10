import { problemDetailsContentType } from '@app/shared-contracts/problem-details';
import { SYMMY_REST_PREFIX } from '@app/shared-contracts/symmy/route-catalog';
import { DEFAULT_DATA_BATCH_ENDPOINT } from '@modern-js/bff-effect/data-platform';
import type effectServerPlugin from '@modern-js/plugin-bff-extensions/effect-server';
import { flow } from 'effect/Function';

import { symmyRouteNotFoundProblem } from '../api/symmy/defect-boundary.ts';

const rejectBatchAlias = (context: {
  json: (problem: typeof symmyRouteNotFoundProblem, status: 404, headers: Record<string, string>) => Response;
}) =>
  context.json(symmyRouteNotFoundProblem, symmyRouteNotFoundProblem.status, {
    'Cache-Control': 'no-store',
    'Content-Type': problemDetailsContentType,
  });

const rejectSymmyBatchAlias: ReturnType<typeof effectServerPlugin> = {
  name: 'ontos:reject-symmy-batch-alias',
  setup(api) {
    api.onPrepare(() => {
      const prefix = api.getServerConfig()?.bff?.prefix;
      if (!Array.isArray(prefix) || !prefix.includes(SYMMY_REST_PREFIX)) {
        return;
      }

      // The framework handles its batch envelope before any Effect route policy runs.
      api.getServerContext().middlewares.push({
        handler: flow(
          rejectBatchAlias,
          Promise.resolve.bind<PromiseConstructor, [], [Response], Promise<Response>>(Promise),
        ),
        method: 'all',
        name: 'ontos:reject-symmy-batch-alias',
        order: 'pre',
        path: `${SYMMY_REST_PREFIX}${DEFAULT_DATA_BATCH_ENDPOINT}`,
      });
    });
  },
};

export default { plugins: [rejectSymmyBatchAlias] };
