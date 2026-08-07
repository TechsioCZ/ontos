import { readdir, readFile } from 'node:fs/promises';
import { createCodesmithGenerator } from '../generator-adapter.mts';
import {
  MODULE_CONTRACT_GENERATOR_HEADER,
  MODULE_MANIFEST_ACTION_SLOT_END,
  MODULE_MANIFEST_ACTION_SLOT_START,
  MODULE_MANIFEST_IMPORT_SLOT_END,
  MODULE_MANIFEST_IMPORT_SLOT_START,
  MODULE_REGISTRATION_ACTION_SLOT_END,
  MODULE_REGISTRATION_ACTION_SLOT_START,
  MODULE_REGISTRATION_IMPORT_SLOT_END,
  MODULE_REGISTRATION_IMPORT_SLOT_START,
  MODULE_REGISTRATION_WORKER_SLOT_END,
  MODULE_REGISTRATION_WORKER_SLOT_START,
  VERTICAL_PUBLIC_COMPONENT_SLOT_END,
  VERTICAL_PUBLIC_COMPONENT_SLOT_START,
  VERTICAL_REPORT_SLOT_END,
  VERTICAL_REPORT_SLOT_START,
  VERTICAL_SEARCH_SLOT_END,
  VERTICAL_SEARCH_SLOT_START,
  asJsonObject,
  createMutation,
  discoverVertical,
  ensureUniqueMutationPaths,
  patchJsonObjectProperty,
  readJson,
  requireOntosModuleId,
  requiredString,
  resolveContainedPath,
  toCamelCase,
  toTitle,
  updateMutation,
} from '../shared.mts';
import type {
  ModuleContractScaffoldConfig,
  ModuleContractScaffoldResult,
  ScaffoldPlan,
  VerticalMetadata,
} from '../shared.mts';

const moduleMarkerPattern = /^\/\/ @ontos-module-id (?<moduleId>[^\s]+)$/mu;

const assertUniqueModuleId = async (
  workspaceRoot: string,
  targetSlug: string,
  moduleId: string,
): Promise<void> => {
  const verticalsRoot = resolveContainedPath(workspaceRoot, 'verticals');
  const entries = await readdir(verticalsRoot, { withFileTypes: true });
  const owners = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== targetSlug)
      .map(async (entry) => {
        const manifestPath = resolveContainedPath(
          verticalsRoot,
          entry.name,
          'vertical.manifest.ts',
        );
        try {
          const content = await readFile(manifestPath, 'utf-8');
          return { entry, moduleId: content.match(moduleMarkerPattern)?.groups?.['moduleId'] };
        } catch (error) {
          if ((error as { readonly code?: string }).code === 'ENOENT') {
            return null;
          }
          throw error;
        }
      }),
  );
  const duplicate = owners.find((owner) => owner?.moduleId === moduleId);
  if (duplicate !== undefined && duplicate !== null) {
    throw new Error(`duplicate OntOS module ID ${moduleId} in vertical ${duplicate.entry.name}`);
  }
};

const renderManifest = (vertical: VerticalMetadata, moduleId: string): string => {
  const valueName = `${toCamelCase(vertical.slug)}Manifest`;
  return `${MODULE_CONTRACT_GENERATOR_HEADER}
// @ontos-deployment-app-id ${vertical.appId}
// @ontos-module-id ${moduleId}
import { defineOntosModuleManifest } from '@app/core-runtime';
${MODULE_MANIFEST_IMPORT_SLOT_START}
${MODULE_MANIFEST_IMPORT_SLOT_END}

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
  dependencies: {
    core: [
      'core.identity',
      'core.authz',
      'core.modules',
      'core.actions',
      'core.audit',
      'core.events',
      'core.outbox',
      'core.search',
    ],
    externalSystems: [],
    modules: [],
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
    api: {},
    components: {},
    events: [],
    reports: [],
    resourceTypes: [],
    search: [],
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
  current: unknown,
  vertical: VerticalMetadata,
  target: 'cloudflare-dist' | 'dist',
  label: string,
): string => {
  const script = requiredString(current, `vertical ${vertical.slug} ${label} script`);
  const command = `node ../../scripts/generate-ontos-module-contract.mts --vertical ${vertical.slug} --target ${target}`;
  if (script.includes('generate-ontos-module-contract.mts')) {
    throw new Error(`vertical ${vertical.slug} ${label} script already contains module emission`);
  }
  const buildToken = target === 'dist' ? 'modern build' : 'MODERNJS_DEPLOY=cloudflare modern build';
  if (!script.includes(buildToken)) {
    throw new Error(`vertical ${vertical.slug} ${label} script is not a generated Modern build`);
  }
  return script.replace(buildToken, `${buildToken} && ${command}`);
};

const patchPackage = (vertical: VerticalMetadata, moduleId: string): string => {
  const dependencies = {
    ...asJsonObject(vertical.packageJson['dependencies'], `vertical ${vertical.slug} dependencies`),
  };
  const currentCore = dependencies['@app/core-runtime'];
  if (currentCore !== undefined && currentCore !== 'workspace:*') {
    throw new Error(`vertical ${vertical.slug} has an incompatible @app/core-runtime dependency`);
  }
  dependencies['@app/core-runtime'] = 'workspace:*';
  const sortedDependencies = Object.fromEntries(
    Object.entries(dependencies).toSorted(([left], [right]) => left.localeCompare(right)),
  );
  const scripts = {
    ...asJsonObject(vertical.packageJson['scripts'], `vertical ${vertical.slug} scripts`),
  };
  scripts['build'] = addArtifactCommand(scripts['build'], vertical, 'dist', 'build');
  scripts['cloudflare:build'] = addArtifactCommand(
    scripts['cloudflare:build'],
    vertical,
    'cloudflare-dist',
    'cloudflare:build',
  );
  let content = patchJsonObjectProperty(
    vertical.packageContent,
    [],
    'dependencies',
    sortedDependencies,
  );
  content = patchJsonObjectProperty(content, [], 'scripts', scripts);
  content = patchJsonObjectProperty(content, ['modernjs'], 'ontosModule', {
    contractPath: '/.well-known/ontos-module-manifest.json',
    manifest: './vertical.manifest.ts',
    moduleId,
    registration: './vertical.registration.ts',
    schemaVersion: 0,
  });
  return content;
};

const patchTsconfig = async (
  vertical: VerticalMetadata,
): Promise<ReturnType<typeof updateMutation>> => {
  const tsconfigPath = resolveContainedPath(vertical.directory, 'tsconfig.json');
  const { content, value } = await readJson(tsconfigPath, `vertical ${vertical.slug} tsconfig`);
  const { include } = value;
  if (!Array.isArray(include) || !include.every((entry) => typeof entry === 'string')) {
    throw new Error(`vertical ${vertical.slug} tsconfig include must be a string array`);
  }
  const nextInclude = [
    ...include,
    ...['vertical.manifest.ts', 'vertical.registration.ts'].filter(
      (entry) => !include.includes(entry),
    ),
  ];
  return updateMutation(
    tsconfigPath,
    content,
    patchJsonObjectProperty(content, [], 'include', nextInclude),
  );
};

export const planModuleContractScaffold = async (
  workspaceRoot: string,
  config: ModuleContractScaffoldConfig,
): Promise<ScaffoldPlan<ModuleContractScaffoldResult>> => {
  const moduleId = requireOntosModuleId(config.module);
  const vertical = await discoverVertical(workspaceRoot, config.vertical);
  await assertUniqueModuleId(workspaceRoot, vertical.slug, moduleId);
  const manifestPath = resolveContainedPath(vertical.directory, 'vertical.manifest.ts');
  const registrationPath = resolveContainedPath(vertical.directory, 'vertical.registration.ts');
  const manifestMutation = await createMutation(manifestPath, renderManifest(vertical, moduleId));
  const registrationMutation = await createMutation(
    registrationPath,
    renderRegistration(vertical, moduleId),
  );
  const packageContent = patchPackage(vertical, moduleId);
  const packageMutation = updateMutation(
    vertical.packagePath,
    vertical.packageContent,
    packageContent,
  );
  const tsconfigMutation = await patchTsconfig(vertical);
  const mutations = [
    manifestMutation,
    registrationMutation,
    packageMutation,
    tsconfigMutation,
  ].filter((mutation): mutation is NonNullable<typeof mutation> => mutation !== undefined);
  ensureUniqueMutationPaths(mutations);
  return {
    mutations,
    result: { appId: vertical.appId, manifestPath, moduleId, registrationPath },
  };
};

export default createCodesmithGenerator(planModuleContractScaffold);
