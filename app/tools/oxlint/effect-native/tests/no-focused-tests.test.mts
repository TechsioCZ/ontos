import { testEffectNativeRule, virtualFile } from './rule-tester.mts';

const effectImport = "import { Effect } from 'effect';";
const filename = virtualFile('apps/demo/tests/unit/focused.test.ts');
const focused = (count: number) => Array.from({ length: count }, () => ({ messageId: 'focused' }));

testEffectNativeRule('no-focused-tests', {
  invalid: [
    {
      code: [
        "import { describe, it, test } from '@rstest/core';",
        "it.only('a', () => {});",
        "test.only('b', () => {});",
        "describe.only('c', () => {});",
      ].join('\n'),
      errors: focused(3),
      filename,
      name: 'Rstest registrations',
    },
    {
      code: [
        effectImport,
        "import { it } from 'effect-rstest';",
        "it.effect.only('a', () => Effect.void);",
        "it.live.only('b', () => Effect.void);",
        "it.only('c', () => {});",
      ].join('\n'),
      errors: focused(3),
      filename,
      name: 'effect-rstest Effect testers',
    },
    {
      code: [
        effectImport,
        "import { effect as effectTest, it as register, live } from 'effect-rstest';",
        "register.effect.only('a', () => Effect.void);",
        "effectTest.only('b', () => Effect.void);",
        "live.only('c', () => Effect.void);",
      ].join('\n'),
      errors: focused(3),
      filename,
      name: 'aliased effect-rstest imports',
    },
    {
      code: [
        "import * as runner from 'effect-rstest';",
        "runner.it.only('a', () => {});",
        "runner.describe['only']('b', () => {});",
        "runner.it.live[`only`]('c', () => runner.it);",
      ].join('\n'),
      errors: focused(3),
      filename,
      name: 'namespace import with computed keys',
    },
    {
      code: [
        "import { test } from 'vitest';",
        "test.only.each([1])('a %s', () => {});",
        "test.concurrent.only('b', () => {});",
      ].join('\n'),
      errors: focused(2),
      filename,
      name: 'modifier chains',
    },
    {
      code: [
        "import { Effect, Layer } from 'effect';",
        "import { it, layer } from 'effect-rstest';",
        'const Live = Layer.empty;',
        "layer(Live)('suite', (scoped) => {",
        "  scoped.effect.only('a', () => Effect.void);",
        "  scoped.layer(Live)('nested', (nested) => {",
        "    nested.live.only('b', () => Effect.void);",
        '  });',
        '});',
        "it.layer(Live)((shared) => { shared.effect.only('c', () => Effect.void); });",
      ].join('\n'),
      errors: focused(3),
      filename,
      name: 'testers handed to effect-rstest layer callbacks',
    },
    {
      code: "describe.only('a', () => {});\nit.only('b', () => {});\ntest.only('c', () => {});",
      errors: focused(3),
      filename,
      name: 'unresolved runner globals',
    },
    {
      code: "import { it } from '@jest/globals';\nit.only('a', () => {});",
      errors: focused(1),
      filename,
      name: 'Jest import',
    },
  ],
  valid: [
    {
      code: "const it = { only: (name: string) => name };\nit.only('local');",
      filename,
      name: 'local object shadowing it',
    },
    {
      code: 'export const run = (test: { only(): void }) => test.only();',
      filename,
      name: 'parameter shadowing test',
    },
    {
      code: "import { it } from './local-registry.ts';\nit.only('a');",
      filename,
      name: 'it imported from a non-framework module',
    },
    {
      code: [
        "import { layer } from './local-layer.ts';",
        "layer(1)('suite', (it: { only(): void }) => it.only());",
      ].join('\n'),
      filename,
      name: 'callback of a non-framework layer',
    },
    {
      code: [
        effectImport,
        "import { it } from 'effect-rstest';",
        'const choices = { only: true };',
        "it.effect('reads choices', () => Effect.sync(() => choices.only));",
        "it.skip('skipped', () => {});",
        "it.live.skip('skipped live', () => Effect.void);",
      ].join('\n'),
      filename,
      name: 'unrelated only properties and non-focusing modifiers',
    },
    {
      code: [
        "const fixture = `import { it } from 'effect-rstest';",
        "it.live.only('virtual wait', () => Effect.sleep('1 millis'));`;",
        'const other = "describe.only(\'a\', () => {})";',
        'export const sources = [fixture, other];',
      ].join('\n'),
      filename,
      name: 'focused tests spelled inside fixture strings',
    },
  ],
});
