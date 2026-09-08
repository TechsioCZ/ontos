import { Effect, FileSystem, Option, Path } from 'effect';
import bootstrapEnvironment from './workspace-environment-bootstrap.cjs';

const isAppWorkspace = Effect.fn('WorkspaceEnvironment.isAppWorkspace')(
  function* isAppWorkspaceEffect(candidate: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return (
      (yield* fileSystem.exists(path.join(candidate, 'pnpm-workspace.yaml'))) &&
      (yield* fileSystem.exists(path.join(candidate, 'packages/core-runtime/package.json')))
    );
  },
);

const workspaceCandidates = (path: Path.Path, candidate: string): readonly string[] => {
  const nestedApp = path.join(candidate, 'app');
  const parent = path.dirname(candidate);
  return parent === candidate
    ? [candidate, nestedApp]
    : [candidate, nestedApp, ...workspaceCandidates(path, parent)];
};

/**
 * Finds the application workspace without relying on import.meta.dirname.
 *
 * Modern.js bundles server modules into a cache directory, so module-relative
 * paths do not identify the source workspace at runtime.
 */
export const resolveAppWorkspaceRootEffect = Effect.fn(
  'WorkspaceEnvironment.resolveAppWorkspaceRootEffect',
)(function* resolveAppWorkspaceRootEffect(startDirectory: string) {
  const path = yield* Path.Path;
  const candidates = workspaceCandidates(path, path.resolve(startDirectory));
  return Option.getOrUndefined(yield* Effect.findFirst(candidates, isAppWorkspace));
});

export const resolveAppWorkspaceRoot: (startDirectory: string) => string | undefined =
  bootstrapEnvironment.resolveAppWorkspaceRootSync;

/** The application workspace owns the single local environment file. */
export const APP_WORKSPACE_ROOT: string = bootstrapEnvironment.APP_WORKSPACE_ROOT;

export const APP_ENV_PATH: string = bootstrapEnvironment.APP_ENV_PATH;
