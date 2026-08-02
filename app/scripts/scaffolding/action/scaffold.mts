import {
  ACTION_GENERATOR_HEADER,
  OUTBOX_SLOT_END,
  OUTBOX_SLOT_START,
  createMutation,
  discoverVertical,
  ensureUniqueMutationPaths,
  requireCanonicalSlug,
  resolveContainedPath,
  toCamelCase,
  toPascalCase,
  toTitle,
  withCoreDependency,
} from '../shared.mts';
import { createCodesmithGenerator } from '../generator-adapter.mts';
import type {
  ActionScaffoldConfig,
  ActionScaffoldResult,
  ScaffoldPlan,
  VerticalMetadata,
} from '../shared.mts';

const renderAction = (vertical: VerticalMetadata, action: string): string => {
  const actionType = toPascalCase(action);
  const actionValue = `${toCamelCase(action)}Action`;
  const handler = `handle${actionType}`;
  return `${ACTION_GENERATOR_HEADER}
// @ontos-action-owner ${vertical.appId}
// @ontos-action-slug ${action}
import { Effect, Schema } from 'effect';
import { defineAction } from '@app/core-runtime';

export const ${actionType}Payload = Schema.Struct({});
export type ${actionType}Payload = Schema.Schema.Type<typeof ${actionType}Payload>;

export const ${actionType}Result = Schema.Struct({});
export type ${actionType}Result = Schema.Schema.Type<typeof ${actionType}Result>;

export class ${actionType}NotImplemented extends Schema.TaggedErrorClass<${actionType}NotImplemented>()(
  '${actionType}NotImplemented',
  {
    code: Schema.Literal('action_not_implemented'),
    reason: Schema.String,
  },
) {}

const ${handler} = () =>
  Effect.fail(
    new ${actionType}NotImplemented({
      code: 'action_not_implemented',
      reason: 'The ${toTitle(action)} Action is not implemented',
    }),
  );

export const ${actionValue} = defineAction(
  {
    accessEvidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: '${vertical.appId}.${action}.access.v1',
    },
    actionKey: '${vertical.appId}.${action}',
    auditProfile: 'standard',
    domainErrorSchema: ${actionType}NotImplemented,
    domainEvents: {},
    idempotency: 'required',
    owningModuleKey: '${vertical.appId}',
    payloadSchema: ${actionType}Payload,
    policies: [],
    resultSchema: ${actionType}Result,
    schemaVersion: '1',
  },
  ${handler},
);

${OUTBOX_SLOT_START}
${OUTBOX_SLOT_END}
`;
};

export const planActionScaffold = async (
  workspaceRoot: string,
  config: ActionScaffoldConfig,
): Promise<ScaffoldPlan<ActionScaffoldResult>> => {
  const action = requireCanonicalSlug(config.action, 'action');
  const vertical = await discoverVertical(workspaceRoot, config.vertical);
  const actionPath = resolveContainedPath(
    workspaceRoot,
    'verticals',
    vertical.slug,
    'src',
    'actions',
    `${action}.action.ts`,
  );
  const actionMutation = await createMutation(actionPath, renderAction(vertical, action));
  const dependencyMutation = withCoreDependency(vertical);
  const mutations =
    dependencyMutation === undefined ? [actionMutation] : [actionMutation, dependencyMutation];
  ensureUniqueMutationPaths(mutations);
  return { mutations, result: { actionPath } };
};

export default createCodesmithGenerator(planActionScaffold);
