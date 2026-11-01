import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import plugin from '../index.ts';
import { listRuleNames } from '../shared/discover-rules.ts';
import { appRoot, pluginDirectory } from './oxlint.mts';

const RuleSetting = Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]);
// The production config is typed against oxlint's own definitions; only the fields this suite
// asserts on are decoded here, at the module boundary.
const ProductionConfigModule = Schema.Struct({
  default: Schema.Struct({
    overrides: Schema.Array(
      Schema.Struct({
        excludeFiles: Schema.optional(Schema.Array(Schema.String)),
        files: Schema.Array(Schema.String),
        rules: Schema.Record(Schema.String, RuleSetting),
      }),
    ),
  }),
});
const FixtureConfig = Schema.fromJsonString(
  Schema.Struct({
    ignorePatterns: Schema.optional(Schema.Array(Schema.String)),
    rules: Schema.Record(Schema.String, RuleSetting),
  }),
);
const decodeFixtureConfig = Schema.decodeUnknownSync(FixtureConfig);
const { default: config } = Schema.decodeUnknownSync(ProductionConfigModule)(
  await import(pathToFileURL(nodePath.join(appRoot, 'oxlint.config.ts')).href),
);
const rules = listRuleNames();

it('every rule is reporting-only and declares diagnostic metadata', () => {
  for (const [name, rule] of Object.entries(plugin.rules)) {
    expect(rule.meta, `${name} needs metadata`).toBeDefined();
    if (rule.meta === undefined) {
      throw new Error(`${name} needs metadata`);
    }
    expect(Object.keys(rule.meta.messages ?? {}).length > 0, `${name} needs messages`).toBe(true);
    expect(rule.meta.fixable, `${name} must not advertise fixes`).toBe(undefined);
    expect(!(rule.meta.hasSuggestions ?? false), `${name} must not advertise suggestions`).toBe(true);
  }
});

it('fixture configs enable only their owned rule without file-ignore shortcuts', () => {
  for (const rule of rules) {
    const fixture = decodeFixtureConfig(
      readFileSync(nodePath.join(pluginDirectory, 'tests', 'fixtures', rule, '.oxlintrc.json'), 'utf-8'),
    );
    expect(Object.keys(fixture.rules)).toEqual([`effect-native/${rule}`]);
    const setting = fixture.rules[`effect-native/${rule}`];
    expect(Array.isArray(setting) ? setting[0] : setting).toBe('error');
    expect((fixture.ignorePatterns ?? []).length === 0, `${rule} must exercise fixtures, not ignore them`).toBe(true);
  }
});

it('production test import policy is owned by exactly one override', () => {
  // production-config.test.mts proves through Oxlint that the override applies to tests but not e2e adapters.
  expect(config.overrides.filter((override) => 'eslint/no-restricted-imports' in override.rules)).toHaveLength(1);
});
