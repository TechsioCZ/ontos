import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { describe, expect, it } from 'effect-rstest';
import { Effect } from 'effect';
import * as Schema from 'effect/Schema';

const shellConfigUrl = new URL('../../module-federation.config.ts', import.meta.url);
const partyRegistryConfigUrl = new URL(
  '../../../../verticals/party-registry/module-federation.config.ts',
  import.meta.url,
);
const applicationPackageJsonUrls = new Set([
  new URL('../../package.json', import.meta.url).href,
  new URL('../../../../verticals/party-registry/package.json', import.meta.url).href,
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

describe('module-federation-i18n-runtime', () => {
  it.effect(
    'Shell and Party Registry share the i18n runtime that owns the federated provider context',
    () =>
      Effect.gen(function* sharesFederatedI18nRuntime() {
        const [{ default: shellConfig }, { default: partyRegistryConfig }] = yield* Effect.promise(
          () => Promise.all([import(shellConfigUrl.href), import(partyRegistryConfigUrl.href)]),
        );
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

        expect(shellConfig.shared?.['@modern-js/plugin-i18n/runtime']).toEqual(
          expectedSharedRuntime,
        );
        expect(partyRegistryConfig.shared?.['@modern-js/plugin-i18n/runtime']).toEqual(
          expectedSharedRuntime,
        );
      }),
  );
});
