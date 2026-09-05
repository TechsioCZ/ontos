import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseOxlintOutput } from './oxlint.mts';

const diagnostic = {
  code: 'effect-native(example)',
  filename: 'invalid/example.ts',
  message: 'Example violation',
  severity: 'error',
  labels: [],
};
const report = (diagnostics: unknown[] = [], files = 1) =>
  JSON.stringify({ diagnostics, number_of_files: files });

test('accepts a successful clean lint run', () => {
  const run = parseOxlintOutput(report(), '', 0);
  assert.equal(run.numberOfFiles, 1);
  assert.deepEqual(run.diagnostics, []);
  assert.equal(run.exitCode, 0);
});

test('accepts actual lint failures as diagnostics, not a loader crash', () => {
  const run = parseOxlintOutput(report([diagnostic]), '', 1);
  assert.deepEqual(run.diagnostics, [diagnostic]);
  assert.equal(run.exitCode, 1);
});

test('rejects loader failures on stdout, including a JSON-looking suffix', () => {
  for (const stdout of [
    'Failed to load plugin',
    `Failed to load plugin\n${report()}`,
    '',
    '{bad',
    'null',
  ]) {
    assert.throws(() => parseOxlintOutput(stdout, '', 1));
  }
});

test('rejects empty-file runs and missing report fields', () => {
  for (const stdout of [
    report([], 0),
    report([], -1),
    report([], 1.5),
    '{}',
    '{"diagnostics":[]}',
  ]) {
    assert.throws(() => parseOxlintOutput(stdout, '', 0), /incomplete or empty-file/);
  }
});

test('rejects crashes, stderr failures, and inconsistent exit statuses', () => {
  assert.throws(() => parseOxlintOutput(report(), '', null), /did not complete/);
  assert.throws(() => parseOxlintOutput(report(), '', 2), /did not complete/);
  assert.throws(() => parseOxlintOutput(report(), 'plugin crashed', 0), /stderr/);
  assert.throws(() => parseOxlintOutput(report(), '', 1), /contradicts/);
  assert.throws(() => parseOxlintOutput(report([diagnostic]), '', 0), /contradicts/);
});

test('rejects malformed diagnostics rather than hiding them', () => {
  for (const entry of [
    null,
    {},
    { ...diagnostic, severity: 'unknown' },
    { ...diagnostic, labels: null },
  ]) {
    assert.throws(() => parseOxlintOutput(report([entry]), '', 1), /malformed diagnostic/);
  }
});
