import { Effect, Order, Predicate, Result, Schema } from 'effect';
import {
  OntosComponentContractSchema,
  OntosDeploymentIdentitySchema,
  OntosModuleIdSchema,
} from './manifest.ts';

export const ONTOS_APPLICATION_COMPOSITION_SCHEMA_VERSION = '1' as const;

const sha256 = Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u));
const version = Schema.String.check(Schema.isPattern(/^[0-9]+(?:\.[0-9]+){0,2}$/u));
const isLoopbackHostname = (hostname: string): boolean =>
  ['localhost', '127.0.0.1', '[::1]'].includes(hostname) || hostname.endsWith('.localhost');

const artifactUrl = Schema.String.check(
  Schema.makeFilter((value) => {
    const url = URL.parse(value);
    if (url === null) {
      return 'artifact URL must be absolute';
    }
    const loopback = isLoopbackHostname(url.hostname);
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
  environment: Schema.optionalKey(Schema.NonEmptyString),
  federationManifests: Schema.Record(Schema.String, observedFederationSchema),
  runtime: ApplicationCompositionSchema.fields.shell,
});

export type ObservedApplicationCompositionContract = typeof observedContractSchema.Type;
export type ObservedModuleFederationManifest = typeof observedFederationSchema.Type;
export type ApplicationCompositionCandidateEvidence = typeof candidateEvidenceSchema.Type;

export class ApplicationCompositionValidationError extends Schema.TaggedError<ApplicationCompositionValidationError>()(
  'ApplicationCompositionValidationError',
  {
    code: Schema.tag('application_composition_invalid'),
    reason: Schema.String,
  },
) {}

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
    return yield* new ApplicationCompositionValidationError({
      reason: `duplicate ${label} ${value}`,
    });
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
  const visit: (moduleId: string) => Effect.Effect<void, ApplicationCompositionValidationError> =
    Effect.fn('assertAcyclicDependencies.visit')(function* visitDependency(moduleId) {
      if (visiting.has(moduleId)) {
        return yield* new ApplicationCompositionValidationError({
          reason: `dependency cycle includes module ${moduleId}`,
        });
      }
      if (visited.has(moduleId)) {
        return yield* Effect.void;
      }
      visiting.add(moduleId);
      yield* Effect.forEach(dependencies.get(moduleId) ?? [], visit, {
        concurrency: 1,
        discard: true,
      });
      visiting.delete(moduleId);
      visited.add(moduleId);
      return yield* Effect.void;
    });
  yield* Effect.forEach(modules, ({ moduleId }) => visit(moduleId), {
    concurrency: 1,
    discard: true,
  });
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
  yield* Effect.forEach(
    module.dependencies,
    Effect.fnUntraced(function* checkDependency(dependency) {
      yield* claim(dependencies, dependency, `dependency in module ${module.moduleId}`);
      if (!moduleIds.has(dependency)) {
        return yield* new ApplicationCompositionValidationError({
          reason: `module ${module.moduleId} requires missing dependency ${dependency}`,
        });
      }
      return yield* Effect.void;
    }),
    { concurrency: 1, discard: true },
  );
  return yield* Effect.void;
});

const assertShellCompatibility = Effect.fnUntraced(function* checkCompatibility(
  module: ApplicationCompositionModule,
  shell: ApplicationComposition['shell'],
  availableCapabilities: ReadonlySet<string>,
  availableSingletons: ReadonlyMap<string, string>,
) {
  if (identityKey(module.requiredShellAbi) !== identityKey(shell.contributionAbi)) {
    return yield* new ApplicationCompositionValidationError({
      reason: `module ${module.moduleId} requires an incompatible Shell contribution ABI`,
    });
  }
  const capabilityIds = new Set<string>();
  yield* Effect.forEach(
    module.requiredCoreCapabilities,
    Effect.fnUntraced(function* checkCapability(capability) {
      yield* claim(capabilityIds, capability.id, 'required Core capability');
      if (!availableCapabilities.has(identityKey(capability))) {
        return yield* new ApplicationCompositionValidationError({
          reason: `module ${module.moduleId} requires unavailable Core capability ${capability.id}`,
        });
      }
      return yield* Effect.void;
    }),
    { concurrency: 1, discard: true },
  );
  const singletonPackages = new Set<string>();
  yield* Effect.forEach(
    module.sharedSingletons,
    Effect.fnUntraced(function* checkSingleton(singleton) {
      yield* claim(singletonPackages, singleton.packageName, 'required shared singleton');
      if (availableSingletons.get(singleton.packageName) !== singleton.version) {
        return yield* new ApplicationCompositionValidationError({
          reason: `module ${module.moduleId} requires incompatible shared singleton ${singleton.packageName}`,
        });
      }
      return yield* Effect.void;
    }),
    { concurrency: 1, discard: true },
  );
  return yield* Effect.void;
});

const matchesObservedArtifact = (
  module: ApplicationCompositionModule,
  contract: ObservedApplicationCompositionContract,
): boolean =>
  contract.contractUrl === module.contract.url &&
  contract.sha256 === module.contract.sha256 &&
  sameDeployment(contract.deployment, module.deployment);

const assertObservedDeployment = Effect.fnUntraced(function* checkDeployment(
  module: ApplicationCompositionModule,
  contract: ObservedApplicationCompositionContract | undefined,
) {
  if (
    contract === undefined ||
    !matchesObservedArtifact(module, contract) ||
    contract.moduleId !== module.moduleId ||
    contract.mfBoundaryId !== module.federation.remoteName ||
    !samePublicContract(contract.publicContract, module.publicContract) ||
    module.publicContract.id !== module.moduleId ||
    !sameUniqueStrings(module.allowedContributions, contract.contributionKeys) ||
    !sameUniqueStrings(module.federation.exposes, contract.federationExposes)
  ) {
    return yield* new ApplicationCompositionValidationError({
      reason: `module ${module.moduleId} does not match its observed deployment contract`,
    });
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
    return yield* new ApplicationCompositionValidationError({
      reason: `module ${module.moduleId} does not match its observed Module Federation manifest`,
    });
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
    return yield* new ApplicationCompositionValidationError({
      reason: 'Shell and Core claims do not match the observed runtime contract',
    });
  }
  return yield* Effect.void;
});

const compositionJsonSchema = Schema.fromJsonString(ApplicationCompositionSchema);

const encodeCompositionJson = (composition: ApplicationComposition): string =>
  Result.getOrThrow(Schema.encodeResult(compositionJsonSchema)(composition));

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
    Effect.catchTag('SchemaError', () =>
      Effect.fail(
        new ApplicationCompositionValidationError({
          reason: 'candidate does not match the supported Application Composition schema',
        }),
      ),
    ),
  );
  const observed = yield* Schema.decodeEffect(candidateEvidenceSchema)(evidence).pipe(
    Effect.catchTag('SchemaError', () =>
      Effect.fail(
        new ApplicationCompositionValidationError({
          reason: 'candidate evidence does not match the supported observation schema',
        }),
      ),
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
  yield* Effect.forEach(
    composition.shell.coreCapabilities,
    ({ id }) => claim(shellCapabilityIds, id, 'Core capability'),
    { concurrency: 1, discard: true },
  );
  yield* Effect.forEach(
    composition.shell.sharedSingletons,
    ({ packageName }) => claim(shellSingletonPackages, packageName, 'shared singleton'),
    { concurrency: 1, discard: true },
  );
  yield* assertObservedRuntime(composition.shell, observed.runtime);

  yield* Effect.forEach(
    composition.modules,
    Effect.fnUntraced(function* validateModule(module) {
      const manifestUrl = module.federation.manifest.url;
      if (
        observed.environment !== 'development' &&
        [module.contract.url, manifestUrl].some((url) => new URL(url).protocol !== 'https:')
      ) {
        return yield* new ApplicationCompositionValidationError({
          reason: 'artifact URLs must use HTTPS outside development',
        });
      }
      yield* claim(appIds, module.deployment.appId, 'deployment app ID');
      yield* claim(artifactUrls, new URL(module.contract.url).href, 'artifact URL');
      yield* claim(artifactUrls, new URL(manifestUrl).href, 'artifact URL');
      yield* claim(claimedModuleIds, module.moduleId, 'module ID');
      yield* claim(remoteNames, module.federation.remoteName, 'Module Federation remote');
      yield* Effect.forEach(
        module.allowedContributions,
        (contributionKey) => claim(contributionKeys, contributionKey, 'Shell contribution'),
        { concurrency: 1, discard: true },
      );
      yield* assertDependenciesPresent(module, moduleIds);
      yield* assertShellCompatibility(
        module,
        composition.shell,
        shellCapabilities,
        shellSingletons,
      );
      yield* assertObservedDeployment(module, observed.contracts[module.deployment.appId]);
      yield* assertObservedFederationManifest(module, observed.federationManifests[manifestUrl]);
      return yield* Effect.void;
    }),
    { concurrency: 1, discard: true },
  );

  yield* assertAcyclicDependencies(composition.modules);

  return freeze(composition);
});
