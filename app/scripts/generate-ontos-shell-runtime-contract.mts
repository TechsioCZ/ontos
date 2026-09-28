#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Layer, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

import {
  ONTOS_SHELL_CONTRIBUTION_ABI,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  OntosShellRuntimeContractSchema,
} from '../packages/core-runtime/src/index.ts';
import type { OntosShellRuntimeContract } from '../packages/core-runtime/src/index.ts';

/**
 * The Shell reports the Core-defined contribution ABI and the Core capabilities it provides so the
 * Application Composition publisher observes them from the deployed Shell instead of assuming them.
 */
export const shellRuntimeContract: OntosShellRuntimeContract = Object.freeze({
  contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
  coreCapabilities: [],
  schemaVersion: '1',
});

export class ShellRuntimeContractGenerationError extends Schema.TaggedError<ShellRuntimeContractGenerationError>()(
  'ShellRuntimeContractGenerationError',
  { cause: Schema.optional(Schema.Defect()), message: Schema.String },
) {}

const ShellRuntimeContractJsonSchema = Schema.fromJsonString(OntosShellRuntimeContractSchema, { space: 2 });

export const ShellRuntimeContractTargetSchema = Schema.Literals(['cloudflare-dist', 'dist']);
type ShellRuntimeContractTarget = typeof ShellRuntimeContractTargetSchema.Type;

const outputRootByTarget: Readonly<Record<ShellRuntimeContractTarget, string>> = Object.freeze({
  'cloudflare-dist': 'dist-cloudflare',
  dist: 'dist',
});

export const generateOntosShellRuntimeContract = Effect.fn('generateOntosShellRuntimeContract')(
  function* generate(input: { readonly shellDirectory: string; readonly target: ShellRuntimeContractTarget }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const platformPath = yield* Path.Path;
    const encoded = yield* Schema.encodeEffect(ShellRuntimeContractJsonSchema)(shellRuntimeContract).pipe(
      Effect.mapError(
        (cause) =>
          new ShellRuntimeContractGenerationError({ cause, message: 'unable to encode the Shell runtime contract' }),
      ),
    );
    const outputPath = platformPath.join(
      input.shellDirectory,
      outputRootByTarget[input.target],
      'public',
      ONTOS_SHELL_RUNTIME_CONTRACT_PATH.slice(1),
    );
    yield* fileSystem.makeDirectory(platformPath.dirname(outputPath), { recursive: true });
    yield* fileSystem.writeFileString(outputPath, `${encoded}\n`);
    return outputPath;
  },
);

const generateCommand = Command.make(
  'generate-ontos-shell-runtime-contract',
  {
    shellDirectory: Flag.String('shell-directory'),
    target: Flag.Literals('target', ['cloudflare-dist', 'dist']),
  },
  ({ shellDirectory, target }) =>
    generateOntosShellRuntimeContract({ shellDirectory, target }).pipe(
      Effect.flatMap((outputPath) => Effect.logInfo(`Generated ${outputPath}`)),
    ),
);

export const main = Command.run({ version: '1.0.0' })(generateCommand);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(NodeServices.layer))).pipe(Effect.scoped),
  );
}
