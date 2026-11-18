#!/usr/bin/env node
/**
 * The seconds the Zerops app build is expected to spend building these units, printed as one integer: the shared
 * declaration typecheck build-app.sh runs before any unit build, then the units dealt longest first over the build's
 * BUILD_LANES (zerops.yaml BUILD_JOBS), each to the lane with the least work so far. Runner measurements
 * (MODULE_BUILD_SECONDS); the delivery job compares them with ZEROPS_BUILD_BUDGET_SECONDS to decide whether the Zerops
 * build builds the changed units itself or the runner build matrix does. No unit costs nothing.
 *
 *   node scripts/zerops/zerops-unit-build-seconds.mts [<unit> ...]
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Effect } from 'effect';
import { Argument, Command } from 'effect/cli';

import { BUILD_LANES, moduleSeconds } from './build-shard-units.mts';
import { SHELL_ID } from './hosted-units.mts';

/** The Shell's build, the slowest measured (74-116 s over the runs MODULE_BUILD_SECONDS names). */
export const SHELL_BUILD_SECONDS = 116;
/** `ultramodern typecheck --build` of shared-contracts and shared-design-tokens before the first unit build. */
export const SHARED_TYPECHECK_SECONDS = 30;

const unitSeconds = (unit: string) => (unit === SHELL_ID ? SHELL_BUILD_SECONDS : moduleSeconds(unit));

export const zeropsUnitBuildSeconds = (units: readonly string[]): number => {
  if (units.length === 0) {
    return 0;
  }
  const lanes = Array.from({ length: BUILD_LANES }, () => 0);
  for (const unit of units.toSorted((left, right) => unitSeconds(right) - unitSeconds(left))) {
    const lightest = lanes.indexOf(Math.min(...lanes));
    lanes[lightest] = (lanes[lightest] ?? 0) + unitSeconds(unit);
  }
  return SHARED_TYPECHECK_SECONDS + Math.max(...lanes);
};

const command = Command.make(
  'zerops-unit-build-seconds',
  { units: Argument.String('unit').pipe(Argument.variadic()) },
  ({ units }) => Console.log(String(zeropsUnitBuildSeconds(units))),
);

if (import.meta.main) {
  NodeRuntime.runMain(Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)), {
    disableErrorReporting: false,
  });
}
