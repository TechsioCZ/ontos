/**
 * Run one effect-native rule (via its fixture config) against the real repository and print a summary.
 * Usage: node tools/oxlint/effect-native/tests/run-on-repo.mts <rule> [--all] [--limit=N]
 */
import { appRoot, fixtureConfigPath, runOxlint } from './oxlint.mts';

const [rule, ...flags] = process.argv.slice(2);
if (!rule) {
  console.error('usage: run-on-repo.mts <rule> [--all] [--limit=N]');
  process.exit(2);
}
const showAll = flags.includes('--all');
if (flags.some((flag) => flag !== '--all' && !/^--limit=\d+$/u.test(flag)))
  throw new Error('Unknown report flag');
const limit = Number(
  flags.find((flag) => flag.startsWith('--limit='))?.slice('--limit='.length) ?? 40,
);
if (!Number.isSafeInteger(limit) || limit < 1)
  throw new Error('--limit must be a positive integer');
const run = runOxlint(
  fixtureConfigPath(rule),
  ['apps', 'verticals', 'packages', 'scripts'],
  appRoot,
);
if (run.stderr.trim()) console.error(run.stderr.trim());
for (const diagnostic of run.diagnostics) {
  if (diagnostic.code !== `effect-native(${rule})`)
    throw new Error(`Unexpected diagnostic: ${diagnostic.code}`);
}
const hits = run.diagnostics;
const perFile = new Map<string, number>();
for (const hit of hits) perFile.set(hit.filename, (perFile.get(hit.filename) ?? 0) + 1);
const groups = { scripts: 0, src: 0, tests: 0 };
for (const [file, count] of perFile) {
  if (/(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec|test-d|spec-d)\.[cm]?[jt]sx?$/u.test(file))
    groups.tests += count;
  else if (/(?:^|\/)scripts\//u.test(file)) groups.scripts += count;
  else groups.src += count;
}
console.log(
  JSON.stringify({
    rule,
    settings: 'fixture (may differ from production)',
    total: hits.length,
    files: perFile.size,
    ...groups,
  }),
);
process.exitCode = run.exitCode;
const sorted = [...perFile.entries()].sort((a, b) => b[1] - a[1]);
for (const [file, count] of sorted.slice(0, showAll ? sorted.length : 25))
  console.log(`${String(count).padStart(4)}  ${file}`);
console.log('--- sample diagnostics ---');
for (const hit of hits.slice(0, showAll ? hits.length : limit)) {
  const span = hit.labels[0]?.span;
  console.log(`${hit.filename}:${span?.line ?? 0}:${span?.column ?? 0}  ${hit.message}`);
}
