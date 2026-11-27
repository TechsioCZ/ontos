/* oxlint-disable typescript/consistent-return -- Existing compatibility boundary; expires: 2026-12-31. */
const { existsSync } = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');
const ambientEnvironmentDescriptor = Object.getOwnPropertyDescriptor(process, 'env');

/** @param {string} name - Ambient environment variable name. */
const environmentValue = (name) => {
  const variableDescriptor =
    ambientEnvironmentDescriptor === undefined
      ? undefined
      : Object.getOwnPropertyDescriptor(ambientEnvironmentDescriptor.value, name);
  return variableDescriptor === undefined ? undefined : String(variableDescriptor.value);
};

/** @param {string} candidate - Directory to inspect for workspace files. */
const isAppWorkspace = (candidate) =>
  existsSync(path.join(candidate, 'pnpm-workspace.yaml')) &&
  existsSync(path.join(candidate, 'packages/core-runtime/package.json'));

/** @param {string} startDirectory - Directory from which to find the workspace. */
const resolveAppWorkspaceRootSync = (startDirectory) => {
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
      return;
    }
    candidate = parent;
  }
};

/**
 * @param {[string | undefined, string, string | undefined]} candidates - Ordered workspace-root candidates.
 * @returns {{ APP_ENV_PATH: string, APP_WORKSPACE_ROOT: string }} The resolved workspace paths.
 */
const resolveWorkspaceEnvironmentSync = (candidates) => {
  const APP_WORKSPACE_ROOT =
    candidates
      .map((candidate) =>
        candidate === undefined || candidate.length === 0 ? undefined : resolveAppWorkspaceRootSync(candidate),
      )
      .find((candidate) => candidate !== undefined) ?? candidates[1];
  const explicitEnvironmentPath = environmentValue('APP_ENV_PATH');
  return {
    APP_ENV_PATH:
      explicitEnvironmentPath !== undefined && explicitEnvironmentPath.length > 0
        ? path.resolve(APP_WORKSPACE_ROOT, explicitEnvironmentPath)
        : path.join(APP_WORKSPACE_ROOT, '.env'),
    APP_WORKSPACE_ROOT,
  };
};

const resolvedWorkspaceEnvironment = resolveWorkspaceEnvironmentSync([
  environmentValue('ULTRAMODERN_WORKSPACE_ROOT'),
  process.cwd(),
  environmentValue('INIT_CWD'),
]);

module.exports = {
  APP_ENV_PATH: resolvedWorkspaceEnvironment.APP_ENV_PATH,
  APP_WORKSPACE_ROOT: resolvedWorkspaceEnvironment.APP_WORKSPACE_ROOT,
  resolveAppWorkspaceRootSync,
};
