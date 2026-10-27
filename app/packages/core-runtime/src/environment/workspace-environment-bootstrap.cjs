/// <reference types="node" />
/** @type {typeof import('node:process')} */
const nodeProcess = process;
const { existsSync } = nodeProcess.getBuiltinModule('node:fs');
const path = nodeProcess.getBuiltinModule('node:path');
/** @type {{ readonly value?: unknown } | undefined} */
const ambientEnvironmentDescriptor = Object.getOwnPropertyDescriptor(nodeProcess, 'env');

/**
 * @param {string} name - Environment variable name.
 * @returns {string | undefined} The own data-property value converted to a string.
 */
const environmentValue = (name) => {
  /** @type {{ readonly value?: unknown } | undefined} */
  const variableDescriptor =
    ambientEnvironmentDescriptor === undefined
      ? undefined
      : Object.getOwnPropertyDescriptor(ambientEnvironmentDescriptor.value, name);
  return variableDescriptor === undefined ? undefined : String(variableDescriptor.value);
};

/**
 * @param {string} candidate - Possible application workspace directory.
 * @returns {boolean} Whether both workspace markers exist.
 */
const isAppWorkspace = (candidate) =>
  existsSync(path.join(candidate, 'pnpm-workspace.yaml')) &&
  existsSync(path.join(candidate, 'packages/core-runtime/package.json'));

/**
 * @param {string} startDirectory - Directory from which to search upwards.
 * @returns {string | undefined} The first matching workspace, if any.
 */
const resolveAppWorkspaceRootSync = (startDirectory) => {
  let candidate = path.resolve(startDirectory);
  /** @type {string | undefined} */
  let match;
  let searching = true;
  while (searching) {
    if (isAppWorkspace(candidate)) {
      match = candidate;
      searching = false;
    } else {
      const nestedApp = path.join(candidate, 'app');
      if (isAppWorkspace(nestedApp)) {
        match = nestedApp;
        searching = false;
      } else {
        const parent = path.dirname(candidate);
        searching = parent !== candidate;
        candidate = parent;
      }
    }
  }
  return match;
};

/**
 * @param {[string | undefined, string, string | undefined]} candidates - Ordered workspace-root candidates.
 * @returns {{ APP_ENV_PATH: string, APP_WORKSPACE_ROOT: string }} The resolved workspace paths.
 */
const resolveWorkspaceEnvironmentSync = (candidates) => {
  const usableCandidates = candidates.flatMap((candidate) =>
    candidate !== undefined && candidate.length > 0 ? [candidate] : [],
  );
  const APP_WORKSPACE_ROOT =
    usableCandidates.map(resolveAppWorkspaceRootSync).find((candidate) => candidate !== undefined) ?? candidates[1];
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
  nodeProcess.cwd(),
  environmentValue('INIT_CWD'),
]);

module.exports = {
  APP_ENV_PATH: resolvedWorkspaceEnvironment.APP_ENV_PATH,
  APP_WORKSPACE_ROOT: resolvedWorkspaceEnvironment.APP_WORKSPACE_ROOT,
  resolveAppWorkspaceRootSync,
};
