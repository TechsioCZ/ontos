import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Sonar and the repository config require fixtures below the application's topDir.
// Reports are ignored source inputs; each callback still owns only its fresh child.
const defaultRoot = fileURLToPath(new URL('../../../../.codex/reports/lint-rule-workspaces/', import.meta.url));
const owned = new Set<string>();
const release = (directory: string): void => {
  if (!owned.has(directory)) return;
  rmSync(directory, { force: true, recursive: true });
  owned.delete(directory);
};

process.once('exit', () => {
  for (const directory of owned) {
    try {
      release(directory);
    } catch (error) {
      console.error(`Could not clean fixture workspace ${directory}`, error);
    }
  }
});
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));

/** Own only this fresh child directory; never remove a caller's temporary root. */
export function withTemporaryWorkspace<T>(
  run: (directory: string) => T,
  root = process.env.EFFECT_NATIVE_TEST_TMPDIR ?? defaultRoot,
): T {
  if (root === defaultRoot) mkdirSync(root, { recursive: true });
  // Oxlint canonicalizes paths before matching override globs.
  const directory = mkdtempSync(join(realpathSync(root), 'effect-policy-'));
  owned.add(directory);
  let result: T;
  try {
    result = run(directory);
  } catch (error) {
    try {
      release(directory);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Fixture run failed and workspace remains: ${directory}`, {
        cause: error,
      });
    }
    throw error;
  }
  release(directory);
  return result;
}
