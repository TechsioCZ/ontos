// Tax's browser client (`@app/tax/api/client`) runs in other modules' pages: Finance's DPH page imports it. Every Tax
// source file it reaches must stay free of server-only code, or the page's client build fails on Node built-ins. The
// Core root barrel is server-only (it pulls the SpiceDB client, gRPC and PostgreSQL); browser code takes Core's
// subpaths instead. Type-only imports are erased and do not count.
import { NodeServices } from '@effect/platform-node';
import { expect, it } from 'effect-rstest';
import { Effect, FileSystem, Path } from 'effect';

const taxRoot = new URL('../../', import.meta.url).pathname;
const clientEntry = new URL('../../src/api/tax-client.ts', import.meta.url).pathname;
/** The Core root barrel exactly (its subpaths are fine), and these packages with any subpath. */
const SERVER_ROOTS = new Set(['@app/core-runtime']);
const SERVER_PACKAGES = ['@authzed/authzed-node', '@effect/sql-pg', 'pg', 'drizzle-orm'];
const serverOnly = (specifier: string) =>
  SERVER_ROOTS.has(specifier) ||
  SERVER_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`)) ||
  specifier.startsWith('node:');
const IMPORT = /^\s*(?:import|export)\s+(?!type[\s{])(?:[^'";]*?\sfrom\s+)?['"](?<specifier>[^'"]+)['"]/gmu;

const specifiersOf = (source: string) => [...source.matchAll(IMPORT)].map((match) => match.groups?.['specifier'] ?? '');

/** Every server-only value import of the Tax files the browser client reaches, as `file: specifier`. */
const reachedImports = Effect.fn('TaxBrowserClient.reachedImports')(function* reachedImports() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const seen = new Set<string>([clientEntry]);
  const pending = [clientEntry];
  const imports: string[] = [];
  let files = 0;
  while (pending.length > 0) {
    const file = pending.pop() ?? clientEntry;
    files += 1;
    for (const specifier of specifiersOf(yield* fileSystem.readFileString(file))) {
      if (serverOnly(specifier)) {
        imports.push(`${path.relative(taxRoot, file)}: ${specifier}`);
      }
      const resolved = path.resolve(path.dirname(file), specifier);
      const next = path.extname(resolved) === '' ? `${resolved}.ts` : resolved;
      if (specifier.startsWith('.') && !seen.has(next)) {
        seen.add(next);
        pending.push(next);
      }
    }
  }
  return { files, imports };
});

it.layer(NodeServices.layer)('the Tax browser client', (suite) => {
  suite.effect('reaches no server-only module, the Core root barrel included', () =>
    Effect.gen(function* serverFreeClient() {
      const { files, imports } = yield* reachedImports();
      expect(files).toBeGreaterThan(20);
      expect(imports).toEqual([]);
    }),
  );
});
