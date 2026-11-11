#!/usr/bin/env node
/**
 * Derives the active Application Composition snapshot from this revision's built artifacts (every topology unit's
 * `dist/` module contract and Module Federation manifest, and the Shell's runtime contract and manifest), re-decodes
 * it exactly as consumers do, and writes it to `--snapshot-output`. CI's native owner fixtures read that file through
 * `NATIVE_1290_COMPOSITION_SNAPSHOT_PATH`, so they run against the real built Composition, not a synthetic one.
 *
 *   node scripts/derive-built-application-composition.mts --snapshot-output <file>
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { DateTime, Effect, FileSystem, Layer, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import {
  ONTOS_MODULE_CONTRACT_PATH,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  OntosDeploymentAppIdSchema,
} from '../packages/core-runtime/src/index.ts';
import {
  ACTIVE_APPLICATION_COMPOSITION_POLICY,
  ActiveApplicationCompositionPublicationError,
  decodeActiveApplicationCompositionSnapshot,
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from './active-application-composition.mts';
import type { ObservedArtifact, ObservedModuleDeployment } from './active-application-composition.mts';

const SHELL_APP_ID = 'shell-super-app';
const MF_MANIFEST_PATH = '/mf-manifest.json';
const BUILD_PROOF_ENVIRONMENT = 'build-proof';

/** One required built artifact is missing; the whole derivation fails, never a partial Composition. */
export class BuiltApplicationCompositionError extends Schema.TaggedError<BuiltApplicationCompositionError>()(
  'BuiltApplicationCompositionError',
  { appId: OntosDeploymentAppIdSchema, cause: Schema.optional(Schema.Defect()), message: Schema.String },
) {}

const TopologySchema = Schema.Struct({
  verticals: Schema.Array(
    Schema.Struct({
      id: OntosDeploymentAppIdSchema,
      surfaceProfile: Schema.optionalKey(Schema.Literal('api-only')),
    }),
  ),
});
type TopologyVertical = (typeof TopologySchema.Type)['verticals'][number];

const artifactUrl = (origin: string, path: string): string => new URL(path, origin).href;

const buildProofOrigin = (appId: string): string => `https://${appId}.build-proof.invalid`;

const workspaceFile = (...segments: readonly string[]) =>
  Path.Path.pipe(Effect.map((platformPath) => platformPath.resolve(import.meta.dirname, '..', ...segments)));

const readTopology = Effect.gen(function* readTopologyFile() {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(yield* workspaceFile('topology', 'reference-topology.json'));
}).pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(TopologySchema))));

const readBuiltArtifact = (appId: string, url: string, ...segments: readonly string[]) =>
  Effect.gen(function* readBuiltArtifactFile() {
    const fileSystem = yield* FileSystem.FileSystem;
    const bytes = yield* fileSystem.readFile(yield* workspaceFile(...segments));
    const artifact: ObservedArtifact = { bytes, url };
    return artifact;
  }).pipe(
    Effect.mapError(
      (cause) => new BuiltApplicationCompositionError({ appId, cause, message: `${segments.join('/')} is not built` }),
    ),
  );

const observeBuiltModule = (vertical: TopologyVertical) => {
  const origin = buildProofOrigin(vertical.id);
  const contract = readBuiltArtifact(
    vertical.id,
    artifactUrl(origin, ONTOS_MODULE_CONTRACT_PATH),
    'verticals',
    vertical.id,
    'dist',
    'public',
    ONTOS_MODULE_CONTRACT_PATH.slice(1),
  );
  if (vertical.surfaceProfile === 'api-only') {
    return contract.pipe(
      Effect.map((artifact): ObservedModuleDeployment => ({
        appId: vertical.id,
        backend: { baseUrl: `${origin}/`, transport: 'node-http' },
        contract: artifact,
      })),
    );
  }
  const manifest = readBuiltArtifact(
    vertical.id,
    artifactUrl(origin, MF_MANIFEST_PATH),
    'verticals',
    vertical.id,
    'dist',
    MF_MANIFEST_PATH.slice(1),
  );
  return Effect.all([contract, manifest], { concurrency: 2 }).pipe(
    Effect.map(([artifact, federationManifest]): ObservedModuleDeployment => ({
      appId: vertical.id,
      backend: { baseUrl: `${origin}/`, transport: 'node-http' },
      contract: artifact,
      federationManifest,
    })),
  );
};

/** The snapshot of this revision's built artifacts, derived by the same code the app host publishes with. */
export const deriveBuiltSnapshot = Effect.fn('BuiltApplicationComposition.derive')(function* deriveBuiltSnapshot(
  observedAt: DateTime.Utc,
) {
  const topology = yield* readTopology;
  const shellOrigin = buildProofOrigin(SHELL_APP_ID);
  const [modules, runtimeContract, federationManifest] = yield* Effect.all(
    [
      Effect.forEach(topology.verticals, observeBuiltModule, { concurrency: 4 }),
      readBuiltArtifact(
        SHELL_APP_ID,
        artifactUrl(shellOrigin, ONTOS_SHELL_RUNTIME_CONTRACT_PATH),
        'apps',
        SHELL_APP_ID,
        'dist',
        'public',
        ONTOS_SHELL_RUNTIME_CONTRACT_PATH.slice(1),
      ),
      readBuiltArtifact(
        SHELL_APP_ID,
        artifactUrl(shellOrigin, MF_MANIFEST_PATH),
        'apps',
        SHELL_APP_ID,
        'dist',
        MF_MANIFEST_PATH.slice(1),
      ),
    ],
    { concurrency: 3 },
  );
  return yield* deriveActiveApplicationCompositionSnapshot({
    environment: BUILD_PROOF_ENVIRONMENT,
    modules,
    observedAt,
    shell: { federationManifest, runtimeContract },
    validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
  });
});

const writeBuiltSnapshot = Effect.fn('BuiltApplicationComposition.write')(function* writeBuiltSnapshot(
  snapshotOutput: string,
) {
  const snapshot = yield* deriveBuiltSnapshot(yield* DateTime.now);
  const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
  const decoded = yield* decodeActiveApplicationCompositionSnapshot(encoded);
  if (decoded.composition.revision !== snapshot.composition.revision) {
    return yield* new ActiveApplicationCompositionPublicationError({
      message: 'the decoded snapshot names a different Application Composition revision',
      reason: 'invalid_observation',
    });
  }
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.writeFileString(snapshotOutput, encoded);
  return yield* Effect.logInfo('Built artifacts form an active Application Composition snapshot consumers decode', {
    modules: decoded.composition.modules.length,
    revision: decoded.composition.revision,
  });
});

export const deriveBuiltApplicationCompositionCommand = Command.make(
  'derive-built-application-composition',
  { snapshotOutput: Flag.String('snapshot-output') },
  ({ snapshotOutput }) => writeBuiltSnapshot(snapshotOutput),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(Command.run(deriveBuiltApplicationCompositionCommand, { version: '1.0.0' })).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ).pipe(Effect.scoped),
  );
}
