import { mkdirSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, runOxlint, testsDirectory } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const supportDirectory = 'tests/support';
const directRunMain = 'NodeRuntime.runMain(Effect.void);';
const lintConfig = nodePath.join(appRoot, 'oxlint.config.ts');

const ruleCode = 'anti-slop-effect(no-service-constructor-imports)';

it('recognizes only owner-local executable test process roots for service composition', () => {
  withTemporaryWorkspace((directory) => {
    const workspace = nodePath.join(directory, 'app');
    const runtimeFilename = 'runtime.ts';
    const cases = [
      { names: ['makeAuthDatabase', 'makeAuthenticationService', 'makeApiKeyService'], owner: 'apps/shell-super-app' },
      { names: ['makePrivacyApiRuntime'], owner: 'verticals/privacy' },
    ];
    for (const { names, owner } of cases) {
      const ownerRoot = nodePath.join(workspace, owner);
      const support = nodePath.join(ownerRoot, supportDirectory);
      const api = nodePath.join(ownerRoot, 'api');
      mkdirSync(support, { recursive: true });
      mkdirSync(api, { recursive: true });
      const factory = nodePath.join(api, runtimeFilename);
      writeFileSync(
        factory,
        names
          .map((name) => `export const ${name} = (dependency: { readonly read: () => string }) => dependency;`)
          .join('\n'),
      );
      const consumer = nodePath.join(support, 'privacy-completion.ts');
      const localImport = `import { ${names.join(', ')} } from '../../api/runtime.ts';`;
      const runtimeImport = "import { NodeRuntime } from '@effect/platform-node';";
      const constructors = names.map((name) => `${name}({ read: () => 'fixture' });`).join(' ');
      const run = directRunMain;
      const effectImport = "import { Effect } from 'effect';";
      const count = (path: string, source: string) => {
        writeFileSync(path, source);
        return runOxlint(lintConfig, [path], appRoot).diagnostics.filter(({ code }) => code === ruleCode).length;
      };
      expect(count(consumer, `${runtimeImport} ${effectImport} ${localImport} ${constructors} ${run}`)).toBe(0);
      expect(
        count(
          consumer,
          `import { NodeRuntime as Runtime } from '@effect/platform-node'; ${effectImport} ${localImport} ${constructors} Runtime.runMain(Effect.void);`,
        ),
      ).toBe(0);
      const invalidRoots = [
        `${effectImport} ${localImport} ${constructors}`,
        `${runtimeImport} ${effectImport} ${localImport} ${constructors} const start = () => { ${run} }; void start;`,
        `${effectImport} ${localImport} ${constructors} const NodeRuntime = { runMain: (value: unknown) => value }; ${run}`,
        `import { NodeRuntime } from 'foreign-runtime'; ${effectImport} ${localImport} ${constructors} ${run}`,
        `${runtimeImport} ${effectImport} ${localImport} ${constructors} NodeRuntime['runMain'](Effect.void);`,
        `${runtimeImport} ${effectImport} ${localImport} ${constructors} NodeRuntime.runMain = (value: unknown) => value; ${run}`,
        `${runtimeImport} ${effectImport} ${localImport} ${constructors} const alias = NodeRuntime; alias.runMain(Effect.void);`,
        `${runtimeImport} ${effectImport} ${localImport} ${constructors} export const helper = () => undefined; ${run}`,
        `${runtimeImport} ${effectImport} ${localImport} ${constructors} export default {}; ${run}`,
        `${runtimeImport} ${effectImport} ${localImport} ${constructors} export * from '../../api/runtime.ts'; ${run}`,
        `${effectImport} ${localImport} ${constructors} // NodeRuntime.runMain(Effect.void);`,
      ];
      for (const source of invalidRoots) {
        expect(count(consumer, source), source).toBe(names.length);
      }
      expect(
        count(
          factory,
          `${runtimeImport} ${effectImport} import { ${names.join(', ')} } from './service.ts'; ${constructors} ${run}`,
        ),
      ).toBe(names.length);
      // Restore the owner source after using its runtime path as the negative consumer.
      writeFileSync(
        factory,
        names
          .map((name) => `export const ${name} = (dependency: { readonly read: () => string }) => dependency;`)
          .join('\n'),
      );
      const foreign = nodePath.join(workspace, 'verticals/foreign-owner/api');
      mkdirSync(foreign, { recursive: true });
      writeFileSync(
        nodePath.join(foreign, runtimeFilename),
        names
          .map((name) => `export const ${name} = (dependency: { readonly read: () => string }) => dependency;`)
          .join('\n'),
      );
      const foreignImport = nodePath.relative(support, nodePath.join(foreign, runtimeFilename)).replaceAll('\\', '/');
      expect(
        count(
          consumer,
          `${runtimeImport} ${effectImport} import { ${names.join(', ')} } from '${foreignImport}'; ${constructors} ${run}`,
        ),
      ).toBe(names.length);
      const barrel = nodePath.join(api, 'barrel.ts');
      const foreignFromApi = nodePath.relative(api, nodePath.join(foreign, runtimeFilename)).replaceAll('\\', '/');
      writeFileSync(barrel, `export { ${names.join(', ')} } from '${foreignFromApi}';`);
      expect(
        count(
          consumer,
          `${runtimeImport} ${effectImport} import { ${names.join(', ')} } from '../../api/barrel.ts'; ${constructors} ${run}`,
        ),
      ).toBe(names.length);
    }
  }, testsDirectory);
});
