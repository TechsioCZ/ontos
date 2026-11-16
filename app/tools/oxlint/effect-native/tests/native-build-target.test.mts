import { readFileSync } from 'node:fs';
import path from 'node:path';

import { appRoot, describeWorkspace, effectNativeRule, ruleTester } from './rule-tester.mts';
import type { WorkspaceEntry } from './rule-tester.mts';

const rules = ['no-ambient-process-env', 'no-hand-parsed-environment-value'];
const manifest = {
  dependencies: { '@modern-js/runtime': '*' },
  devDependencies: { '@modern-js/app-tools': '*' },
  scripts: { build: 'modern build --deploy-target node' },
};
const nativeConfig = "import { defineConfig } from '@modern-js/app-tools'; export default defineConfig({});";
const owner = 'apps/modern';
const valid = {
  browser: "if (process.env.MODERN_TARGET === 'browser') { void import('@module-federation/modern-js-v3/runtime'); }",
  conditional:
    "const runtime = process.env.MODERN_TARGET === 'browser' ? import('@module-federation/modern-js-v3/runtime') : null;",
  importMetaBrowser:
    "if (import.meta.env.MODERN_TARGET === 'browser') { void import('@module-federation/modern-js-v3/runtime'); }",
  importMetaConditional:
    "const runtime = import.meta.env.MODERN_TARGET === 'browser' ? import('@module-federation/modern-js-v3/runtime') : null;",
  importMetaNode: "if (import.meta.env.MODERN_TARGET === 'node') { console.log('server'); }",
  node: "if (process.env.MODERN_TARGET === 'node') { console.log('server'); }",
};
const invalid = {
  aliasedProcess: "const host = process; if (host.env.MODERN_TARGET === 'browser') {}",
  capturedComparison: "const browser = process.env.MODERN_TARGET === 'browser'; if (browser) {}",
  capturedEnvironment: "const environment = process.env; if (environment.MODERN_TARGET === 'browser') {}",
  capturedTarget: "const target = process.env.MODERN_TARGET; if (target === 'browser') {}",
  computedEnvironment: "if (process['env'].MODERN_TARGET === 'browser') {}",
  computedTarget: "if (process.env['MODERN_TARGET'] === 'browser') {}",
  counterfeitTarget: "if (process.env.MODERN_TARGET === 'server') {}",
  globalContainer: "if (globalThis.process.env.MODERN_TARGET === 'browser') {}",
  importedProcess: "import process from 'node:process'; if (process.env.MODERN_TARGET === 'browser') {}",
  importMetaCapturedEnvironment: "const environment = import.meta.env; if (environment.MODERN_TARGET === 'browser') {}",
  importMetaCapturedTarget: "const target = import.meta.env.MODERN_TARGET; if (target === 'browser') {}",
  importMetaComputedTarget: "if (import.meta.env['MODERN_TARGET'] === 'browser') {}",
  importMetaCounterfeitTarget: "if (import.meta.env.MODERN_TARGET === 'server') {}",
  importMetaOptional: "if (import.meta.env?.MODERN_TARGET === 'browser') {}",
  importMetaReversedComparison: "if ('browser' === import.meta.env.MODERN_TARGET) {}",
  importMetaRuntime: "if (import.meta.env.FEATURE === 'browser') {}",
  looseComparison: "if (process.env.MODERN_TARGET == 'browser') {}",
  mutableProcess: "process = other; if (process.env.MODERN_TARGET === 'browser') {}",
  optional: "if (process.env?.MODERN_TARGET === 'browser') {}",
  reversedComparison: "if ('browser' === process.env.MODERN_TARGET) {}",
  runtime: "if (process.env.FEATURE === 'browser') {}",
};
interface CompilerManifest {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly scripts: Readonly<Record<string, string>>;
}
const ownerFiles = (directory: string, compilerManifest: CompilerManifest, config: string): WorkspaceEntry[] => [
  { path: `${directory}/package.json`, source: JSON.stringify(compilerManifest) },
  { path: `${directory}/modern.config.ts`, source: config },
];
const counterfeitOwners = [
  ['missing-compiler', { dependencies: manifest.dependencies, scripts: manifest.scripts }, nativeConfig],
  ['runtime-build', { ...manifest, scripts: { build: 'node src/browser.tsx' } }, nativeConfig],
  ['comment-config', manifest, `/* ${nativeConfig} */ export default {};`],
  ['counterfeit-config', manifest, 'const defineConfig = (value) => value; export default defineConfig({});'],
  [
    'unused-native-config',
    manifest,
    "import { defineConfig } from '@modern-js/app-tools'; void defineConfig; export default {};",
  ],
] as const;
const currentPage = 'apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.tsx';
const currentShell = ['package.json', 'modern.config.ts', 'src/routes/[lang]/modules/[moduleId]/page.tsx'].map(
  (file) => ({
    path: `apps/shell-super-app/${file}`,
    source: readFileSync(path.join(appRoot, `apps/shell-super-app/${file}`), 'utf-8'),
  }),
);

const admitted: WorkspaceEntry[] = [
  ...Object.entries(valid).map(([name, source]) => ({ path: `${owner}/src/${name}.tsx`, source })),
  ...currentShell.filter((entry) => entry.path === currentPage),
];
const rejected: WorkspaceEntry[] = [
  ...Object.entries(invalid).map(([name, source]) => ({ path: `${owner}/src/${name}.tsx`, source })),
  { path: `${owner}/scripts/runtime.mts`, source: valid.browser },
  ...counterfeitOwners.map(([name]) => ({ path: `apps/${name}/src/browser.tsx`, source: valid.browser })),
];

// The rules read the owning package manifest and Modern configuration from disk.
describeWorkspace(
  'models only genuine Modern compiler target branches and retains runtime environment diagnostics',
  [
    ...ownerFiles(owner, manifest, nativeConfig),
    ...counterfeitOwners.flatMap(([name, compilerManifest, config]) =>
      ownerFiles(`apps/${name}`, compilerManifest, config),
    ),
    ...currentShell,
    ...admitted,
    ...rejected,
  ],
  (workspace) => {
    const toCase = ({ path: logicalPath, source }: WorkspaceEntry) => ({
      code: source ?? '',
      filename: workspace.file(logicalPath),
      name: logicalPath,
    });
    for (const rule of rules) {
      ruleTester.run(`effect-native/${rule}`, effectNativeRule(rule), {
        // Each rejected file reports exactly once under both rules.
        invalid: rejected.map((entry) => ({ ...toCase(entry), errors: 1 })),
        valid: admitted.map(toCase),
      });
    }
  },
);
