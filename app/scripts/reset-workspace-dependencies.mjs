#!/usr/bin/env node

import { NodeServices } from '@effect/platform-node';
import { Console, Effect, FileSystem, Path } from 'effect';

const main = Effect.gen(function* resetWorkspaceDependenciesEffect() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaceRoot = path.resolve(import.meta.dirname, '..');
  const dependencyDirectories = [path.join(workspaceRoot, 'node_modules')];

  for (const scope of ['apps', 'packages', 'verticals']) {
    const scopeDirectory = path.join(workspaceRoot, scope);
    const entries = yield* fileSystem.readDirectory(scopeDirectory);
    const packageDirectories = yield* Effect.filter(
      entries,
      (entry) =>
        fileSystem
          .stat(path.join(scopeDirectory, entry))
          .pipe(Effect.map((info) => info.type === 'Directory')),
      { concurrency: 'unbounded' }
    );
    dependencyDirectories.push(
      ...packageDirectories.map((entry) =>
        path.join(scopeDirectory, entry, 'node_modules')
      )
    );
  }

  yield* Effect.forEach(
    dependencyDirectories,
    (directory) =>
      fileSystem.remove(directory, { force: true, recursive: true }),
    { concurrency: 'unbounded', discard: true }
  );

  yield* Console.log(
    `Removed ${dependencyDirectories.length} workspace dependency directories`
  );
});

await Effect.runPromise(main.pipe(Effect.provide(NodeServices.layer)));
