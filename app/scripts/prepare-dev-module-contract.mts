#!/usr/bin/env node
import { loadCoreNodeServices } from './shared/core-node-services.mts';
import { Console, Effect, Exit, FileSystem, Path, Schema } from 'effect';
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
      const generated = yield* generateOntosModuleContract({
        target: 'dist',
        vertical,
        workspaceRoot,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ModuleContractPreparationError({
              cause,
              reason: `Unable to generate the ${vertical} development module contract`,
            }),
        ),
      );
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
        Schema.is(ModuleContractPreparationError)(cause)
          ? cause
          : new ModuleContractPreparationError({
              cause,
              reason: `Unable to prepare the ${vertical} development module contract`,
            }),
      ),
    ),
);

const NodeServices = loadCoreNodeServices();

const exit = await Effect.runPromiseExit(
  Command.run(prepareDevModuleContractCommand, { version: '1.0.0' }).pipe(
    Effect.tapError((failure) =>
      Schema.is(ModuleContractPreparationError)(failure)
        ? Console.error(failure.message)
        : Effect.void,
    ),
    Effect.provide(NodeServices.layer),
  ),
);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
