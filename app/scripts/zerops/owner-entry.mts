#!/usr/bin/env node
/**
 * Turns one unit's generated Node deploy entry (`<unit>/.output/index.js`, emitted by `modern deploy --deploy-target
 * node`) into `<unit>/dist/zerops-entry.mjs`, which exports `start(port)` instead of listening on `PORT` at import.
 * The app host imports every owner's entry into one process; all of them resolve their packages through the one
 * installed workspace, so shared dependencies load once.
 *
 *   node scripts/zerops/owner-entry.mts <unit directory> [...]
 */
import { createRequire } from 'node:module';
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Effect, FileSystem, Layer, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';

export class OwnerEntryError extends Schema.TaggedError<OwnerEntryError>()('OwnerEntryError', {
  reason: Schema.String,
}) {}

const workspaceRoot = path.resolve(import.meta.dirname, '../..');

const MAIN = 'async function main() {';
/** A package without `"type": "module"` gets the CommonJS variant of the generated entry. */
const COMMONJS_SERVER = "require('@modern-js/prod-server')";
/** Loads the CommonJS entry, so the host imports every unit through the same `dist/zerops-entry.mjs`. */
const COMMONJS_SHIM = [
  "import { createRequire } from 'node:module';",
  '',
  "export const { start } = createRequire(import.meta.url)('./zerops-entry.cjs');",
  '',
].join('\n');

export const isCommonJsEntry = (generated: string): boolean => generated.includes(COMMONJS_SERVER);
const PORT = 'const port = process.env.PORT || 8080;';
const RUN = '\nmain();';

const relativeImport = (distDirectory: string, absolute: string) => {
  const relative = path.relative(distDirectory, absolute);
  const specifier = relative.startsWith('.') ? relative : `./${relative}`;
  return `'${specifier}'`;
};

/**
 * Rewrites the generated entry. Its package imports were traced into `.output/node_modules`; here they resolve to the
 * installed workspace files instead (through `resolvePackage`), as paths relative to dist/ so the tree can move.
 */
export const ownerEntrySource = (
  generated: string,
  distDirectory: string,
  resolvePackage: (specifier: string) => string,
): string | undefined => {
  if (!generated.includes(MAIN) || !generated.includes(PORT) || !generated.trimEnd().endsWith('main();')) {
    return undefined;
  }
  const relocated = generated
    .replaceAll(/'(?<absolute>\/[^']+\/node_modules\/[^']+)'/gu, (_match, absolute: string) =>
      relativeImport(distDirectory, absolute),
    )
    .replaceAll(/ from '(?<specifier>(?:@[^'/]+\/)?[^'./][^':]*)'/gu, (_match, specifier: string) =>
      specifier.startsWith('node:') ? _match : ` from ${relativeImport(distDirectory, resolvePackage(specifier))}`,
    )
    .replaceAll(/require\('(?<specifier>(?:@[^'/]+\/)?[^'./][^':]*)'\)/gu, (_match, specifier: string) =>
      specifier.startsWith('node:') ? _match : `require(${relativeImport(distDirectory, resolvePackage(specifier))})`,
    );
  const commonJs = isCommonJsEntry(generated);
  return (
    relocated
      .replace(MAIN, commonJs ? 'async function start(port) {' : 'export async function start(port) {')
      .replace(PORT, '')
      // Owners answer only the host's loopback relay, never the container's private network.
      .replace('app.listen({', "app.listen({ host: '127.0.0.1',")
      .replace(/\nmain\(\);\s*$/u, commonJs ? '\nmodule.exports = { start };\n' : '\n')
      .replace(RUN, '')
  );
};

const writeOwnerEntry = Effect.fn('OwnerEntry.write')(function* writeOwnerEntry(unitDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const unit = path.resolve(workspaceRoot, unitDirectory);
  const dist = path.join(unit, 'dist');
  const generated = yield* fs.readFileString(path.join(unit, '.output', 'index.js'));
  const fromUnit = createRequire(path.join(unit, 'package.json'));
  // The prod server is a dependency of the unit's build tooling, not of the unit itself.
  const fromTools = createRequire(
    path.join(yield* fs.realPath(path.join(unit, 'node_modules', '@modern-js', 'app-tools')), 'package.json'),
  );
  const resolvePackage = (specifier: string) => {
    try {
      return fromUnit.resolve(specifier);
    } catch {
      return fromTools.resolve(specifier);
    }
  };
  const source = ownerEntrySource(generated, dist, resolvePackage);
  if (source === undefined) {
    return yield* new OwnerEntryError({ reason: `${unitDirectory}/.output/index.js has an unexpected shape` });
  }
  const entry = path.join(dist, 'zerops-entry.mjs');
  if (isCommonJsEntry(generated)) {
    yield* fs.writeFileString(path.join(dist, 'zerops-entry.cjs'), source);
    yield* fs.writeFileString(entry, COMMONJS_SHIM);
  } else {
    yield* fs.writeFileString(entry, source);
  }
  return yield* Console.log(`wrote ${path.relative(workspaceRoot, entry)}`);
});

const command = Command.make(
  'owner-entry',
  { units: Argument.String('unit-directory').pipe(Argument.atLeast(1)) },
  ({ units }) => Effect.forEach(units, writeOwnerEntry, { discard: true }),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(Command.run({ version: '1.0.0' })(command)).pipe(Layer.provide(NodeServices.layer)),
    ).pipe(Effect.scoped),
  );
}
