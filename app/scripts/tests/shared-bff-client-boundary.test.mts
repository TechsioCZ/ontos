import { checkMicroVerticalApiConsumerFiles } from '@modern-js/code-tools/microvertical-api-boundary';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { hasGeneratedActionClientPublication } from '../generated-governed-http-boundary.mts';

it('accepts named Action exports but rejects incomplete and foreign publication', () => {
  const slug = 'create-dsr-case';
  const source = `// <generated-action-http-client-exports>
export { executeCreateDsrCaseWithAuthorization, executeCreateDsrCase } from './create-dsr-case-action-client.ts';
// </generated-action-http-client-exports>`;
  expect(hasGeneratedActionClientPublication(source, slug)).toBe(true);
  expect(hasGeneratedActionClientPublication(source.replace('executeCreateDsrCaseWithAuthorization, ', ''), slug)).toBe(
    false,
  );
  expect(
    hasGeneratedActionClientPublication(
      source.replace('./create-dsr-case-action-client.ts', './foreign-action-client.ts'),
      slug,
    ),
  ).toBe(false);
});

it.live(
  'accepts the native factory with shared OntOS options only for the owning API contract',
  Effect.fn(function* sharedFactoryOwnership() {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), 'ontos-shared-bff-check-'))),
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    );
    const clientFile = 'verticals/demo/src/api/demo-client.ts';
    const files = {
      'package.json': JSON.stringify({ dependencies: { '@modern-js/ultramodern-create': '3.9.0-ultramodern.28' } }),
      'packages/shared-contracts/package.json': JSON.stringify({
        exports: { './client-runtime': './src/client-runtime.ts' },
        name: '@app/shared-contracts',
      }),
      'packages/shared-contracts/src/client-runtime.ts':
        'export const makeEffectBffClientOptions = (options) => options;\nexport const makeEffectBffClient = (options) => options;\n',
      'verticals/demo/api/index.ts': 'export default {};\n',
      'verticals/demo/package.json': JSON.stringify({
        exports: { './api': './shared/api.ts', './api/client': './src/api/demo-client.ts' },
        name: '@app/demo',
      }),
      'verticals/demo/shared/api.ts': `import { HttpApi } from '@modern-js/bff-effect/effect-client';
export const demoApi = HttpApi.make('demo');\n`,
      'verticals/demo/shared/foreign.ts': `import { HttpApi } from '@modern-js/bff-effect/effect-client';
export const foreignApi = HttpApi.make('foreign');\n`,
    };
    yield* Effect.promise(() =>
      Promise.all(
        Object.entries(files).map(async ([file, content]) => {
          await mkdir(path.dirname(path.join(root, file)), { recursive: true });
          await writeFile(path.join(root, file), content);
        }),
      ),
    );
    yield* Effect.promise(() => mkdir(path.dirname(path.join(root, clientFile)), { recursive: true }));
    const valid = `import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { makeEffectBffClientOptions } from '@app/shared-contracts/client-runtime';
import { demoApi } from '../../shared/api.ts';
export const client = makeEffectBffClientOptions({ defaultApiPrefix: '/demo-api' }).pipe(
  Effect.flatMap((options) => makeEffectHttpApiClient(demoApi, options)),
);\n`;
    const check = Effect.fn(function* checkSource(source: string) {
      yield* Effect.promise(() => writeFile(path.join(root, clientFile), source));
      return checkMicroVerticalApiConsumerFiles({
        baselinePackageDirectory: path.resolve(import.meta.dirname, '../../node_modules/@modern-js/ultramodern-create'),
        configuredApps: [{ api: { stem: 'demo' }, id: 'demo', kind: 'vertical', path: 'verticals/demo' }],
        workspaceRoot: root,
      });
    });
    const accepted = yield* check(valid);
    expect(accepted.toolErrors).toEqual([]);
    expect(accepted.diagnostics.filter((message) => message.startsWith(`${clientFile}:`))).toEqual([]);
    const foreign = yield* check(
      valid
        .replace('makeEffectHttpApiClient(demoApi', 'makeEffectHttpApiClient(foreignApi')
        .replace(
          "import { demoApi } from '../../shared/api.ts';",
          "import { demoApi } from '../../shared/api.ts';\nimport { foreignApi } from '../../shared/foreign.ts';",
        ),
    );
    expect(foreign.toolErrors).toEqual([]);
    expect(foreign.diagnostics).toContain(`${clientFile}: must construct the client from its own API contract`);
    // A wrapper factory around the native one is not proven, even with the owning contract (ultramodern.js#240).
    const wrapped = yield* check(`import { Effect } from '@modern-js/bff-effect/effect-client';
import { makeEffectBffClient } from '@app/shared-contracts/client-runtime';
import { demoApi } from '../../shared/api.ts';
export const client = makeEffectBffClient({ api: demoApi, defaultApiPrefix: '/demo-api' });\n`);
    expect(wrapped.diagnostics).toEqual(
      expect.arrayContaining([
        `${clientFile}: must import makeEffectHttpApiClient from @modern-js/bff-effect/effect-client`,
        `${clientFile}: must call makeEffectHttpApiClient(...)`,
      ]),
    );
  }, Effect.scoped),
);
