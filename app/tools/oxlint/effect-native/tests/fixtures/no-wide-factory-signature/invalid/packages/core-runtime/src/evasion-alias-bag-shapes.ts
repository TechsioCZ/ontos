// expect-count: 4
import { Effect as Fx } from 'effect';

/** Aliased named import: the bag is still a bag when `Effect` is spelled `Fx`. */
export const makeAliasRuntime = (dependencies: AliasRuntimeDependencies) =>
  Fx.fn('alias')(function* () {
    return dependencies;
  });

/** Qualified bag type: `Shell.CompositionDependencies` still ends in `Dependencies`. */
export const createQualifiedRuntime = (dependencies: Shell.CompositionDependencies) =>
  Fx.gen(function* () {
    return dependencies;
  });

/** Generic bag type argument must not hide the bag. */
export const buildGenericRuntime = (dependencies: RuntimeDependencies<ShellScope>) =>
  Fx.gen(function* () {
    return dependencies;
  });

/** Optional parameter: `?` does not remove the collaborator bag. */
export const defineOptionalRuntime = (options?: OutboxOptions) =>
  Fx.gen(function* () {
    return options;
  });

/** Allowed: two scalars, no bag. */
export const createAliasKey = (tenant: string, module: string) => `${tenant}:${module}`;
