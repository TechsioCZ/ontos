/* eslint-disable node/no-process-env -- Workspace discovery may use the package-manager invocation directory. */
import { existsSync } from 'node:fs';
import path from 'node:path';

const isAppWorkspace = (candidate: string): boolean =>
  existsSync(path.join(candidate, 'pnpm-workspace.yaml')) &&
  existsSync(path.join(candidate, 'packages/core-runtime/package.json'));

/**
 * Finds the application workspace without relying on import.meta.dirname.
 *
 * Modern.js bundles server modules into a cache directory, so module-relative
 * paths do not identify the source workspace at runtime.
 */
export const resolveAppWorkspaceRoot = (startDirectory: string): string | undefined => {
  let candidate = path.resolve(startDirectory);

  while (true) {
    if (isAppWorkspace(candidate)) {
      return candidate;
    }

    const nestedApp = path.join(candidate, 'app');
    if (isAppWorkspace(nestedApp)) {
      return nestedApp;
    }

    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return undefined;
    }

    candidate = parent;
  }
};

const workspaceCandidates = [
  process.env['ULTRAMODERN_WORKSPACE_ROOT'],
  process.cwd(),
  process.env['INIT_CWD'],
].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);

/** The application workspace owns the single local environment file. */
export const APP_WORKSPACE_ROOT =
  workspaceCandidates
    .map(resolveAppWorkspaceRoot)
    .find((candidate): candidate is string => candidate !== undefined) ?? process.cwd();

export const APP_ENV_PATH = path.join(APP_WORKSPACE_ROOT, '.env');
