// @effect-diagnostics nodeBuiltinImport:off -- Synchronous static scan of the workspace sources; remove-when: the transport boundary becomes an oxlint rule.
import { readFileSync, readdirSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

const appRoot = new URL('../../../../', import.meta.url).pathname;
const skippedDirectories = new Set(['.git', 'dist', 'node_modules', 'tests', 'test', 'fixtures', '.modern', 'build']);

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return skippedDirectories.has(entry.name) || entry.name.startsWith('.')
        ? []
        : sourceFiles(nodePath.join(directory, entry.name));
    }
    return /\.(?:c|m)?tsx?$/u.test(entry.name) && !entry.name.endsWith('.d.ts')
      ? [nodePath.join(directory, entry.name)]
      : [];
  });

const sourcesMatching = (roots: readonly string[], allowed: string, matches: (source: string) => boolean) =>
  roots.flatMap((root) =>
    sourceFiles(nodePath.join(appRoot, root))
      .map((file) => nodePath.relative(appRoot, file))
      .filter((file) => file !== allowed)
      .filter((file) => matches(readFileSync(nodePath.join(appRoot, file), 'utf-8'))),
  );

// The runtime refuses remote I/O inside a marked transaction only because every transport is opened behind
// the guard. A second way to a platform transport, or a second Core pool, would bypass it.
it('opens the SpiceDB transport only behind the transaction guard', () => {
  expect(
    sourcesMatching(
      ['packages', 'verticals', 'apps'],
      'packages/core-runtime/src/permissions/spicedb-transaction-guard.ts',
      (source) => source.includes("'#spicedb-transport'") || /\bspiceDbTransport\.open\(/u.test(source),
    ),
  ).toEqual([]);
});

it('reaches module releases only through the guarded module transport', () => {
  expect(
    sourcesMatching(
      ['packages', 'verticals', 'apps'],
      'packages/core-runtime/src/http/unit-service-fetch.export.ts',
      (source) => source.includes("'#unit-service-fetch'"),
    ),
  ).toEqual([]);
});

it('creates the Core connection pool only behind the pool guard', () => {
  expect(
    sourcesMatching(['packages/core-runtime/src'], 'packages/core-runtime/src/db/client.ts', (source) =>
      /\bPgClient\.make\(/u.test(source),
    ),
  ).toEqual([]);
});
