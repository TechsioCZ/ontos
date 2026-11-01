import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { fixtureConfigPath, runOxlint } from './oxlint.mts';
import {
  directiveSuppressedFixtures,
  fixtureOptions,
  fixturesDirectory,
  productionOptions,
  testEffectNativeRule,
  withOptions,
} from './rule-tester.mts';

/**
 * Each rule owns `fixtures/<rule>/{valid,invalid}/**`. Every file becomes one RuleTester case at its
 * real absolute path, linted with the options its `.oxlintrc.json` selects for that path.
 * An invalid file states its exact diagnostic count in a leading `// expect-count: N` comment, or,
 * where a leading comment would change the input (shebangs, BOMs, suppression headers), in
 * `fixtures/expected-counts.json`.
 */
const onlyRule = process.env.RULE;

const listFiles = (directory: string): readonly string[] => {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .flatMap((entry) => {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) {
        return listFiles(full);
      }
      return entry.startsWith('.') ? [] : [full];
    })
    .toSorted();
};

const rules = readdirSync(fixturesDirectory)
  .filter((entry) => statSync(path.join(fixturesDirectory, entry)).isDirectory())
  .filter((rule) => onlyRule === undefined || onlyRule === '' || rule === onlyRule)
  .toSorted();

const countsFile = path.join(fixturesDirectory, 'expected-counts.json');
const expectedCounts = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Int.check(Schema.isGreaterThan(0)))),
)(readFileSync(countsFile, 'utf-8'));
const fixtureKey = (file: string): string => path.relative(fixturesDirectory, file).replaceAll('\\', '/');

const expectedCount = (file: string): number => {
  const header = /^\/\/\s*expect-count:\s*(?<count>\d+)/u.exec(readFileSync(file, 'utf-8'))?.groups?.count;
  const listed = expectedCounts[fixtureKey(file)];
  if (header !== undefined && listed !== undefined) {
    throw new Error(`${fixtureKey(file)} declares its count twice`);
  }
  const count = header === undefined ? listed : Number(header);
  if (count === undefined || count <= 0) {
    throw new Error(`${fixtureKey(file)} needs a positive expect-count header or expected-counts.json entry`);
  }
  return count;
};

it('fixture directories exist and every count entry names an invalid fixture', () => {
  const suffix = onlyRule === undefined || onlyRule === '' ? '' : ` for ${onlyRule}`;
  expect(rules, `No fixture directories found${suffix}.`).not.toHaveLength(0);
  for (const key of Object.keys(expectedCounts)) {
    const file = path.join(fixturesDirectory, key);
    expect(existsSync(file) && key.split('/')[1] === 'invalid', `${key} is not an invalid fixture`).toBe(true);
  }
});

for (const rule of rules) {
  const fixtureDirectory = path.join(fixturesDirectory, rule);
  const invalid = listFiles(path.join(fixtureDirectory, 'invalid'));
  const valid = listFiles(path.join(fixtureDirectory, 'valid'));
  it(`effect-native/${rule} has valid and invalid fixtures`, () => {
    expect(invalid.length, `${rule}: add at least one file under invalid/`).toBeGreaterThan(0);
    expect(valid.length, `${rule}: add at least one file under valid/`).toBeGreaterThan(0);
  });
  const suppressed = valid.filter((filename) => directiveSuppressedFixtures.has(fixtureKey(filename)));
  const fixtureCase = (filename: string) => ({
    code: readFileSync(filename, 'utf-8'),
    cwd: fixtureDirectory,
    filename,
    name: path.relative(fixtureDirectory, filename),
    ...withOptions(fixtureOptions(rule, filename)),
  });
  testEffectNativeRule(
    rule,
    {
      invalid: [
        ...invalid.map((filename) => ({ ...fixtureCase(filename), errors: expectedCount(filename) })),
        ...suppressed.map((filename) => ({
          ...fixtureCase(filename),
          errors: [{ messageId: 'ungovernedSuppression' }],
        })),
      ],
      valid: valid.filter((filename) => !suppressed.includes(filename)).map(fixtureCase),
    },
    `effect-native/${rule} fixtures`,
  );
}

for (const key of directiveSuppressedFixtures) {
  const [rule = ''] = key.split('/');
  it(`Oxlint applies the blanket disable directive in ${key} before plugin diagnostics`, () => {
    const fixtureDirectory = path.join(fixturesDirectory, rule);
    const run = runOxlint(fixtureConfigPath(rule), [path.relative(rule, key)], fixtureDirectory);
    expect(run.numberOfFiles).toBe(1);
    expect(run.exitCode).toBe(0);
    expect(run.diagnostics).toEqual([]);
    // The production-settings suite skips this file; its settings match the fixture settings.
    expect(productionOptions(`effect-native/${rule}`)).toEqual(fixtureOptions(rule));
  });
}
