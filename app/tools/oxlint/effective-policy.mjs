// Read the actual analyzer packages and Oxlint's merged config, not the source spelling of the presets.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire, findPackageJSON } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const publishedPlugins = {
  '@nkzw': '@nkzw/eslint-plugin',
  github: 'eslint-plugin-github/lib/plugin.js',
  perfectionist: 'eslint-plugin-perfectionist',
  'react-doctor': 'oxlint-plugin-react-doctor',
  sonarjs: 'eslint-plugin-sonarjs',
};
const pinned = [
  'oxlint',
  '@effect/tsgo',
  'tsrs',
  'ultracite',
  '@oxlint/plugins',
  '@nkzw/eslint-plugin',
  'eslint-plugin-github',
  'eslint-plugin-perfectionist',
  'oxlint-plugin-react-doctor',
  'eslint-plugin-sonarjs',
];
const severity = (value) => (Array.isArray(value) ? value[0] : value);
export function capture(root) {
  const manifest = path.join(root, 'package.json');
  const req = createRequire(manifest);
  const output = execFileSync(path.join(root, 'node_modules/.bin/oxlint'), ['--print-config'], {
    cwd: root,
    encoding: 'utf-8',
  });
  const stylesheet = '@techsio/ui-kit/styles.css';
  const asset = createRequire(path.join(root, 'apps/shell-super-app/package.json')).resolve(stylesheet);
  const config = JSON.parse(output.replaceAll(JSON.stringify(asset), JSON.stringify(stylesheet)));
  config.jsPlugins.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  // Override order stays intact. Include rule defaults even for rules enabled only in an override.
  const active = new Set(
    [config, ...config.overrides].flatMap((part) =>
      Object.entries(part.rules ?? {})
        .filter(([, setting]) => severity(setting) !== 'allow')
        .map(([name]) => name),
    ),
  );
  const defaults = {};
  for (const [name, spec] of Object.entries(publishedPlugins)) {
    const mod = req(spec);
    for (const [key, rule] of Object.entries((mod.default ?? mod).rules)) {
      const id = name + '/' + key;
      if (active.has(id)) defaults[id] = rule.meta?.defaultOptions ?? rule.defaultOptions ?? null;
    }
  }
  // Native/opaque defaults can change even if --print-config and public metadata do not. Upgrades require a reviewed refresh.
  const versions = Object.fromEntries(
    pinned.map((name) => [
      name,
      JSON.parse(readFileSync(findPackageJSON(name, pathToFileURL(manifest)), 'utf-8')).version,
    ]),
  );
  return { config, defaults, versions };
}

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  return value && typeof value === 'object'
    ? Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((k) => [k, ordered(value[k])]),
      )
    : value;
}
const stable = (value) => JSON.stringify(ordered(value));
const digest = (value) => createHash('sha256').update(stable(value)).digest('hex');
const changes = (a, b) =>
  Object.fromEntries(
    [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .sort()
      .filter((k) => stable(a[k]) !== stable(b[k]))
      .map((k) => [k, { before: a[k] ?? null, after: b[k] ?? null }]),
  );
function scopeDelta(before, after) {
  let next = 0;
  const retained = [],
    removed = [];
  for (const [index, value] of before.entries()) {
    const found = after.findIndex((other, i) => i >= next && stable(other) === stable(value));
    if (found < 0) removed.push({ index, value });
    else {
      retained.push([index, found]);
      next = found + 1;
    }
  }
  const kept = new Set(retained.map(([, i]) => i));
  return { retained, removed, added: after.flatMap((value, index) => (kept.has(index) ? [] : [{ index, value }])) };
}
export function compare(before, after, baseCommit) {
  const { rules: oldRules, overrides: oldScopes, ...oldOther } = before.config;
  const { rules, overrides, ...other } = after.config;
  return {
    baseCommit,
    basePolicySha256: digest(before),
    candidatePolicySha256: digest(after),
    rules: changes(oldRules, rules),
    overrides: scopeDelta(oldScopes, overrides),
    other: changes(oldOther, other),
    declaredDefaults: changes(before.defaults, after.defaults),
    analyzerVersions: changes(before.versions, after.versions),
  };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [mode, root, head, baseCommit] = process.argv.slice(2);
  if (mode !== 'snapshot' && mode !== 'diff') throw new Error('Use snapshot APP or diff BASE_APP HEAD_APP BASE_COMMIT');
  const output =
    mode === 'snapshot'
      ? capture(path.resolve(root))
      : compare(capture(path.resolve(root)), capture(path.resolve(head)), baseCommit);
  process.stdout.write(JSON.stringify(ordered(output), null, 2) + '\n');
}
