import { readFile } from 'node:fs/promises';
import {
  ACTION_GENERATOR_HEADER,
  CORE_ACTION_CATALOG_IMPORT_SLOT_END,
  CORE_ACTION_CATALOG_IMPORT_SLOT_START,
  CORE_ACTION_CATALOG_VALUE_SLOT_END,
  CORE_ACTION_CATALOG_VALUE_SLOT_START,
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
  isModuleManifestImport,
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
  provisioning: ActionScaffoldConfig['provisioning'],
): string => {
  const actionType = toPascalCase(action);
  const actionValue = `${toCamelCase(action)}Action`;
  const handler = `handle${actionType}`;
  return `${ACTION_GENERATOR_HEADER}
// @ontos-action-owner ${vertical.moduleId}
// @ontos-action-slug ${action}
import { Effect, Schema } from 'effect';
import { defineAction, defineTenantModuleEntrypoint } from '@app/core-runtime';

export const ${actionType}PayloadSchema = Schema.Struct({});
export type ${actionType}Payload = Schema.Schema.Type<typeof ${actionType}PayloadSchema>;

export const ${actionType}ResultSchema = Schema.Struct({});
export type ${actionType}Result = Schema.Schema.Type<typeof ${actionType}ResultSchema>;

export class ${actionType}NotImplemented extends Schema.TaggedError<${actionType}NotImplemented>()(
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
      authorization: { kind: 'action_execution', provisioning: '${provisioning}' },
      entrypointKey: '${vertical.moduleId}.${action}',
      moduleKey: '${vertical.moduleId}',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: '${legalEntityScope}',
    owningModuleKey: '${vertical.moduleId}',
    payloadSchema: ${actionType}PayloadSchema,
    policies: [],
    resultSchema: ${actionType}ResultSchema,
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
  provisioning: ActionScaffoldConfig['provisioning'],
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

export const ${actionType}PayloadSchema = Schema.Struct({});
export type ${actionType}Payload = Schema.Schema.Type<typeof ${actionType}PayloadSchema>;

export const ${actionType}ResultSchema = Schema.Struct({});
export type ${actionType}Result = Schema.Schema.Type<typeof ${actionType}ResultSchema>;

export class ${actionType}NotImplemented extends Schema.TaggedError<${actionType}NotImplemented>()(
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
      authorization: { kind: 'action_execution', provisioning: '${provisioning}' },
      entrypointKey: '${moduleKey}.${action}',
      moduleKey: '${moduleKey}',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: '${legalEntityScope}',
    owningModuleKey: '${moduleKey}',
    payloadSchema: ${actionType}PayloadSchema,
    policies: [],
    resultSchema: ${actionType}ResultSchema,
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

const coreCatalogImportEntry = (action: string): string =>
  `import { ${toCamelCase(action)}Action } from './${action}.action.ts';`;

const isCoreActionCatalogImport = (candidate: string): boolean =>
  /^import \{ [a-z][A-Za-z0-9]*Action \} from '\.\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.action\.ts';$/u.test(
    candidate,
  );

const coreCatalogValueEntry = (action: string): string =>
  `${toCamelCase(action)}Action.descriptor,`;

const isCoreActionCatalogValue = (candidate: string): boolean =>
  /^[a-z][A-Za-z0-9]*Action\.descriptor,$/u.test(candidate);

const planCoreActionScaffold = async (
  workspaceRoot: string,
  moduleKeyInput: string,
  action: string,
  legalEntityScope: ActionScaffoldConfig['legalEntityScope'],
  provisioning: ActionScaffoldConfig['provisioning'],
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
  const catalogPath = resolveContainedPath(
    workspaceRoot,
    'packages',
    'core-runtime',
    'src',
    'modules',
    'actions',
    'catalog.ts',
  );
  const actionMutation = await createMutation(
    actionPath,
    renderCoreAction(moduleKey, action, legalEntityScope, provisioning),
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
  const catalogContent = await readFile(catalogPath, 'utf-8');
  const nextCatalog = insertSortedSlot(
    insertSortedSlot(
      catalogContent,
      CORE_ACTION_CATALOG_IMPORT_SLOT_START,
      CORE_ACTION_CATALOG_IMPORT_SLOT_END,
      [coreCatalogImportEntry(action)],
      isCoreActionCatalogImport,
    ),
    CORE_ACTION_CATALOG_VALUE_SLOT_START,
    CORE_ACTION_CATALOG_VALUE_SLOT_END,
    [coreCatalogValueEntry(action)],
    isCoreActionCatalogValue,
  );
  const catalogMutation = updateMutation(catalogPath, catalogContent, nextCatalog);
  const mutations = [actionMutation, indexMutation, catalogMutation].filter(
    (mutation) => mutation !== undefined,
  );
  ensureUniqueMutationPaths(mutations);
  return { mutations, result: { actionPath } };
};

export const planActionScaffold = async (
  workspaceRoot: string,
  config: ActionScaffoldConfig,
): Promise<ScaffoldPlan<ActionScaffoldResult>> => {
  const action = requireCanonicalSlug(config.action, 'action');
  if (config.scope === 'core') {
    return planCoreActionScaffold(
      workspaceRoot,
      config.module,
      action,
      config.legalEntityScope,
      config.provisioning,
    );
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
    renderAction(vertical, action, config.legalEntityScope, config.provisioning),
  );
  const actionValue = `${toCamelCase(action)}Action`;
  const ownerImport = `import { ${actionValue} } from './src/actions/${action}.action.ts';`;
  const nextManifest = insertSortedSlot(
    insertSortedSlot(
      vertical.manifestContent,
      MODULE_MANIFEST_IMPORT_SLOT_START,
      MODULE_MANIFEST_IMPORT_SLOT_END,
      [ownerImport],
      isModuleManifestImport,
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
        ) ||
        /^import \{ [a-z][A-Za-z0-9]*Worker \} from '\.\/src\/workers\/[a-z][a-z0-9-]*\.worker\.ts';$/u.test(
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
