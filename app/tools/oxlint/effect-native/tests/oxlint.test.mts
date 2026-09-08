import { expect, it } from 'effect-rstest';

import { parseOxlintOutput } from './oxlint.mts';

const diagnostic = {
  code: 'effect-native(example)',
  filename: 'invalid/example.ts',
  labels: [],
  message: 'Example violation',
  severity: 'error',
};
const report = (diagnostics: unknown[] = [], files = 1) =>
  JSON.stringify({ diagnostics, number_of_files: files });

it('accepts a successful clean lint run', () => {
  const run = parseOxlintOutput(report(), '', 0);
  expect(run.numberOfFiles).toBe(1);
  expect(run.diagnostics).toEqual([]);
  expect(run.exitCode).toBe(0);
});

it('accepts actual lint failures as diagnostics, not a loader crash', () => {
  const run = parseOxlintOutput(report([diagnostic]), '', 1);
  expect(run.diagnostics).toEqual([diagnostic]);
  expect(run.exitCode).toBe(1);
});

it('rejects loader failures on stdout, including a JSON-looking suffix', () => {
  for (const stdout of [
    'Failed to load plugin',
    `Failed to load plugin\n${report()}`,
    '',
    '{bad',
    'null',
  ]) {
    expect(() => parseOxlintOutput(stdout, '', 1)).toThrow();
  }
});

it('rejects empty-file runs and missing report fields', () => {
  for (const stdout of [
    report([], 0),
    report([], -1),
    report([], 1.5),
    '{}',
    '{"diagnostics":[]}',
  ]) {
    expect(() => parseOxlintOutput(stdout, '', 0)).toThrow(
      /incomplete or empty-file/u
    );
  }
});

it('rejects crashes, stderr failures, and inconsistent exit statuses', () => {
  expect(() => parseOxlintOutput(report(), '', null)).toThrow(
    /did not complete/u
  );
  expect(() => parseOxlintOutput(report(), '', 2)).toThrow(/did not complete/u);
  expect(() => parseOxlintOutput(report(), 'plugin crashed', 0)).toThrow(
    /stderr/u
  );
  expect(() => parseOxlintOutput(report(), '', 1)).toThrow(/contradicts/u);
  expect(() => parseOxlintOutput(report([diagnostic]), '', 0)).toThrow(
    /contradicts/u
  );
});

it('rejects malformed diagnostics rather than hiding them', () => {
  for (const entry of [
    null,
    {},
    { ...diagnostic, severity: 'unknown' },
    { ...diagnostic, labels: null },
  ]) {
    expect(() => parseOxlintOutput(report([entry]), '', 1)).toThrow(
      /malformed diagnostic/u
    );
  }
});
