import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, pluginDirectory, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const rules = ['no-ambient-process-env', 'no-hand-parsed-environment-value'];
const manifest = {
  dependencies: { '@modern-js/runtime': '*' },
  devDependencies: { '@modern-js/app-tools': '*' },
  scripts: { build: 'modern build --deploy-target node' },
};
const nativeConfig = "import { defineConfig } from '@modern-js/app-tools'; export default defineConfig({});";
const write = (directory: string, filename: string, source: string): void => {
  const full = path.join(directory, filename);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, source);
};

it('models only genuine Modern compiler target branches and retains runtime environment diagnostics', () => {
  withTemporaryWorkspace((directory) => {
    const owner = 'apps/modern';
    write(directory, `${owner}/package.json`, JSON.stringify(manifest));
    write(directory, `${owner}/modern.config.ts`, nativeConfig);
    const valid = {
      browser:
        "if (process.env.MODERN_TARGET === 'browser') { void import('@module-federation/modern-js-v3/runtime'); }",
      conditional:
        "const runtime = process.env.MODERN_TARGET === 'browser' ? import('@module-federation/modern-js-v3/runtime') : null;",
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
      looseComparison: "if (process.env.MODERN_TARGET == 'browser') {}",
      mutableProcess: "process = other; if (process.env.MODERN_TARGET === 'browser') {}",
      optional: "if (process.env?.MODERN_TARGET === 'browser') {}",
      reversedComparison: "if ('browser' === process.env.MODERN_TARGET) {}",
      runtime: "if (process.env.FEATURE === 'browser') {}",
    };
    const validFiles = Object.entries(valid).map(([name, source]) => {
      const file = `${owner}/src/${name}.tsx`;
      write(directory, file, source);
      return file;
    });
    const invalidFiles = Object.entries(invalid).map(([name, source]) => {
      const file = `${owner}/src/${name}.tsx`;
      write(directory, file, source);
      return file;
    });
    const runtimeScript = `${owner}/scripts/runtime.mts`;
    write(directory, runtimeScript, valid.browser);
    invalidFiles.push(runtimeScript);
    for (const [name, compilerManifest, config] of [
      ['missing-compiler', { dependencies: manifest.dependencies, scripts: manifest.scripts }, nativeConfig],
      ['runtime-build', { ...manifest, scripts: { build: 'node src/browser.tsx' } }, nativeConfig],
      ['comment-config', manifest, `/* ${nativeConfig} */ export default {};`],
      ['counterfeit-config', manifest, 'const defineConfig = (value) => value; export default defineConfig({});'],
      [
        'unused-native-config',
        manifest,
        "import { defineConfig } from '@modern-js/app-tools'; void defineConfig; export default {};",
      ],
    ] as const) {
      const file = `apps/${name}/src/browser.tsx`;
      write(directory, `apps/${name}/package.json`, JSON.stringify(compilerManifest));
      write(directory, `apps/${name}/modern.config.ts`, config);
      write(directory, file, valid.browser);
      invalidFiles.push(file);
    }
    const currentPage = 'apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.tsx';
    for (const file of ['package.json', 'modern.config.ts', 'src/routes/[lang]/modules/[moduleId]/page.tsx']) {
      write(
        directory,
        `apps/shell-super-app/${file}`,
        readFileSync(path.join(appRoot, `apps/shell-super-app/${file}`), 'utf-8'),
      );
    }
    for (const rule of rules) {
      const configuration = path.join(directory, `${rule}.json`);
      writeFileSync(
        configuration,
        JSON.stringify({
          categories: { correctness: 'off' },
          jsPlugins: [{ name: 'effect-native', specifier: path.join(pluginDirectory, 'tests/fixture-plugin.ts') }],
          rules: { [`effect-native/${rule}`]: 'error' },
        }),
      );
      const run = runOxlint(configuration, [...validFiles, ...invalidFiles, currentPage], directory, rule);
      expect(run.exitCode).toBe(1);
      expect(run.numberOfFiles).toBe(validFiles.length + invalidFiles.length + 1);
      expect(run.diagnostics.every((diagnostic) => diagnostic.code === `effect-native(${rule})`)).toBe(true);
      const reported = new Set(run.diagnostics.map((diagnostic) => diagnostic.filename));
      for (const file of [...validFiles, currentPage]) {
        expect(reported.has(file), `${rule} must admit ${file}`).toBe(false);
      }
      for (const file of invalidFiles) {
        expect(reported.has(file), `${rule} must reject ${file}`).toBe(true);
      }
    }
  });
});
