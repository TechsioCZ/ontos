import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it } from 'effect-rstest';

import { appRoot, fixtureConfigPath, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const ruleName = 'no-process-exit-outside-script-entry';
const ruleCode = `effect-native(${ruleName})`;
const native = readFileSync(
  new URL(`fixtures/${ruleName}/valid/scripts/native-runtime-teardown.mts`, import.meta.url),
  'utf-8',
);
const hardExit = 'process.exit(code);';
const forwardExit = 'onExit(code);';
const teardownName = 'exitWhenCommandCompletes';
const defaultCall = 'Runtime.defaultTeardown(exit, (code) => {';
const runMainCall =
  'NodeRuntime.runMain(Layer.build(executableLayer).pipe(Effect.scoped), { teardown: exitWhenCommandCompletes });';

interface TeardownFixture {
  readonly expected: number;
  readonly name: string;
  readonly source: string;
}

const expectFixtures = (fixtures: readonly TeardownFixture[]): void => {
  withTemporaryWorkspace((directory) => {
    const scripts = path.join(directory, 'scripts');
    mkdirSync(scripts);
    const files = fixtures.map(({ name, source }) => {
      const filename = path.join(scripts, `${name}.mts`);
      writeFileSync(filename, source);
      return filename;
    });
    const result = runOxlint(fixtureConfigPath(ruleName), files, appRoot);
    expect(result.numberOfFiles).toBe(fixtures.length);
    expect(result.diagnostics.filter(({ code }) => code !== ruleCode)).toEqual([]);
    for (const [index, fixture] of fixtures.entries()) {
      const diagnostics = result.diagnostics.filter(
        ({ code, filename }) => code === ruleCode && path.resolve(appRoot, filename) === files[index],
      );
      expect(diagnostics, `${fixture.name}: ${JSON.stringify(diagnostics)}`).toHaveLength(fixture.expected);
    }
  });
};

it('accepts the production top-level native teardown and genuine import renames', () => {
  expectFixtures([
    { expected: 0, name: 'production', source: native },
    {
      expected: 0,
      name: 'renamed-imports',
      source: native
        .replace('{ NodeRuntime }', '{ NodeRuntime as Node }')
        .replaceAll('NodeRuntime.runMain', 'Node.runMain')
        .replace('Effect, Layer, Runtime', 'Effect, Layer, Runtime as NativeRuntime')
        .replaceAll('Runtime.', 'NativeRuntime.'),
    },
    {
      expected: 0,
      name: 'native-submodules',
      source: native
        .replace(
          "import { NodeRuntime } from '@effect/platform-node';",
          "import * as NodeRuntime from '@effect/platform-node/NodeRuntime';",
        )
        .replace(
          "import { Effect, Layer, Runtime } from 'effect';",
          "import { Effect, Layer } from 'effect';\nimport * as Runtime from 'effect/Runtime';",
        ),
    },
  ]);
});

it('rejects forged, type-only, shadowed, mutated, and escaped native runtime imports', () => {
  const variants: readonly (readonly [string, string])[] = [
    ['foreign-node', native.replace("'@effect/platform-node'", "'./fake-node.ts'")],
    ['foreign-effect', native.replace("'effect'", "'./fake-effect.ts'")],
    ['provenance-lookalike', native.replace("'effect'", "'Runtime'")],
    ['type-only-node', native.replace('import { NodeRuntime }', 'import type { NodeRuntime }')],
    ['type-only-runtime', native.replace('Layer, Runtime', 'Layer, type Runtime')],
    ['shadowed-node', native.replace(runMainCall, `((NodeRuntime) => { ${runMainCall} })(fake);`)],
    ['shadowed-runtime', native.replace(defaultCall, `((Runtime) => Runtime.defaultTeardown)(exit, (code) => {`)],
    ['mutated-node', `${native}\nNodeRuntime.runMain = fake;`],
    ['mutated-runtime', `${native}\nRuntime.defaultTeardown = fake;`],
    ['escaped-node', `${native}\nopaque(NodeRuntime);`],
    ['escaped-runtime', `${native}\nconst alias = Runtime;`],
    ['exported-runtime', `${native}\nexport { Runtime };`],
    ['reflective-mutation', `${native}\nObject.assign(Runtime, { defaultTeardown: fake });`],
    ['computed-default', native.replace('Runtime.defaultTeardown', "Runtime['defaultTeardown']")],
  ];
  expectFixtures(variants.map(([name, source]) => ({ expected: 1, name, source })));
});

it('rejects teardown escapes, manual calls, arbitrary callbacks, and signal registrations', () => {
  const variants: readonly (readonly [string, string])[] = [
    ['manual-call', `${native}\n${teardownName}(Exit.succeed(undefined), () => {});`],
    ['escaped-callback', `${native}\nopaque(${teardownName});`],
    ['aliased-callback', `${native}\nconst alias = ${teardownName};`],
    ['exported-callback', `${native}\nexport { ${teardownName} };`],
    ['mutated-callback', `${native}\n${teardownName} = fake;`],
    ['mutable-callback', native.replace(`const ${teardownName}`, `let ${teardownName}`)],
    ['arbitrary-runner', native.replace('NodeRuntime.runMain(', 'arbitraryRunMain(')],
    ['arbitrary-default', native.replace('Runtime.defaultTeardown(', 'arbitraryTeardown(')],
    ['second-native-use', `${native}\n${runMainCall}`],
    ['signal-callback', `${native}\nprocess.on('SIGTERM', ${teardownName});`],
    ['signal-manual-call', `${native}\nprocess.once('SIGINT', () => ${teardownName}(exit, onExit));`],
    ['signal-hard-exit', `${native}\nprocess.once('SIGTERM', () => process.exit(1));`],
    ['options-spread', native.replace('{ teardown:', '{ ...options, teardown:')],
    [
      'overridden-teardown',
      native.replace('teardown: exitWhenCommandCompletes }', 'teardown: exitWhenCommandCompletes, ...options }'),
    ],
    [
      'extra-runMain-argument',
      native.replace('{ teardown: exitWhenCommandCompletes });', '{ teardown: exitWhenCommandCompletes }, extra);'),
    ],
    ['async-teardown', native.replace('(exit, onExit) =>', 'async (exit, onExit) =>')],
    ['async-forwarder', native.replace('(code) =>', 'async (code) =>')],
  ];
  expectFixtures(variants.map(([name, source]) => ({ expected: 1, name, source })));
});

it('requires exact Exit and onExit forwarding with no other callback uses or exits', () => {
  const variants: readonly (readonly [string, string, number])[] = [
    ['wrong-exit', native.replace('defaultTeardown(exit,', 'defaultTeardown(otherExit,'), 1],
    ['missing-forward', native.replace(forwardExit, ''), 1],
    ['wrong-forwarder', native.replace(forwardExit, 'notifyExit(code);'), 1],
    ['wrong-forward-code', native.replace(forwardExit, 'onExit(0);'), 1],
    ['wrong-exit-code', native.replace(hardExit, 'process.exit(0);'), 1],
    ['reverse-order', native.replace(`onExit(code);\n    ${hardExit}`, `${hardExit}\n    onExit(code);`), 1],
    ['escaped-onExit', native.replace(forwardExit, `opaque(onExit);\n    ${forwardExit}`), 1],
    ['escaped-code', native.replace(hardExit, `opaque(code);\n    ${hardExit}`), 1],
    ['extra-inner-exit', native.replace(hardExit, `${hardExit}\n    process.exit(1);`), 2],
    ['extra-outer-exit', native.replace(defaultCall, `process.exit(1);\n  ${defaultCall}`), 2],
    ['extra-edge-exit', `${native}\nprocess.exit(1);`, 1],
    ['self-signal', native.replace(hardExit, "process.kill(process.pid, 'SIGTERM');"), 1],
    ['exit-code-write', native.replace(hardExit, 'process.exitCode = code;'), 1],
    ['optional-exit', native.replace(hardExit, 'process.exit?.(code);'), 1],
  ];
  expectFixtures(variants.map(([name, source, expected]) => ({ expected, name, source })));
});

it('retains the configured maximum exit-site policy for native teardown adapters', () => {
  withTemporaryWorkspace((directory) => {
    const scripts = path.join(directory, 'scripts');
    mkdirSync(scripts);
    const file = path.join(scripts, 'native.mts');
    const config = path.join(directory, 'config.json');
    const fixtureConfig = {
      categories: { correctness: 'off' },
      jsPlugins: [
        {
          name: 'effect-native',
          specifier: path.join(appRoot, 'tools/oxlint/effect-native/tests/fixture-plugin.ts'),
        },
      ],
      rules: { [`effect-native/${ruleName}`]: ['error', { maxExitSites: 0 }] },
    };
    writeFileSync(config, JSON.stringify(fixtureConfig));
    writeFileSync(file, native);
    const { diagnostics } = runOxlint(config, [file], appRoot, ruleName);
    expect(diagnostics).toHaveLength(1);
    const [diagnostic] = diagnostics;
    expect(diagnostic?.message).toContain('another, independent exit decision');
  });
});

it('runs asynchronous Scope finalizers before native teardown hard-exits a child with an open handle', () => {
  withTemporaryWorkspace((directory) => {
    const require = createRequire(path.join(appRoot, 'package.json'));
    const effectModule = pathToFileURL(require.resolve('effect')).href;
    const nodeModule = pathToFileURL(require.resolve('@effect/platform-node')).href;
    for (const [outcome, code, effectSource] of [
      ['success', 0, 'Effect.void'],
      ['failure', 1, "Effect.fail('expected failure')"],
      ['interrupt', 130, 'Effect.interrupt'],
    ] as const) {
      const evidence = path.join(directory, `${outcome}.txt`);
      const child = path.join(directory, `${outcome}.mjs`);
      writeFileSync(
        child,
        `import { appendFileSync } from 'node:fs';
import { Effect, Runtime } from ${JSON.stringify(effectModule)};
import { NodeRuntime } from ${JSON.stringify(nodeModule)};
const record = (event) => appendFileSync(${JSON.stringify(evidence)}, event + '\\n');
setInterval(() => {}, 60_000);
process.once('exit', (code) => record('process-exit:' + code));
const exitWhenCommandCompletes = (exit, onExit) => {
  Runtime.defaultTeardown(exit, (code) => {
    onExit(code);
    process.exit(code);
  });
};
const program = Effect.gen(function* lifecycle() {
  yield* Effect.addFinalizer(() => Effect.gen(function* release() {
    record('release-start');
    yield* Effect.sleep('10 millis');
    record('release-complete');
  }));
  record('program');
  yield* ${effectSource};
}).pipe(Effect.scoped);
NodeRuntime.runMain(program, { disableErrorReporting: true, teardown: exitWhenCommandCompletes });
`,
      );
      const result = spawnSync(process.execPath, [child], { encoding: 'utf-8', timeout: 10_000 });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(code);
      expect(readFileSync(evidence, 'utf-8').trim().split('\n')).toEqual([
        'program',
        'release-start',
        'release-complete',
        `process-exit:${code}`,
      ]);
    }
  });
});
