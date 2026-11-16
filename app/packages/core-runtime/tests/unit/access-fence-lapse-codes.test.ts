import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';

import { ACCESS_FAILURES_BEFORE_ENGINE_WRITE } from '../../src/access/lifecycle/fence.ts';

/*
 * Only an operation that failed before it sent the engine anything may lose its hold at once. The take-over (Core) and
 * the sweep's lapsed-fence function (SQL) must name exactly the same failure codes, and never `projection_failed`.
 */
it.layer(NodeServices.layer)('immediate lapse', (suite) => {
  suite.effect('the sweep function and the take-over lapse the same pre-write failures, never a failed write', () =>
    Effect.gen(function* sameCodes() {
      const files = yield* FileSystem.FileSystem;
      const migration = yield* files.readFileString(
        new URL('../../drizzle/20261112044938_access-fence-sweep/migration.sql', import.meta.url).pathname,
      );
      const listed = /j\.failure_code IN \((?<codes>[^)]*)\)/u.exec(migration)?.groups?.['codes'] ?? '';
      const codes = listed.split(',').map((code) => code.trim().replaceAll("'", ''));
      expect(codes).toEqual([...ACCESS_FAILURES_BEFORE_ENGINE_WRITE]);
      expect(codes).not.toContain('projection_failed');
    }),
  );
});
