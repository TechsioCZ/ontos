import { readFile } from 'node:fs/promises';
import {
  ACTION_GENERATOR_HEADER,
  CORE_ACTION_SLOT_END,
  CORE_ACTION_SLOT_START,
  MODULE_MANIFEST_ACTION_SLOT_END,
  MODULE_MANIFEST_ACTION_SLOT_START,
  MODULE_MANIFEST_IMPORT_SLOT_END,
  MODULE_MANIFEST_IMPORT_SLOT_START,
  MODULE_REGISTRATION_ACTION_SLOT_END,
  MODULE_REGISTRATION_ACTION_SLOT_START,
  MODULE_REGISTRATION_IMPORT_SLOT_END,
  MODULE_REGISTRATION_IMPORT_SLOT_START,
  OUTBOX_SLOT_END,
  OUTBOX_SLOT_START,
  createMutation,
  discoverOntosModule,
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
  OntosVerticalMetadata,
} from '../shared.mts';

const renderAction = (
  vertical: OntosVerticalMetadata,
  action: string,
  legalEntityScope: ActionScaffoldConfig['legalEntityScope'],
): string => {
  const actionType = toPascalCase(action);
  const actionValue = `${toCamelCase(action)}Action`;
  const handler = `handle${actionType}`;
  return `${ACTION_GENERATOR_HEADER}
// @ontos-action-owner ${vertical.moduleId}
// @ontos-action-slug ${action}
import { Effect, Schema } from 'effect';
import { defineAction, defineTenantModuleEntrypoint } from '@app/core-runtime';

export const ${actionType}Payload = Schema.Struct({});
type ${actionType}PayloadType = Schema.Schema.Type<typeof ${actionType}Payload>;
export type { ${actionType}PayloadType as ${actionType}Payload };

export const ${actionType}Result = Schema.Struct({});
type ${actionType}ResultType = Schema.Schema.Type<typeof ${actionType}Result>;
export type { ${actionType}ResultType as ${actionType}Result };

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
      policyKey: '${vertical.moduleId}.${action}.access.v1',
    },
    actionKey: '${vertical.moduleId}.${action}',
    auditProfile: 'standard',
    domainErrorSchema: ${actionType}NotImplemented,
    domainEvents: {},
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      entrypointKey: '${vertical.moduleId}.${action}',
      moduleKey: '${vertical.moduleId}',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: '${legalEntityScope}',
    owningModuleKey: '${vertical.moduleId}',
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

const renderCoreAction = (
  moduleKey: string,
  action: string,
  legalEntityScope: ActionScaffoldConfig['legalEntityScope'],
): string => {
  const actionType = toPascalCase(action);
  const actionValue = `${toCamelCase(action)}Action`;
  const handler = `handle${actionType}`;
  return `${ACTION_GENERATOR_HEADER}
// @ontos-action-owner ${moduleKey}
// @ontos-action-slug ${action}
import { Effect, Schema } from 'effect';
import { defineAction } from '../../actions/definition.ts';
import { defineSystemModuleEntrypoint } from '../module-entrypoint.ts';

export const ${actionType}Payload = Schema.Struct({});
type ${actionType}PayloadType = Schema.Schema.Type<typeof ${actionType}Payload>;
export type { ${actionType}PayloadType as ${actionType}Payload };

export const ${actionType}Result = Schema.Struct({});
type ${actionType}ResultType = Schema.Schema.Type<typeof ${actionType}Result>;
export type { ${actionType}ResultType as ${actionType}Result };

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
    entrypoint: defineSystemModuleEntrypoint({
      access: 'write',
      entrypointKey: '${moduleKey}.${action}',
      moduleKey: '${moduleKey}',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: '${legalEntityScope}',
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
  legalEntityScope: ActionScaffoldConfig['legalEntityScope'],
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
  const actionMutation = await createMutation(
    actionPath,
    renderCoreAction(moduleKey, action, legalEntityScope),
  );
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
    return planCoreActionScaffold(workspaceRoot, config.module, action, config.legalEntityScope);
  }
  const vertical = await discoverOntosModule(workspaceRoot, config.vertical);
  const actionPath = resolveContainedPath(
    workspaceRoot,
    'verticals',
    vertical.slug,
    'src',
    'actions',
    `${action}.action.ts`,
  );
  const actionMutation = await createMutation(
    actionPath,
    renderAction(vertical, action, config.legalEntityScope),
  );
  const actionValue = `${toCamelCase(action)}Action`;
  const ownerImport = `import { ${actionValue} } from './src/actions/${action}.action.ts';`;
  const nextManifest = insertSortedSlot(
    insertSortedSlot(
      vertical.manifestContent,
      MODULE_MANIFEST_IMPORT_SLOT_START,
      MODULE_MANIFEST_IMPORT_SLOT_END,
      [ownerImport],
      (candidate) =>
        /^(?:import \{ [a-z][A-Za-z0-9]*Action \} from '\.\/src\/actions\/[a-z][a-z0-9-]*\.action\.ts';|import \{ [A-Z][A-Za-z0-9]*Api \} from '\.\/shared\/apis\/[a-z][a-z0-9-]*\.ts';|import \{ [A-Z][A-Za-z0-9]*Page \} from '\.\/src\/routes\/.+\/page\.tsx';|import \{ [A-Z][A-Za-z0-9]* \} from '\.\/src\/components\/[a-z][a-z0-9-]*\.tsx';)$/u.test(
          candidate,
        ),
    ),
    MODULE_MANIFEST_ACTION_SLOT_START,
    MODULE_MANIFEST_ACTION_SLOT_END,
    [`${actionValue},`],
    (candidate) => /^[a-z][A-Za-z0-9]*Action,$/u.test(candidate),
  );
  const nextRegistration = insertSortedSlot(
    insertSortedSlot(
      vertical.registrationContent,
      MODULE_REGISTRATION_IMPORT_SLOT_START,
      MODULE_REGISTRATION_IMPORT_SLOT_END,
      [ownerImport],
      (candidate) =>
        /^import \{ [a-z][A-Za-z0-9]*Action \} from '\.\/src\/actions\/[a-z][a-z0-9-]*\.action\.ts';$/u.test(
          candidate,
        ),
    ),
    MODULE_REGISTRATION_ACTION_SLOT_START,
    MODULE_REGISTRATION_ACTION_SLOT_END,
    [`${actionValue},`],
    (candidate) => /^[a-z][A-Za-z0-9]*Action,$/u.test(candidate),
  );
  const manifestMutation = updateMutation(
    vertical.manifestPath,
    vertical.manifestContent,
    nextManifest,
  );
  const registrationMutation = updateMutation(
    vertical.registrationPath,
    vertical.registrationContent,
    nextRegistration,
  );
  const dependencyMutation = withCoreDependency(vertical);
  const mutations = [
    actionMutation,
    manifestMutation,
    registrationMutation,
    dependencyMutation,
  ].filter((mutation) => mutation !== undefined);
  ensureUniqueMutationPaths(mutations);
  return { mutations, result: { actionPath } };
};

export default createCodesmithGenerator(planActionScaffold);
