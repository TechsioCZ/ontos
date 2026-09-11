import { Array as EffectArray, Effect, FileSystem, Option, Schema } from 'effect';

import { topLevelSeparators } from '../../boundary-source-structure.mts';
import { createCodesmithGenerator } from '../generator-adapter.mts';
import {
  MODULE_CONTRACT_GENERATOR_HEADER,
  GOVERNED_HTTP_API_ADDITION_SLOT_END,
  GOVERNED_HTTP_API_ADDITION_SLOT_START,
  GOVERNED_HTTP_API_IMPORT_SLOT_END,
  GOVERNED_HTTP_API_IMPORT_SLOT_START,
  GOVERNED_HTTP_HANDLER_IMPORT_SLOT_END,
  GOVERNED_HTTP_HANDLER_IMPORT_SLOT_START,
  GOVERNED_HTTP_HANDLER_LAYER_SLOT_END,
  GOVERNED_HTTP_HANDLER_LAYER_SLOT_START,
  GOVERNED_HTTP_HANDLER_SUPPORT_IMPORT_SLOT_END,
  GOVERNED_HTTP_HANDLER_SUPPORT_IMPORT_SLOT_START,
  GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_END,
  GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_START,
  MODULE_MANIFEST_ACTION_SLOT_END,
  MODULE_MANIFEST_ACTION_SLOT_START,
  MODULE_MANIFEST_API_SLOT_END,
  MODULE_MANIFEST_API_SLOT_START,
  MODULE_MANIFEST_COMPONENT_SLOT_END,
  MODULE_MANIFEST_COMPONENT_SLOT_START,
  MODULE_MANIFEST_IMPORT_SLOT_END,
  MODULE_MANIFEST_IMPORT_SLOT_START,
  MODULE_REGISTRATION_ACTION_SLOT_END,
  MODULE_REGISTRATION_ACTION_SLOT_START,
  MODULE_REGISTRATION_API_SLOT_END,
  MODULE_REGISTRATION_API_SLOT_START,
  MODULE_REGISTRATION_COMPONENT_SLOT_END,
  MODULE_REGISTRATION_COMPONENT_SLOT_START,
  MODULE_REGISTRATION_IMPORT_SLOT_END,
  MODULE_REGISTRATION_IMPORT_SLOT_START,
  MODULE_REGISTRATION_PAGE_SLOT_END,
  MODULE_REGISTRATION_PAGE_SLOT_START,
  MODULE_REGISTRATION_REPORT_SLOT_END,
  MODULE_REGISTRATION_REPORT_SLOT_START,
  MODULE_REGISTRATION_SEARCH_SLOT_END,
  MODULE_REGISTRATION_SEARCH_SLOT_START,
  MODULE_REGISTRATION_WORKER_SLOT_END,
  MODULE_REGISTRATION_WORKER_SLOT_START,
  ONTOS_MODULE_CONTRACT_PACKAGE_SCHEMA_VERSION,
  VERTICAL_PUBLIC_COMPONENT_SLOT_END,
  VERTICAL_PUBLIC_COMPONENT_SLOT_START,
  VERTICAL_REPORT_SLOT_END,
  VERTICAL_REPORT_SLOT_START,
  VERTICAL_SEARCH_SLOT_END,
  VERTICAL_SEARCH_SLOT_START,
  MODULE_MANIFEST_REPORT_SLOT_END,
  MODULE_MANIFEST_REPORT_SLOT_START,
  MODULE_MANIFEST_RESOURCE_SLOT_END,
  MODULE_MANIFEST_RESOURCE_SLOT_START,
  MODULE_MANIFEST_SEARCH_SLOT_END,
  MODULE_MANIFEST_SEARCH_SLOT_START,
  MODULE_MANIFEST_SHELL_COMPONENT_SLOT_END,
  MODULE_MANIFEST_SHELL_COMPONENT_SLOT_START,
  MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_END,
  MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_START,
  MODULE_MANIFEST_SHELL_PAGE_SLOT_END,
  MODULE_MANIFEST_SHELL_PAGE_SLOT_START,
  MODULE_MANIFEST_SHELL_REPORT_SLOT_END,
  MODULE_MANIFEST_SHELL_REPORT_SLOT_START,
  MODULE_MANIFEST_SHELL_SEARCH_SLOT_END,
  MODULE_MANIFEST_SHELL_SEARCH_SLOT_START,
  asJsonObject,
  createMutationEffect,
  discoverVerticalEffect,
  ensureUniqueMutationPaths,
  maskNonCode,
  patchJsonObjectProperty,
  raiseScaffoldFailure,
  readJsonEffect,
  requireOntosModuleId,
  requiredString,
  resolveContainedPath,
  toCamelCase,
  toTitle,
  updateMutation,
  createScaffoldErrorTools,
} from '../shared.mts';
import type {
  JsonValue,
  Mutation,
  ModuleContractScaffoldConfig,
  ModuleContractScaffoldResult,
  ScaffoldPlan,
  ScaffoldFailure,
  VerticalMetadata,
} from '../shared.mts';

const moduleMarkerPattern = /^\/\/ @ontos-module-id (?<moduleId>[^\s]+)$/mu;
const MANIFEST_FILE_NAME = 'vertical.manifest.ts';

const renderGovernedHttpApiRoot = (vertical: VerticalMetadata): string => `${MODULE_CONTRACT_GENERATOR_HEADER}
// @ontos-deployment-app-id ${vertical.appId}
import { HttpApi } from '@modern-js/bff-effect/effect-client';
import { identity } from 'effect';

${GOVERNED_HTTP_API_IMPORT_SLOT_START}
${GOVERNED_HTTP_API_IMPORT_SLOT_END}

export const governedHttpApi = HttpApi.make('${toCamelCase(vertical.slug)}GovernedApi')
  ${GOVERNED_HTTP_API_ADDITION_SLOT_START}
  ${GOVERNED_HTTP_API_ADDITION_SLOT_END}
  .pipe(identity);
`;

const topLevelStatementEnd = (structure: string, start: number): number =>
  topLevelSeparators(structure, ';', start)[0] ?? -1;

const initializeGovernedHttpApiRoot = (source: string, vertical: VerticalMetadata): string => {
  if (
    source.includes(GOVERNED_HTTP_API_IMPORT_SLOT_START) ||
    source.includes(GOVERNED_HTTP_API_ADDITION_SLOT_START) ||
    source.includes('governedHttpApi')
  ) {
    return raiseScaffoldFailure(`vertical ${vertical.slug} shared API already uses reserved governed-read composition`);
  }
  const structure = maskNonCode(source);
  const declarations = [...structure.matchAll(/export const (?<api>[A-Za-z][A-Za-z0-9]*)\s*=\s*HttpApi\.make\(/gu)];
  if (declarations.length !== 1) {
    return raiseScaffoldFailure(`vertical ${vertical.slug} shared API must contain exactly one generated HttpApi root`);
  }
  const [declaration] = declarations;
  const apiValue = declaration?.groups?.['api'];
  const declarationStart = declaration?.index;
  if (apiValue === undefined || declarationStart === undefined) {
    return raiseScaffoldFailure(`vertical ${vertical.slug} shared API root is malformed`);
  }
  const statementEnd = topLevelStatementEnd(structure, declarationStart);
  if (statementEnd === -1) {
    return raiseScaffoldFailure(`vertical ${vertical.slug} shared API root has no terminator`);
  }
  return `${source.slice(0, declarationStart)}${GOVERNED_HTTP_API_IMPORT_SLOT_START}
${GOVERNED_HTTP_API_IMPORT_SLOT_END}

import { identity as governedHttpApiIdentity } from 'effect';

${source.slice(declarationStart, statementEnd)}
  ${GOVERNED_HTTP_API_ADDITION_SLOT_START}
  ${GOVERNED_HTTP_API_ADDITION_SLOT_END}
  .pipe(governedHttpApiIdentity)${source.slice(statementEnd, statementEnd + 1)}

/** Canonical composition-root binding consumed by generated governed HTTP adapters. */
export const governedHttpApi = ${apiValue};${source.slice(statementEnd + 1)}`;
};

const initializeGovernedHttpHandlerRoot = (source: string, vertical: VerticalMetadata): string => {
  for (const reserved of [
    'GovernedReadRuntime',
    'GovernedReadLayer',
    'governedReadRuntimeLive',
    'governedReadApiHandlersLive',
    GOVERNED_HTTP_HANDLER_IMPORT_SLOT_START,
    GOVERNED_HTTP_HANDLER_LAYER_SLOT_START,
    GOVERNED_HTTP_HANDLER_SUPPORT_IMPORT_SLOT_START,
    GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_START,
  ]) {
    if (source.includes(reserved)) {
      return raiseScaffoldFailure(
        `vertical ${vertical.slug} API root already uses reserved governed-read composition ${reserved}`,
      );
    }
  }
  const runtimeLayerNeedle = ') satisfies EffectRuntimeLayer;';
  const runtimeLayerEnd = source.lastIndexOf(runtimeLayerNeedle);
  if (runtimeLayerEnd === -1) {
    return raiseScaffoldFailure(`vertical ${vertical.slug} API root must expose the pinned Effect runtime layer`);
  }
  const runtimeLayerStart = source.lastIndexOf('const layer = HttpApiBuilder.layer(', runtimeLayerEnd);
  if (runtimeLayerStart === -1) {
    return raiseScaffoldFailure(`vertical ${vertical.slug} API root must contain the pinned HttpApiBuilder layer`);
  }
  const generatedRoot = `import {
  ContextAccessLive as GovernedContextAccessLive,
  CorePersistenceLive as GovernedCorePersistenceLive,
  DatabaseConfigLive as GovernedDatabaseConfigLive,
  ReadRuntimeLive as GovernedReadRuntimeLive,
  TenantModuleStateServiceLive as GovernedTenantModuleStateServiceLive,
} from '@app/core-runtime';
import {
  ModuleEntrypointGatewayLive as GovernedModuleEntrypointGatewayLive,
  ModuleStateGateLive as GovernedModuleStateGateLive,
  OperationalScopeResolverLive as GovernedOperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { Layer as GovernedReadLayer } from 'effect';
${GOVERNED_HTTP_HANDLER_SUPPORT_IMPORT_SLOT_START}
${GOVERNED_HTTP_HANDLER_SUPPORT_IMPORT_SLOT_END}

${GOVERNED_HTTP_HANDLER_IMPORT_SLOT_START}
${GOVERNED_HTTP_HANDLER_IMPORT_SLOT_END}

const governedTenantModuleStateServiceLive = GovernedTenantModuleStateServiceLive.pipe(
  GovernedReadLayer.provide(GovernedCorePersistenceLive),
);
const governedModuleStateGateLive = GovernedModuleStateGateLive.pipe(
  GovernedReadLayer.provide(governedTenantModuleStateServiceLive),
);
const governedReadRuntimeDependenciesLive = GovernedReadLayer.mergeAll(
  GovernedCorePersistenceLive,
  GovernedContextAccessLive,
  GovernedModuleEntrypointGatewayLive.pipe(GovernedReadLayer.provide(governedModuleStateGateLive)),
  GovernedOperationalScopeResolverLive.pipe(
    GovernedReadLayer.provide(
      GovernedReadLayer.mergeAll(GovernedCorePersistenceLive, GovernedContextAccessLive),
    ),
  ),
);
const governedReadRuntimeLive = GovernedReadRuntimeLive.pipe(
  GovernedReadLayer.provide(governedReadRuntimeDependenciesLive),
);

export const governedReadApiHandlersLive = GovernedReadLayer.mergeAll(
  GovernedReadLayer.empty,
  ${GOVERNED_HTTP_HANDLER_LAYER_SLOT_START}
  ${GOVERNED_HTTP_HANDLER_LAYER_SLOT_END}
).pipe(
  ${GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_START}
  ${GOVERNED_HTTP_HANDLER_SUPPORT_LAYER_SLOT_END}
  GovernedReadLayer.provide(GovernedReadLayer.empty),
);
`;
  return `${generatedRoot}\n${source.slice(0, runtimeLayerStart)}${source.slice(
    runtimeLayerStart,
    runtimeLayerEnd,
  )}  GovernedReadLayer.provide(governedReadApiHandlersLive),
  GovernedReadLayer.provide(GovernedDatabaseConfigLive),
  GovernedReadLayer.orDie,
${source.slice(runtimeLayerEnd)}`;
};

class ModuleContractScaffoldError extends Schema.TaggedError<ModuleContractScaffoldError>()(
  'ModuleContractScaffoldError',
  {
    cause: Schema.optionalKey(Schema.Unknown),
    message: Schema.String,
  },
) {}

const { scaffoldError, trySync } = createScaffoldErrorTools(
  ModuleContractScaffoldError,
  Schema.is(ModuleContractScaffoldError),
  'module contract update failed',
);

const readModuleOwner = (fileSystem: FileSystem.FileSystem, verticalsRoot: string, entryName: string) => {
  const manifestPath = resolveContainedPath(verticalsRoot, entryName, MANIFEST_FILE_NAME);
  return Effect.gen(function* readModuleOwnerEffect() {
    const exists = yield* fileSystem
      .exists(manifestPath)
      .pipe(Effect.mapError((cause) => scaffoldError(`failed to inspect ${manifestPath}`, cause)));
    if (!exists) {
      return null;
    }
    const content = yield* fileSystem
      .readFileString(manifestPath)
      .pipe(Effect.mapError((cause) => scaffoldError(`failed to read ${manifestPath}`, cause)));
    return {
      entryName,
      moduleId: moduleMarkerPattern.exec(content)?.groups?.['moduleId'],
    };
  });
};

const assertUniqueModuleId = (
  workspaceRoot: string,
  targetSlug: string,
  moduleId: string,
): Effect.Effect<void, ModuleContractScaffoldError, FileSystem.FileSystem> =>
  Effect.gen(function* assertUniqueModuleIdEffect() {
    const verticalsRoot = yield* trySync(() => resolveContainedPath(workspaceRoot, 'verticals'));
    const fileSystem = yield* FileSystem.FileSystem;
    const entries = yield* fileSystem
      .readDirectory(verticalsRoot)
      .pipe(
        Effect.mapError((cause) => scaffoldError(`failed to inspect generated verticals at ${verticalsRoot}`, cause)),
      );
    const owners = yield* Effect.forEach(
      entries.filter((entryName) => entryName !== targetSlug),
      (entryName) => readModuleOwner(fileSystem, verticalsRoot, entryName),
      { concurrency: 'unbounded' },
    );
    const duplicate = owners.find((owner) => owner?.moduleId === moduleId);
    if (duplicate !== undefined && duplicate !== null) {
      return yield* scaffoldError(`duplicate OntOS module ID ${moduleId} in vertical ${duplicate.entryName}`);
    }
    return yield* Effect.void;
  });

const renderManifest = (vertical: VerticalMetadata, moduleId: string): string => {
  const valueName = `${toCamelCase(vertical.slug)}Manifest`;
  return `${MODULE_CONTRACT_GENERATOR_HEADER}
// @ontos-deployment-app-id ${vertical.appId}
// @ontos-module-id ${moduleId}
import {
  defineOntosModuleManifest,
  ShellNavigationContributionSchema,
  ShellPageContributionSchema,
  ShellPublicComponentContributionSchema,
  ShellReportContributionSchema,
  ShellSearchContributionSchema,
} from '@app/core-runtime';
import { Result, Schema } from 'effect';
${MODULE_MANIFEST_IMPORT_SLOT_START}
${MODULE_MANIFEST_IMPORT_SLOT_END}

type NavigationContributionInput = typeof ShellNavigationContributionSchema.Encoded;
type PageContributionInput = typeof ShellPageContributionSchema.Encoded;
type PublicComponentContributionInput = typeof ShellPublicComponentContributionSchema.Encoded;
type ReportContributionInput = typeof ShellReportContributionSchema.Encoded;
type SearchContributionInput = typeof ShellSearchContributionSchema.Encoded;

const navigationContribution = (value: NavigationContributionInput) =>
  Result.getOrThrow(Schema.decodeUnknownResult(ShellNavigationContributionSchema)(value));
const pageContribution = (value: PageContributionInput) =>
  Result.getOrThrow(Schema.decodeUnknownResult(ShellPageContributionSchema)(value));
const publicComponentContribution = (value: PublicComponentContributionInput) =>
  Result.getOrThrow(Schema.decodeUnknownResult(ShellPublicComponentContributionSchema)(value));
const reportContribution = (value: ReportContributionInput) =>
  Result.getOrThrow(Schema.decodeUnknownResult(ShellReportContributionSchema)(value));
const searchContribution = (value: SearchContributionInput) =>
  Result.getOrThrow(Schema.decodeUnknownResult(ShellSearchContributionSchema)(value));

export const ${valueName} = defineOntosModuleManifest({
  activation: {
    defaultState: 'inactive',
    preservesHistoryWhenInactive: true,
    scope: 'tenant',
    supportedStates: [
      'inactive',
      'active',
      'read_only',
      'suspended',
      'quarantined',
      'deprecated',
      'archived',
    ],
  },
  module: {
    description: '${toTitle(vertical.slug)} business capability.',
    displayName: '${toTitle(vertical.slug)}',
    id: '${moduleId}',
    implementedAs: 'ultramodern_microvertical',
    kind: 'business_module',
  },
  publicSurface: {
    actions: [
      ${MODULE_MANIFEST_ACTION_SLOT_START}
      ${MODULE_MANIFEST_ACTION_SLOT_END}
    ],
    api: {
      ${MODULE_MANIFEST_API_SLOT_START}
      ${MODULE_MANIFEST_API_SLOT_END}
    },
    components: {
      ${MODULE_MANIFEST_COMPONENT_SLOT_START}
      ${MODULE_MANIFEST_COMPONENT_SLOT_END}
    },
    events: [],
    reports: [
      ${MODULE_MANIFEST_REPORT_SLOT_START}
      ${MODULE_MANIFEST_REPORT_SLOT_END}
    ],
    resourceTypes: [
      ${MODULE_MANIFEST_RESOURCE_SLOT_START}
      ${MODULE_MANIFEST_RESOURCE_SLOT_END}
    ],
    search: [
      ${MODULE_MANIFEST_SEARCH_SLOT_START}
      ${MODULE_MANIFEST_SEARCH_SLOT_END}
    ],
    shellContributions: {
      mediaAttachments: [],
      navigation: [
        ${MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_START}
        ${MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_END}
      ],
      pages: [
        ${MODULE_MANIFEST_SHELL_PAGE_SLOT_START}
        ${MODULE_MANIFEST_SHELL_PAGE_SLOT_END}
      ],
      publicComponents: [
        ${MODULE_MANIFEST_SHELL_COMPONENT_SLOT_START}
        ${MODULE_MANIFEST_SHELL_COMPONENT_SLOT_END}
      ],
      reports: [
        ${MODULE_MANIFEST_SHELL_REPORT_SLOT_START}
        ${MODULE_MANIFEST_SHELL_REPORT_SLOT_END}
      ],
      resourceDetails: [],
      search: [
        ${MODULE_MANIFEST_SHELL_SEARCH_SLOT_START}
        ${MODULE_MANIFEST_SHELL_SEARCH_SLOT_END}
      ],
      timelines: [],
    },
  },
});
`;
};

const renderRegistration = (vertical: VerticalMetadata, moduleId: string): string => {
  const prefix = toCamelCase(vertical.slug);
  return `${MODULE_CONTRACT_GENERATOR_HEADER}
// @ontos-deployment-app-id ${vertical.appId}
// @ontos-module-id ${moduleId}
import { defineVerticalRuntimeRegistration } from '@app/core-runtime';
import { ${prefix}Manifest } from './vertical.manifest.ts';
${MODULE_REGISTRATION_IMPORT_SLOT_START}
${MODULE_REGISTRATION_IMPORT_SLOT_END}

export const ${prefix}Registration = defineVerticalRuntimeRegistration({
  actions: [
    ${MODULE_REGISTRATION_ACTION_SLOT_START}
    ${MODULE_REGISTRATION_ACTION_SLOT_END}
  ],
  entrypoints: {
    api: {
      ${MODULE_REGISTRATION_API_SLOT_START}
      ${MODULE_REGISTRATION_API_SLOT_END}
    },
    components: {
      ${MODULE_REGISTRATION_COMPONENT_SLOT_START}
      ${MODULE_REGISTRATION_COMPONENT_SLOT_END}
    },
    pages: {
      ${MODULE_REGISTRATION_PAGE_SLOT_START}
      ${MODULE_REGISTRATION_PAGE_SLOT_END}
    },
    reports: {
      ${MODULE_REGISTRATION_REPORT_SLOT_START}
      ${MODULE_REGISTRATION_REPORT_SLOT_END}
    },
    search: {
      ${MODULE_REGISTRATION_SEARCH_SLOT_START}
      ${MODULE_REGISTRATION_SEARCH_SLOT_END}
    },
  },
  manifest: ${prefix}Manifest,
  outboxWorkers: [
    ${MODULE_REGISTRATION_WORKER_SLOT_START}
    ${MODULE_REGISTRATION_WORKER_SLOT_END}
  ],
});

${VERTICAL_PUBLIC_COMPONENT_SLOT_START}
${VERTICAL_PUBLIC_COMPONENT_SLOT_END}
${VERTICAL_SEARCH_SLOT_START}
${VERTICAL_SEARCH_SLOT_END}
${VERTICAL_REPORT_SLOT_START}
${VERTICAL_REPORT_SLOT_END}
`;
};

const addArtifactCommand = (
  current: JsonValue | undefined,
  vertical: VerticalMetadata,
  target: 'cloudflare-dist' | 'dist',
  label: string,
): Effect.Effect<string, ModuleContractScaffoldError> =>
  Effect.gen(function* addArtifactCommandEffect() {
    const script = yield* trySync(() => requiredString(current, `vertical ${vertical.slug} ${label} script`));
    const command = `node ../../scripts/generate-ontos-module-contract.mts --vertical ${vertical.slug} --target ${target}`;
    if (script.includes('generate-ontos-module-contract.mts')) {
      return yield* scaffoldError(`vertical ${vertical.slug} ${label} script already contains module emission`);
    }
    const buildToken = target === 'dist' ? 'modern build' : 'MODERNJS_DEPLOY=cloudflare modern build';
    if (!script.includes(buildToken)) {
      return yield* scaffoldError(`vertical ${vertical.slug} ${label} script is not a generated Modern build`);
    }
    return script.replace(buildToken, `${buildToken} && ${command}`);
  });

const patchPackage = (
  vertical: VerticalMetadata,
  moduleId: string,
): Effect.Effect<string, ModuleContractScaffoldError> =>
  Effect.gen(function* patchPackageEffect() {
    const dependencies = yield* trySync(() => ({
      ...asJsonObject(vertical.packageJson['dependencies'], `vertical ${vertical.slug} dependencies`),
    }));
    const currentCore = dependencies['@app/core-runtime'];
    if (currentCore !== undefined && currentCore !== 'workspace:*') {
      return yield* scaffoldError(`vertical ${vertical.slug} has an incompatible @app/core-runtime dependency`);
    }
    dependencies['@app/core-runtime'] = 'workspace:*';
    const sortedDependencies = Object.fromEntries(
      Object.entries(dependencies).toSorted(([left], [right]) => left.localeCompare(right)),
    );
    const scripts = yield* trySync(() => ({
      ...asJsonObject(vertical.packageJson['scripts'], `vertical ${vertical.slug} scripts`),
    }));
    scripts['build'] = yield* addArtifactCommand(scripts['build'], vertical, 'dist', 'build');
    scripts['cloudflare:build'] = yield* addArtifactCommand(
      scripts['cloudflare:build'],
      vertical,
      'cloudflare-dist',
      'cloudflare:build',
    );
    return yield* trySync(() => {
      let content = patchJsonObjectProperty(vertical.packageContent, [], 'dependencies', sortedDependencies);
      content = patchJsonObjectProperty(content, [], 'scripts', scripts);
      return patchJsonObjectProperty(content, ['modernjs'], 'ontosModule', {
        contractPath: '/.well-known/ontos-module-manifest.json',
        manifest: `./${MANIFEST_FILE_NAME}`,
        moduleId,
        registration: './vertical.registration.ts',
        schemaVersion: ONTOS_MODULE_CONTRACT_PACKAGE_SCHEMA_VERSION,
      });
    });
  });

const patchTsconfig = (
  vertical: VerticalMetadata,
): Effect.Effect<Option.Option<Mutation>, ModuleContractScaffoldError | ScaffoldFailure, FileSystem.FileSystem> =>
  Effect.gen(function* patchTsconfigEffect() {
    const tsconfigPath = yield* trySync(() => resolveContainedPath(vertical.directory, 'tsconfig.json'));
    const { content, value } = yield* readJsonEffect(tsconfigPath, `vertical ${vertical.slug} tsconfig`);
    const include = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(value['include']).pipe(
      Effect.mapError((cause) =>
        scaffoldError(`vertical ${vertical.slug} tsconfig include must be a string array`, cause),
      ),
    );
    const nextInclude = [
      ...include,
      ...[MANIFEST_FILE_NAME, 'vertical.registration.ts'].filter((entry) => !include.includes(entry)),
    ];
    return yield* trySync(() =>
      Option.fromNullishOr(
        updateMutation(tsconfigPath, content, patchJsonObjectProperty(content, [], 'include', nextInclude)),
      ),
    );
  });

const planModuleContractScaffold = (
  workspaceRoot: string,
  config: ModuleContractScaffoldConfig,
): Effect.Effect<
  ScaffoldPlan<ModuleContractScaffoldResult>,
  ModuleContractScaffoldError | ScaffoldFailure,
  FileSystem.FileSystem
> =>
  Effect.gen(function* planModuleContractScaffoldEffect() {
    const moduleId = yield* trySync(() => requireOntosModuleId(config.module));
    const vertical = yield* discoverVerticalEffect(workspaceRoot, config.vertical);
    yield* assertUniqueModuleId(workspaceRoot, vertical.slug, moduleId);
    const manifestPath = yield* trySync(() => resolveContainedPath(vertical.directory, MANIFEST_FILE_NAME));
    const registrationPath = yield* trySync(() => resolveContainedPath(vertical.directory, 'vertical.registration.ts'));
    const sharedApiPath = yield* trySync(() => resolveContainedPath(vertical.directory, 'shared', 'api.ts'));
    const apiRootPath = yield* trySync(() => resolveContainedPath(vertical.directory, 'api', 'index.ts'));
    const manifestMutation = yield* createMutationEffect(manifestPath, renderManifest(vertical, moduleId));
    const registrationMutation = yield* createMutationEffect(registrationPath, renderRegistration(vertical, moduleId));
    const fileSystem = yield* FileSystem.FileSystem;
    const sharedApiExists = yield* fileSystem
      .exists(sharedApiPath)
      .pipe(
        Effect.mapError((cause) => scaffoldError(`failed to inspect vertical ${vertical.slug} shared API root`, cause)),
      );
    const sharedApiMutation = sharedApiExists
      ? yield* fileSystem.readFileString(sharedApiPath).pipe(
          Effect.mapError((cause) => scaffoldError(`failed to read vertical ${vertical.slug} shared API root`, cause)),
          Effect.flatMap((content) =>
            trySync(() => updateMutation(sharedApiPath, content, initializeGovernedHttpApiRoot(content, vertical))),
          ),
        )
      : yield* createMutationEffect(sharedApiPath, renderGovernedHttpApiRoot(vertical));
    const apiRootContent = yield* fileSystem
      .readFileString(apiRootPath)
      .pipe(Effect.mapError((cause) => scaffoldError(`failed to read vertical ${vertical.slug} API root`, cause)));
    const apiRootMutation = yield* trySync(() =>
      updateMutation(apiRootPath, apiRootContent, initializeGovernedHttpHandlerRoot(apiRootContent, vertical)),
    );
    const packageContent = yield* patchPackage(vertical, moduleId);
    const packageMutation = yield* trySync(() =>
      Option.fromNullishOr(updateMutation(vertical.packagePath, vertical.packageContent, packageContent)),
    );
    const tsconfigMutation = yield* patchTsconfig(vertical);
    const mutations = EffectArray.getSomes([
      Option.some(manifestMutation),
      Option.some(registrationMutation),
      Option.fromNullishOr(sharedApiMutation),
      Option.fromNullishOr(apiRootMutation),
      packageMutation,
      tsconfigMutation,
    ]);
    yield* trySync(() => ensureUniqueMutationPaths(mutations));
    return {
      mutations,
      result: {
        appId: vertical.appId,
        manifestPath,
        moduleId,
        registrationPath,
      },
    };
  });

export default createCodesmithGenerator(planModuleContractScaffold);
