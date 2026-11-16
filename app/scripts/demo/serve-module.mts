#!/usr/bin/env node
/**
 * Serves one calling module locally (`modern serve` in this very process) holding its module credential the way the
 * app host's owners process holds it: the module's built API bundle carries its own credential store copy, which this
 * program claims (the bundle's exposed claim, `scripts/zerops/hosted-credential-claim.mts expose`) before
 * `modern serve` loads that same bundle file, and the key arrives later on the private handover channel (file
 * descriptor 3), never in the environment or arguments.
 *
 *   ONTOS_MODULE_CREDENTIAL_HANDOVER=fd3 node scripts/demo/serve-module.mts <app-id> <module directory> 3<>"$fifo"
 *
 * The local demo opens the channel on a private FIFO and writes that module's handover to it once the platform
 * issued the keys for the published local composition (scripts/demo/up.sh).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Layer, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';

import { API_BUNDLE, BUNDLE_CLAIM_EXPORT } from '../zerops/hosted-credential-claim.mts';
import {
  holdUnitStoreCopy,
  receiveModuleCredentialHandover,
  UnitCredentialClaimSchema,
} from '../zerops/module-credentials.mts';

class ServeModuleError extends Schema.TaggedError<ServeModuleError>()('ServeModuleError', { reason: Schema.String }) {}

const workspaceRoot = path.resolve(import.meta.dirname, '../..');

/**
 * Loads the module's API bundle by the real path `modern serve` loads it from, so both hold the one module instance,
 * and returns the claim of its own credential store copy.
 */
const BundleClaimSchema = Schema.Struct({ [BUNDLE_CLAIM_EXPORT]: UnitCredentialClaimSchema });

const bundleClaimOf = Effect.fn('ServeModule.bundleClaim')(function* bundleClaimOf(directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const unavailable = () =>
    new ServeModuleError({ reason: `${directory}/${API_BUNDLE} exposes no credential claim; build the module` });
  const bundle = yield* fs
    .realPath(path.join(path.resolve(workspaceRoot, directory), API_BUNDLE))
    .pipe(Effect.mapError(unavailable));
  const loaded = yield* Effect.tryPromise({
    catch: unavailable,
    // SAFETY: a dynamically imported module namespace is opaque until Schema decodes its claim export below.
    try: async () => (await import(pathToFileURL(bundle).href)) as unknown,
  });
  const decoded = yield* Schema.decodeUnknownEffect(BundleClaimSchema)(loaded).pipe(Effect.mapError(unavailable));
  return decoded[BUNDLE_CLAIM_EXPORT];
});

/** Runs the module's own `modern serve` in this process; it loads the API bundle whose copy was claimed above. */
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
      // Before the module serves: its bundle's own copy is claimed for it and filled later on the private channel.
      const holders = yield* receiveModuleCredentialHandover([appId]);
      yield* holdUnitStoreCopy(holders, appId, yield* bundleClaimOf(directory));
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
