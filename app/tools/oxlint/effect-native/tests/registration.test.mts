import { expect, it } from '@app/effect-rstest';
import { Schema } from 'effect';
import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

import plugin from '../index.ts';
import { listRuleNames } from '../shared/discover-rules.ts';
import { appRoot, listFixtureRules, pluginDirectory } from './oxlint.mts';

const RuleSetting = Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]);
// The production config is typed against oxlint's own definitions; only the fields this suite
// asserts on are decoded here, at the module boundary.
const ProductionConfigModule = Schema.Struct({
  default: Schema.Struct({
    jsPlugins: Schema.optional(Schema.Array(Schema.Unknown)),
    options: Schema.optional(
      Schema.Struct({
        denyWarnings: Schema.optional(Schema.Boolean),
        typeAware: Schema.optional(Schema.Boolean),
        typeCheck: Schema.optional(Schema.Boolean),
      }),
    ),
    rules: Schema.optional(Schema.Record(Schema.String, RuleSetting)),
  }),
});
const FixtureConfig = Schema.fromJsonString(
  Schema.Struct({
    ignorePatterns: Schema.optional(Schema.Array(Schema.String)),
    rules: Schema.Record(Schema.String, RuleSetting),
  }),
);
const NamedPluginEntry = Schema.Struct({ name: Schema.String, specifier: Schema.String });
const isNamedPluginEntry = Schema.is(NamedPluginEntry);
const decodeFixtureConfig = Schema.decodeUnknownSync(FixtureConfig);
const { default: config } = Schema.decodeUnknownSync(ProductionConfigModule)(
  await import(pathToFileURL(nodePath.join(appRoot, 'oxlint.config.ts')).href),
);
const configuredRules = config.rules ?? {};
const rules = listRuleNames();

it('every rule is actually exported, enabled at error severity, and covered by fixtures', () => {
  expect(rules.length > 0, 'the plugin cannot be empty').toBe(true);
  expect(Object.keys(plugin.rules).toSorted()).toEqual(rules);
  expect([...listFixtureRules()].toSorted()).toEqual(rules);
  const configured = Object.keys(configuredRules).filter((name) =>
    name.startsWith('effect-native/'),
  );
  expect(configured.toSorted()).toEqual(rules.map((name) => `effect-native/${name}`));
  for (const rule of rules) {
    const setting = configuredRules[`effect-native/${rule}`];
    expect(Array.isArray(setting) ? setting[0] : setting, `${rule} must be an error`).toBe('error');
  }
});

it('production configuration loads the plugin and preserves strict typed linting', () => {
  expect(
    (config.jsPlugins ?? []).some(
      (entry) =>
        isNamedPluginEntry(entry) &&
        entry.name === 'effect-native' &&
        entry.specifier === './tools/oxlint/effect-native/index.ts',
    ),
  ).toBe(true);
  expect(config.options?.typeAware).toBe(true);
  expect(config.options?.typeCheck).toBe(true);
  expect(config.options?.denyWarnings).toBe(true);
});

it('every rule is reporting-only and declares diagnostic metadata', () => {
  for (const [name, rule] of Object.entries(plugin.rules)) {
    expect(rule.meta, `${name} needs metadata`).toBeDefined();
    if (rule.meta === undefined) {
      throw new Error(`${name} needs metadata`);
    }
    expect(Object.keys(rule.meta.messages ?? {}).length > 0, `${name} needs messages`).toBe(true);
    expect(rule.meta.fixable, `${name} must not advertise fixes`).toBe(undefined);
    expect(!(rule.meta.hasSuggestions ?? false), `${name} must not advertise suggestions`).toBe(
      true,
    );
  }
});

it('fixture configs enable only their owned rule without file-ignore shortcuts', () => {
  for (const rule of rules) {
    const fixture = decodeFixtureConfig(
      readFileSync(
        nodePath.join(pluginDirectory, 'tests', 'fixtures', rule, '.oxlintrc.json'),
        'utf-8',
      ),
    );
    expect(Object.keys(fixture.rules)).toEqual([`effect-native/${rule}`]);
    const setting = fixture.rules[`effect-native/${rule}`];
    expect(Array.isArray(setting) ? setting[0] : setting).toBe('error');
    expect(
      (fixture.ignorePatterns ?? []).length === 0,
      `${rule} must exercise fixtures, not ignore them`,
    ).toBe(true);
  }
});
