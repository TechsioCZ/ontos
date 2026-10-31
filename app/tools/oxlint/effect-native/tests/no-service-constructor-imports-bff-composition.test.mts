import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, runOxlint, testsDirectory } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const bootstrapFilename = 'bootstrap.ts';
const processImports = "import { NodeRuntime } from '@effect/platform-node'; import { Effect } from 'effect';";
const loaderAcquisition = 'const load = require; void load;';
const bffAssemblyReturn = 'return assembleEffectBffRuntime({ api: Api, handlers });';
const statusComparison = 'if (status === 403)';
const supportDirectory = 'tests/support';
const directRunMain = 'NodeRuntime.runMain(Effect.void);';
const lintConfig = nodePath.join(appRoot, 'oxlint.config.ts');

const ruleCode = 'anti-slop-effect(no-service-constructor-imports)';

interface BffCase {
  readonly consumer?: string;
  readonly expected: number;
  readonly extra?: string;
  readonly name: string;
  readonly replace?: readonly [string, string];
  readonly source?: string;
}

const bffFactorySource = [
  "import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';",
  "import { Layer } from '@modern-js/bff-effect/effect-edge';",
  "import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';",
  "import { Api } from '../shared/api.ts';",
  "const header = (headers: unknown, key: string) => headers[key]; header({}, 'x-correlation-id'); header({}, 'idempotency-key');",
  'const group = Layer.mergeAll();',
  'export const makeRuntime = (): EffectBffDefinition<typeof Api> & EffectBffRuntime<typeof Api> => {',
  'const handlers = Layer.mergeAll(group).pipe(Layer.provide(group), Layer.orDie);',
  bffAssemblyReturn,
  '};',
  'const runtime = makeRuntime(); void runtime;',
].join('\n');

const inspectBffCases = (cases: readonly BffCase[]): void => {
  withTemporaryWorkspace((directory) => {
    const files = cases.map((scenario) => {
      const owner = nodePath.join(directory, 'app/verticals', scenario.name);
      mkdirSync(nodePath.join(owner, 'api'), { recursive: true });
      mkdirSync(nodePath.join(owner, 'shared'), { recursive: true });
      mkdirSync(nodePath.join(owner, supportDirectory), { recursive: true });
      writeFileSync(nodePath.join(owner, 'shared/api.ts'), 'export const Api = {};');
      const baseline = scenario.source ?? bffFactorySource;
      const original = scenario.replace === undefined ? baseline : baseline.replace(...scenario.replace);
      writeFileSync(nodePath.join(owner, 'api/index.ts'), `${original}\n${scenario.extra ?? ''}`);
      const consumer = nodePath.join(owner, supportDirectory, bootstrapFilename);
      writeFileSync(
        consumer,
        scenario.consumer ??
          [processImports, "import { makeRuntime } from '../../api/index.ts'; void makeRuntime;", directRunMain].join(
            '\n',
          ),
      );
      return consumer;
    });
    const diagnostics = runOxlint(lintConfig, files, appRoot).diagnostics.filter(({ code }) => code === ruleCode);
    for (const scenario of cases) {
      expect(diagnostics.filter(({ filename }) => filename.includes(`/${scenario.name}/`)).length, scenario.name).toBe(
        scenario.expected,
      );
    }
  }, testsDirectory);
};

it('classifies only genuine immutable same-owner canonical BFF assembly factories', () => {
  inspectBffCases([
    { expected: 0, name: 'bff-canonical' },
    { expected: 1, extra: 'export const empty = Layer.empty; Layer.provide(empty);', name: 'bff-empty-layer-export' },
    {
      expected: 1,
      extra: "import * as Other from 'effect/Layer'; Other.mergeAll = replacement;",
      name: 'bff-layer-subpath-alias',
    },
    {
      expected: 1,
      extra: "import { Layer as Other } from '@modern-js/bff-effect/effect-server'; Other.mergeAll = replacement;",
      name: 'bff-layer-barrel-alias',
    },
    {
      consumer:
        "import { NodeRuntime } from '@effect/platform-node'; import { Effect } from 'effect'; import { makeRuntime, makeRawService } from '../../api/index.ts'; void makeRuntime; void makeRawService; NodeRuntime.runMain(Effect.void);",
      expected: 1,
      extra: 'export const makeRawService = () => group;',
      name: 'bff-raw-service-isolated',
    },

    {
      expected: 0,
      name: 'bff-empty-layer-value',
      replace: [
        'const group = Layer.mergeAll();',
        'const group = Layer.mergeAll(); const optionalLayer = enabled ? group : Layer.empty; Layer.provide(optionalLayer);',
      ],
    },
    { expected: 1, extra: 'Layer.empty();', name: 'bff-empty-layer-call' },
    { expected: 1, extra: 'const empty = Layer.empty; empty();', name: 'bff-empty-layer-alias-call' },
    { expected: 1, extra: 'Layer.empty = replacement;', name: 'bff-empty-layer-mutation' },
    {
      expected: 1,
      extra: "import { Api as Other } from '../shared/api.ts'; Other.changed = replacement;",
      name: 'bff-api-second-alias-mutation',
    },
    {
      expected: 1,
      extra: "import * as Other from '../shared/api.ts'; const api = Other.Api; void api;",
      name: 'bff-api-namespace-escape',
    },
    { expected: 1, extra: 'type EffectBffRuntime<T> = T;', name: 'bff-type-shadow' },
    { expected: 1, extra: 'consume(Api);', name: 'bff-api-escaped' },
    {
      expected: 1,
      name: 'bff-assembler-call-indirection',
      replace: ['return assembleEffectBffRuntime({', 'return assembleEffectBffRuntime.call(null, {'],
    },

    {
      expected: 0,
      name: 'bff-renamed-assembler',
      source: bffFactorySource
        .replace('{ assembleEffectBffRuntime }', '{ assembleEffectBffRuntime as assemble }')
        .replace('return assembleEffectBffRuntime(', 'return assemble('),
    },
    {
      expected: 1,
      name: 'bff-wrong-assembler-origin',
      replace: ["from '@modern-js/bff-effect/assembly'", "from 'foreign-assembly'"],
    },
    {
      expected: 1,
      name: 'bff-fake-type-origin',
      replace: [
        "import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge'",
        "import type { EffectBffDefinition, EffectBffRuntime } from 'foreign-types'",
      ],
    },
    { expected: 1, name: 'bff-fake-api', replace: ["import { Api } from '../shared/api.ts';", 'const Api = {};'] },
    { expected: 1, extra: 'const box = { assembleEffectBffRuntime }; void box;', name: 'bff-assembler-escape' },
    {
      expected: 1,
      extra:
        "import { assembleEffectBffRuntime as other } from '@modern-js/bff-effect/assembly'; other.value = replacement;",
      name: 'bff-second-assembler-mutation',
    },
    {
      expected: 1,
      extra: "import { default as other } from '@modern-js/bff-effect/assembly'; void other;",
      name: 'bff-second-assembler-default',
    },
    { expected: 1, extra: 'Layer.mergeAll = replacement;', name: 'bff-layer-mutated' },
    {
      expected: 1,
      name: 'bff-return-wrapped',
      replace: [bffAssemblyReturn, 'return wrap(assembleEffectBffRuntime({ api: Api, handlers }));'],
    },
    {
      expected: 1,
      name: 'bff-early-return',
      replace: [
        'const handlers = Layer.mergeAll(group)',
        'if (flag) return {}; const handlers = Layer.mergeAll(group)',
      ],
    },
    { expected: 1, name: 'bff-wrong-handler', replace: ['handlers });', 'handlers: {} });'] },
    {
      expected: 1,
      name: 'bff-dummy-call',
      replace: [bffAssemblyReturn, 'assembleEffectBffRuntime({ api: Api, handlers }); return group;'],
    },
    {
      consumer: "import { makeRuntime } from '../../api/index.ts'; void makeRuntime;",
      expected: 1,
      name: 'bff-runtime-consumer',
    },
    {
      consumer:
        "import { NodeRuntime } from '@effect/platform-node'; import { Effect } from 'effect'; import { makeRuntime } from '../../api/index.ts'; export const helper = makeRuntime; NodeRuntime.runMain(Effect.void);",
      expected: 1,
      name: 'bff-exported-support',
    },
    { expected: 1, extra: loaderAcquisition, name: 'bff-loader-after' },
    { expected: 1, extra: "const load = import('ordinary'); void load;", name: 'bff-import-after' },
    { expected: 1, name: 'bff-unknown-handler-pipe', replace: ['Layer.orDie);', 'Layer.unknown);'] },
  ]);
});

it('closes finite data keys over all immutable local helper callers before BFF classification', () => {
  inspectBffCases([
    { expected: 0, name: 'bff-key-positive' },
    { expected: 1, extra: 'export { header };', name: 'bff-key-export' },

    {
      expected: 0,
      extra: "const key1 = 'x-safe'; const key2 = key1; header({}, key2);",
      name: 'bff-key-literal-alias',
    },
    {
      expected: 1,
      extra: 'const later = () => header({}, unknownKey); void later;',
      name: 'bff-key-hidden-late-caller',
    },

    { expected: 1, extra: 'header({}, unknownKey);', name: 'bff-key-late-unknown-caller' },
    { expected: 1, extra: "header({}, 'constructor');", name: 'bff-key-reflective-caller' },
    { expected: 1, extra: 'const callback = header; void callback;', name: 'bff-key-callback-escape' },
    { expected: 1, extra: 'header(...arguments_);', name: 'bff-key-spread' },
    { expected: 1, extra: 'header({});', name: 'bff-key-omitted' },
    {
      expected: 1,
      name: 'bff-key-recursion',
      replace: ['=> headers[key]', "=> header(headers, 'safe') || headers[key]"],
    },
    { expected: 1, name: 'bff-key-default', replace: ['key: string)', "key: string = 'safe')"] },
    { expected: 1, extra: "header?.({}, 'safe');", name: 'bff-key-optional-caller' },
    { expected: 1, extra: "header.call(null, {}, 'safe');", name: 'bff-key-call-indirection' },
  ]);
});

it('closes strict scalar observations and rejects computed evaluator capabilities or result escapes', () => {
  const observe =
    'const policy = (map: unknown, key: string) => { const status = map[key]; if (status === 403) return 1; if (status === 409) return 2; if (status !== 422) return 3; return 4; };';
  const carrier =
    "const key = ['con', 'structor'].join(''); const carrier = () => {}; const evaluate = carrier[key]; evaluate('return globalThis')();";
  inspectBffCases([
    { expected: 0, extra: observe, name: 'bff-observation-positive' },
    {
      expected: 0,
      extra: observe.replace('const status = map[key];', 'const value = map[key]; const status = value;'),
      name: 'bff-observation-alias-positive',
    },
    {
      expected: 1,
      extra: observe.replace(statusComparison, 'new status(); if (status === 403)'),
      name: 'bff-observation-new',
    },
    {
      expected: 1,
      extra: observe.replace(statusComparison, 'const { value } = status; void value; if (status === 403)'),
      name: 'bff-observation-destructure',
    },
    {
      expected: 1,
      extra: observe.replace(statusComparison, 'const result = status ?? 0; void result; if (status === 403)'),
      name: 'bff-observation-nullish',
    },
    {
      expected: 1,
      extra: 'const status = input[key]; if (status === 403) consume(1); export { status };',
      name: 'bff-observation-export',
    },
    {
      expected: 1,
      extra: `const key = { toString() { ${carrier} } }; const status = input[key]; if (status === 403) consume(1);`,
      name: 'bff-key-coercion-hidden',
    },

    {
      expected: 1,
      extra: observe.replace(statusComparison, 'status(); if (status === 403)'),
      name: 'bff-observation-call',
    },
    {
      expected: 1,
      extra: observe.replace(statusComparison, 'const alias = status; alias(); if (status === 403)'),
      name: 'bff-observation-alias-call',
    },
    {
      expected: 1,
      extra: observe.replace(statusComparison, 'consume(status); if (status === 403)'),
      name: 'bff-observation-argument',
    },
    {
      expected: 1,
      extra: observe.replace(statusComparison, 'const box = { status }; void box; if (status === 403)'),
      name: 'bff-observation-container',
    },
    { expected: 1, extra: observe.replace('return 4;', 'return status;'), name: 'bff-observation-return' },
    { expected: 1, extra: observe.replace('status === 403', 'status == 403'), name: 'bff-observation-coercion' },
    {
      expected: 1,
      extra: observe.replace(statusComparison, 'status?.(); if (status === 403)'),
      name: 'bff-observation-optional-call',
    },
    {
      expected: 1,
      extra: observe.replace(statusComparison, 'status.value; if (status === 403)'),
      name: 'bff-observation-member',
    },
    {
      expected: 1,
      extra: observe.replace(statusComparison, 'status`code`; if (status === 403)'),
      name: 'bff-observation-template',
    },
    { expected: 1, extra: carrier, name: 'bff-computed-constructor' },
    { expected: 1, extra: `const hidden = () => { ${carrier} }; void hidden;`, name: 'bff-computed-callback' },
    {
      expected: 1,
      extra: "const key = ['con', 'structor'].join(''); const { [key]: evaluate } = () => {}; evaluate('code');",
      name: 'bff-computed-destructure',
    },
    {
      expected: 1,
      extra: 'const { constructor: evaluate } = () => {}; evaluate("code");',
      name: 'bff-static-destructure',
    },
    { expected: 1, extra: 'const value = input?.[key]; value();', name: 'bff-optional-computed' },
    { expected: 1, extra: `const object = { get value() { ${carrier} } }; void object;`, name: 'bff-getter-hidden' },
    {
      expected: 1,
      extra: `const object = new Proxy({}, { get() { ${carrier} } }); void object;`,
      name: 'bff-proxy-hidden',
    },
  ]);
});

it('proves the actual Shell API composition factory from current owner source without executing it', () => {
  withTemporaryWorkspace((directory) => {
    const owner = nodePath.join(directory, 'app/apps/shell-super-app');
    for (const file of ['api/index.ts', 'shared/api.ts', 'src/module-api/transport.ts']) {
      const target = nodePath.join(owner, file);
      mkdirSync(nodePath.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(nodePath.join(appRoot, 'apps/shell-super-app', file), 'utf-8'));
    }
    const consumer = nodePath.join(owner, supportDirectory, bootstrapFilename);
    mkdirSync(nodePath.dirname(consumer), { recursive: true });
    writeFileSync(
      consumer,
      [
        processImports,
        "import { makeShellAuthenticationApiRuntime } from '../../api/index.ts'; void makeShellAuthenticationApiRuntime;",
        directRunMain,
      ].join('\n'),
    );
    expect(runOxlint(lintConfig, [consumer], appRoot).diagnostics.filter(({ code }) => code === ruleCode)).toEqual([]);
  }, testsDirectory);
});

const finiteKeyParameterProbe = (body: string): string =>
  `const read = (object: unknown, key: string) => { ${body} }; const evaluate = read(() => {}, 'safe'); evaluate('return 1')();`;

it('requires closed immutable finite-key parameter references rather than literal callers alone', () => {
  inspectBffCases([
    {
      expected: 1,
      extra: finiteKeyParameterProbe('const { ...alias } = key; consume(alias); return object[key];'),
      name: 'bff-key-parameter-destructure-escape',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe('const alias = { ...key }; consume(alias); return object[key];'),
      name: 'bff-key-parameter-spread-escape',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe('const [alias] = [key]; consume(alias); return object[key];'),
      name: 'bff-key-parameter-array-escape',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe('const alias = () => key; consume(alias); return object[key];'),
      name: 'bff-key-parameter-closure-escape',
    },
    {
      expected: 0,
      extra: finiteKeyParameterProbe('const alias = key; return object[alias];'),
      name: 'bff-key-parameter-alias-positive',
    },
    {
      expected: 0,
      extra: finiteKeyParameterProbe(
        "const local = (key: string) => { key = 'constructor'; }; local('other'); return object[key];",
      ),
      name: 'bff-key-parameter-shadow-positive',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe("key = 'constructor'; return object[key];"),
      name: 'bff-key-parameter-assigned',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe("({ key } = { key: 'constructor' }); return object[key];"),
      name: 'bff-key-parameter-destructure-assigned',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe("key += 'constructor'; return object[key];"),
      name: 'bff-key-parameter-compound-assigned',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe("const mutate = () => { key = 'constructor'; }; mutate(); return object[key];"),
      name: 'bff-key-parameter-callback-assigned',
    },
    { expected: 1, extra: finiteKeyParameterProbe('key++; return object[key];'), name: 'bff-key-parameter-updated' },
    {
      expected: 1,
      extra: finiteKeyParameterProbe('for (key in { constructor: 1 }) {} return object[key];'),
      name: 'bff-key-parameter-for-in',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe("for (key of ['constructor']) {} return object[key];"),
      name: 'bff-key-parameter-for-of',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe("([...key] = ['constructor']); return object[key];"),
      name: 'bff-key-parameter-rest-assigned',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe('consume(key); return object[key];'),
      name: 'bff-key-parameter-argument-escape',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe('const box = { key }; consume(box); return object[key];'),
      name: 'bff-key-parameter-container-escape',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe('const alias = key; consume(alias); return object[key];'),
      name: 'bff-key-parameter-alias-escape',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe("const alias = key; ([alias] = ['constructor']); return object[alias];"),
      name: 'bff-key-parameter-alias-destructure',
    },
  ]);
});

it('recognizes the real legacy receiver process protocol without weakening owner provenance', () => {
  const consumer = (body: string) =>
    [
      processImports,
      "import { createInterface } from 'node:readline';",
      "import { makeRuntime } from '../../api/index.ts';",
      body,
      'makeRuntime();',
      directRunMain,
    ].join('\n');
  inspectBffCases([
    {
      consumer: consumer(
        "const input = createInterface({ input: process.stdin }); process.stdin.on('data', () => {}); process.stdin.destroy(new Error('bounded')); void input;",
      ),
      expected: 0,
      name: 'legacy-stdin-protocol',
    },
    {
      consumer: consumer('const input = channel; input[Symbol.asyncIterator]();'),
      expected: 0,
      name: 'legacy-async-iterator',
    },
    { consumer: consumer('Effect.catchCause(() => Effect.void);'), expected: 0, name: 'legacy-cause-recovery' },
    {
      consumer: consumer('const Symbol = source; channel[Symbol.asyncIterator]();'),
      expected: 1,
      name: 'legacy-symbol-shadow',
    },
    {
      consumer: consumer('Symbol.asyncIterator = replacement; channel[Symbol.asyncIterator]();'),
      expected: 1,
      name: 'legacy-symbol-mutation',
    },
    { consumer: consumer('channel[key]();'), expected: 1, name: 'legacy-unknown-protocol-key' },

    {
      consumer: consumer("Symbol = { asyncIterator: 'constructor' }; channel[Symbol.asyncIterator]();"),
      expected: 1,
      name: 'legacy-symbol-global-assignment',
    },
    {
      consumer: consumer('({ Symbol } = replacement); channel[Symbol.asyncIterator]();'),
      expected: 1,
      name: 'legacy-symbol-destructured-assignment',
    },
    {
      consumer: consumer('[Symbol] = replacement; channel[Symbol.asyncIterator]();'),
      expected: 1,
      name: 'legacy-symbol-array-assignment',
    },
    {
      consumer: consumer('for (Symbol of values) {} channel[Symbol.asyncIterator]();'),
      expected: 1,
      name: 'legacy-symbol-loop-assignment',
    },
    {
      consumer: consumer('const alias = Symbol; mutate(alias); channel[Symbol.asyncIterator]();'),
      expected: 1,
      name: 'legacy-symbol-alias-escape',
    },

    {
      consumer: consumer('const input = process.stdin; consume(input);'),
      expected: 1,
      name: 'legacy-stdin-alias-escape',
    },
    { consumer: consumer('process.stdin.constructor;'), expected: 1, name: 'legacy-stdin-reflection' },
    {
      consumer: consumer('const recover = Effect.catchCause; recover(program);'),
      expected: 1,
      name: 'legacy-cause-extraction',
    },
    { consumer: consumer('Effect.catchCause = replacement;'), expected: 1, name: 'legacy-cause-mutation' },
    {
      consumer: consumer(
        "import { createRequire } from 'node:module'; const input = createInterface({ input: process.stdin }); void input; void createRequire;",
      ),
      expected: 1,
      name: 'legacy-loader-with-protocol',
    },
    {
      consumer: consumer('const NodeRuntime = fake;').replace(
        'import { NodeRuntime }',
        'import { NodeRuntime as ActualRuntime }',
      ),
      expected: 1,
      name: 'legacy-fake-main',
    },
    {
      consumer: consumer('').replace('../../api/index.ts', '../../../foreign/api/index.ts'),
      expected: 1,
      name: 'legacy-foreign-owner',
    },
  ]);
});

it('closes NodeRuntime subpath capabilities in governed BFF origins', () => {
  inspectBffCases([
    { expected: 0, name: 'bff-subpath-unchanged-positive' },
    {
      expected: 1,
      extra:
        "import { runMain as launch } from '@effect/platform-node/NodeRuntime'; export const escapedRuntime = launch;",
      name: 'bff-subpath-runtime-escape',
    },
    {
      expected: 1,
      extra: "import { runMain as launch } from '@effect/platform-node/NodeRuntime'; const alias = launch; void alias;",
      name: 'bff-subpath-runtime-alias',
    },
    {
      expected: 1,
      extra: "import { runMain as launch } from '@effect/platform-node/NodeRuntime'; launch(Effect.void);",
      name: 'bff-subpath-runtime-call',
    },
  ]);
});
