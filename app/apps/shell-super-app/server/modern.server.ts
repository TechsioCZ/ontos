import type { problemDetailsContentType } from '@app/shared-contracts/problem-details';
import type { SYMMY_REST_PREFIX } from '@app/shared-contracts/symmy/route-catalog';
import { DEFAULT_DATA_BATCH_ENDPOINT } from '@modern-js/bff-effect/data-platform';
import type effectServerPlugin from '@modern-js/plugin-bff-extensions/effect-server';
import { flow } from 'effect/Function';

import { symmyRouteNotFoundPayload } from '../shared/symmy-route-not-found.ts';

// Modern's unbundled Node server config keeps these imports type-only.
const symmyRestPrefix = '/api/symmy/v1' satisfies typeof SYMMY_REST_PREFIX;
const problemContentType = 'application/problem+json' satisfies typeof problemDetailsContentType;

const rejectBatchAlias = (context: {
  json: (problem: typeof symmyRouteNotFoundPayload, status: 404, headers: Record<string, string>) => Response;
}) =>
  context.json(symmyRouteNotFoundPayload, symmyRouteNotFoundPayload.status, {
    'Cache-Control': 'no-store',
    'Content-Type': problemContentType,
  });

const rejectSymmyBatchAlias: ReturnType<typeof effectServerPlugin> = {
  name: 'ontos:reject-symmy-batch-alias',
  setup(api) {
    api.onPrepare(() => {
      const prefix = api.getServerConfig()?.bff?.prefix;
      if (!Array.isArray(prefix) || !prefix.includes(symmyRestPrefix)) {
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
        path: `${symmyRestPrefix}${DEFAULT_DATA_BATCH_ENDPOINT}`,
      });
    });
  },
};

export default { plugins: [rejectSymmyBatchAlias] };
