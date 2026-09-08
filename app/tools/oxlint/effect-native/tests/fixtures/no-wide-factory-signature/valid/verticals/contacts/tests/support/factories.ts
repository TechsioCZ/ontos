import { Effect } from 'effect';

/** Test fixture builders are blessed by the audit's D tier and are out of scope by default. */
export const makeTestPrincipal = (tenant: string, module: string, role: string, now: Date) => ({
  module,
  now,
  role,
  tenant,
});

export const createTestRuntime = (dependencies: TestRuntimeDependencies) =>
  Effect.gen(function* () {
    return dependencies;
  });
