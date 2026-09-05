import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const owned = new Set<string>();
const release = (directory: string): void => {
  if (!owned.has(directory)) return;
  rmSync(directory, { recursive: true, force: true });
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
  root = process.env.EFFECT_NATIVE_TEST_TMPDIR ?? tmpdir(),
): T {
  const directory = mkdtempSync(join(root, 'effect-policy-'));
  owned.add(directory);
  let result: T;
  try {
    result = run(directory);
  } catch (error) {
    try {
      release(directory);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Fixture run failed and workspace remains: ${directory}`,
        { cause: error },
      );
    }
    throw error;
  }
  release(directory);
  return result;
}
