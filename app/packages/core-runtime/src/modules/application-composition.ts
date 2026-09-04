import { Predicate, Schema } from 'effect';
import { OntosDeploymentIdentitySchema, OntosModuleIdSchema } from './manifest.ts';

export const ONTOS_APPLICATION_COMPOSITION_SCHEMA_VERSION = '1' as const;

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));
const sha256 = Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u));
const version = Schema.String.check(Schema.isPattern(/^[0-9]+(?:\.[0-9]+){0,2}$/u));
const artifactUrl = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => {
      try {
        const url = new URL(value);
        const loopback =
          url.hostname === 'localhost' ||
          url.hostname === '127.0.0.1' ||
          url.hostname === '[::1]' ||
          url.hostname.endsWith('.localhost');
        return (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) &&
          url.username === '' &&
          url.password === '' &&
          url.search === '' &&
          url.hash === ''
          ? undefined
          : 'artifact URL must use HTTPS (or loopback HTTP) without credentials, query, or fragment';
      } catch {
        return 'artifact URL must be absolute';
      }
    }),
  ),
);

export const ApplicationCompositionArtifactReferenceSchema = Schema.Struct({
  sha256,
  url: artifactUrl,
});

export const ApplicationCompositionVersionedIdentitySchema = Schema.Struct({
  id: nonEmptyString,
  version,
});

export const ApplicationCompositionSingletonSchema = Schema.Struct({
  packageName: nonEmptyString,
  version: nonEmptyString,
});

export const ApplicationCompositionModuleSchema = Schema.Struct({
  allowedContributions: Schema.Array(OntosModuleIdSchema),
  contract: ApplicationCompositionArtifactReferenceSchema,
  dependencies: Schema.Array(OntosModuleIdSchema),
  deployment: OntosDeploymentIdentitySchema,
  federation: Schema.Struct({
    execution: Schema.Literal('browser'),
    exposes: Schema.Array(nonEmptyString),
    manifest: ApplicationCompositionArtifactReferenceSchema,
    remoteName: Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9]*$/u)),
  }),
  moduleId: OntosModuleIdSchema,
  publicContract: Schema.Struct({
    id: nonEmptyString,
    sha256,
    version,
  }),
  requiredCoreCapabilities: Schema.Array(ApplicationCompositionVersionedIdentitySchema),
  requiredShellAbi: ApplicationCompositionVersionedIdentitySchema,
  sharedSingletons: Schema.Array(ApplicationCompositionSingletonSchema),
});

export const ApplicationCompositionSchema = Schema.Struct({
  modules: Schema.Array(ApplicationCompositionModuleSchema),
  revision: sha256,
  schemaVersion: Schema.Literal(ONTOS_APPLICATION_COMPOSITION_SCHEMA_VERSION),
  shell: Schema.Struct({
    contributionAbi: ApplicationCompositionVersionedIdentitySchema,
    coreCapabilities: Schema.Array(ApplicationCompositionVersionedIdentitySchema),
    sharedSingletons: Schema.Array(ApplicationCompositionSingletonSchema),
  }),
});

export type ApplicationComposition = typeof ApplicationCompositionSchema.Type;
export type ApplicationCompositionModule = typeof ApplicationCompositionModuleSchema.Type;
export type ApplicationCompositionVersionedIdentity =
  typeof ApplicationCompositionVersionedIdentitySchema.Type;

export interface ObservedApplicationCompositionContract {
  readonly contractUrl: string;
  readonly contributionKeys: readonly string[];
  readonly deployment: ApplicationCompositionModule['deployment'];
  readonly federationExposes: readonly string[];
  readonly moduleId: ApplicationCompositionModule['moduleId'];
  readonly publicContract: ApplicationCompositionModule['publicContract'];
  readonly sha256: string;
}

export interface ObservedModuleFederationManifest {
  readonly exposes: readonly string[];
  readonly sha256: string;
}

export interface ApplicationCompositionCandidateEvidence {
  readonly contracts: Readonly<Record<string, ObservedApplicationCompositionContract>>;
  readonly federationManifests: Readonly<Record<string, ObservedModuleFederationManifest>>;
}

export class ApplicationCompositionValidationError extends Schema.TaggedError<ApplicationCompositionValidationError>()(
  'ApplicationCompositionValidationError',
  {
    code: Schema.Literal('application_composition_invalid'),
    reason: Schema.String,
  },
) {}

const invalid = (reason: string): ApplicationCompositionValidationError =>
  new ApplicationCompositionValidationError({ code: 'application_composition_invalid', reason });

const identityKey = (identity: ApplicationCompositionVersionedIdentity): string =>
  `${identity.id}@${identity.version}`;

const singletonKey = (
  singleton: ApplicationCompositionModule['sharedSingletons'][number],
): string => `${singleton.packageName}@${singleton.version}`;

const claim = (claims: Set<string>, value: string, label: string): void => {
  if (claims.has(value)) {
    throw invalid(`duplicate ${label} ${value}`);
  }
  claims.add(value);
};

const assertAcyclicDependencies = (modules: readonly ApplicationCompositionModule[]): void => {
  const dependencies = new Map(modules.map((module) => [module.moduleId, module.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (moduleId: string): void => {
    if (visiting.has(moduleId)) {
      throw invalid(`dependency cycle includes module ${moduleId}`);
    }
    if (visited.has(moduleId)) {
      return;
    }
    visiting.add(moduleId);
    for (const dependency of dependencies.get(moduleId) ?? []) {
      visit(dependency);
    }
    visiting.delete(moduleId);
    visited.add(moduleId);
  };
  for (const module of modules) {
    visit(module.moduleId);
  }
};

const freeze = <Value>(value: Value): Value => {
  if (!Predicate.isObjectKeyword(value) || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    freeze(nested);
  }
  return Object.freeze(value);
};

const assertDependenciesPresent = (
  module: ApplicationCompositionModule,
  moduleIds: ReadonlySet<string>,
): void => {
  for (const dependency of module.dependencies) {
    if (!moduleIds.has(dependency)) {
      throw invalid(`module ${module.moduleId} requires missing dependency ${dependency}`);
    }
  }
};

const assertShellCompatibility = (
  module: ApplicationCompositionModule,
  shell: ApplicationComposition['shell'],
  availableCapabilities: ReadonlySet<string>,
  availableSingletons: ReadonlySet<string>,
): void => {
  if (identityKey(module.requiredShellAbi) !== identityKey(shell.contributionAbi)) {
    throw invalid(`module ${module.moduleId} requires an incompatible Shell contribution ABI`);
  }
  const capabilityIds = new Set<string>();
  for (const capability of module.requiredCoreCapabilities) {
    claim(capabilityIds, capability.id, 'required Core capability');
    if (!availableCapabilities.has(identityKey(capability))) {
      throw invalid(
        `module ${module.moduleId} requires unavailable Core capability ${capability.id}`,
      );
    }
  }
  const singletonPackages = new Set<string>();
  for (const singleton of module.sharedSingletons) {
    claim(singletonPackages, singleton.packageName, 'required shared singleton');
    if (!availableSingletons.has(singletonKey(singleton))) {
      throw invalid(
        `module ${module.moduleId} requires incompatible shared singleton ${singleton.packageName}`,
      );
    }
  }
};

const assertObservedDeployment = (
  module: ApplicationCompositionModule,
  contract: ObservedApplicationCompositionContract | undefined,
): void => {
  const contributionKeys = new Set(contract?.contributionKeys);
  const federationExposes = new Set(contract?.federationExposes);
  if (
    contract === undefined ||
    contract.contractUrl !== module.contract.url ||
    contract.sha256 !== module.contract.sha256 ||
    contract.deployment.appId !== module.deployment.appId ||
    contract.deployment.buildMarker !== module.deployment.buildMarker ||
    contract.moduleId !== module.moduleId ||
    contract.publicContract.id !== module.publicContract.id ||
    contract.publicContract.version !== module.publicContract.version ||
    contract.publicContract.sha256 !== module.publicContract.sha256 ||
    module.publicContract.id !== module.moduleId ||
    module.allowedContributions.some((contributionKey) => !contributionKeys.has(contributionKey)) ||
    module.federation.exposes.some((expose) => !federationExposes.has(expose))
  ) {
    throw invalid(`module ${module.moduleId} does not match its observed deployment contract`);
  }
};

const assertObservedFederationManifest = (
  module: ApplicationCompositionModule,
  manifest: ObservedModuleFederationManifest | undefined,
): void => {
  const exposes = new Set(manifest?.exposes);
  if (
    manifest === undefined ||
    manifest.sha256 !== module.federation.manifest.sha256 ||
    module.federation.exposes.some((expose) => !exposes.has(expose))
  ) {
    throw invalid(
      `module ${module.moduleId} does not match its observed Module Federation manifest`,
    );
  }
};

export const canonicalizeApplicationComposition = (composition: ApplicationComposition): string =>
  JSON.stringify({
    modules: composition.modules
      .map((module) => ({
        allowedContributions: module.allowedContributions.toSorted(),
        contract: { sha256: module.contract.sha256, url: module.contract.url },
        dependencies: module.dependencies.toSorted(),
        deployment: {
          appId: module.deployment.appId,
          buildMarker: module.deployment.buildMarker,
        },
        federation: {
          execution: module.federation.execution,
          exposes: module.federation.exposes.toSorted(),
          manifest: {
            sha256: module.federation.manifest.sha256,
            url: module.federation.manifest.url,
          },
          remoteName: module.federation.remoteName,
        },
        moduleId: module.moduleId,
        publicContract: {
          id: module.publicContract.id,
          sha256: module.publicContract.sha256,
          version: module.publicContract.version,
        },
        requiredCoreCapabilities: module.requiredCoreCapabilities.toSorted((left, right) =>
          identityKey(left).localeCompare(identityKey(right)),
        ),
        requiredShellAbi: {
          id: module.requiredShellAbi.id,
          version: module.requiredShellAbi.version,
        },
        sharedSingletons: module.sharedSingletons.toSorted((left, right) =>
          singletonKey(left).localeCompare(singletonKey(right)),
        ),
      }))
      .toSorted((left, right) => left.moduleId.localeCompare(right.moduleId)),
    revision: composition.revision,
    schemaVersion: composition.schemaVersion,
    shell: {
      contributionAbi: {
        id: composition.shell.contributionAbi.id,
        version: composition.shell.contributionAbi.version,
      },
      coreCapabilities: composition.shell.coreCapabilities.toSorted((left, right) =>
        identityKey(left).localeCompare(identityKey(right)),
      ),
      sharedSingletons: composition.shell.sharedSingletons.toSorted((left, right) =>
        singletonKey(left).localeCompare(singletonKey(right)),
      ),
    },
  });

export const validateApplicationCompositionCandidate = <Input>(
  input: Input,
  evidence: ApplicationCompositionCandidateEvidence,
): ApplicationComposition => {
  let composition: ApplicationComposition;
  try {
    composition = Schema.decodeUnknownSync(ApplicationCompositionSchema, {
      onExcessProperty: 'error',
    })(input);
  } catch {
    throw invalid('candidate does not match the supported Application Composition schema');
  }

  const moduleIds = new Set(composition.modules.map(({ moduleId }) => moduleId));
  const appIds = new Set<string>();
  const claimedModuleIds = new Set<string>();
  const contributionKeys = new Set<string>();
  const remoteNames = new Set<string>();
  const shellCapabilities = new Set(composition.shell.coreCapabilities.map(identityKey));
  const shellSingletons = new Set(composition.shell.sharedSingletons.map(singletonKey));
  const shellCapabilityIds = new Set<string>();
  const shellSingletonPackages = new Set<string>();
  for (const capability of composition.shell.coreCapabilities) {
    claim(shellCapabilityIds, capability.id, 'Core capability');
  }
  for (const singleton of composition.shell.sharedSingletons) {
    claim(shellSingletonPackages, singleton.packageName, 'shared singleton');
  }

  for (const module of composition.modules) {
    claim(appIds, module.deployment.appId, 'deployment app ID');
    claim(claimedModuleIds, module.moduleId, 'module ID');
    claim(remoteNames, module.federation.remoteName, 'Module Federation remote');
    for (const contributionKey of module.allowedContributions) {
      claim(contributionKeys, contributionKey, 'Shell contribution');
    }
    assertDependenciesPresent(module, moduleIds);
    assertShellCompatibility(module, composition.shell, shellCapabilities, shellSingletons);
    assertObservedDeployment(module, evidence.contracts[module.deployment.appId]);
    assertObservedFederationManifest(
      module,
      evidence.federationManifests[module.federation.manifest.url],
    );
  }

  assertAcyclicDependencies(composition.modules);

  return freeze(composition);
};
