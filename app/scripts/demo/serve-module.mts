#!/usr/bin/env node
/**
 * Serves one calling module locally (`modern serve` in this very process) holding its module credential the way the
 * app host's owners process holds it: the process is claimed for that one owner before the module loads, and the key
 * arrives later on the private handover channel (file descriptor 3), never in the environment or arguments.
 *
 *   ONTOS_MODULE_CREDENTIAL_HANDOVER=fd3 node scripts/demo/serve-module.mts <app-id> <module directory> 3<>"$fifo"
 *
 * The local demo opens the channel on a private FIFO and writes that module's handover to it once the platform
 * issued the keys for the published local composition (scripts/demo/up.sh).
 */
import { createRequire } from 'node:module';
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Layer, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';

import { receiveModuleCredentialHandover } from '../zerops/module-credentials.mts';

class ServeModuleError extends Schema.TaggedError<ServeModuleError>()('ServeModuleError', { reason: Schema.String }) {}

const workspaceRoot = path.resolve(import.meta.dirname, '../..');

/** Runs the module's own `modern serve` in this process, so it shares this process's credential slots. */
const serveInProcess = (directory: string) =>
  Effect.try({
    catch: () => new ServeModuleError({ reason: `modern serve could not start in ${directory}` }),
    try: () => {
      const moduleRoot = path.resolve(workspaceRoot, directory);
      const modern = createRequire(path.join(moduleRoot, 'package.json')).resolve('@modern-js/app-tools/bin/modern.js');
      process.chdir(moduleRoot);
      process.argv = [process.execPath, modern, 'serve'];
      createRequire(modern)(modern);
    },
  });

const command = Command.make(
  'serve-module',
  { appId: Argument.String('app-id'), directory: Argument.String('module-directory') },
  ({ appId, directory }) =>
    Effect.gen(function* serveModule() {
      // Before the module loads: it then reads only its own slot, filled later on the private channel.
      yield* receiveModuleCredentialHandover([appId]);
      yield* serveInProcess(directory);
      return yield* Effect.never;
    }),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.launch(
      Layer.effectDiscard(Command.run({ version: '1.0.0' })(command)).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
}
