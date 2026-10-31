import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, runOxlint, testsDirectory } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const privacyCompletionProcess = 'verticals/privacy/tests/support/privacy-completion-http.ts';
const processImports = "import { NodeRuntime } from '@effect/platform-node'; import { Effect } from 'effect';";
const loaderAcquisition = 'const load = require; void load;';
const factoryFilename = 'factory.ts';
const supportDirectory = 'tests/support';
const directRunMain = 'NodeRuntime.runMain(Effect.void);';
const lintConfig = nodePath.join(appRoot, 'oxlint.config.ts');

const ruleCode = 'anti-slop-effect(no-service-constructor-imports)';

interface ProcessCapabilityCase {
  readonly after?: string;
  readonly before?: string;
  readonly constructorName?: string;
  readonly declaration?: string;
  readonly expected: number;
  readonly name: string;
}

const inspectProcessCapabilityCases = (cases: readonly ProcessCapabilityCase[]): void => {
  withTemporaryWorkspace((directory) => {
    const files = cases.map((scenario, index) => {
      const constructorName = scenario.constructorName ?? 'makeService';
      const owner = nodePath.join(directory, 'app/verticals', `capability-${index}`);
      const api = nodePath.join(owner, 'api');
      const support = nodePath.join(owner, supportDirectory);
      mkdirSync(api, { recursive: true });
      mkdirSync(support, { recursive: true });
      writeFileSync(
        nodePath.join(api, factoryFilename),
        scenario.declaration ??
          "import { Effect } from 'effect'; export const makeService = Effect.fn('service')(function* (dependency: { readonly read: () => string }) { return dependency; });",
      );
      const file = nodePath.join(support, `${scenario.name}.ts`);
      writeFileSync(
        file,
        [
          processImports,
          `import { ${constructorName} } from '../../api/factory.ts'; void ${constructorName};`,
          scenario.before ?? '',
          directRunMain,
          scenario.after ?? '',
        ].join('\n'),
      );
      return file;
    });
    const diagnostics = runOxlint(lintConfig, files, appRoot).diagnostics.filter(({ code }) => code === ruleCode);
    for (const scenario of cases) {
      expect(
        diagnostics.filter(({ filename }) => filename.endsWith(`/${scenario.name}.ts`)).length,
        scenario.name,
      ).toBe(scenario.expected);
    }
  }, testsDirectory);
};

it('recognizes canonical Effect.result observation without permitting capability escape', () => {
  inspectProcessCapabilityCases([
    {
      before: "const outcome = Effect.fail('typed').pipe(Effect.result); void outcome;",
      expected: 0,
      name: 'result-pipe-direct',
    },
    {
      before: "import { Effect as E } from 'effect'; const outcome = E.fail('typed').pipe(E.result); void outcome;",
      expected: 0,
      name: 'result-pipe-renamed-import',
    },
    { before: 'consume(Effect.result);', expected: 1, name: 'result-argument-escape' },
    { before: 'program.pipe?.(Effect.result);', expected: 1, name: 'result-optional-pipe' },
    { before: "program['pipe'](Effect.result);", expected: 1, name: 'result-computed-pipe' },
    { before: 'program.pipe(...[Effect.result]);', expected: 1, name: 'result-spread-pipe' },
    { before: 'const observe = Effect.result; void observe;', expected: 1, name: 'result-extraction' },
    { before: "program.pipe(Effect['result']);", expected: 1, name: 'result-computed' },
    { before: 'program.pipe(Effect?.result);', expected: 1, name: 'result-optional' },
    { before: 'Effect.result = replacement;', expected: 1, name: 'result-write-before' },
    { after: 'Effect.result = replacement;', expected: 1, name: 'result-write-after' },
    { before: 'const alias = Effect; program.pipe(alias.result);', expected: 1, name: 'result-object-alias' },
  ]);
});

it('closes real executable HTTP observations without admitting evaluator or capability escape', () => {
  const fetchSource = "const fetch = globalThis.fetch; fetch('https://example.test');";
  const mapSource =
    "const choices = new Map([['/read', 'read']]); const operation = choices.get(path); const observed = { read: 'NONE' }; observed[operation] = 'SUCCESS';";
  inspectProcessCapabilityCases([
    {
      before:
        "Effect.all([Effect.void]); Effect.forEach([], () => Effect.void); Effect.tapErrorTag('Failure', () => Effect.void);",
      expected: 0,
      name: 'owner-effect-observers',
    },
    { before: 'const all = Effect.all; consume(all);', expected: 1, name: 'owner-effect-all-escape' },
    { before: 'Effect.tapErrorTag = replacement;', expected: 1, name: 'owner-effect-observer-mutation' },
    { before: fetchSource, expected: 0, name: 'owner-native-fetch' },
    ...[
      'consume(fetch);',
      'const alias = fetch; alias(url);',
      'fetch?.(url);',
      'fetch.constructor;',
      'globalThis.fetch = replacement;',
      'const global = globalThis; consume(global);',
      'globalThis[key](code);',
    ].map((after, index) => ({ after, before: fetchSource, expected: 1, name: `owner-fetch-unsafe-${index}` })),
    { before: 'const observed = input[key] !== other.value;', expected: 0, name: 'owner-strict-observation' },
    ...['input[key]();', 'consume(input[key]);', 'const observed = input[key] == other.value;'].map(
      (before, index) => ({ before, expected: 1, name: `owner-computed-unsafe-${index}` }),
    ),
    { before: mapSource, expected: 0, name: 'owner-finite-map-observation' },
    ...[
      "choices.set('/other', 'constructor');",
      'consume(choices);',
      'const alias = choices; alias.get(path);',
      'Map = replacement;',
    ].map((after, index) => ({ after, before: mapSource, expected: 1, name: `owner-map-unsafe-${index}` })),
    {
      before: mapSource.replace("'/read', 'read'", "'/read', 'constructor'"),
      expected: 1,
      name: 'owner-map-reflective-value',
    },
    {
      before: mapSource.replace("'/read', 'read'", "'/read', dynamicKey"),
      expected: 1,
      name: 'owner-map-dynamic-value',
    },
    { before: mapSource.replace('new Map(', 'new OtherMap('), expected: 1, name: 'owner-map-foreign-constructor' },
    {
      before: mapSource.replace('choices.get(path)', 'choices.get?.(path)'),
      expected: 1,
      name: 'owner-map-optional-lookup',
    },
    {
      before: mapSource.replace('choices.get(path)', "choices['get'](path)"),
      expected: 1,
      name: 'owner-map-computed-lookup',
    },
  ]);
});

it('permits only data-only native module-relative path metadata', () => {
  const pathSource = "const cwd = new URL('../../', import.meta.url).pathname;";
  inspectProcessCapabilityCases([
    { before: `${pathSource} URL.canParse(candidate);`, expected: 0, name: 'owner-module-path' },
    ...[
      'const meta = import.meta;',
      'const url = import.meta.url;',
      "import.meta.resolve('code');",
      pathSource.replace('import.meta.url', "import.meta['url']"),
      pathSource.replace("'../../'", 'dynamicPath'),
      pathSource.replace('new URL', 'new OtherURL'),
      pathSource.replace('.pathname', '.constructor'),
      `${pathSource} URL = replacement;`,
      `${pathSource} URL.canParse = replacement;`,
      `${pathSource} const parse = URL.canParse; parse(candidate);`,
      `const URL = replacement; ${pathSource}`,
      `${pathSource} const factory = URL; consume(factory);`,
    ].map((before, index) => ({ before, expected: 1, name: `owner-module-path-unsafe-${index}` })),
  ]);
});

it('classifies fixed non-enumerable local error causes without allowing reflection mutation', () => {
  const causeDescriptor = 'configurable: true, value: cause';
  const causeSource =
    "import { Failure } from './failure.ts'; export const makeService = (cause: unknown) => { const failure = new Failure({ reason: 'safe' }); Object.defineProperty(failure, 'cause', { configurable: true, value: cause }); return failure; };";
  inspectProcessCapabilityCases([
    { declaration: causeSource, expected: 0, name: 'owner-error-cause' },
    ...[
      ["'cause'", "'prototype'"],
      ["'cause'", "'constructor'"],
      ["'cause'", 'unknownKey'],
      [causeDescriptor, 'enumerable: true, value: cause'],
      [causeDescriptor, 'get: () => cause'],
      [causeDescriptor, '...descriptor'],
      ['const failure =', 'let failure ='],
      ['Object.defineProperty(failure,', 'Object.defineProperty(globalThis,'],
    ].map(([from, to], index) => ({
      declaration: causeSource.replace(from, to),
      expected: 1,
      name: `owner-error-cause-unsafe-${index}`,
    })),
  ]);
});

it('recognizes the real owner Party resolver constructor without executing its dependency', () => {
  inspectProcessCapabilityCases([
    {
      constructorName: 'makePartyRegistryRetailPartyResolver',
      declaration: readFileSync(
        nodePath.join(
          appRoot,
          'verticals/commerce-customer-context/src/integrations/party-registry-retail-party-resolver.ts',
        ),
        'utf-8',
      ),
      expected: 0,
      name: 'actual-owner-party-resolver',
    },
  ]);
});

it('closes canonical runtime object aliases and every unsupported reference before root eligibility', () => {
  inspectProcessCapabilityCases([
    { expected: 0, name: 'positive-floor' },
    {
      before:
        "import type * as P from '@effect/platform-node'; import type { NodeRuntime as R } from '@effect/platform-node/NodeRuntime';",
      expected: 0,
      name: 'type-only-equivalents',
    },
    {
      before: "import { NodeRuntime as Other } from '@effect/platform-node'; Other.runMain = replacement;",
      expected: 1,
      name: 'named-alias-mutation',
    },
    {
      before: "import * as P from '@effect/platform-node'; P['NodeRuntime'].runMain = replacement;",
      expected: 1,
      name: 'namespace-computed-slot',
    },
    {
      before: "import P from '@effect/platform-node'; P.NodeRuntime.runMain = replacement;",
      expected: 1,
      name: 'default-equivalent',
    },
    {
      before: "import { default as P } from '@effect/platform-node'; P.NodeRuntime.runMain = replacement;",
      expected: 1,
      name: 'named-default-equivalent',
    },
    {
      before: "import * as R from '@effect/platform-node/NodeRuntime'; R.runMain = replacement;",
      expected: 1,
      name: 'subpath-equivalent',
    },
    { before: 'const box = { runtime: NodeRuntime }; void box;', expected: 1, name: 'object-storage' },
    { before: 'const box = [NodeRuntime]; void box;', expected: 1, name: 'array-storage' },
    { before: 'const box = { ...NodeRuntime }; void box;', expected: 1, name: 'spread-storage' },
    { before: 'const box = flag ? NodeRuntime : {}; void box;', expected: 1, name: 'conditional-storage' },
    { before: 'const box = NodeRuntime || {}; void box;', expected: 1, name: 'logical-storage' },
    { before: 'const box = (0, NodeRuntime); void box;', expected: 1, name: 'sequence-storage' },
    { before: 'const load = () => NodeRuntime; void load;', expected: 1, name: 'closure-storage' },
    { before: 'mutate(NodeRuntime);', expected: 1, name: 'unknown-call' },
    { before: 'const start = NodeRuntime.runMain; void start;', expected: 1, name: 'method-extraction' },
    { before: 'NodeRuntime.runMain.call(null, Effect.void);', expected: 1, name: 'call-operation' },
    { before: 'const start = NodeRuntime.runMain.bind(null); void start;', expected: 1, name: 'bind-operation' },
    { before: 'NodeRuntime?.runMain(Effect.void);', expected: 1, name: 'optional-operation' },
    { after: 'NodeRuntime.runMain = replacement;', expected: 1, name: 'after-main-assignment' },
    { after: 'NodeRuntime.runMain++;', expected: 1, name: 'after-main-update' },
    { after: 'delete NodeRuntime.runMain;', expected: 1, name: 'after-main-delete' },
    { after: 'const box = (NodeRuntime as unknown); void box;', expected: 1, name: 'typescript-wrapper-escape' },
    {
      before: 'function local(NodeRuntime: { runMain: () => void }) { NodeRuntime.runMain(); } void local;',
      expected: 0,
      name: 'lexical-shadow-parameter',
    },
    {
      before: '{ const NodeRuntime = { runMain() {} }; NodeRuntime.runMain(); }',
      expected: 0,
      name: 'lexical-shadow-block',
    },
    { before: 'try {} catch (NodeRuntime) { void NodeRuntime; }', expected: 0, name: 'lexical-shadow-catch' },
    {
      before: 'function local({ NodeRuntime }: { NodeRuntime: unknown }) { void NodeRuntime; } void local;',
      expected: 0,
      name: 'lexical-shadow-destructure',
    },
  ]);
});

it('rejects loader and evaluator acquisition itself across import and free-reference forms', () => {
  inspectProcessCapabilityCases([
    { expected: 0, name: 'ordinary-positive' },
    {
      before: 'function local(input = require) { var require = () => undefined; return input; } void local;',
      expected: 1,
      name: 'unsupported-body-var-parameter-loader',
    },
    { before: 'var ordinary = 1; void ordinary;', expected: 1, name: 'unsupported-var-floor' },
    {
      before: 'function require(value: string) { return value; } require("ordinary");',
      expected: 0,
      name: 'local-require',
    },
    { before: 'const module = { name: "local" }; void module.name;', expected: 0, name: 'local-module' },
    {
      before: 'function local(globalThis: { name: string }) { return globalThis.name; } void local;',
      expected: 0,
      name: 'local-global-name',
    },
    {
      before:
        'import type { Module } from "node:module"; type Names = "require" | "eval"; const text = "globalThis.Function"; void text; // require module eval Function',
      expected: 0,
      name: 'type-comment-string',
    },
    {
      before:
        "const load = require; const Other = load('@effect/platform-node')['NodeRuntime']; Other.runMain = replacement;",
      expected: 1,
      name: 'global-require-alias',
    },
    {
      before:
        "import { createRequire as acquire } from 'node:module'; const load = acquire(import.meta.url); const Other = load('@effect/platform-node')['NodeRuntime']; Other.runMain = replacement;",
      expected: 1,
      name: 'renamed-loader-factory',
    },
    { before: loaderAcquisition, expected: 1, name: 'loader-unused-alias' },
    { after: loaderAcquisition, expected: 1, name: 'loader-acquired-after-main' },
    { before: 'const box = { load: require }; void box;', expected: 1, name: 'loader-container' },
    { before: 'const load = module?.require; void load;', expected: 1, name: 'loader-optional' },
    { before: "import modules from 'node:module'; void modules;", expected: 1, name: 'loader-default' },
    { before: "import { default as modules } from 'module'; void modules;", expected: 1, name: 'loader-named-default' },
    { before: "import * as modules from 'module'; void modules;", expected: 1, name: 'loader-namespace' },
    {
      before: "import { syncBuiltinESMExports as sync } from 'node:module'; void sync;",
      expected: 1,
      name: 'loader-sync-import',
    },
    { before: "import { runInThisContext as execute } from 'vm'; void execute;", expected: 1, name: 'vm-named' },
    { before: "import * as evaluator from 'node:vm'; void evaluator;", expected: 1, name: 'vm-namespace' },
    { before: "import evaluator from 'vm'; void evaluator;", expected: 1, name: 'vm-default' },
    { before: "const load = import('ordinary'); void load;", expected: 1, name: 'dynamic-import' },
    { before: "import load = require('ordinary'); void load;", expected: 1, name: 'import-equals' },
    { before: 'const load = import.meta.resolve; void load;', expected: 1, name: 'import-meta' },
    { before: 'const execute = (0, eval); void execute;', expected: 1, name: 'indirect-eval' },
    { before: 'const execute = Function; void execute;', expected: 1, name: 'function-alias' },
    { before: 'const execute = (eval as unknown); void execute;', expected: 1, name: 'typescript-evaluator-wrapper' },
    ...['globalThis', 'global', 'window', 'self', 'Reflect'].map((name) => ({
      before: `const box = { root: ${name} }; void box;`,
      expected: 1,
      name: `global-root-${name}`,
    })),
    { before: 'const execute = (() => {}).constructor; void execute;', expected: 1, name: 'constructor-acquisition' },
    { before: 'const execute = (() => {})?.constructor; void execute;', expected: 1, name: 'optional-constructor' },
    { before: 'const prototype = (() => {}).prototype; void prototype;', expected: 1, name: 'prototype-acquisition' },
    {
      before: 'const execute = (() => {})["con" + "structor"]; void execute;',
      expected: 1,
      name: 'computed-constructor',
    },
    { before: 'const acquire = Object.getPrototypeOf; void acquire;', expected: 1, name: 'reflective-intrinsic' },
    { before: 'const object = Object; void object;', expected: 1, name: 'intrinsic-object-escape' },
  ]);
});

it('limits canonical process capabilities to ordinary data and direct IO operations', () => {
  inspectProcessCapabilityCases([
    {
      before:
        'process.stdout.write("ready"); process.stderr.write("diagnostic"); const pid = process.pid; const environment = process.env.MODE; void pid; void environment; process.argv.includes("--describe");',
      expected: 0,
      name: 'global-process-ordinary',
    },
    { before: "import proc from 'node:process'; proc.stdout.write('ready');", expected: 0, name: 'process-default' },
    {
      before: "import { default as proc } from 'process'; proc.argv.includes('--describe');",
      expected: 0,
      name: 'process-default-as',
    },
    {
      before: "import * as proc from 'node:process'; const pid = proc.pid; void pid;",
      expected: 0,
      name: 'process-namespace',
    },
    { before: 'const proc = process; void proc;', expected: 1, name: 'raw-process-alias' },
    { before: 'const load = process.mainModule; void load;', expected: 1, name: 'process-main-module' },
    { before: 'const load = process.getBuiltinModule; void load;', expected: 1, name: 'process-builtin-loader' },
    {
      before: "import proc from 'node:process'; const load = proc.getBuiltinModule; void load;",
      expected: 1,
      name: 'process-default-loader',
    },
    {
      before: "import { default as proc } from 'process'; const load = proc.mainModule; void load;",
      expected: 1,
      name: 'process-default-as-loader',
    },
    {
      before: "import * as proc from 'process'; const load = proc.default; void load;",
      expected: 1,
      name: 'process-namespace-default',
    },
    {
      before: "import { getBuiltinModule as load } from 'node:process'; void load;",
      expected: 1,
      name: 'process-named-loader',
    },
    { before: 'const value = process.unknown; void value;', expected: 1, name: 'unknown-process-slot' },
    { before: 'const value = process[slot]; void value;', expected: 1, name: 'computed-process-slot' },
    { before: 'const write = process.stdout.write; void write;', expected: 1, name: 'process-method-extraction' },
    { before: 'const environment = process.env; void environment;', expected: 1, name: 'process-environment-escape' },
    { before: 'process.stdout.write = replacement;', expected: 1, name: 'process-io-mutation' },
  ]);
});

it('closes the full owner definition before proving direct or genuine Effect fn constructors', () => {
  const genuine =
    "import { Effect } from 'effect'; export const makeService = Effect.fn('service')(function* (dependency: { readonly read: () => string }) { return dependency; });";
  inspectProcessCapabilityCases([
    { declaration: genuine, expected: 0, name: 'genuine-definition' },
    {
      declaration: `${genuine} function local(input = require) { var require = () => undefined; return input; } void local;`,
      expected: 1,
      name: 'owner-body-var-parameter-loader',
    },
    {
      declaration: `${genuine} import { default as Other } from 'effect'; Other['Effect'].fn = replacement;`,
      expected: 1,
      name: 'owner-effect-named-default-mutation',
    },
    {
      declaration: `${genuine} export { type Module } from 'node:module';`,
      expected: 0,
      name: 'owner-type-only-loader-export',
    },
    {
      declaration: `${genuine} function local(Effect: { fn: unknown }) { return Effect.fn; } void local;`,
      expected: 0,
      name: 'owner-local-shadow',
    },
    {
      declaration: `${genuine} function require(value: string) { return value; } require('ordinary');`,
      expected: 0,
      name: 'owner-local-require',
    },
    { declaration: `${genuine} const load = require; void load;`, expected: 1, name: 'owner-loader-after-definition' },
    {
      declaration: `import { createRequire as load } from 'node:module'; ${genuine} void load;`,
      expected: 1,
      name: 'owner-loader-import',
    },
    {
      declaration: `${genuine} export { createRequire as load } from 'module';`,
      expected: 1,
      name: 'owner-loader-reexport',
    },
    {
      declaration: `${genuine} const module = import('ordinary'); void module;`,
      expected: 1,
      name: 'owner-dynamic-import',
    },
    {
      declaration:
        'const load = require; export const makeService = (dependency: { readonly read: () => string }) => dependency; void load;',
      expected: 1,
      name: 'owner-direct-arrow-loader',
    },
    {
      declaration: `${genuine} const box = { effect: Effect }; void box;`,
      expected: 1,
      name: 'owner-effect-object-container',
    },
    { declaration: `${genuine} const fn = Effect.fn; void fn;`, expected: 1, name: 'owner-effect-fn-extraction' },
    { declaration: `${genuine} Effect.unknown();`, expected: 1, name: 'owner-effect-unknown-member' },
    {
      declaration: `${genuine} Effect['fn']('other')(function* () {});`,
      expected: 1,
      name: 'owner-effect-computed-member',
    },
    {
      declaration: `${genuine} import { Effect as Other } from 'effect'; Other.fn = replacement;`,
      expected: 1,
      name: 'owner-effect-second-alias-mutation',
    },
    {
      declaration: `${genuine} import * as Library from 'effect'; Library['Effect'].fn = replacement;`,
      expected: 1,
      name: 'owner-effect-namespace-mutation',
    },
    {
      declaration: `${genuine} import * as Other from 'effect/Effect'; void Other;`,
      expected: 1,
      name: 'owner-effect-subpath',
    },
    { declaration: `${genuine} Effect.fn++;`, expected: 1, name: 'owner-effect-update-after-definition' },
    { declaration: `${genuine} delete Effect.fn;`, expected: 1, name: 'owner-effect-delete-after-definition' },
    {
      declaration: `${genuine} const root = (() => {}).constructor; void root;`,
      expected: 1,
      name: 'owner-prototype-acquisition',
    },
    {
      declaration:
        "import { makeService as foreign } from '../../../foreign/api/service.ts'; export const makeService = foreign;",
      expected: 1,
      name: 'owner-foreign-initializer',
    },
  ]);
});

it('keeps all three actual completion process children clear without source or filename exceptions', () => {
  const files = [
    'apps/shell-super-app/tests/support/privacy-completion-shell.ts',
    privacyCompletionProcess,
    'verticals/party-registry/tests/support/privacy-completion-worker.ts',
  ].map((file) => nodePath.join(appRoot, file));
  expect(runOxlint(lintConfig, files, appRoot).diagnostics.filter(({ code }) => code === ruleCode)).toEqual([]);
});

it('keeps direct pinned Effect try and catch operations inside the canonical closed-use grammar', () => {
  const syncProgram =
    "import { writeSync } from 'node:fs'; const program = Effect.try({ try: () => writeSync(3, 'private'), catch: () => new Error('unavailable') }).pipe(Effect.catch(() => Effect.void)); void program;";
  inspectProcessCapabilityCases([
    { before: syncProgram, expected: 0, name: 'direct-sync-fd-try-recovery-catch' },
    {
      before:
        "import { Effect as E } from 'effect'; const program = E.try({ try: () => 1, catch: () => new Error('unavailable') }).pipe(E.catch(() => E.void)); void program;",
      expected: 0,
      name: 'renamed-try-catch',
    },
    { before: 'const capture = Effect.try; void capture;', expected: 1, name: 'try-extraction' },
    { before: 'const recover = Effect.catch; void recover;', expected: 1, name: 'catch-extraction' },
    {
      before: "Effect['try']({ try: () => 1, catch: () => new Error('unavailable') });",
      expected: 1,
      name: 'computed-try',
    },
    { before: 'Effect.catch?.(() => Effect.void);', expected: 1, name: 'optional-catch' },
    { before: 'Effect.try.call(null, {});', expected: 1, name: 'try-call-indirection' },
    { after: 'Effect.try = replacement;', expected: 1, name: 'try-assignment-after-main' },
    { after: 'Effect.catch++;', expected: 1, name: 'catch-update-after-main' },
    { after: 'delete Effect.try;', expected: 1, name: 'try-delete-after-main' },
    {
      before: "import { Effect as E } from 'effect'; E.catch = replacement;",
      expected: 1,
      name: 'renamed-catch-mutation',
    },
    { before: 'const box = { effect: Effect }; void box;', expected: 1, name: 'try-catch-object-escape' },
    { before: 'Effect.unknownOperation();', expected: 1, name: 'unknown-operation-still-rejected' },
    {
      before: syncProgram,
      declaration:
        "import { Effect } from 'effect'; export const makeService = Effect.fn('service')(function* (dependency: { readonly read: () => string }) { return yield* Effect.try({ try: () => dependency, catch: () => new Error('unavailable') }).pipe(Effect.catch(() => Effect.succeed(dependency))); });",
      expected: 0,
      name: 'owner-definition-try-catch',
    },
  ]);
});

it('keeps direct canonical tapError and tapCause observation inside the closed process grammar', () => {
  const observe = 'const program = Effect.fail("typed").pipe(Effect.tapError(() => Effect.void)); void program;';
  const cases: readonly ProcessCapabilityCase[] = [
    { before: observe, expected: 0, name: 'tap-error-direct' },
    {
      before:
        "import { Effect as E } from 'effect'; const program = E.fail('typed').pipe(E.tapError(() => E.void)); void program;",
      expected: 0,
      name: 'tap-error-renamed-canonical',
    },
    {
      before: [
        "import { Context, Layer } from 'effect';",
        'const decorate = (actual: { readonly runAction: <A>(input: A) => A }, context: Context.Context<never>) => {',
        'const runAction: typeof actual.runAction = (input) => actual.runAction(input).pipe(Effect.tapError(() => Effect.void));',
        'return Layer.succeedContext(Context.add(context, Runtime, { ...actual, runAction })); }; void decorate;',
      ].join('\n'),
      expected: 0,
      name: 'tap-error-public-runtime-delegation',
    },
    { before: 'const observe = Effect.tapError; void observe;', expected: 1, name: 'tap-error-extraction' },
    { before: "Effect['tapError'](() => Effect.void);", expected: 1, name: 'tap-error-computed' },
    { before: 'Effect.tapError?.(() => Effect.void);', expected: 1, name: 'tap-error-optional-call' },
    { before: 'Effect?.tapError(() => Effect.void);', expected: 1, name: 'tap-error-optional-member' },
    { before: 'Effect.tapError.call(null, () => Effect.void);', expected: 1, name: 'tap-error-call-indirection' },
    { before: 'Effect.tapError.apply(null, []);', expected: 1, name: 'tap-error-apply-indirection' },
    { before: 'const alias = Effect; alias.tapError(() => Effect.void);', expected: 1, name: 'tap-error-object-alias' },
    { before: 'const box = { effect: Effect }; void box;', expected: 1, name: 'tap-error-object-escape' },
    { before: 'Effect.tapError = replacement;', expected: 1, name: 'tap-error-write-before' },
    { after: 'Effect.tapError = replacement;', expected: 1, name: 'tap-error-write-after' },
    { after: 'Effect.tapError++;', expected: 1, name: 'tap-error-update-after' },
    { after: 'delete Effect.tapError;', expected: 1, name: 'tap-error-delete-after' },
    {
      before: "import { Effect as E } from 'effect'; E.tapError = replacement;",
      expected: 1,
      name: 'tap-error-renamed-mutation',
    },
    { before: 'Effect.unknownOperation();', expected: 1, name: 'tap-error-unknown-operation' },
    {
      before: observe,
      declaration:
        "import { Effect } from 'foreign-effect'; export const makeService = Effect.fn('service')(function* (dependency: unknown) { return dependency; });",
      expected: 1,
      name: 'tap-error-foreign-effect-constructor',
    },
    {
      before: "import * as E from 'effect'; E.Effect.tapError(() => Effect.void);",
      expected: 1,
      name: 'tap-error-module-namespace',
    },
    {
      before: 'Effect.tapError(() => { const leaked = Effect; return leaked; });',
      expected: 1,
      name: 'tap-error-callback-capability-escape',
    },
    {
      before: "Effect.tapError(() => import('foreign-effect'));",
      expected: 1,
      name: 'tap-error-callback-dynamic-loader',
    },
    {
      before: "Effect.tapError(() => require('foreign-effect'));",
      expected: 1,
      name: 'tap-error-callback-require',
    },
    {
      before: "Effect.tapError(() => eval('unsafe'));",
      expected: 1,
      name: 'tap-error-callback-eval',
    },
    {
      before: 'Effect.tapError(() => Object.getPrototypeOf(Effect));',
      expected: 1,
      name: 'tap-error-callback-reflection',
    },
    {
      before: observe,
      declaration:
        "import { makeForeign } from '../../foreign-owner/api/factory.ts'; export { makeForeign as makeService };",
      expected: 1,
      name: 'tap-error-foreign-owner-reexport',
    },
    {
      before: 'Effect.tapError(() => Effect.unknownOperation());',
      expected: 1,
      name: 'tap-error-opaque-callback',
    },
    {
      before: 'Effect.tapErrorCause(() => Effect.void);',
      expected: 1,
      name: 'tap-error-cause-nonexistent-operation',
    },
  ];
  inspectProcessCapabilityCases(
    cases.flatMap((scenario) => {
      const paired = { ...scenario, name: scenario.name.replace('tap-error', 'tap-cause') };
      if (scenario.after !== undefined) {
        paired.after = scenario.after.replaceAll('tapError', 'tapCause');
      }
      if (scenario.before !== undefined) {
        paired.before = scenario.before.replaceAll('tapError', 'tapCause');
      }
      if (scenario.declaration !== undefined) {
        paired.declaration = scenario.declaration.replaceAll('tapError', 'tapCause');
      }
      return [scenario, paired];
    }),
  );
});

it('keeps the actual typed-error Privacy process floor clear without source exceptions', () => {
  const file = nodePath.join(appRoot, privacyCompletionProcess);
  expect(runOxlint(lintConfig, [file], appRoot).diagnostics.filter(({ code }) => code === ruleCode)).toEqual([]);
});
