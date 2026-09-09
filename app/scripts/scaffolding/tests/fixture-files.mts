import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Effect } from 'effect';

export const write = Effect.fn(function* writeFixture(root: string, relativePath: string, content: string) {
  const target = path.join(root, relativePath);
  yield* Effect.promise(async () => await mkdir(path.dirname(target), { recursive: true }));
  yield* Effect.promise(async () => await writeFile(target, content, 'utf-8'));
});

const visitTree = (
  root: string,
  directory: string,
  excludedDirectories: readonly string[],
  snapshot: Record<string, string>,
): Effect.Effect<void> =>
  Effect.gen(function* visitFixtureTree() {
    const entries = yield* Effect.promise(async () => await readdir(directory, { withFileTypes: true }));
    yield* Effect.forEach(
      entries.toSorted((left, right) => left.name.localeCompare(right.name)),
      Effect.fn(function* visitFixtureEntry(entry) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory() && !excludedDirectories.includes(entry.name)) {
          yield* visitTree(root, target, excludedDirectories, snapshot);
        } else if (entry.isFile()) {
          snapshot[path.relative(root, target)] = yield* Effect.promise(async () => await readFile(target, 'utf-8'));
        }
      }),
      { concurrency: 'unbounded', discard: true },
    );
  });

export const snapshotTree = Effect.fn(function* snapshotFixtureTree(
  root: string,
  excludedDirectories: readonly string[] = [],
) {
  const snapshot: Record<string, string> = {};
  yield* visitTree(root, root, excludedDirectories, snapshot);
  return snapshot;
});
