import { readFileSync, readdirSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

const appRoot = new URL('../../../../', import.meta.url).pathname;
const guardModule = 'packages/core-runtime/src/permissions/spicedb-transaction-guard.ts';
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

// The runtime refuses SpiceDB inside a marked transaction only because every connection is opened through
// `openSpiceDbRpc`. A second way to the platform transport would bypass that guard.
it('opens the SpiceDB transport only behind the transaction guard', () => {
  const bypasses = ['packages', 'verticals', 'apps'].flatMap((root) =>
    sourceFiles(nodePath.join(appRoot, root))
      .map((file) => nodePath.relative(appRoot, file))
      .filter((file) => file !== guardModule)
      .filter((file) => {
        const source = readFileSync(nodePath.join(appRoot, file), 'utf-8');
        return source.includes("'#spicedb-transport'") || /\bspiceDbTransport\.open\(/u.test(source);
      }),
  );
  expect(bypasses).toEqual([]);
});
