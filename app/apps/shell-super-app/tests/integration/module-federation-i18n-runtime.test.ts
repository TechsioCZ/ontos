import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { strict as assert } from 'node:assert';
import test from 'node:test';
import * as Schema from 'effect/Schema';

const shellConfigUrl = new URL('../../module-federation.config.ts', import.meta.url);
const projectsConfigUrl = new URL(
  '../../../../verticals/projects/module-federation.config.ts',
  import.meta.url,
);
const applicationPackageJsonUrls = new Set([
  new URL('../../package.json', import.meta.url).href,
  new URL('../../../../verticals/projects/package.json', import.meta.url).href,
]);

registerHooks({
  load(url, context, nextLoad) {
    if (!applicationPackageJsonUrls.has(url)) {
      return nextLoad(url, context);
    }

    const packageJson = readFileSync(new URL(url), 'utf-8');
    return {
      format: 'module',
      shortCircuit: true,
      source: `const packageJson = ${packageJson};\nexport const dependencies = packageJson.dependencies;\nexport default packageJson;`,
    };
  },
});

test('Shell and Projects share the i18n runtime that owns the federated provider context', async () => {
  const [{ default: shellConfig }, { default: projectsConfig }] = await Promise.all([
    import(shellConfigUrl.href),
    import(projectsConfigUrl.href),
  ]);
  const require = createRequire(shellConfigUrl);
  const { version: i18nVersion } = Schema.decodeUnknownSync(
    Schema.Struct({ version: Schema.String }),
  )(require('@modern-js/plugin-i18n/package.json'));
  const expectedSharedRuntime = {
    import: '@modern-js/plugin-i18n/runtime/no-react-i18next',
    requiredVersion: i18nVersion,
    singleton: true,
    strictVersion: true,
    treeShaking: false,
  };

  assert.deepEqual(shellConfig.shared?.['@modern-js/plugin-i18n/runtime'], expectedSharedRuntime);
  assert.deepEqual(
    projectsConfig.shared?.['@modern-js/plugin-i18n/runtime'],
    expectedSharedRuntime,
  );
});
