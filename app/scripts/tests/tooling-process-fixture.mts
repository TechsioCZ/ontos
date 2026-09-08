import { Effect, Stream } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process';

import type { ChildProcess } from 'effect/unstable/process';

export const collectToolingProcess = Effect.fn(function* collectToolingProcess(
  command: ChildProcess.Command,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(command);
  const [status, stdout, stderr] = yield* Effect.all(
    [
      handle.exitCode.pipe(Effect.map(Number)),
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
    ],
    { concurrency: 'unbounded' },
  );
  return { status, stderr, stdout };
});
