import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';

import { countLintSuppressions } from '../lint-suppression-ratchet.mts';
import { collectToolingProcess } from './tooling-process-fixture.mts';

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

const runMonitor = Effect.fn('runSuppressionMonitorFixture')(function* runMonitorFixture(
  baselineSource: string,
  fixtureSource: string,
  args: readonly string[] = [],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-suppression-monitor-' });
  const app = yield* path.fromFileUrl(new URL('../..', import.meta.url));
  yield* fs.makeDirectory(path.join(root, 'scripts'));
  yield* fs.makeDirectory(path.join(root, 'quality-audit'));
  for (const file of ['lint-suppression-ratchet.mts', 'quality-cli-lifecycle.mts']) {
    yield* fs.copyFile(path.join(app, 'scripts', file), path.join(root, 'scripts', file));
  }
  yield* fs.symlink(path.join(app, 'node_modules'), path.join(root, 'node_modules'));
  const baselinePath = path.join(root, 'quality-audit/lint-suppressions.json');
  yield* fs.writeFileString(baselinePath, baselineSource);
  yield* fs.writeFileString(path.join(root, 'quality-audit/scope.json'), '{"exclude":[],"patterns":["fixture.ts"]}');
  yield* fs.writeFileString(path.join(root, fixturePath), fixtureSource);
  const summary = path.join(root, 'summary.txt');
  yield* fs.writeFileString(summary, 'Existing summary\n');
  const result = yield* collectToolingProcess(
    ChildProcess.make(process.execPath, [path.join(root, 'scripts/lint-suppression-ratchet.mts'), ...args], {
      cwd: root,
      env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary },
    }),
  );
  return {
    ...result,
    baseline: yield* fs.readFileString(baselinePath),
    summary: yield* fs.readFileString(summary),
  };
});

it.live('reports matching counts and a total without a warning', () =>
  Effect.gen(function* matchingBaseline() {
    const result = yield* runMonitor(baseline, source);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('Lint suppressions match the committed baseline\nTotal: 6 -> 6 (0)\n');
    expect(result.summary).toContain('| Total | 6 | 6 | 0 |');
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live('reports an increase, warns in Actions, appends a summary and exits zero', () =>
  Effect.gen(function* addedSuppression() {
    const added = `// oxlint-disable-next-line effect-native/no-ambient-date -- new reason\n${source}`;
    const result = yield* runMonitor(baseline, added);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      'effect-native/no-ambient-date: 2 -> 3 (+1)\nTotal: 6 -> 7 (+1)\n' +
        '::warning title=Lint suppressions increased::effect-native/no-ambient-date: 2 -> 3 (+1)\n',
    );
    expect(result.summary).toBe(
      'Existing summary\n\n## Lint suppressions\n\nReport only. Counts are compared with the committed baseline.\n\n' +
        '| Rule | Baseline | Now | Delta |\n| --- | ---: | ---: | ---: |\n' +
        '| effect-native/no-ambient-date | 2 | 3 | +1 |\n| Total | 6 | 7 | +1 |\n',
    );
    expect(result.baseline).toBe(baseline);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live('reports a decrease without requiring a baseline update and exits zero', () =>
  Effect.gen(function* removedSuppression() {
    const result = yield* runMonitor(baseline, source.replace('/* oxlint-disable */', ''));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('*: 1 -> 0 (-1)\nTotal: 6 -> 5 (-1)\n');
    expect(result.summary).toContain('| * | 1 | 0 | -1 |\n| Total | 6 | 5 | -1 |');
    expect(result.baseline).toBe(baseline);
  }).pipe(Effect.provide(NodeServices.layer)),
);

for (const malformed of ['not json', '{"rules":{"rule":-1}}', '{"rules":[]}']) {
  it.live(`fails on a malformed baseline: ${malformed}`, () =>
    Effect.gen(function* malformedBaseline() {
      const result = yield* runMonitor(malformed, source);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('LintSuppressionReportError: Malformed quality-audit/lint-suppressions.json');
      expect(result.stdout).toBe('');
      expect(result.summary).toBe('Existing summary\n');
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.live('refreshes the baseline only with --update', () =>
  Effect.gen(function* updateBaseline() {
    const result = yield* runMonitor('{"rules":{}}', source, ['--update']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('Wrote quality-audit/lint-suppressions.json\n');
    expect(JSON.parse(result.baseline)).toEqual(JSON.parse(baseline));
  }).pipe(Effect.provide(NodeServices.layer)),
);
