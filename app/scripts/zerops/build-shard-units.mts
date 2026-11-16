#!/usr/bin/env node
/**
 * The units one stage build shard builds (zerops-stage.yml, job `build`), printed space-separated.
 *
 * The Shell builds alone in shard 0: its build takes several times as long as a module's, and the push waits for
 * the slowest shard. The modules of topology/application-release-intent.json are dealt over the other shards by their
 * measured build seconds (MODULE_BUILD_SECONDS), longest first, each to the shard with the least work so far, so the
 * shards end together when every unit rebuilds. A module that has no measurement yet is dealt after every measured
 * one, at UNMEASURED_MODULE_SECONDS: adding a module never moves another, so every shard's restored unit cache still
 * holds its modules. Changing a measurement can move modules; each moved module then builds once in its new shard.
 *
 *   node scripts/zerops/build-shard-units.mts <shard> <shards>
 */
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Data, Effect, FileSystem, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';

import { ReleaseIntentSchema, SHELL_ID, workspaceRoot } from './hosted-units.mts';

/** The Shell's own shard. */
export const SHELL_SHARD = 0;

/**
 * Seconds each module's build took in its stage shard, two builds at a time (BUILD_JOBS=2): the `built <unit> in Ns`
 * lines of run 43764570181 (2026-11-15), which rebuilt every unit. The shard waits for the sum over its two lanes.
 */
export const MODULE_BUILD_SECONDS = new Map([
  ['assortment', 75],
  ['catalog', 89],
  ['commerce-customer-context', 108],
  ['commerce-market-catalog', 100],
  ['crm', 102],
  ['crm-activities', 60],
  ['facility-operations', 79],
  ['finance-billing', 91],
  ['inventory', 64],
  ['legal-agreements', 79],
  ['merchandise', 73],
  ['party-registry', 125],
  ['payment-term-catalog', 48],
  ['price-group-catalog', 73],
  ['pricing', 74],
  ['privacy', 103],
  ['projects', 93],
  ['property-leasing', 99],
  ['property-portfolio', 62],
  ['sales-insights', 65],
  ['sales-pipeline', 55],
  ['storefront-registry', 52],
  ['symmy-integration', 46],
  ['tagging', 77],
  ['tax', 50],
  ['work-tasks', 99],
  ['workforce', 56],
]);

/** A module without a measurement counts as the median measured module. */
export const UNMEASURED_MODULE_SECONDS = 75;

export class BuildShardError extends Data.TaggedError('BuildShardError')<{ readonly message: string }> {}

/** A module's build seconds for dealing. */
export const moduleSeconds = (module: string): number => MODULE_BUILD_SECONDS.get(module) ?? UNMEASURED_MODULE_SECONDS;

/**
 * Every shard's units; shard 0 holds only the Shell. Within a shard the longest build comes first, so its two build
 * lanes start with the long ones. Deterministic: ties go to the module named first and the lowest shard.
 */
export const buildShardUnits = (modules: readonly string[], shards: number): readonly (readonly string[])[] => {
  const dealt = Array.from({ length: shards }, (_, shard): string[] => (shard === SHELL_SHARD ? [SHELL_ID] : []));
  const load = Array.from({ length: shards }, () => 0);
  const measured = modules
    .filter((module) => MODULE_BUILD_SECONDS.has(module))
    .toSorted((left, right) => moduleSeconds(right) - moduleSeconds(left) || left.localeCompare(right));
  const unmeasured = modules.filter((module) => !MODULE_BUILD_SECONDS.has(module));
  for (const module of [...measured, ...unmeasured]) {
    let lightest = -1;
    for (let shard = 0; shard < shards; shard += 1) {
      if (shard !== SHELL_SHARD && (lightest < 0 || (load[shard] ?? 0) < (load[lightest] ?? 0))) {
        lightest = shard;
      }
    }
    dealt[lightest]?.push(module);
    load[lightest] = (load[lightest] ?? 0) + moduleSeconds(module);
  }
  return dealt;
};

/** The release intent's modules, in file order. */
export const readReleaseModules = Effect.gen(function* readReleaseModules() {
  const fs = yield* FileSystem.FileSystem;
  const intent = yield* Schema.decodeEffect(ReleaseIntentSchema)(
    yield* fs.readFileString(path.join(workspaceRoot, 'topology/application-release-intent.json')),
  );
  return intent.modules.map(({ appId }): string => appId);
});

const command = Command.make(
  'build-shard-units',
  { shard: Argument.Int('shard'), shards: Argument.Int('shards') },
  ({ shard, shards }) =>
    Effect.gen(function* printShardUnits() {
      if (shards < 2 || shard < 0 || shard >= shards) {
        return yield* new BuildShardError({ message: `No shard ${String(shard)} of ${String(shards)}` });
      }
      const units = buildShardUnits(yield* readReleaseModules, shards)[shard] ?? [];
      return yield* Console.log(units.join(' '));
    }),
);

if (import.meta.main) {
  NodeRuntime.runMain(Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)), {
    disableErrorReporting: false,
  });
}
