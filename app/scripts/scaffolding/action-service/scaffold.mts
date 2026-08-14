import {
  ACTION_SERVICE_GENERATOR_HEADER,
  createMutation,
  discoverOntosModule,
  requireCanonicalSlug,
  resolveContainedPath,
  toCamelCase,
} from '../shared.mts';
import { createCodesmithGenerator } from '../generator-adapter.mts';
import type {
  ActionServiceScaffoldConfig,
  ActionServiceScaffoldResult,
  ScaffoldPlan,
} from '../shared.mts';

const renderActionService = (service: string): string => `${ACTION_SERVICE_GENERATOR_HEADER}
import { Effect } from 'effect';

export const ${toCamelCase(service)}Service = () => Effect.succeed({});
`;

export const planActionServiceScaffold = async (
  workspaceRoot: string,
  config: ActionServiceScaffoldConfig,
): Promise<ScaffoldPlan<ActionServiceScaffoldResult>> => {
  const service = requireCanonicalSlug(config.service, 'service');
  const vertical = await discoverOntosModule(workspaceRoot, config.vertical);
  const servicePath = resolveContainedPath(
    workspaceRoot,
    'verticals',
    vertical.slug,
    'src',
    'services',
    `${service}.service.ts`,
  );
  return {
    mutations: [await createMutation(servicePath, renderActionService(service))],
    result: { servicePath },
  };
};

export default createCodesmithGenerator(planActionServiceScaffold);
