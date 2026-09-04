import { Effect, Order, Predicate, Schema } from 'effect';
import {
  OntosComponentContractSchema,
  OntosDeploymentIdentitySchema,
  OntosModuleIdSchema,
} from './manifest.ts';

export const ONTOS_APPLICATION_COMPOSITION_SCHEMA_VERSION = '1' as const;

const sha256 = Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u));
const version = Schema.String.check(Schema.isPattern(/^[0-9]+(?:\.[0-9]+){0,2}$/u));
const artifactUrl = Schema.String.check(
  Schema.makeFilter((value) => {
    const url = URL.parse(value);
    if (url === null) {
      return 'artifact URL must be absolute';
    }
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
  }),
);

export const ApplicationCompositionArtifactReferenceSchema = Schema.Struct({
  sha256,
  url: artifactUrl,
});

export const ApplicationCompositionVersionedIdentitySchema = Schema.Struct({
  id: Schema.NonEmptyString,
  version,
});

export const ApplicationCompositionSingletonSchema = Schema.Struct({
  packageName: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
});

export const ApplicationCompositionModuleSchema = Schema.Struct({
  allowedContributions: Schema.Array(OntosModuleIdSchema),
  contract: ApplicationCompositionArtifactReferenceSchema,
  dependencies: Schema.Array(OntosModuleIdSchema),
  deployment: OntosDeploymentIdentitySchema,
  federation: Schema.Struct({
    execution: Schema.Literal('browser'),
    exposes: Schema.Array(Schema.NonEmptyString),
    manifest: ApplicationCompositionArtifactReferenceSchema,
    remoteName: OntosComponentContractSchema.fields.mfBoundaryId,
  }),
  moduleId: OntosModuleIdSchema,
  publicContract: Schema.Struct({
    id: Schema.NonEmptyString,
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

const observedContractSchema = Schema.Struct({
  contractUrl: artifactUrl,
  contributionKeys: ApplicationCompositionModuleSchema.fields.allowedContributions,
  deployment: OntosDeploymentIdentitySchema,
  federationExposes: ApplicationCompositionModuleSchema.fields.federation.fields.exposes,
  mfBoundaryId: OntosComponentContractSchema.fields.mfBoundaryId,
  moduleId: OntosModuleIdSchema,
  publicContract: ApplicationCompositionModuleSchema.fields.publicContract,
  sha256,
});
const observedFederationSchema = Schema.Struct({
  exposes: ApplicationCompositionModuleSchema.fields.federation.fields.exposes,
  remoteName: OntosComponentContractSchema.fields.mfBoundaryId,
  sha256,
  sharedSingletons: ApplicationCompositionModuleSchema.fields.sharedSingletons,
});
const candidateEvidenceSchema = Schema.Struct({
  contracts: Schema.Record(Schema.String, observedContractSchema),
  federationManifests: Schema.Record(Schema.String, observedFederationSchema),
  runtime: ApplicationCompositionSchema.fields.shell,
});

export type ObservedApplicationCompositionContract = typeof observedContractSchema.Type;
export type ObservedModuleFederationManifest = typeof observedFederationSchema.Type;
export type ApplicationCompositionCandidateEvidence = typeof candidateEvidenceSchema.Type;

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

const identityOrder = Order.mapInput(Order.String, identityKey);
const moduleOrder = Order.mapInput(
  Order.String,
  (module: ApplicationCompositionModule) => module.moduleId,
);
const singletonOrder = Order.Struct({
  packageName: Order.String,
  version: Order.String,
});
const sameDeployment = Schema.toEquivalence(OntosDeploymentIdentitySchema);
const samePublicContract = Schema.toEquivalence(
  ApplicationCompositionModuleSchema.fields.publicContract,
);

const sameUniqueStrings = (left: readonly string[], right: readonly string[]): boolean => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    leftSet.size === rightSet.size &&
    left.every((value) => rightSet.has(value))
  );
};

const sameVersionClaims = <Value extends { readonly version: string }>(
  left: readonly Value[],
  right: readonly Value[],
  key: (value: Value) => string,
): boolean => {
  const leftVersions = new Map(left.map((value) => [key(value), value.version]));
  const rightVersions = new Map(right.map((value) => [key(value), value.version]));
  return (
    leftVersions.size === left.length &&
    rightVersions.size === right.length &&
    leftVersions.size === rightVersions.size &&
    [...leftVersions].every(([claim, claimVersion]) => rightVersions.get(claim) === claimVersion)
  );
};

const claim = Effect.fnUntraced(function* claimUnique(
  claims: Set<string>,
  value: string,
  label: string,
) {
  if (claims.has(value)) {
    return yield* invalid(`duplicate ${label} ${value}`);
  }
  claims.add(value);
  return yield* Effect.void;
});

const assertAcyclicDependencies = Effect.fnUntraced(function* checkCycles(
  modules: readonly ApplicationCompositionModule[],
) {
  const dependencies = new Map(modules.map((module) => [module.moduleId, module.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (moduleId: string): Effect.Effect<void, ApplicationCompositionValidationError> =>
    Effect.gen(function* visitDependency() {
      if (visiting.has(moduleId)) {
        return yield* invalid(`dependency cycle includes module ${moduleId}`);
      }
      if (visited.has(moduleId)) {
        return yield* Effect.void;
      }
      visiting.add(moduleId);
      for (const dependency of dependencies.get(moduleId) ?? []) {
        yield* visit(dependency);
      }
      visiting.delete(moduleId);
      visited.add(moduleId);
      return yield* Effect.void;
    });
  for (const module of modules) {
    yield* visit(module.moduleId);
  }
  return yield* Effect.void;
});

const freeze = <Value>(value: Value): Value => {
  if (!Predicate.isObjectKeyword(value) || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    freeze(nested);
  }
  return Object.freeze(value);
};

const assertDependenciesPresent = Effect.fnUntraced(function* checkDependencies(
  module: ApplicationCompositionModule,
  moduleIds: ReadonlySet<string>,
) {
  const dependencies = new Set<string>();
  for (const dependency of module.dependencies) {
    yield* claim(dependencies, dependency, `dependency in module ${module.moduleId}`);
    if (!moduleIds.has(dependency)) {
      return yield* invalid(`module ${module.moduleId} requires missing dependency ${dependency}`);
    }
  }
  return yield* Effect.void;
});

const assertShellCompatibility = Effect.fnUntraced(function* checkCompatibility(
  module: ApplicationCompositionModule,
  shell: ApplicationComposition['shell'],
  availableCapabilities: ReadonlySet<string>,
  availableSingletons: ReadonlyMap<string, string>,
) {
  if (identityKey(module.requiredShellAbi) !== identityKey(shell.contributionAbi)) {
    return yield* invalid(
      `module ${module.moduleId} requires an incompatible Shell contribution ABI`,
    );
  }
  const capabilityIds = new Set<string>();
  for (const capability of module.requiredCoreCapabilities) {
    yield* claim(capabilityIds, capability.id, 'required Core capability');
    if (!availableCapabilities.has(identityKey(capability))) {
      return yield* invalid(
        `module ${module.moduleId} requires unavailable Core capability ${capability.id}`,
      );
    }
  }
  const singletonPackages = new Set<string>();
  for (const singleton of module.sharedSingletons) {
    yield* claim(singletonPackages, singleton.packageName, 'required shared singleton');
    if (availableSingletons.get(singleton.packageName) !== singleton.version) {
      return yield* invalid(
        `module ${module.moduleId} requires incompatible shared singleton ${singleton.packageName}`,
      );
    }
  }
  return yield* Effect.void;
});

const assertObservedDeployment = Effect.fnUntraced(function* checkDeployment(
  module: ApplicationCompositionModule,
  contract: ObservedApplicationCompositionContract | undefined,
) {
  if (
    contract === undefined ||
    contract.contractUrl !== module.contract.url ||
    contract.sha256 !== module.contract.sha256 ||
    !sameDeployment(contract.deployment, module.deployment) ||
    contract.moduleId !== module.moduleId ||
    contract.mfBoundaryId !== module.federation.remoteName ||
    !samePublicContract(contract.publicContract, module.publicContract) ||
    module.publicContract.id !== module.moduleId ||
    !sameUniqueStrings(module.allowedContributions, contract.contributionKeys) ||
    !sameUniqueStrings(module.federation.exposes, contract.federationExposes)
  ) {
    return yield* invalid(
      `module ${module.moduleId} does not match its observed deployment contract`,
    );
  }
  return yield* Effect.void;
});

const assertObservedFederationManifest = Effect.fnUntraced(function* checkFederation(
  module: ApplicationCompositionModule,
  manifest: ObservedModuleFederationManifest | undefined,
) {
  if (
    manifest === undefined ||
    manifest.remoteName !== module.federation.remoteName ||
    manifest.sha256 !== module.federation.manifest.sha256 ||
    !sameUniqueStrings(module.federation.exposes, manifest.exposes) ||
    !sameVersionClaims(
      module.sharedSingletons,
      manifest.sharedSingletons,
      ({ packageName }) => packageName,
    )
  ) {
    return yield* invalid(
      `module ${module.moduleId} does not match its observed Module Federation manifest`,
    );
  }
  return yield* Effect.void;
});

const assertObservedRuntime = Effect.fnUntraced(function* checkRuntime(
  shell: ApplicationComposition['shell'],
  runtime: ApplicationCompositionCandidateEvidence['runtime'],
) {
  if (
    identityKey(shell.contributionAbi) !== identityKey(runtime.contributionAbi) ||
    !sameVersionClaims(shell.coreCapabilities, runtime.coreCapabilities, ({ id }) => id) ||
    !sameVersionClaims(
      shell.sharedSingletons,
      runtime.sharedSingletons,
      ({ packageName }) => packageName,
    )
  ) {
    return yield* invalid('Shell and Core claims do not match the observed runtime contract');
  }
  return yield* Effect.void;
});

const encodeCompositionJson = Schema.encodeSync(
  Schema.fromJsonString(ApplicationCompositionSchema),
);

export const canonicalizeApplicationComposition = (composition: ApplicationComposition): string =>
  encodeCompositionJson({
    ...composition,
    modules: composition.modules
      .map((module) => ({
        ...module,
        allowedContributions: module.allowedContributions.toSorted(),
        dependencies: module.dependencies.toSorted(),
        federation: {
          ...module.federation,
          exposes: module.federation.exposes.toSorted(),
        },
        requiredCoreCapabilities: module.requiredCoreCapabilities.toSorted(identityOrder),
        sharedSingletons: module.sharedSingletons.toSorted(singletonOrder),
      }))
      .toSorted(moduleOrder),
    shell: {
      ...composition.shell,
      coreCapabilities: composition.shell.coreCapabilities.toSorted(identityOrder),
      sharedSingletons: composition.shell.sharedSingletons.toSorted(singletonOrder),
    },
  });

export const validateApplicationCompositionCandidate = Effect.fnUntraced(function* validate<Input>(
  input: Input,
  evidence: ApplicationCompositionCandidateEvidence,
) {
  const composition = yield* Schema.decodeUnknownEffect(ApplicationCompositionSchema, {
    onExcessProperty: 'error',
  })(input).pipe(
    Effect.mapError(() =>
      invalid('candidate does not match the supported Application Composition schema'),
    ),
  );
  const observed = yield* Schema.decodeUnknownEffect(candidateEvidenceSchema)(evidence).pipe(
    Effect.mapError(() =>
      invalid('candidate evidence does not match the supported observation schema'),
    ),
  );
  const moduleIds = new Set(composition.modules.map(({ moduleId }) => moduleId));
  const appIds = new Set<string>();
  const artifactUrls = new Set<string>();
  const claimedModuleIds = new Set<string>();
  const contributionKeys = new Set<string>();
  const remoteNames = new Set<string>();
  const shellCapabilities = new Set(composition.shell.coreCapabilities.map(identityKey));
  const shellSingletons = new Map(
    composition.shell.sharedSingletons.map(({ packageName, version: singletonVersion }) => [
      packageName,
      singletonVersion,
    ]),
  );
  const shellCapabilityIds = new Set<string>();
  const shellSingletonPackages = new Set<string>();
  for (const capability of composition.shell.coreCapabilities) {
    yield* claim(shellCapabilityIds, capability.id, 'Core capability');
  }
  for (const singleton of composition.shell.sharedSingletons) {
    yield* claim(shellSingletonPackages, singleton.packageName, 'shared singleton');
  }
  yield* assertObservedRuntime(composition.shell, observed.runtime);

  for (const module of composition.modules) {
    yield* claim(appIds, module.deployment.appId, 'deployment app ID');
    yield* claim(artifactUrls, new URL(module.contract.url).href, 'artifact URL');
    yield* claim(artifactUrls, new URL(module.federation.manifest.url).href, 'artifact URL');
    yield* claim(claimedModuleIds, module.moduleId, 'module ID');
    yield* claim(remoteNames, module.federation.remoteName, 'Module Federation remote');
    for (const contributionKey of module.allowedContributions) {
      yield* claim(contributionKeys, contributionKey, 'Shell contribution');
    }
    yield* assertDependenciesPresent(module, moduleIds);
    yield* assertShellCompatibility(module, composition.shell, shellCapabilities, shellSingletons);
    yield* assertObservedDeployment(module, observed.contracts[module.deployment.appId]);
    yield* assertObservedFederationManifest(
      module,
      observed.federationManifests[module.federation.manifest.url],
    );
  }

  yield* assertAcyclicDependencies(composition.modules);

  return freeze(composition);
});
