import { Effect, FileSystem, Option, Path, Schema } from 'effect';

import {
  ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY,
  ONTOS_SHELL_CONTRIBUTION_ABI,
} from '../packages/core-runtime/src/index.ts';
import type { OntosShellRuntimeContract } from '../packages/core-runtime/src/index.ts';

/**
 * The Shell reports the Core-defined contribution ABI and the Core capabilities it provides so the
 * Application Composition publisher observes them from the deployed Shell instead of assuming them.
 */
export const createShellRuntimeContract = (buildMarker: string): OntosShellRuntimeContract =>
  Object.freeze<OntosShellRuntimeContract>({
    contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
    coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
    deployment: { appId: 'shell-super-app', buildMarker },
    schemaVersion: '2',
  });

const exactBuildMarker = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const sourceRevision = Schema.String.check(Schema.isPattern(/^(?:workspace|[a-f0-9]{40}|[a-f0-9]{64})$/u));
const compiledNodeBuildSchema = Schema.fromJsonString(
  Schema.Struct({
    deliveryUnit: Schema.Struct({
      appId: Schema.Literal('shell-super-app'),
      build: exactBuildMarker,
      buildMarker: exactBuildMarker,
      sourceRevision,
      unitId: Schema.Literal('app/shell-super-app'),
    }).check(Schema.makeFilter(({ build, buildMarker }) => build === buildMarker || 'Shell build marker mismatch')),
  }),
);

/** Read the identity emitted by the Node compiler. A fixture with no compiler output has no compiled identity. */
export const readCompiledNodeShellIdentity = Effect.fn('readCompiledNodeShellIdentity')(
  function* readCompiledNodeShellIdentity(shellDirectory: string) {
    const filesystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const artifactPath = path.join(shellDirectory, 'dist', 'ultramodern-build.json');
    if (!(yield* filesystem.exists(artifactPath))) {
      return Option.none();
    }
    const { deliveryUnit } = yield* filesystem
      .readFileString(artifactPath)
      .pipe(Effect.flatMap(Schema.decodeEffect(compiledNodeBuildSchema)));
    return Option.some(deliveryUnit);
  },
);
