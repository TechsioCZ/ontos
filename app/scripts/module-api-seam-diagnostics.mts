#!/usr/bin/env node
// Merge diagnostics: explain why an owner's generated module API seam (`<owner>/shared/api.ts`) fails, i.e. the
// cause behind `api:check:ontos` "module APIs require an approved Codesmith generator …" and behind consumer
// imports of that owner's clients. Prints OK or the seam proof's diagnostics per owner.
//   pnpm exec node scripts/module-api-seam-diagnostics.mts verticals/<owner> [verticals/<owner> …]
import { Console, Effect, FileSystem, Path, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';

import { hasCompleteGeneratedModuleApiSeam } from './generated-governed-http-boundary.mts';
import { runQualityCli } from './quality-cli-lifecycle.mts';

const SOURCE_ROOTS = ['verticals', 'packages', 'apps'] as const;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'tests', 'fixtures']);
const SOURCE_FILE = /\.(?:ts|tsx|mts|json)$/u;

const collectSources = (fileSystem: FileSystem.FileSystem, path: Path.Path, root: string) =>
  Effect.gen(function* collectWorkspaceSources() {
    const sources = new Map<string, string>();
    const pending: string[] = [...SOURCE_ROOTS];
    for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
      const parent = directory;
      const entries = yield* fileSystem.readDirectory(path.join(root, parent));
      for (const entry of entries) {
        const relative = `${parent}/${entry}`;
        const info =
          SKIPPED_DIRECTORIES.has(entry) || entry.startsWith('.')
            ? undefined
            : yield* fileSystem.stat(path.join(root, relative));
        if (info?.type === 'Directory') {
          pending.push(relative);
        } else if (info?.type === 'File' && SOURCE_FILE.test(entry)) {
          sources.set(relative, yield* fileSystem.readFileString(path.join(root, relative), 'utf-8'));
        }
      }
    }
    return sources;
  });

const cli = Command.make(
  'module-api-seam-diagnostics',
  { owners: Argument.String('owner-directory').pipe(Argument.atLeast(1)) },
  ({ owners }) =>
    Effect.gen(function* moduleApiSeamDiagnostics() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL('..', import.meta.url));
      const sources = yield* collectSources(fileSystem, path, root);
      const reports = owners.map((owner) => {
        const diagnostics: string[] = [];
        const valid = hasCompleteGeneratedModuleApiSeam(
          sources,
          `${owner.replace(/\/$/u, '')}/shared/api.ts`,
          undefined,
          diagnostics,
        );
        return [owner, valid ? '  OK' : diagnostics.map((line) => `  ${line}`).join('\n')].join('\n');
      });
      return yield* Console.log(reports.join('\n'));
    }),
);

if (Schema.is(Schema.Struct({ main: Schema.Literal(true) }))(import.meta)) {
  runQualityCli(Command.run(cli, { version: '1.0.0' }));
}
