import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, fixtureConfigPath, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const ruleName = 'require-timeout-on-external-effect';
const ruleCode = `effect-native(${ruleName})`;
const serverFolder = 'apps/demo/api';
const localServerImport = "import('./server-factory.ts')";
const batch = "Promise.all([import('@modelcontextprotocol/server'), import('./server-factory.ts')])";
const source = `import { Effect } from 'effect';
export const load = Effect.promise(() => ${batch});
`;

it('recognizes only native static server import batches and preserves external-operation timeout checks', () => {
  withTemporaryWorkspace((directory) => {
    const production = readFileSync(path.join(appRoot, 'apps/shell-super-app/api/mcp/http.ts'), 'utf-8');
    const cases = [
      { count: 0, folder: 'apps/demo/api/mcp', name: 'production', source: production },
      { count: 0, folder: 'apps/demo/api/mcp', name: 'native', source },
      {
        count: 0,
        folder: serverFolder,
        name: 'native-constant',
        source: source
          .replace('{ Effect }', '{ Effect, Function as Fn }')
          .replace(`() => ${batch}`, `Fn.constant(${batch})`),
      },
      {
        count: 1,
        folder: serverFolder,
        name: 'foreign-constant',
        source: source.replace(`() => ${batch}`, `fakeConstant(${batch})`),
      },
      { count: 1, folder: 'apps/demo/src', name: 'browser', source },
      { count: 1, folder: 'apps/demo/src/api', name: 'browser-api-folder', source },
      {
        count: 1,
        folder: serverFolder,
        name: 'mixed-fetch',
        source: source.replace(localServerImport, "fetch('/network')"),
      },
      {
        count: 1,
        folder: serverFolder,
        name: 'dynamic-import',
        source: source.replace(localServerImport, 'import(moduleName)'),
      },
      {
        count: 1,
        folder: serverFolder,
        name: 'remote-import',
        source: source.replace(localServerImport, "import('https://example.test/module.js')"),
      },
      {
        count: 1,
        folder: serverFolder,
        name: 'data-import',
        source: source.replace(localServerImport, "import('data:text/javascript,export default 1')"),
      },
      { count: 1, folder: serverFolder, name: 'shadowed-promise', source: `const Promise = fake;\n${source}` },
      { count: 1, folder: serverFolder, name: 'mutated-promise', source: `${source}\nPromise.all = fake;` },
      { count: 1, folder: serverFolder, name: 'escaped-promise', source: `${source}\nopaque(Promise);` },
      { count: 1, folder: serverFolder, name: 'aliased-promise', source: `${source}\nconst P = Promise;` },
      {
        count: 1,
        folder: serverFolder,
        name: 'array-spread',
        source: source.replace(batch, 'Promise.all([...modules])'),
      },
      {
        count: 1,
        folder: serverFolder,
        name: 'extra-thunk-work',
        source: source.replace(`() => ${batch}`, `() => { fetch('/network'); return ${batch}; }`),
      },
      {
        count: 1,
        folder: serverFolder,
        name: 'fetch-unbounded',
        source: `${source}\nexport const request = Effect.promise(() => fetch('/network'));`,
      },
    ];
    const files = cases.map((entry) => {
      const owner = path.join(directory, entry.folder, entry.name);
      mkdirSync(owner, { recursive: true });
      const filename = path.join(owner, 'loader.ts');
      writeFileSync(filename, entry.source);
      return filename;
    });
    const result = runOxlint(fixtureConfigPath(ruleName), files, appRoot);
    expect(result.numberOfFiles).toBe(cases.length);
    expect(result.diagnostics.filter(({ code }) => code !== ruleCode)).toEqual([]);
    for (const [index, entry] of cases.entries()) {
      const diagnostics = result.diagnostics.filter(({ filename }) => path.resolve(appRoot, filename) === files[index]);
      expect(diagnostics, `${entry.name}: ${JSON.stringify(diagnostics)}`).toHaveLength(entry.count);
    }
  });
});
