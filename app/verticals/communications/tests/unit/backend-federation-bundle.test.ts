import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'effect-rstest';

const root = fileURLToPath(new URL('../../', import.meta.url));

const bundledSources = (directory: string): readonly string[] =>
  readdirSync(path.join(root, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name))
    // The Outbox worker host runs as its own ESM Node process and is never part of the federated remote.
    .filter((file) => !file.includes(`${path.sep}worker-host${path.sep}`));

const platformNodeBarrelImport = /from\s+['"]@effect\/platform-node['"]/u;

/**
 * The Node backend-federation remote evaluates its bundle as CommonJS with no `import.meta.url`. The
 * `@effect/platform-node` barrel pulls in `NodeHttpServer`, whose `createRequire(import.meta.url)` throws there, so
 * the proof reports only "could not load ./effect-api". Source reachable from the remote imports the narrow subpath.
 */
describe('Communications backend federation bundle', () => {
  it('never imports the @effect/platform-node barrel from the sources the remote bundles', () => {
    const offenders = ['api', 'shared', 'src']
      .flatMap(bundledSources)
      .filter((file) => platformNodeBarrelImport.test(readFileSync(file, 'utf-8')))
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });
});
