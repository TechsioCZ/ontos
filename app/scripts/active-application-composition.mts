import { createHash } from 'node:crypto';

import { Array as EffectArray, DateTime, Duration, Effect, Option, Order, Schema } from 'effect';

import {
  ActiveApplicationCompositionSnapshotSchema,
  ApplicationCompositionSchema,
  ONTOS_APPLICATION_COMPOSITION_SCHEMA_VERSION,
  ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
  ONTOS_SHELL_CONTRIBUTION_ABI,
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
  canonicalizeApplicationComposition,
  validateApplicationCompositionCandidate,
} from '../packages/core-runtime/src/index.ts';
import type {
  ActiveApplicationCompositionSnapshot,
  ApplicationComposition,
  ApplicationCompositionCandidateEvidence,
  ApplicationCompositionModule,
  ObservedApplicationCompositionContract,
  ObservedModuleFederationManifest,
} from '../packages/core-runtime/src/index.ts';
import { governedSharedSingletonPackages } from '../module-federation.shared.ts';

/**
 * The one place that fixes how long an observed active Application Composition may be trusted and how
 * often the scheduled publisher re-observes it. Consumers stop trusting a snapshot at validUntil, so the
 * refresh cadence leaves three missed runs of headroom inside one validity window.
 */
export const ACTIVE_APPLICATION_COMPOSITION_POLICY = Object.freeze({
  /** Zerops project variable that carries the published snapshot to every service. */
  projectVariable: 'ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON',
  /** Cron of the scheduled re-observation; the refresh workflow's schedule must equal it. */
  refreshCron: '17 */6 * * *',
  refreshInterval: Duration.hours(6),
  validity: Duration.hours(24),
});

/** Bound on observing one deployed artifact. */
export const ARTIFACT_FETCH_TIMEOUT = Duration.seconds(10);

/**
 * Derivation, validation, and conflicting-publication failures of the publisher. Messages name the
 * failing artifact but never carry composition payloads.
 */
export class ActiveApplicationCompositionPublicationError extends Schema.TaggedError<ActiveApplicationCompositionPublicationError>()(
  'ActiveApplicationCompositionPublicationError',
  {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
    reason: Schema.Literals(['conflicting_revision', 'invalid_observation']),
  },
) {}

/** Exact bytes served at one URL. The digest is computed over these bytes, never over a re-encoding. */
export interface ObservedArtifact {
  readonly bytes: Uint8Array;
  readonly url: string;
}

export interface ObservedModuleDeployment {
  readonly appId: string;
  readonly contract: ObservedArtifact;
  /** Present exactly for browser modules; a server-only module ships no Module Federation remote. */
  readonly federationManifest?: ObservedArtifact;
}

export interface ObservedShellDeployment {
  readonly federationManifest: ObservedArtifact;
  readonly runtimeContract: ObservedArtifact;
}

export interface ActiveApplicationCompositionObservation {
  /** Trusted publisher evidence; only `development` admits loopback HTTP artifacts. */
  readonly environment: string;
  readonly modules: readonly ObservedModuleDeployment[];
  readonly observedAt: DateTime.Utc;
  readonly shell: ObservedShellDeployment;
  readonly validity: Duration.Duration;
}

const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

const invalidObservation = (message: string) => (cause: unknown) =>
  new ActiveApplicationCompositionPublicationError({ cause, message, reason: 'invalid_observation' });

const ModuleFederationManifestSchema = Schema.Struct({
  exposes: Schema.Array(Schema.Struct({ path: Schema.NonEmptyString })),
  name: Schema.NonEmptyString,
  shared: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      requiredVersion: Schema.optionalKey(Schema.String),
      singleton: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
type ModuleFederationManifest = typeof ModuleFederationManifestSchema.Type;
type ModuleDeploymentContract = typeof OntosModuleDeploymentContractSchema.Type;
type SharedSingleton = ApplicationCompositionModule['sharedSingletons'][number];

const ContractJsonSchema = Schema.fromJsonString(OntosModuleDeploymentContractSchema);
const FederationManifestJsonSchema = Schema.fromJsonString(ModuleFederationManifestSchema);
const ShellRuntimeContractJsonSchema = Schema.fromJsonString(OntosShellRuntimeContractSchema);
const SnapshotJsonSchema = Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema);
const CompositionJsonSchema = Schema.fromJsonString(ApplicationCompositionSchema);

const utf8 = new TextDecoder('utf-8', { fatal: true });

const artifactText = (artifact: ObservedArtifact, label: string) =>
  Effect.try({
    catch: invalidObservation(`${label} at ${artifact.url} is not UTF-8 text`),
    try: () => utf8.decode(artifact.bytes),
  });

const decodeContract = (artifact: ObservedArtifact) =>
  artifactText(artifact, 'deployment contract').pipe(
    Effect.flatMap(Schema.decodeEffect(ContractJsonSchema)),
    Effect.mapError(invalidObservation(`deployment contract at ${artifact.url} does not match its schema`)),
  );

const decodeFederationManifest = (artifact: ObservedArtifact) =>
  artifactText(artifact, 'Module Federation manifest').pipe(
    Effect.flatMap(Schema.decodeEffect(FederationManifestJsonSchema)),
    Effect.mapError(invalidObservation(`Module Federation manifest at ${artifact.url} does not match its schema`)),
  );

const decodeShellRuntime = (artifact: ObservedArtifact) =>
  artifactText(artifact, 'Shell runtime contract').pipe(
    Effect.flatMap(Schema.decodeEffect(ShellRuntimeContractJsonSchema)),
    Effect.mapError(invalidObservation(`Shell runtime contract at ${artifact.url} does not match its schema`)),
  );

const singletonOrder = Order.mapInput(Order.String, (singleton: SharedSingleton) => singleton.packageName);
const moduleOrder = Order.mapInput(Order.String, (module: ApplicationCompositionModule) => module.moduleId);

/**
 * Strict shared singletons the Shell and every browser remote must agree on. Module Federation lists only
 * the shared packages a build actually consumes, so a remote may omit a governed package it never loads;
 * the Shell hosts all of them. Every listed governed package must be shared exactly once as a versioned
 * singleton: an unshared or duplicated entry would let a remote run its own React, router, runtime, or
 * i18n instance, so the observation is rejected.
 */
const governedSingletons = Effect.fn('ActiveApplicationComposition.governedSingletons')(function* governedSingletons(
  manifest: ModuleFederationManifest,
  url: string,
  role: 'host' | 'remote',
) {
  const singletons = yield* Effect.forEach(
    governedSharedSingletonPackages,
    (packageName) => {
      const entries = manifest.shared.filter(({ name }) => name === packageName);
      const [entry] = entries;
      if (entries.length === 0 && role === 'remote') {
        return Effect.succeed(Option.none());
      }
      return entries.length === 1 &&
        entry !== undefined &&
        entry.singleton === true &&
        entry.requiredVersion !== undefined &&
        entry.requiredVersion !== ''
        ? Effect.succeed(Option.some({ packageName, version: entry.requiredVersion }))
        : Effect.fail(
            new ActiveApplicationCompositionPublicationError({
              message: `Module Federation manifest at ${url} does not share ${packageName} exactly once as a versioned singleton`,
              reason: 'invalid_observation',
            }),
          );
    },
    { concurrency: 1 },
  );
  return EffectArray.sort(EffectArray.getSomes(singletons), singletonOrder);
});

const contributionKeysOf = (contract: ModuleDeploymentContract): string[] =>
  EffectArray.sort(
    Object.values(contract.manifest.publicSurface.shellContributions).flatMap((contributions) =>
      contributions.map(({ contributionKey }): string => contributionKey),
    ),
    Order.String,
  );

interface DerivedModule {
  readonly evidence: ObservedApplicationCompositionContract;
  readonly manifestEvidence: Option.Option<readonly [string, ObservedModuleFederationManifest]>;
  readonly module: ApplicationCompositionModule;
}

const contractEvidence = (
  observed: ObservedModuleDeployment,
  contract: ModuleDeploymentContract,
  contractSha256: string,
): ObservedApplicationCompositionContract => {
  const { components } = contract.manifest.publicSurface;
  const base = {
    contractUrl: observed.contract.url,
    contributionKeys: contributionKeysOf(contract),
    deployment: contract.deployment,
    federationExposes: EffectArray.sort(
      components.map(({ expose }) => expose),
      Order.String,
    ),
    moduleId: contract.manifest.module.id,
    publicContract: {
      id: contract.manifest.module.id,
      sha256: contractSha256,
      version: ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
    },
    sha256: contractSha256,
  };
  const [component] = components;
  return component === undefined ? base : { ...base, mfBoundaryId: component.mfBoundaryId };
};

const deriveModule = Effect.fn('ActiveApplicationComposition.deriveModule')(function* deriveModule(
  observed: ObservedModuleDeployment,
) {
  const contract = yield* decodeContract(observed.contract);
  if (contract.deployment.appId !== observed.appId) {
    return yield* new ActiveApplicationCompositionPublicationError({
      message: `deployment contract at ${observed.contract.url} identifies ${contract.deployment.appId}, not ${observed.appId}`,
      reason: 'invalid_observation',
    });
  }
  const contractSha256 = sha256Hex(observed.contract.bytes);
  const evidence = contractEvidence(observed, contract, contractSha256);
  const common = {
    allowedContributions: evidence.contributionKeys,
    contract: { sha256: contractSha256, url: observed.contract.url },
    dependencies: [],
    deployment: contract.deployment,
    moduleId: evidence.moduleId,
    publicContract: evidence.publicContract,
    requiredCoreCapabilities: [],
    requiredShellAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
  };
  const manifestArtifact = observed.federationManifest;
  if (manifestArtifact === undefined) {
    const derived: DerivedModule = {
      evidence,
      manifestEvidence: Option.none(),
      module: { ...common, federation: { execution: 'server' }, sharedSingletons: [] },
    };
    return derived;
  }
  const manifest = yield* decodeFederationManifest(manifestArtifact);
  const manifestSha256 = sha256Hex(manifestArtifact.bytes);
  const exposes = EffectArray.sort(
    manifest.exposes.map(({ path }) => path),
    Order.String,
  );
  const sharedSingletons = yield* governedSingletons(manifest, manifestArtifact.url, 'remote');
  const derived: DerivedModule = {
    evidence,
    manifestEvidence: Option.some([
      manifestArtifact.url,
      { exposes, remoteName: manifest.name, sha256: manifestSha256, sharedSingletons },
    ] as const),
    module: {
      ...common,
      federation: {
        execution: 'browser',
        exposes,
        manifest: { sha256: manifestSha256, url: manifestArtifact.url },
        remoteName: manifest.name,
      },
      sharedSingletons,
    },
  };
  return derived;
});

const REVISION_PLACEHOLDER = '0'.repeat(64);

/**
 * A revision is the SHA-256 of the canonical composition bytes with the revision itself zeroed, so one
 * revision can never name two different compositions.
 */
export const applicationCompositionRevision = (composition: ApplicationComposition): string =>
  sha256Hex(canonicalizeApplicationComposition({ ...composition, revision: REVISION_PLACEHOLDER }));

/** Derives, validates, and bounds one active Application Composition snapshot from observed deployments. */
export const deriveActiveApplicationCompositionSnapshot = Effect.fn('ActiveApplicationComposition.deriveSnapshot')(
  function* deriveSnapshot(observation: ActiveApplicationCompositionObservation) {
    const [shellRuntime, shellManifest, derived] = yield* Effect.all(
      [
        decodeShellRuntime(observation.shell.runtimeContract),
        decodeFederationManifest(observation.shell.federationManifest),
        Effect.forEach(observation.modules, deriveModule, { concurrency: 1 }),
      ],
      { concurrency: 1 },
    );
    const shell = {
      contributionAbi: shellRuntime.contributionAbi,
      coreCapabilities: shellRuntime.coreCapabilities,
      sharedSingletons: yield* governedSingletons(shellManifest, observation.shell.federationManifest.url, 'host'),
    };
    const unrevised: ApplicationComposition = {
      modules: EffectArray.sort(
        derived.map(({ module }) => module),
        moduleOrder,
      ),
      revision: REVISION_PLACEHOLDER,
      schemaVersion: ONTOS_APPLICATION_COMPOSITION_SCHEMA_VERSION,
      shell,
    };
    const candidate: ApplicationComposition = { ...unrevised, revision: applicationCompositionRevision(unrevised) };
    const evidence: ApplicationCompositionCandidateEvidence = {
      contracts: Object.fromEntries(derived.map(({ evidence: contract }) => [contract.deployment.appId, contract])),
      environment: observation.environment,
      federationManifests: Object.fromEntries(
        derived.flatMap(({ manifestEvidence }) => Option.toArray(manifestEvidence)),
      ),
      runtime: shell,
    };
    const validated = yield* validateApplicationCompositionCandidate(candidate, evidence).pipe(
      Effect.mapError(invalidObservation('observed deployments do not form a valid Application Composition')),
    );
    const composition = yield* Schema.decodeEffect(CompositionJsonSchema)(
      canonicalizeApplicationComposition(validated),
    ).pipe(Effect.mapError(invalidObservation('canonical Application Composition does not round-trip')));
    const snapshot: ActiveApplicationCompositionSnapshot = {
      composition,
      observedAt: observation.observedAt,
      validUntil: DateTime.addDuration(observation.observedAt, observation.validity),
    };
    return snapshot;
  },
);

/** The exact project-variable value, encoded with the snapshot codec every consumer decodes. */
export const encodeActiveApplicationCompositionSnapshot = (snapshot: ActiveApplicationCompositionSnapshot) =>
  Schema.encodeEffect(SnapshotJsonSchema)(snapshot).pipe(
    Effect.mapError(invalidObservation('active Application Composition snapshot does not encode')),
  );

/** Decodes a project-variable value exactly as consumers do, rejecting unknown fields. */
export const decodeActiveApplicationCompositionSnapshot = (encoded: string) =>
  Schema.decodeEffect(SnapshotJsonSchema, { onExcessProperty: 'error' })(encoded).pipe(
    Effect.mapError(invalidObservation('value does not decode as an active Application Composition snapshot')),
  );

const conflict = (message: string, revision: string) =>
  new ActiveApplicationCompositionPublicationError({
    message: `${message} (revision ${revision})`,
    reason: 'conflicting_revision',
  });

/**
 * Rejects a revision that is not the digest of its content and replacing a published snapshot with
 * different content under the same revision. A different revision is an explicit promotion; an
 * undecodable current value is invalid state that publication repairs.
 */
export const assertNoConflictingPublication = Effect.fn('ActiveApplicationComposition.assertNoConflict')(
  function* assertNoConflict(current: Option.Option<string>, next: ActiveApplicationCompositionSnapshot) {
    const { revision } = next.composition;
    if (applicationCompositionRevision(next.composition) !== revision) {
      return yield* conflict(
        'the Application Composition revision is not the digest of its canonical content',
        revision,
      );
    }
    const published = Option.isSome(current)
      ? yield* Effect.option(decodeActiveApplicationCompositionSnapshot(current.value))
      : Option.none();
    if (
      Option.isSome(published) &&
      published.value.composition.revision === revision &&
      canonicalizeApplicationComposition(published.value.composition) !==
        canonicalizeApplicationComposition(next.composition)
    ) {
      return yield* conflict('a different Application Composition is already published under this revision', revision);
    }
    return yield* Effect.void;
  },
);
