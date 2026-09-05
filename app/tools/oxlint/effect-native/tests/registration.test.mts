import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import type { Rule } from '@oxlint/plugins';

import { listRuleNames } from '../shared/discover-rules.ts';
import { appRoot, listFixtureRules, pluginDirectory } from './oxlint.mts';

const pluginModule = await import(pathToFileURL(join(pluginDirectory, 'index.ts')).href);
const configModule = await import(pathToFileURL(join(appRoot, 'oxlint.config.ts')).href);
const plugin: { rules: Record<string, Rule> } = pluginModule.default;
const config: {
  rules: Record<string, unknown>;
  options: { typeAware?: boolean; typeCheck?: boolean; denyWarnings?: boolean };
  jsPlugins: unknown[];
} = configModule.default;
const rules = listRuleNames();

test('every rule is actually exported, enabled at error severity, and covered by fixtures', () => {
  assert.ok(rules.length > 0, 'the plugin cannot be empty');
  assert.deepEqual(Object.keys(plugin.rules).sort(), rules);
  assert.deepEqual([...listFixtureRules()].sort(), rules);
  const configured = Object.keys(config.rules).filter((name) => name.startsWith('effect-native/'));
  assert.deepEqual(
    configured.sort(),
    rules.map((name) => `effect-native/${name}`),
  );
  for (const rule of rules) {
    const setting = config.rules[`effect-native/${rule}`];
    assert.equal(
      Array.isArray(setting) ? setting[0] : setting,
      'error',
      `${rule} must be an error`,
    );
  }
});

test('production configuration loads the plugin and preserves strict typed linting', () => {
  assert.ok(
    config.jsPlugins.some(
      (plugin) =>
        typeof plugin === 'object' &&
        plugin !== null &&
        'name' in plugin &&
        plugin.name === 'effect-native' &&
        'specifier' in plugin &&
        plugin.specifier === './tools/oxlint/effect-native/index.ts',
    ),
  );
  assert.equal(config.options.typeAware, true);
  assert.equal(config.options.typeCheck, true);
  assert.equal(config.options.denyWarnings, true);
});

test('every rule is reporting-only and declares diagnostic metadata', () => {
  for (const [name, rule] of Object.entries(plugin.rules)) {
    assert.ok(rule.meta, `${name} needs metadata`);
    assert.ok(Object.keys(rule.meta.messages ?? {}).length > 0, `${name} needs messages`);
    assert.equal(rule.meta.fixable, undefined, `${name} must not advertise fixes`);
    assert.ok(!rule.meta.hasSuggestions, `${name} must not advertise suggestions`);
  }
});

test('fixture configs enable only their owned rule without file-ignore shortcuts', () => {
  for (const rule of rules) {
    const fixture = JSON.parse(
      readFileSync(join(pluginDirectory, 'tests', 'fixtures', rule, '.oxlintrc.json'), 'utf8'),
    );
    assert.deepEqual(Object.keys(fixture.rules), [`effect-native/${rule}`]);
    const setting = fixture.rules[`effect-native/${rule}`];
    assert.equal(Array.isArray(setting) ? setting[0] : setting, 'error');
    assert.ok(!fixture.ignorePatterns?.length, `${rule} must exercise fixtures, not ignore them`);
  }
});
