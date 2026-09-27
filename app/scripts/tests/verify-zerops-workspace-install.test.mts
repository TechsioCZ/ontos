import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';

import { findEscapingDependencyLinks } from '../verify-zerops-workspace-install.mts';

it.effect('reports dependency links that resolve outside the deployed workspace', () =>
  Effect.gen(function* escapingLinks() {
    const fs = yield* FileSystem.FileSystem;
    const outside = yield* fs.makeTempDirectoryScoped();
    const root = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(root, 'packages/core/node_modules/@scope'), { recursive: true });
    yield* fs.makeDirectory(path.join(root, 'node_modules/.pnpm/local@1.0.0/node_modules/local'), { recursive: true });
    yield* fs.symlink(
      path.join(root, 'node_modules/.pnpm/local@1.0.0/node_modules/local'),
      path.join(root, 'node_modules/local'),
    );
    yield* fs.symlink(path.join(root, 'packages/core'), path.join(root, 'node_modules/core'));
    yield* fs.symlink(outside, path.join(root, 'packages/core/node_modules/@scope/global'));
    yield* fs.symlink(path.join(root, 'missing'), path.join(root, 'node_modules/broken'));

    const escaping = yield* findEscapingDependencyLinks(root);

    expect(escaping).toHaveLength(2);
    expect(escaping).toContain('node_modules/broken -> unresolvable');
    expect(escaping.some((entry) => entry.startsWith('packages/core/node_modules/@scope/global -> '))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
