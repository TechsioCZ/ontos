import { existsSync } from 'node:fs';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Duration, Effect, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

const channels = path.resolve(import.meta.dirname, '../demo/module-credential-channels.sh');

/**
 * The local demo's channel helpers, driven by real bash and FIFOs: a handover never blocks (a dead server, or a live
 * process that never opened its channel), a live reader receives exactly its line, and the private channel directory
 * is gone once the launching shell exits.
 */
const HARNESS = `
set -eu
say() { printf 'say: %s\\n' "$*"; }
PID_DIR="$(mktemp -d)"
. "$1"
printf 'dir=%s\\n' "$CHANNEL_DIR"

channel_open dead
# Reap a completed child before testing a dead PID; immediate kill can race Bash child startup.
( exit 0 ) & dead=$!; wait "$dead"; echo "$dead" > "$PID_DIR/dead.pid"
if hand_over dead 'dead-line'; then echo dead=delivered; else echo dead=refused; fi

channel_open idle
sleep 30 & idle=$!; echo "$idle" > "$PID_DIR/idle.pid"
hand_over idle 'idle-line' && echo idle=returned
kill "$idle"; wait "$idle" 2>/dev/null || true

channel_open live
# As up.sh launches a server: its file descriptor 3 is open on the FIFO before the handover happens.
exec 8<>"$CHANNEL_DIR/live"
( IFS= read -r got <&8; printf 'live=%s\\n' "$got" ) & reader=$!
exec 8>&-
echo "$reader" > "$PID_DIR/live.pid"
hand_over live '{"credentials":{},"schemaVersion":1}'
wait "$reader"
rm -rf "$PID_DIR"
`;

it.live('hands a demo module its credential line without ever blocking, and removes the channels on exit', () =>
  Effect.scoped(
    Effect.gen(function* demoChannels() {
      const handle = yield* ChildProcess.make('bash', ['-c', HARNESS, 'harness', channels], {
        extendEnv: true,
        stderr: 'inherit',
        stdin: 'ignore',
        stdout: 'pipe',
      });
      const [output, code] = yield* Effect.all(
        [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: 2 },
      ).pipe(Effect.timeout(Duration.seconds(20)));
      expect(code).toBe(0);
      expect(output).toContain('dead=refused');
      expect(output).toContain('idle=returned');
      expect(output).toContain('live={"credentials":{},"schemaVersion":1}');
      const directory = /^dir=(?<directory>.+)$/mu.exec(output)?.groups?.directory;
      expect(directory).toBeDefined();
      expect(directory === undefined ? true : existsSync(directory)).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
