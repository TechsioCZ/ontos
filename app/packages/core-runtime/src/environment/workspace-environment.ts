/* oxlint-disable sonarjs/no-built-in-override, typescript/consistent-return */
import { Effect, FileSystem, Path } from 'effect';
import bootstrapEnvironment from './workspace-environment-bootstrap.cjs';

const isAppWorkspace = (candidate: string) =>
  Effect.gen(function* isAppWorkspaceEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return (
      (yield* fileSystem.exists(path.join(candidate, 'pnpm-workspace.yaml'))) &&
      (yield* fileSystem.exists(path.join(candidate, 'packages/core-runtime/package.json')))
    );
  });

/**
 * Finds the application workspace without relying on import.meta.dirname.
 *
 * Modern.js bundles server modules into a cache directory, so module-relative
 * paths do not identify the source workspace at runtime.
 */
const resolveAppWorkspaceRootWithServices = (startDirectory: string) =>
  Effect.gen(function* resolveAppWorkspaceRootEffect() {
    const path = yield* Path.Path;
    let candidate = path.resolve(startDirectory);

    while (true) {
      if (yield* isAppWorkspace(candidate)) {
        return candidate;
      }

      const nestedApp = path.join(candidate, 'app');
      if (yield* isAppWorkspace(nestedApp)) {
        return nestedApp;
      }

      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return;
      }

      candidate = parent;
    }
  });

/**
 * Dependency-transparent workspace lookup.
 *
 * Node hosts provide FileSystem and Path at their composition root; this helper does not allocate a
 * second platform layer or scope a hidden runtime for each lookup.
 */
export const resolveAppWorkspaceRootEffect = (startDirectory: string) =>
  resolveAppWorkspaceRootWithServices(startDirectory);

export const resolveAppWorkspaceRoot: (startDirectory: string) => string | undefined =
  bootstrapEnvironment.resolveAppWorkspaceRootSync;

/** The application workspace owns the single local environment file. */
export const APP_WORKSPACE_ROOT: string = bootstrapEnvironment.APP_WORKSPACE_ROOT;

export const APP_ENV_PATH: string = bootstrapEnvironment.APP_ENV_PATH;
