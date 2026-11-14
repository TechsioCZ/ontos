#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';

// This reads a saved compiler log. It neither runs a compiler nor removes diagnostics from the gate.
const logPath = process.argv[2];
if (!logPath) {
  throw new Error('Usage: node scripts/typecheck-findings.mjs <saved-log> [--locations]');
}
const text = stripVTControlCharacters(readFileSync(logPath, 'utf8'));
const findings = [...text.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/gmu)].map(
  ([, file, line, column, code, message]) => ({ file, line: Number(line), column: Number(column), code, message }),
);
const byOwner = new Map();
const byCode = new Map();
for (const finding of findings) {
  const parts = finding.file.replaceAll('\\', '/').split('/');
  const owner = ['apps', 'verticals', 'packages'].includes(parts[0]) ? parts.slice(0, 2).join('/') : parts[0];
  byOwner.set(owner, (byOwner.get(owner) ?? 0) + 1);
  byCode.set(finding.code, (byCode.get(finding.code) ?? 0) + 1);
}
const descending = (entries) => Object.fromEntries([...entries].sort((left, right) => right[1] - left[1]));
console.info(
  JSON.stringify(
    {
      source: logPath,
      status: 'Saved-run observations only; rerun the gate to establish remaining findings.',
      count: findings.length,
      byOwner: descending(byOwner),
      byCode: descending(byCode),
      ...(process.argv.includes('--locations') ? { findings } : {}),
    },
    null,
    2,
  ),
);
