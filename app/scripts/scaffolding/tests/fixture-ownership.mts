import { Effect } from 'effect';
import { mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';

/** Link only the dependencies a generated subprocess fixture actually needs. */
export const linkFixtureDependencies = Effect.fn(function* linkFixtureDependencies(
  root: string,
  appRoot: string,
  dependencies: Readonly<Record<string, string>>,
) {
  for (const [name, source] of Object.entries(dependencies)) {
    const target = path.join(root, 'node_modules', name);
    yield* Effect.promise(async () => await mkdir(path.dirname(target), { recursive: true }));
    yield* Effect.promise(async () => await symlink(path.join(appRoot, source), target, 'dir'));
  }
});

/** Keep fixture ownership local, including cleanup when the scenario fails. */
export const withCreatedFixture =
  (create: Effect.Effect<string, unknown>) =>
  (run: (root: string) => Effect.Effect<void, unknown>): Effect.Effect<void, unknown> =>
    Effect.acquireUseRelease(create, run, (root) =>
      Effect.promise(async () => await rm(root, { force: true, recursive: true })),
    );
