import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { listRuleNames } from '../shared/discover-rules.ts';
import { globToRegExp } from '../shared/paths.ts';
import { fixtureConfigPath, fixturesDirectory, listFilesRecursively, runOxlint, testsDirectory } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const RuleSetting = Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]);
const RuleMap = Schema.Record(Schema.String, RuleSetting);
const FixtureConfig = Schema.fromJsonString(
  Schema.Struct({
    overrides: Schema.optional(Schema.Array(Schema.Struct({ files: Schema.Array(Schema.String), rules: RuleMap }))),
    rules: RuleMap,
  }),
);
const decodeFixtureConfig = Schema.decodeUnknownSync(FixtureConfig);

// This minimal effect-native-only config has no Sonar plugin. Keep its production-policy
// fixtures outside the real repository so root-anchored rules see the intended fixture paths.
for (const rule of listRuleNames()) {
  it(`effect-native/${rule} production settings report a positive fixture`, () => {
    withTemporaryWorkspace((directory) => {
      for (const kind of ['invalid', 'valid']) {
        const source = nodePath.join(fixturesDirectory, rule, kind);
        for (const file of listFilesRecursively(source)) {
          const target = nodePath.join(directory, kind, nodePath.relative(source, file));
          mkdirSync(nodePath.dirname(target), { recursive: true });
          // Copy fixture bytes without cpSync's filesystem metadata operations,
          // which the shared sandbox mount does not support.
          writeFileSync(target, readFileSync(file));
        }
      }
      const paths = listFilesRecursively(directory).map((file) => nodePath.relative(directory, file));
      const run = runOxlint(nodePath.join(testsDirectory, 'production-fixture.config.ts'), paths, directory, rule);
      expect(run.numberOfFiles, `${rule}: production run skipped fixture files`).toBe(paths.length);
      expect(run.exitCode, `${rule}: production defaults must have a positive fixture`).toBe(1);
      expect(
        run.diagnostics.some((diagnostic) => diagnostic.filename.startsWith('invalid/')),
        `${rule}: no positive production fixture`,
      ).toBe(true);
      for (const diagnostic of run.diagnostics) {
        expect(diagnostic.code).toBe(`effect-native(${rule})`);
      }
      expect(
        run.diagnostics.filter(
          (diagnostic) =>
            diagnostic.filename.startsWith('valid/') && diagnostic.filename.endsWith('/production-default.ts'),
        ),
        `${rule}: explicit default negative reported`,
      ).toEqual([]);
      const fixture = decodeFixtureConfig(readFileSync(fixtureConfigPath(rule), 'utf-8'));
      const key = `effect-native/${rule}`;
      if (fixture.rules[key] === 'error') {
        // Non-default option fixtures remain owned by the ordinary fixture suite.
        const usesOverride = (file: string): boolean =>
          fixture.overrides?.some(
            (override) => key in override.rules && override.files.some((glob) => globToRegExp(glob).test(file)),
          ) ?? false;
        expect(
          run.diagnostics.filter(
            (diagnostic) => diagnostic.filename.startsWith('valid/') && !usesOverride(diagnostic.filename),
          ),
          `${rule}: production false positive`,
        ).toEqual([]);
      }
    }, tmpdir());
  });
}
