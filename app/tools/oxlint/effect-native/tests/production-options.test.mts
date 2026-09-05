import assert from 'node:assert/strict';
import { cpSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { listRuleNames } from '../shared/discover-rules.ts';
import { globToRegExp } from '../shared/paths.ts';
import {
  fixtureConfigPath,
  fixturesDirectory,
  listFilesRecursively,
  runOxlint,
  testsDirectory,
} from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

// Stage outside tools/**/tests: absolute fixture ancestors must not alter production scope.
for (const rule of listRuleNames()) {
  test(`effect-native/${rule} production settings report a positive fixture`, () => {
    withTemporaryWorkspace((directory) => {
      for (const kind of ['invalid', 'valid'])
        cpSync(join(fixturesDirectory, rule, kind), join(directory, kind), { recursive: true });
      const paths = listFilesRecursively(directory).map((file) => relative(directory, file));
      const run = runOxlint(
        join(testsDirectory, 'production-fixture.config.ts'),
        paths,
        directory,
        rule,
      );
      assert.equal(
        run.numberOfFiles,
        paths.length,
        `${rule}: production run skipped fixture files`,
      );
      assert.equal(run.exitCode, 1, `${rule}: production defaults must have a positive fixture`);
      assert.ok(
        run.diagnostics.some((diagnostic) => diagnostic.filename.startsWith('invalid/')),
        `${rule}: no positive production fixture`,
      );
      for (const diagnostic of run.diagnostics)
        assert.equal(diagnostic.code, `effect-native(${rule})`);
      assert.deepEqual(
        run.diagnostics.filter(
          (diagnostic) =>
            diagnostic.filename.startsWith('valid/') &&
            diagnostic.filename.endsWith('/production-default.ts'),
        ),
        [],
        `${rule}: explicit default negative reported`,
      );
      const fixture: {
        rules: Record<string, unknown>;
        overrides?: { files: string[]; rules: Record<string, unknown> }[];
      } = JSON.parse(readFileSync(fixtureConfigPath(rule), 'utf8'));
      const key = `effect-native/${rule}`;
      if (fixture.rules[key] === 'error') {
        // Non-default option fixtures remain owned by the ordinary fixture suite.
        const usesOverride = (file: string): boolean =>
          fixture.overrides?.some(
            (override) =>
              key in override.rules && override.files.some((glob) => globToRegExp(glob).test(file)),
          ) ?? false;
        assert.deepEqual(
          run.diagnostics.filter(
            (diagnostic) =>
              diagnostic.filename.startsWith('valid/') && !usesOverride(diagnostic.filename),
          ),
          [],
          `${rule}: production false positive`,
        );
      }
    });
  });
}
