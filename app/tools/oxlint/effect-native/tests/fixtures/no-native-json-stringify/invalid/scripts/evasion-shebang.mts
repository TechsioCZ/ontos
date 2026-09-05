#!/usr/bin/env node
// A7 report writer with a shebang on line 1 (no expect-count pragma is possible here).
declare const report: unknown;

process.stdout.write(JSON.stringify(report, null, 2));
