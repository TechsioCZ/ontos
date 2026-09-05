/* oxlint-disable typescript/consistent-return, typescript/no-unsafe-argument */
const { existsSync } = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');

const isAppWorkspace = (candidate) =>
  existsSync(path.join(candidate, 'pnpm-workspace.yaml')) &&
  existsSync(path.join(candidate, 'packages/core-runtime/package.json'));

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

const candidates = [
  process.env.ULTRAMODERN_WORKSPACE_ROOT,
  process.cwd(),
  process.env.INIT_CWD,
].filter((candidate) => candidate !== undefined && candidate.length > 0);
const APP_WORKSPACE_ROOT =
  candidates.map(resolveAppWorkspaceRootSync).find((candidate) => candidate !== undefined) ??
  process.cwd();

module.exports = {
  APP_ENV_PATH: path.join(APP_WORKSPACE_ROOT, '.env'),
  APP_WORKSPACE_ROOT,
  resolveAppWorkspaceRootSync,
};
