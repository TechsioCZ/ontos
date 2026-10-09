import { Effect, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { checkLintSuppressions, countLintSuppressions } from '../lint-suppression-ratchet.mts';

const fixturePath = 'fixture.ts';
const source = [
  '// oxlint-disable-next-line sonarjs/no-duplicate-string -- fixture reason',
  "const first = 'a';",
  '/* eslint-disable effect-native/no-ambient-date, sonarjs/no-duplicate-string -- fixture reason */',
  "const directive = '// oxlint-disable-next-line effect-native/no-ambient-date';",
  '// A comment that mentions oxlint-disable later is not a directive.',
  '/* oxlint-disable */',
  '// oxlint-disable-next-line anti-slop/no-reflect-get effect-native/no-ambient-date -- whitespace-separated list',
  'void first;',
  'void directive;',
  '',
].join('\n');
const baseline = JSON.stringify({
  rules: {
    '*': 1,
    'anti-slop/no-reflect-get': 1,
    'effect-native/no-ambient-date': 2,
    'sonarjs/no-duplicate-string': 2,
  },
});

it('counts disable directives per rule from comments only', () => {
  expect(countLintSuppressions([{ path: fixturePath, source }])).toEqual({
    '*': 1,
    'anti-slop/no-reflect-get': 1,
    'effect-native/no-ambient-date': 2,
    'sonarjs/no-duplicate-string': 2,
  });
});

it.effect('passes when the counts match the baseline', () =>
  Effect.gen(function* matchingBaseline() {
    const current = countLintSuppressions([{ path: fixturePath, source }]);
    const result = yield* checkLintSuppressions(baseline, current).pipe(Effect.result);
    expect(Result.isSuccess(result)).toBe(true);
  }),
);

it.effect('fails when one disable is added', () =>
  Effect.gen(function* addedSuppression() {
    const added = `// oxlint-disable-next-line effect-native/no-ambient-date -- new reason\n${source}`;
    const current = countLintSuppressions([{ path: fixturePath, source: added }]);
    const result = yield* checkLintSuppressions(baseline, current).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toMatch(/increased: effect-native\/no-ambient-date 2 -> 3/u);
    }
  }),
);

it.effect('fails until the baseline is lowered after a disable is removed', () =>
  Effect.gen(function* removedSuppression() {
    const current = countLintSuppressions([{ path: fixturePath, source: source.replace('/* oxlint-disable */', '') }]);
    const result = yield* checkLintSuppressions(baseline, current).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toMatch(/decreased: \* 1 -> 0\. Lower/u);
    }
  }),
);
