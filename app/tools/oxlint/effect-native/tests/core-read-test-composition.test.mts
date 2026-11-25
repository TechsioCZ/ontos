import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import nodePath from 'node:path';

import { describe } from 'effect-rstest';

import {
  appRoot,
  collectCases,
  effectNativeRule,
  fixtureOptions,
  ruleTester,
  virtualFile,
  withOptions,
} from './rule-tester.mts';

const provideRule = 'no-effect-provide-in-library';
const rules = ['no-wide-factory-signature', provideRule, 'no-layer-provide-in-library'];
const at = (logicalPath: string) => ({ filename: virtualFile(logicalPath) });
const harnessPath = 'packages/core-runtime/src/testing/reads.ts';
const source = `import { Effect as Fx, Layer } from 'effect';
import { makeReadRuntime as makeRuntime } from '../reads/runtime.ts';
import { scriptedPgClientLayer as makeDriver } from './scripted-pg-client.ts';
interface ReadHarnessOptions { execute: (sql: string) => Fx.Effect<readonly object[]>; }
export const makeReadTestHarness = Fx.fn('ReadTestHarness.make')(function* makeReadTestHarness(options: ReadHarnessOptions) {
  const database = yield* Layer.build(makeDriver(options.execute).pipe(Layer.provide(dependency)));
  yield* Fx.void.pipe(Fx.provideService(service, database));
  const runtime = makeRuntime(database);
  return runtime;
});
`;
const businessHelper = `
export const makeBusiness = (options: ReadHarnessOptions) => Fx.succeed(options).pipe(
  Fx.provideService(service, dependency),
  Fx.as(Layer.succeed(service, options).pipe(Layer.provide(dependency))),
);
`;

for (const rule of rules) {
  describe(`effect-native/${rule} recognizes only the sanctioned Core Read test composition callback`, () => {
    const { accept, register, reject } = collectCases(effectNativeRule(rule), `effect-native/${rule}`, {
      ...withOptions(fixtureOptions(rule)),
    });
    accept(source, at(harnessPath));
    reject(1, source + businessHelper, at(harnessPath));
    reject(1, source.replace('export const makeReadTestHarness', 'const makeReadTestHarness'), at(harnessPath));
    reject(1, source.replace("'./scripted-pg-client.ts'", "'./lookalike-driver.ts'"), at(harnessPath));
    reject(1, source, at('packages/core-runtime/src/testing/business.ts'));
    reject(
      1,
      source.replace(
        'const runtime = makeRuntime(database);',
        'const makeRuntime = () => ({}); const runtime = makeRuntime(database);',
      ),
      at(harnessPath),
    );
    reject(1, source, at('verticals/inventory/src/testing/reads.ts'));
    register();
  });
}

describe('recognizes only the genuine NodeRuntime outer process supply seam', () => {
  const original = `import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
const main = Effect.void;
NodeRuntime.runMain(main.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer))));`;
  const runtimeCall = 'NodeRuntime.runMain';
  const emptyMain = 'const main = Effect.void;';
  const cases = [
    { expected: 0, name: 'node-main', source: original },
    {
      expected: 0,
      name: 'node-main-decoded-independent-artifact',
      source: original
        .replace(
          "import { Effect, Layer } from 'effect';",
          "import { Effect, Layer, Schema } from 'effect'; import { pathToFileURL } from 'node:url';",
        )
        .replace(
          emptyMain,
          'const main = Effect.scoped(Effect.gen(function* () { const owner = yield* Effect.tryPromise({ catch: unavailable, try: async () => await Schema.decodeUnknownPromise(ownerSchema)(await import(pathToFileURL(artifact).href)) }); return owner; }));',
        ),
    },
    {
      expected: 1,
      name: 'node-main-dynamic-runtime-provider',
      source: `${original} const injected = await import('@effect/platform-node'); injected.NodeRuntime.runMain = replacement;`,
    },
    {
      expected: 1,
      name: 'node-main-undecoded-artifact',
      source: original.replace(
        emptyMain,
        'const main = Effect.tryPromise({ try: async () => await import(artifact), catch: unavailable });',
      ),
    },
    {
      expected: 1,
      name: 'node-main-forged-artifact-loader',
      source: original
        .replace(
          "import { Effect, Layer } from 'effect';",
          "import { Effect, Layer, Schema } from 'effect'; import { pathToFileURL } from './forged-url.ts';",
        )
        .replace(
          emptyMain,
          'const main = Effect.scoped(Effect.gen(function* () { return yield* Effect.tryPromise({ catch: unavailable, try: async () => await Schema.decodeUnknownPromise(ownerSchema)(await import(pathToFileURL(artifact).href)) }); }));',
        ),
    },

    {
      expected: 0,
      name: 'node-main-renamed',
      source: original
        .replaceAll('NodeRuntime', 'Runtime')
        .replace('import { Runtime,', 'import { NodeRuntime as Runtime,'),
    },
    {
      expected: 1,
      name: 'node-main-shadow',
      source: original
        .replace('import { NodeRuntime,', 'import { NodeRuntime as ActualRuntime,')
        .replace(runtimeCall, 'const NodeRuntime = fake; NodeRuntime.runMain'),
    },
    {
      expected: 1,
      name: 'node-main-alias',
      source: original.replace(runtimeCall, 'const start = NodeRuntime.runMain; start'),
    },
    {
      expected: 1,
      name: 'node-main-mutation',
      source: original.replace('const main', 'NodeRuntime.runMain = replacement; const main'),
    },
    {
      expected: 1,
      name: 'node-main-fake-module',
      source: original.replace('@effect/platform-node', './fake-runtime.ts'),
    },
    {
      expected: 1,
      name: 'node-main-exported-and-called',
      source: original
        .replace('NodeRuntime.runMain', 'export function start() { NodeRuntime.runMain')
        .replace('));', ')); } start();'),
    },
    {
      expected: 1,
      name: 'node-main-nested',
      source: original.replace(runtimeCall, 'export const start = () => NodeRuntime.runMain'),
    },
    {
      expected: 1,
      name: 'node-main-hidden-supply',
      source: original.replace(
        'main.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer)))',
        'Effect.succeed(main.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer))))',
      ),
    },
    {
      expected: 1,
      name: 'node-main-optional',
      source: original.replace('NodeRuntime.runMain(', 'NodeRuntime.runMain?.('),
    },
    {
      expected: 1,
      name: 'node-main-second-platform-alias',
      source: original.replace(
        'import { Effect',
        "import * as Platform from '@effect/platform-node'; Platform.NodeRuntime.runMain = replacement; import { Effect",
      ),
    },
  ];
  const { accept, register, reject } = collectCases(
    effectNativeRule(provideRule),
    `effect-native/${provideRule}`,
    withOptions(fixtureOptions(provideRule)),
  );
  for (const scenario of cases) {
    const overrides = { filename: virtualFile(`scripts/${scenario.name}.mts`), name: scenario.name };
    if (scenario.expected === 0) {
      accept(scenario.source, overrides);
    } else {
      reject(scenario.expected, scenario.source, overrides);
    }
  }
  register();
});

const productOwnerChild = nodePath.join(appRoot, 'scripts/integration/support/symmy-c14-product-owner-child.mts');
const customerAuthority = nodePath.join(appRoot, 'scripts/demo/symmy-demo-customer-authority.mts');
ruleTester.run('recognizes the actual independently loaded native owner process root', effectNativeRule(provideRule), {
  invalid: [],
  valid: [
    {
      code: readFileSync(productOwnerChild, 'utf-8'),
      filename: productOwnerChild,
      ...withOptions(fixtureOptions(provideRule)),
    },
    {
      code: readFileSync(customerAuthority, 'utf-8'),
      filename: customerAuthority,
      ...withOptions(fixtureOptions(provideRule)),
    },
  ],
});

const scenario = (name: string) => ({ filename: virtualFile(`scripts/${name}.mts`), name });

describe('separates deferred literal contracts from NodeRuntime origins', () => {
  const contract = '../../verticals/symmy-integration/src/ops/symmy-route-enrollment.ts';
  const contractSource = `import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
const fail = (reason: string) => new Error(reason);
export const buildRoutes = (principalId: string) => Effect.gen(function* () {
  const { SymmyRouteEnrollmentRequestSchema } = yield* Effect.tryPromise({
    catch: () => fail('The production Symmy enrollment contract could not be loaded'),
    try: async () => await import('${contract}'),
  });
  return yield* Schema.decodeUnknownEffect(SymmyRouteEnrollmentRequestSchema)(principalId);
});
export const bootstrap = Effect.fn('bootstrap')(function* () {
  const { SymmyJobRetentionPolicySchema, SymmyRouteExecutionConfigurationSchema } = yield* Effect.tryPromise({
    catch: () => fail('The production Symmy source contracts could not be loaded'),
    try: async () => await import('@app/symmy-integration/symmy-internal-contracts'),
  });
  const { symmyPlannedRouteRow, symmyRetentionRefusals } = yield* Effect.tryPromise({
    catch: () => fail('The production Symmy enrollment contract could not be loaded'),
    try: async () => await import('${contract}'),
  });
  return { SymmyJobRetentionPolicySchema, SymmyRouteExecutionConfigurationSchema, symmyPlannedRouteRow, symmyRetentionRefusals };
});
if (import.meta.main) {
  NodeRuntime.runMain(bootstrap().pipe(
    Effect.provide(AuthorityLive),
    Effect.provide(NodeServices.layer),
    Effect.tapError((failure) => report(failure)),
  ));
}`;
  const { accept, register, reject } = collectCases(
    effectNativeRule(provideRule),
    `effect-native/${provideRule} deferred contracts`,
    withOptions(fixtureOptions(provideRule)),
  );
  accept(contractSource, scenario('literal-contracts-under-main-guard'));
  accept(
    contractSource.replace('import { Effect, Schema }', 'import { Effect as Fx, Schema }').replaceAll('Effect.', 'Fx.'),
    scenario('genuine-effect-import-alias'),
  );
  for (const address of ['./contracts.ts', '../contracts.ts', 'published-contracts/schema', '@vendor/contracts']) {
    accept(contractSource.replaceAll(contract, address), scenario(`contract-address-${address}`));
  }
  const builtinAddresses = new Set(
    builtinModules.flatMap((builtin) => {
      const bare = builtin.replace(/^node:/u, '');
      return [bare, `node:${bare}`];
    }),
  );
  for (const [index, address] of [...builtinAddresses].entries()) {
    reject(
      2,
      contractSource.replace(`import('${contract}')`, `import('${address}')`),
      scenario(`builtin-module-${index}-${address}`),
    );
  }
  for (const [name, address, binding, call] of [
    ['process-getBuiltinModule', "'process'", 'getBuiltinModule', 'getBuiltinModule'],
    ['node-process-getBuiltinModule', "'node:process'", 'getBuiltinModule', 'getBuiltinModule'],
    ['process-builtin-alias', "'process'", 'getBuiltinModule: loadBuiltin', 'loadBuiltin'],
    ['escaped-process-builtin-alias', String.raw`'pro\u0063ess'`, 'getBuiltinModule: loadBuiltin', 'loadBuiltin'],
    ['module-builtin-alias', "'module'", 'createRequire: loadBuiltin', 'loadBuiltin'],
  ] satisfies readonly (readonly [string, string, string, string])[]) {
    const exploit = `import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
const fail = (reason: string) => new Error(reason);
const main = Effect.gen(function* () {
  const { ${binding} } = yield* Effect.tryPromise({
    catch: () => fail('x'),
    try: async () => await import(${address}),
  });
  ${call}('vm').runInThisContext('globalThis.injected=true');
});
if (import.meta.main) {
  NodeRuntime.runMain(main.pipe(Effect.provide(AuthorityLive), Effect.provide(NodeServices.layer)));
}`;
    reject(2, exploit, scenario(name));
  }
  const unsafeSources = [
    "'@effect/platform-node'",
    "'@effect/platform-node/NodeRuntime'",
    "'@effect/platform-node/NodeRuntime.js'",
    "'node:module'",
    "'module'",
    "'node:vm'",
    "'vm'",
    'contractPath',
    `\`${contract}\``,
    "'@effect/' + 'platform-node'",
    "'#contracts'",
    "'/contracts.ts'",
    "'//host/contracts.ts'",
    "'./contracts.ts?runtime'",
    "'./contracts%2ets'",
    "' contracts '",
  ];
  for (const [index, address] of unsafeSources.entries()) {
    reject(
      2,
      contractSource.replace(`import('${contract}')`, `import(${address})`),
      scenario(`unsafe-address-${index}`),
    );
  }
  const enrollmentBinding = '{ SymmyRouteEnrollmentRequestSchema }';
  const controls = [
    ['namespace-result', 'const { SymmyRouteEnrollmentRequestSchema }', 'const namespace'],
    ['mutable-result', 'const { SymmyRouteEnrollmentRequestSchema }', 'let { SymmyRouteEnrollmentRequestSchema }'],
    ['runtime-alias', enrollmentBinding, '{ NodeRuntime: SymmyRouteEnrollmentRequestSchema }'],
    ['runner-alias', enrollmentBinding, '{ runMain: SymmyRouteEnrollmentRequestSchema }'],
    ['default-alias', enrollmentBinding, '{ default: SymmyRouteEnrollmentRequestSchema }'],
    ['rest-escape', enrollmentBinding, '{ SymmyRouteEnrollmentRequestSchema, ...namespace }'],
    ['computed-slot', enrollmentBinding, '{ [runtimeKey]: SymmyRouteEnrollmentRequestSchema }'],
    ['default-slot', enrollmentBinding, '{ SymmyRouteEnrollmentRequestSchema = replacement }'],
    ['unawaited-loader', 'try: async () => await import(', 'try: () => import('],
    [
      'loader-side-effect',
      `await import('${contract}')`,
      `(await import('${contract}')).NodeRuntime.runMain = replacement`,
    ],
    ['loader-namespace-escape', `await import('${contract}')`, `retain(await import('${contract}'))`],
    ['loader-promise-escape', `await import('${contract}')`, `await import('${contract}').then(retain)`],
    ['loader-block', `async () => await import('${contract}')`, `async () => { return await import('${contract}'); }`],
    ['loader-options', `import('${contract}')`, `import('${contract}', options)`],
    ['missing-catch', "catch: () => fail('The production Symmy enrollment contract could not be loaded'),", ''],
    [
      'spread-options',
      "catch: () => fail('The production Symmy enrollment contract could not be loaded'),",
      '...options,',
    ],
    [
      'catch-escape',
      "catch: () => fail('The production Symmy enrollment contract could not be loaded')",
      'catch: retain',
    ],
    ['fake-effect', 'yield* Effect.tryPromise(', 'yield* Fake.tryPromise('],
  ] satisfies readonly (readonly [string, string, string])[];
  for (const [name, from, to] of controls) {
    reject(2, contractSource.replace(from, to), scenario(name));
  }
  reject(
    2,
    `import { Effect as Fake } from './fake-effect.ts';\n${contractSource.replace('yield* Effect.tryPromise(', 'yield* Fake.tryPromise(')}`,
    scenario('spoofed-effect-import'),
  );
  for (const [index, escapeCode] of [
    'NodeRuntime.runMain = replacement;',
    'const Runtime = NodeRuntime; Runtime.runMain = replacement;',
    'const start = NodeRuntime.runMain; retain(start);',
    'export { NodeRuntime };',
    'retain(NodeRuntime);',
    "const load = () => import('@effect/platform-node');",
    "const load = () => import('@effect/platform-node').then(({ NodeRuntime: Runtime }) => { Runtime.runMain = replacement; });",
    "import { NodeRuntime as Runtime } from '@effect/platform-node'; Runtime.runMain = replacement;",
    "import * as Platform from '@effect/platform-node'; Platform.NodeRuntime.runMain = replacement;",
    "import * as Runtime from '@effect/platform-node/NodeRuntime'; Runtime.runMain = replacement;",
    "require('@effect/platform-node');",
    "eval('replacement');",
    "Function('return replacement')();",
    'globalThis.runtime = replacement;',
    'Reflect.set(target, key, replacement);',
  ].entries()) {
    reject(2, `${contractSource}\n${escapeCode}`, scenario(`runtime-origin-escape-${index}`));
  }
  reject(
    2,
    contractSource.replace("from '@effect/platform-node'", "from './fake-runtime.ts'"),
    scenario('spoofed-runtime-with-contracts'),
  );
  register();
});
