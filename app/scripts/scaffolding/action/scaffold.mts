import { Effect, FileSystem } from 'effect';
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
  createMutationEffect,
  discoverOntosModuleEffect,
  ensureUniqueMutationPaths,
  insertSortedSlot,
  isModuleManifestImport,
  requireCanonicalSlug,
  requireCoreModuleKey,
  resolveContainedPath,
  scaffoldFailure,
  toCamelCase,
  toPascalCase,
  toTitle,
  tryScaffold,
  updateMutation,
  withCoreDependency,
} from '../shared.mts';
import { createCodesmithGenerator } from '../generator-adapter.mts';
import type { ActionScaffoldConfig, OntosVerticalMetadata } from '../shared.mts';

const CORE_RUNTIME_DIRECTORY = 'core-runtime';

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

const planCoreActionScaffold = Effect.fn('ActionScaffold.planCore')(
  function* planCoreActionScaffold(
    workspaceRoot: string,
    moduleKeyInput: string,
    action: string,
    legalEntityScope: ActionScaffoldConfig['legalEntityScope'],
    provisioning: ActionScaffoldConfig['provisioning'],
  ) {
    const moduleKey = yield* tryScaffold('Core module key is invalid', () =>
      requireCoreModuleKey(moduleKeyInput),
    );
    const [actionPath, indexPath, catalogPath] = yield* tryScaffold(
      'failed to resolve Core Action paths',
      () =>
        [
          resolveContainedPath(
            workspaceRoot,
            'packages',
            CORE_RUNTIME_DIRECTORY,
            'src',
            'modules',
            'actions',
            `${action}.action.ts`,
          ),
          resolveContainedPath(
            workspaceRoot,
            'packages',
            CORE_RUNTIME_DIRECTORY,
            'src',
            'index.ts',
          ),
          resolveContainedPath(
            workspaceRoot,
            'packages',
            CORE_RUNTIME_DIRECTORY,
            'src',
            'modules',
            'actions',
            'catalog.ts',
          ),
        ] as const,
    );
    const actionMutation = yield* createMutationEffect(
      actionPath,
      renderCoreAction(moduleKey, action, legalEntityScope, provisioning),
    );
    const fileSystem = yield* FileSystem.FileSystem;
    const indexContent = yield* fileSystem
      .readFileString(indexPath)
      .pipe(Effect.mapError((cause) => scaffoldFailure(`failed to read ${indexPath}`, cause)));
    const nextIndex = yield* tryScaffold('failed to patch the Core Action export slot', () =>
      insertSortedSlot(
        indexContent,
        CORE_ACTION_SLOT_START,
        CORE_ACTION_SLOT_END,
        [coreExportEntry(action)],
        isCoreActionExport,
      ),
    );
    const indexMutation = updateMutation(indexPath, indexContent, nextIndex);
    const catalogContent = yield* fileSystem
      .readFileString(catalogPath)
      .pipe(Effect.mapError((cause) => scaffoldFailure(`failed to read ${catalogPath}`, cause)));
    const nextCatalog = yield* tryScaffold('failed to patch the Core Action catalog', () =>
      insertSortedSlot(
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
      ),
    );
    const catalogMutation = updateMutation(catalogPath, catalogContent, nextCatalog);
    const mutations = [actionMutation, indexMutation, catalogMutation].filter(
      (mutation) => mutation !== undefined,
    );
    yield* tryScaffold('Core Action mutation paths are invalid', () =>
      ensureUniqueMutationPaths(mutations),
    );
    return { mutations, result: { actionPath } };
  },
);

export const planActionScaffold = Effect.fn('ActionScaffold.plan')(function* planActionScaffold(
  workspaceRoot: string,
  config: ActionScaffoldConfig,
) {
  const action = yield* tryScaffold('Action name is invalid', () =>
    requireCanonicalSlug(config.action, 'action'),
  );
  if (config.scope === 'core') {
    return yield* planCoreActionScaffold(
      workspaceRoot,
      config.module,
      action,
      config.legalEntityScope,
      config.provisioning,
    );
  }
  const vertical = yield* discoverOntosModuleEffect(workspaceRoot, config.vertical);
  const actionPath = yield* tryScaffold('failed to resolve Action path', () =>
    resolveContainedPath(
      workspaceRoot,
      'verticals',
      vertical.slug,
      'src',
      'actions',
      `${action}.action.ts`,
    ),
  );
  const actionMutation = yield* createMutationEffect(
    actionPath,
    renderAction(vertical, action, config.legalEntityScope, config.provisioning),
  );
  const actionValue = `${toCamelCase(action)}Action`;
  const ownerImport = `import { ${actionValue} } from './src/actions/${action}.action.ts';`;
  const [nextManifest, nextRegistration] = yield* tryScaffold(
    'failed to patch generated Action owner slots',
    () =>
      [
        insertSortedSlot(
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
        ),
        insertSortedSlot(
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
        ),
      ] as const,
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
  const dependencyMutation = yield* tryScaffold('failed to patch the Core dependency', () =>
    withCoreDependency(vertical),
  );
  const mutations = [
    actionMutation,
    manifestMutation,
    registrationMutation,
    dependencyMutation,
  ].filter((mutation) => mutation !== undefined);
  yield* tryScaffold('Action mutation paths are invalid', () =>
    ensureUniqueMutationPaths(mutations),
  );
  return { mutations, result: { actionPath } };
});

export default createCodesmithGenerator(planActionScaffold);
