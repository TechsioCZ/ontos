import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';

import { collectToolingProcess } from '../tests/tooling-process-fixture.mts';
import { moduleSeconds } from './build-shard-units.mts';
import { SHELL_ID } from './hosted-units.mts';
import { SHARED_TYPECHECK_SECONDS, SHELL_BUILD_SECONDS, zeropsUnitBuildSeconds } from './zerops-unit-build-seconds.mts';

const APP = path.resolve(import.meta.dirname, '../..');
const runCli = (units: readonly string[]) =>
  collectToolingProcess(
    ChildProcess.make('node', ['scripts/zerops/zerops-unit-build-seconds.mts', ...units], {
      cwd: APP,
      extendEnv: true,
    }),
  );

it('costs nothing without units, and the shared typecheck before the first unit', () => {
  expect(zeropsUnitBuildSeconds([])).toBe(0);
  expect(zeropsUnitBuildSeconds(['tax'])).toBe(SHARED_TYPECHECK_SECONDS + moduleSeconds('tax'));
  expect(zeropsUnitBuildSeconds([SHELL_ID])).toBe(SHARED_TYPECHECK_SECONDS + SHELL_BUILD_SECONDS);
});

it('deals the units longest first over the two build lanes', () => {
  // Two units build side by side; the third joins the lane with less work.
  expect(zeropsUnitBuildSeconds(['tax', 'crm'])).toBe(SHARED_TYPECHECK_SECONDS + moduleSeconds('crm'));
  expect(zeropsUnitBuildSeconds(['tax', 'crm', 'payment-term-catalog'])).toBe(
    SHARED_TYPECHECK_SECONDS +
      Math.max(moduleSeconds('crm'), moduleSeconds('payment-term-catalog') + moduleSeconds('tax')),
  );
  expect(zeropsUnitBuildSeconds([SHELL_ID, 'tax', 'crm'])).toBe(
    SHARED_TYPECHECK_SECONDS + Math.max(SHELL_BUILD_SECONDS, moduleSeconds('crm') + moduleSeconds('tax')),
  );
});

it.live('prints the seconds for the units named on the command line, and 0 for none', () =>
  Effect.gen(function* cli() {
    const none = yield* runCli([]);
    expect(none.status, none.stderr).toBe(0);
    expect(none.stdout.trim()).toBe('0');
    const two = yield* runCli(['tax', 'crm']);
    expect(two.status, two.stderr).toBe(0);
    expect(two.stdout.trim()).toBe(String(zeropsUnitBuildSeconds(['tax', 'crm'])));
  }).pipe(Effect.provide(NodeServices.layer)),
);
