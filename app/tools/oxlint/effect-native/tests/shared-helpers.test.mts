import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import {
  booleanOption,
  compile,
  compilePatterns,
  positiveInteger,
  safeRegExp,
  stringArray,
  stringList,
} from '../shared/options.ts';
import {
  globToRegExp,
  inScriptScope,
  scopePath,
  scriptScope,
  workspacePath,
} from '../shared/paths.ts';
import { runOxlint, testsDirectory } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

it('shared option parsers preserve rejection, sparse arrays and regex flags', () => {
  const fallback = ['default'];
  const sparse: string[] = [];
  sparse.length = 2;
  expect(stringArray(['yes', 1], fallback)).toBe(fallback);
  expect(stringArray(sparse, fallback)).toBe(fallback);
  expect(stringList(sparse, fallback).length).toBe(2);
  expect(booleanOption('false', true)).toBe(true);
  expect(positiveInteger(0, 3)).toBe(3);
  expect(positiveInteger(0, 3, 0)).toBe(0);
  expect(compile('[', 'fallback', 'iu').source).toBe('fallback');
  expect(compile('[', 'fallback', 'iu').flags).toBe('iu');
  expect(compilePatterns(['[', 'ok']).length).toBe(1);
  expect(safeRegExp('', 'fallback').source).toBe('(?:)');
  expect(compile('', 'fallback').source).toBe('fallback');
});

it('shared path policies distinguish earliest and latest markers and script scope', () => {
  const nestedScript = 'packages/p/scripts/apps/demo.ts';
  const fixture =
    '/repo/tools/oxlint/effect-native/tests/fixtures/x/invalid/packages/p/scripts/apps/demo.ts';
  expect(scopePath(fixture)).toBe(nestedScript);
  expect(scriptScope(fixture)).toBe(nestedScript);
  expect(workspacePath(fixture)).toBe('apps/demo.ts');
  expect(inScriptScope(scriptScope(fixture))).toBe(true);
  expect(inScriptScope('scripts/a.test.ts')).toBe(false);
  expect(scriptScope(nestedScript)).toBe(nestedScript);
  expect(globToRegExp('**/*.{ts,mts}').test('a.ts')).toBe(true);
  expect(globToRegExp('a{').test('a{')).toBe(true);
  expect(globToRegExp('x/?*.ts').test('x/a.ts')).toBe(true);
});

const cases = [
  {
    expected: ['SequenceExpression', 'MemberExpression'],
    name: 'sequence wrappers are opt-in',
    probe: 'sequence',
    source: '(ignored, Effect.gen);',
  },
  {
    expected: ['AwaitExpression', 'MemberExpression'],
    name: 'await wrappers are opt-in',
    probe: 'await',
    source: 'await Effect.gen;',
  },
  {
    expected: [true, true],
    name: 'narrow wrappers and required spans stay strict',
    probe: 'wrappers',
    source: 'Effect as unknown;',
  },
  {
    expected: [null, 'gen', 'gen'],
    name: 'template member keys are opt-in',
    probe: 'members',
    source: 'Effect[`gen`];',
  },
  {
    expected: [null, null, 'gen'],
    name: 'wrapped member keys are opt-in',
    probe: 'members',
    source: 'Effect[("gen" as const)];',
  },
  {
    expected: [null, null, null],
    name: 'dynamic member keys remain unknown',
    probe: 'members',
    source: 'Effect[method];',
  },
  {
    expected: [['Types'], 0, 'Effect', 'gen', false, true],
    name: 'imports preserve aliases and type-only filtering',
    probe: 'imports',
    source:
      'import type * as Types from "effect"; import { type gen as tgen, gen as g } from "effect/Effect"; import * as S from "effect/Schema";',
  },
  {
    expected: [['Effect', 'gen'], true],
    name: 'Effect identities follow const destructuring',
    probe: 'binding',
    source: 'import { Effect as E } from "effect"; const { gen: g } = E; g;',
  },
  {
    expected: [['Effect', 'gen'], true],
    name: 'Effect identities follow direct submodule imports',
    probe: 'binding',
    source: 'import { gen as g } from "effect/Effect"; g;',
  },
  {
    expected: [null, ['Effect', 'gen']],
    name: 'Effect origin preserves default-import differences',
    probe: 'origin',
    source: 'import E from "effect/Effect"; E.gen;',
  },
  {
    expected: [null, ['Effect', 'gen']],
    name: 'Effect origin preserves glob barrel differences',
    probe: 'barrel',
    source: 'import { Effect as E } from "@app/barrel"; E.gen;',
  },
  {
    expected: ['process.stderr.write', null],
    name: 'script provenance accepts unwritten let aliases',
    probe: 'provenance',
    source:
      'import * as p from "node:process"; let { stderr: sink } = p; sink.write;',
  },
  {
    expected: [null, null],
    name: 'script provenance rejects later writes',
    probe: 'provenance',
    source:
      'import * as p from "node:process"; let { stderr: sink } = p; sink = p.stdout; sink.write;',
  },
  {
    expected: ['process', null],
    name: 'script provenance follows dynamic imports',
    probe: 'provenance',
    source: 'await import("node:process");',
  },
  {
    expected: ['console.warn', null],
    name: 'script provenance follows require',
    probe: 'provenance',
    source: 'require("node:console").warn;',
  },
  {
    expected: ['process.stderr.write', null],
    name: 'script provenance follows ambient containers',
    probe: 'provenance',
    source: 'globalThis.process.stderr.write;',
  },
  {
    expected: [false, true, true, false],
    name: 'global/import resolution retains type-only policy',
    probe: 'globals',
    source: 'import type { JSON } from "types"; JSON;',
  },
  {
    expected: ['decodeUnknownSync'],
    name: 'Schema identity follows aliases',
    probe: 'schema',
    source:
      'import * as E from "effect"; const S = E.Schema; const { decodeUnknownSync: decode } = S; decode;',
  },
  {
    expected: [null],
    name: 'Schema identity rejects mutable declarations',
    probe: 'schema',
    source: 'import { Schema } from "effect"; let S = Schema; S.Json;',
  },
  {
    expected: ['first _ last', 'TemplateElement', true, true, '   ', 'ab…'],
    name: 'template text preserves cooked offsets and budgets',
    probe: 'template',
    source: `\`first \${name} last\`;`,
  },
  {
    expected: [true, false],
    name: 'entry detection includes top-level IIFEs only',
    probe: 'entry',
    source:
      '(() => { console.warn("x"); })(); function nested() { console.warn("y"); }',
  },
  {
    expected: [false, true, [false, true], [false, true]],
    name: 'reference policies preserve declaration and TS edges',
    probe: 'references',
    source: 'const result = Schema as unknown; type Result = typeof Schema;',
  },
  {
    expected: ['Json', null, null],
    name: 'Schema identity preserves expression wrapper limits',
    probe: 'schema-wrappers',
    source:
      'import { Schema } from "effect"; const S = Schema as unknown; S.Json;',
  },
  ...['`decodeUnknownSync`', '("decodeUnknownSync" as const)'].map((key) => ({
    expected: [null, 'decodeUnknownSync'],
    name: `Schema syntax policy survives aliased key ${key}`,
    probe: 'schema-syntax',
    source: `import { Schema } from "effect"; const S = Schema; const codec = S[${key}]; codec;`,
  })),
];

for (const { expected, name, probe, source } of cases) {
  it(`shared helpers: ${name}`, () => {
    withTemporaryWorkspace((directory) => {
      writeFileSync(path.join(directory, 'probe.ts'), source);
      const config = path.join(directory, '.oxlintrc.json');
      writeFileSync(
        config,
        JSON.stringify({
          categories: { correctness: 'off' },
          jsPlugins: [
            {
              name: 'shared-helpers-probe',
              specifier: path.join(testsDirectory, 'shared-helpers-probe.ts'),
            },
          ],
          rules: { 'shared-helpers-probe/inspect': ['error', probe] },
        })
      );
      const run = runOxlint(config, ['probe.ts'], directory);
      expect(run.exitCode).toBe(1);
      expect(run.numberOfFiles).toBe(1);
      expect(
        run.diagnostics.map(({ code, message }) => ({ code, message }))
      ).toStrictEqual([
        {
          code: 'shared-helpers-probe(inspect)',
          message: JSON.stringify(expected),
        },
      ]);
    });
  });
}
