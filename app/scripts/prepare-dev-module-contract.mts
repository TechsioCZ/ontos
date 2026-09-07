#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Console, Effect, Exit, FileSystem, Layer, Path, Result, Schema } from 'effect';
import { Argument, Command } from 'effect/unstable/cli';

import { generateOntosModuleContract } from './generate-ontos-module-contract.mts';

class ModuleContractPreparationError extends Schema.TaggedError<ModuleContractPreparationError>()(
  'ModuleContractPreparationError',
  {
    cause: Schema.optionalKey(Schema.Unknown),
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

const VerticalNameSchema = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
);

const prepareDevModuleContractCommand = Command.make(
  'prepare-dev-module-contract',
  {
    vertical: Argument.string('vertical').pipe(Argument.withSchema(VerticalNameSchema)),
  },
  ({ vertical }) =>
    Effect.gen(function* prepareDevModuleContractProgram() {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const workspaceRoot = yield* pathService.fromFileUrl(new URL('..', import.meta.url));
      const generated = yield* Effect.tryPromise({
        catch: (cause) =>
          new ModuleContractPreparationError({
            cause,
            reason: `Unable to generate the ${vertical} development module contract`,
          }),
        try: async () =>
          await generateOntosModuleContract({
            target: 'dist',
            vertical,
            workspaceRoot,
          }),
      });
      const publicDirectory = pathService.join(workspaceRoot, 'verticals', vertical, '.dev-public');
      const contractDirectory = pathService.join(publicDirectory, '.well-known');
      yield* fileSystem.makeDirectory(contractDirectory, { recursive: true });
      yield* fileSystem.copyFile(
        generated.path,
        pathService.join(contractDirectory, 'ontos-module-manifest.json'),
      );
      const headers = yield* fileSystem.readFileString(
        pathService.join(pathService.dirname(pathService.dirname(generated.path)), '_headers'),
      );
      yield* fileSystem.writeFileString(pathService.join(publicDirectory, '_headers'), headers);
      yield* Console.log(
        `Prepared the ${vertical} development module contract in ${publicDirectory}`,
      );
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof ModuleContractPreparationError
          ? cause
          : new ModuleContractPreparationError({
              cause,
              reason: `Unable to prepare the ${vertical} development module contract`,
            }),
      ),
    ),
);

const loadFromCoreRuntime = createRequire(
  new URL('../packages/core-runtime/package.json', import.meta.url),
);
const nodePlatform: unknown = loadFromCoreRuntime('@effect/platform-node');
const AnyLayerSchema = Schema.declare(Layer.isLayer);
const NodeServicesLayerSchema = Schema.declare<Layer.Layer<Command.Environment>>(
  (value): value is Layer.Layer<Command.Environment> => Schema.is(AnyLayerSchema)(value),
);
const NodePlatformSchema = Schema.Struct({
  NodeServices: Schema.Struct({ layer: NodeServicesLayerSchema }),
});
const { NodeServices } = Result.getOrThrow(
  Schema.decodeUnknownResult(NodePlatformSchema)(nodePlatform),
);

const exit = await Effect.runPromiseExit(
  Command.run(prepareDevModuleContractCommand, { version: '1.0.0' }).pipe(
    Effect.tapError((failure) =>
      failure instanceof ModuleContractPreparationError
        ? Console.error(failure.message)
        : Effect.void,
    ),
    Effect.provide(NodeServices.layer),
  ),
);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
