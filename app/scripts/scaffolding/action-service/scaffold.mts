import { Effect } from 'effect';

import { createCodesmithGenerator } from '../generator-adapter.mts';
import {
  ACTION_SERVICE_GENERATOR_HEADER,
  createMutationEffect,
  discoverOntosModuleEffect,
  requireCanonicalSlug,
  resolveContainedPath,
  toCamelCase,
  tryScaffold,
} from '../shared.mts';
import type {
  ActionServiceScaffoldConfig,
  ActionServiceScaffoldResult,
  ScaffoldPlan,
} from '../shared.mts';

const renderActionService = (
  service: string
): string => `${ACTION_SERVICE_GENERATOR_HEADER}
import { Effect } from 'effect';

export const ${toCamelCase(service)}Service = () => Effect.succeed({});
`;

const planActionServiceScaffold = Effect.fn('ActionServiceScaffold.plan')(
  function* planActionServiceScaffold(
    workspaceRoot: string,
    config: ActionServiceScaffoldConfig
  ) {
    const service = yield* tryScaffold('service name is invalid', () =>
      requireCanonicalSlug(config.service, 'service')
    );
    const vertical = yield* discoverOntosModuleEffect(
      workspaceRoot,
      config.vertical
    );
    const servicePath = yield* tryScaffold(
      'failed to resolve Action service path',
      () =>
        resolveContainedPath(
          workspaceRoot,
          'verticals',
          vertical.slug,
          'src',
          'services',
          `${service}.service.ts`
        )
    );
    const mutation = yield* createMutationEffect(
      servicePath,
      renderActionService(service)
    );
    return {
      mutations: [mutation],
      result: { servicePath },
    } satisfies ScaffoldPlan<ActionServiceScaffoldResult>;
  }
);

export default createCodesmithGenerator(planActionServiceScaffold);
