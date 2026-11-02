import { readFile } from 'node:fs/promises';

import { NodeServices } from '@effect/platform-node';
import { Effect, Option, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

for (const brokenDescriptor of [false, true]) {
  it.live(
    `the actual fixture writer flushes STOPPED and propagates output errors (broken fd=${brokenDescriptor})`,
    () =>
      Effect.gen(function* actualFixtureWriter() {
        const fixture = yield* Effect.tryPromise(() =>
          readFile(new URL('../support/preproposal-basis-identity.fixture.ts', import.meta.url), 'utf-8'),
        );
        const begin = fixture.indexOf('    const output = yield* Effect.acquireRelease(');
        const end = fixture.indexOf('    const send = ', begin);
        expect(begin).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(begin);
        // Execute the fixture's actual writer acquisition/release, not a duplicate finalizer.
        const source = String.raw`
        import { createReadStream, createWriteStream, closeSync } from 'node:fs';
        import { finished } from 'node:stream/promises';
        import { NodeRuntime, NodeServices, NodeStream, NodeSink } from '@effect/platform-node';
        import { Cause, Effect, Stream } from 'effect';
        NodeRuntime.runMain(Effect.scoped(Effect.gen(function* writerProtocol() {
          ${fixture.slice(begin, end)}
          ${brokenDescriptor ? 'closeSync(3);' : ''}
          const send = frame => Stream.make(JSON.stringify(frame) + '\n').pipe(
            Stream.run(NodeSink.fromWritable({ endOnDone: false, evaluate: () => output, onError: error => error })),
          );
          yield* send({ operation: 'STARTED', pid: process.pid });
          yield* NodeStream.fromReadable({
            evaluate: () => createReadStream('', { autoClose: false, fd: 4 }), onError: error => error,
          }).pipe(
            Stream.decodeText(), Stream.splitLines, Stream.map(line => JSON.parse(line)),
            Stream.takeUntil(command => command.operation === 'STOP'),
            Stream.runForEach(() => send({ operation: 'STOPPED' })),
          );
        })).pipe(
          Effect.provide(NodeServices.layer),
          Effect.tapCause(cause => Effect.sync(() => process.stderr.write(Cause.pretty(cause) + '\n'))),
        ), { disableErrorReporting: true });
      `;
        let pid = 0;
        const result = yield* Effect.scoped(
          Effect.gen(function* ownedWriterChild() {
            const child = yield* ChildProcess.make(process.execPath, ['--input-type=module', '-e', source], {
              additionalFds: {
                fd3: { type: 'output' },
                fd4: { stream: Stream.make(new TextEncoder().encode('{"operation":"STOP"}\n')), type: 'input' },
              },
              cwd: new URL('../../', import.meta.url).pathname,
              stderr: 'pipe',
              stdout: 'pipe',
            });
            ({ pid } = child);
            const [exitCode, frames, stderr] = yield* Effect.all(
              [
                child.exitCode,
                child.getOutputFd(3).pipe(Stream.decodeText(), Stream.splitLines, Stream.runCollect),
                child.stderr.pipe(Stream.decodeText(), Stream.mkString),
                Stream.runDrain(child.stdout),
              ],
              { concurrency: 'unbounded' },
            );
            return { exitCode, frames, stderr };
          }),
        );
        const stillRunning = yield* Effect.try(() => process.kill(pid, 0)).pipe(Effect.option);
        expect(Option.isNone(stillRunning)).toBe(true);
        if (brokenDescriptor) {
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain('EBADF');
        } else {
          expect(result.frames).toContain(JSON.stringify({ operation: 'STOPPED' }));
          expect(result.exitCode).toBe(0);
          expect(result.stderr).toBe('');
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    // A real Node child cold-loads Effect and the platform package, which exceeds the unit default on a loaded runner.
    30_000,
  );
}
