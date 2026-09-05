import { join } from 'node:path';

import plugin from './index.ts';
import { appRoot, pluginDirectory, runOxlint } from './tests/oxlint.mts';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--json'))
  throw new Error('Usage: node tools/oxlint/effect-native/report.mts [--json]');
if (Object.keys(plugin.rules).length === 0)
  throw new Error('No Effect-native rules are registered.');

const scope = ['apps', 'verticals', 'packages', 'scripts'];
const run = runOxlint(join(pluginDirectory, 'report.config.ts'), scope, appRoot);
const byRule = new Map(
  Object.keys(plugin.rules)
    .sort()
    .map((rule) => [rule, { total: 0, source: 0, tests: 0, scripts: 0 }]),
);
const byFile = new Map<string, number>();

for (const diagnostic of run.diagnostics) {
  const name = /^effect-native\(([^)]+)\)$/u.exec(diagnostic.code)?.[1];
  const row = name ? byRule.get(name) : undefined;
  if (!row) throw new Error(`Unexpected diagnostic in Effect report: ${diagnostic.code}`);
  const filename = diagnostic.filename.replaceAll('\\', '/');
  row.total++;
  // Test files are tests even when they live under scripts/; categories never overlap.
  if (/(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec|test-d|spec-d)\.[cm]?[jt]sx?$/u.test(filename))
    row.tests++;
  else if (/(?:^|\/)scripts\//u.test(filename)) row.scripts++;
  else row.source++;
  byFile.set(filename, (byFile.get(filename) ?? 0) + 1);
}

const report = {
  scope,
  rulesEnabled: byRule.size,
  filesLinted: run.numberOfFiles,
  totalDiagnostics: run.diagnostics.length,
  filesWithDiagnostics: byFile.size,
  rules: [...byRule].map(([rule, counts]) => ({ rule, ...counts })),
  files: [...byFile]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([file, count]) => ({ file, count })),
  diagnostics: run.diagnostics,
};

if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `Effect-native: ${report.rulesEnabled} rules, ${report.filesLinted} files linted, ${report.totalDiagnostics} diagnostics in ${report.filesWithDiagnostics} files.`,
  );
  console.log(`Scope: ${scope.join(' ')}. Reporting only; no application files changed.`);
  console.log('\nRULE | TOTAL | SOURCE | TESTS | SCRIPTS');
  for (const row of report.rules)
    console.log(`${row.rule} | ${row.total} | ${row.source} | ${row.tests} | ${row.scripts}`);
  console.log('\nFILES (top 20; use --json for the complete report)');
  for (const row of report.files.slice(0, 20)) console.log(`${row.count}\t${row.file}`);
}
process.exitCode = run.exitCode;
