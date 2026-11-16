#!/usr/bin/env node
/**
 * The units one stage build shard builds (zerops-stage.yml, job `build`), printed space-separated.
 *
 * The push waits for the slowest shard, and a shard ends with its slowest build lane rather than with its total: with
 * BUILD_LANES = 2, a shard whose lanes hold 160 s each ends in 160 s, one that holds 250 s and 70 s ends in 250 s.
 * So the modules of topology/application-release-intent.json are dealt lane by lane, by their measured build seconds
 * (MODULE_BUILD_SECONDS), longest first, each to the lane with the least work so far. A module that has no measurement
 * yet is dealt after every measured one, at UNMEASURED_MODULE_SECONDS, so adding an unmeasured module moves no
 * measured module (only unmeasured modules dealt after it can move). Adding, changing or removing a measurement, or
 * removing a measured module, can move modules; each moved module then builds once in its new shard, because a
 * shard's cache entry is named by its own units' identities.
 *
 *   node scripts/zerops/build-shard-units.mts <shard> <shards>
 */
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Data, Effect, FileSystem, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';

import { ReleaseIntentSchema, SHELL_ID, workspaceRoot } from './hosted-units.mts';

/** The Shell's own shard. It builds alone: measured 74-116 s over the runs below, so shard 0 is never the slowest. */
export const SHELL_SHARD = 0;

/** `BUILD_JOBS=2` in the build job: every shard builds two units at a time, so every shard has two build lanes. */
export const BUILD_LANES = 2;

/**
 * Each module's build cost in seconds, for dealing only. Measured from the `built <unit> in Ns` lines of the five
 * stage runs that rebuilt every unit (43715845040, 43764570181, 43797839971, 43803674984, 43810710505), each run
 * normalised by its own mean module and then averaged, scaled back to the five-run mean of 80.6 s. Normalising first
 * is what makes the five runs comparable: workforce measured 56 s in one and 97 s in another because runner speed and
 * the lane-mate it shares a core with differ per run, while its share of the run is stable.
 */
export const MODULE_BUILD_SECONDS = new Map([
  ['assortment', 77],
  ['catalog', 112],
  ['commerce-customer-context', 130],
  ['commerce-market-catalog', 83],
  ['crm', 90],
  ['crm-activities', 75],
  ['facility-operations', 79],
  ['finance-billing', 90],
  ['inventory', 72],
  ['legal-agreements', 87],
  ['merchandise', 85],
  ['party-registry', 125],
  ['payment-term-catalog', 46],
  ['price-group-catalog', 63],
  ['pricing', 73],
  ['privacy', 94],
  ['projects', 75],
  ['property-leasing', 95],
  ['property-portfolio', 70],
  ['sales-insights', 76],
  ['sales-pipeline', 77],
  ['storefront-registry', 51],
  ['symmy-integration', 65],
  ['tagging', 72],
  ['tax', 45],
  ['work-tasks', 94],
  ['workforce', 74],
]);

/** A module without a measurement counts as the median measured module. */
export const UNMEASURED_MODULE_SECONDS = 77;

export class BuildShardError extends Data.TaggedError('BuildShardError')<{ readonly message: string }> {}

/** A module's build seconds for dealing. */
export const moduleSeconds = (module: string): number => MODULE_BUILD_SECONDS.get(module) ?? UNMEASURED_MODULE_SECONDS;

/**
 * Every shard's units; shard 0 holds only the Shell. Dealt longest first to the lightest build lane, so the longest
 * build of a shard also comes first in its list and build-app.sh's `xargs -P 2` starts the shard with the long ones.
 * Deterministic: ties go to the module named first and the lowest lane, so the same release intent always deals the
 * same shards and their cache entries keep hitting. Lanes fill in index order, so every dealt shard holds units while
 * the intent has two modules per dealt shard (27 over seven dealt shards today); a shard left without a unit list
 * fails its build job rather than deploying a partial app.
 */
export const buildShardUnits = (modules: readonly string[], shards: number): readonly (readonly string[])[] => {
  const dealt = Array.from({ length: shards }, (_, shard): string[] => (shard === SHELL_SHARD ? [SHELL_ID] : []));
  const lanes = Array.from({ length: shards * BUILD_LANES }, () => 0);
  const measured = modules
    .filter((module) => MODULE_BUILD_SECONDS.has(module))
    .toSorted((left, right) => moduleSeconds(right) - moduleSeconds(left) || left.localeCompare(right));
  const unmeasured = modules.filter((module) => !MODULE_BUILD_SECONDS.has(module));
  for (const module of [...measured, ...unmeasured]) {
    let lightest = -1;
    for (let lane = 0; lane < lanes.length; lane += 1) {
      const shard = Math.trunc(lane / BUILD_LANES);
      if (shard !== SHELL_SHARD && (lightest < 0 || (lanes[lane] ?? 0) < (lanes[lightest] ?? 0))) {
        lightest = lane;
      }
    }
    dealt[Math.trunc(lightest / BUILD_LANES)]?.push(module);
    lanes[lightest] = (lanes[lightest] ?? 0) + moduleSeconds(module);
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
