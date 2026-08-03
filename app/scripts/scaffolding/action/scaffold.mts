import { readFile } from 'node:fs/promises';
import {
  ACTION_GENERATOR_HEADER,
  CORE_ACTION_SLOT_END,
  CORE_ACTION_SLOT_START,
  OUTBOX_SLOT_END,
  OUTBOX_SLOT_START,
  createMutation,
  discoverVertical,
  ensureUniqueMutationPaths,
  insertSortedSlot,
  requireCanonicalSlug,
  requireCoreModuleKey,
  resolveContainedPath,
  toCamelCase,
  toPascalCase,
  toTitle,
  updateMutation,
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

const renderCoreAction = (moduleKey: string, action: string): string => {
  const actionType = toPascalCase(action);
  const actionValue = `${toCamelCase(action)}Action`;
  const handler = `handle${actionType}`;
  return `${ACTION_GENERATOR_HEADER}
// @ontos-action-owner ${moduleKey}
// @ontos-action-slug ${action}
import { Effect, Schema } from 'effect';
import { defineAction } from '../../actions/definition.ts';

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
      policyKey: '${moduleKey}.${action}.access.v1',
    },
    actionKey: '${moduleKey}.${action}',
    auditProfile: 'standard',
    domainErrorSchema: ${actionType}NotImplemented,
    domainEvents: {},
    idempotency: 'required',
    owningModuleKey: '${moduleKey}',
    payloadSchema: ${actionType}Payload,
    policies: [],
    resultSchema: ${actionType}Result,
    schemaVersion: '1',
  },
  ${handler},
);
`;
};

const coreExportEntry = (action: string): string =>
  `export { ${toCamelCase(action)}Action } from './modules/actions/${action}.action.ts';`;

const isCoreActionExport = (candidate: string): boolean =>
  /^export \{ [a-z][A-Za-z0-9]*Action \} from '\.\/modules\/actions\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.action\.ts';$/u.test(
    candidate,
  );

const planCoreActionScaffold = async (
  workspaceRoot: string,
  moduleKeyInput: string,
  action: string,
): Promise<ScaffoldPlan<ActionScaffoldResult>> => {
  const moduleKey = requireCoreModuleKey(moduleKeyInput);
  const actionPath = resolveContainedPath(
    workspaceRoot,
    'packages',
    'core-runtime',
    'src',
    'modules',
    'actions',
    `${action}.action.ts`,
  );
  const indexPath = resolveContainedPath(
    workspaceRoot,
    'packages',
    'core-runtime',
    'src',
    'index.ts',
  );
  const actionMutation = await createMutation(actionPath, renderCoreAction(moduleKey, action));
  const indexContent = await readFile(indexPath, 'utf-8');
  const nextIndex = insertSortedSlot(
    indexContent,
    CORE_ACTION_SLOT_START,
    CORE_ACTION_SLOT_END,
    [coreExportEntry(action)],
    isCoreActionExport,
  );
  const indexMutation = updateMutation(indexPath, indexContent, nextIndex);
  const mutations =
    indexMutation === undefined ? [actionMutation] : [actionMutation, indexMutation];
  ensureUniqueMutationPaths(mutations);
  return { mutations, result: { actionPath } };
};

export const planActionScaffold = async (
  workspaceRoot: string,
  config: ActionScaffoldConfig,
): Promise<ScaffoldPlan<ActionScaffoldResult>> => {
  const action = requireCanonicalSlug(config.action, 'action');
  if (config.scope === 'core') {
    return planCoreActionScaffold(workspaceRoot, config.module, action);
  }
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
