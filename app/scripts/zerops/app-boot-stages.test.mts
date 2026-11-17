import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem, Schedule } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';

import { collectToolingProcess } from '../tests/tooling-process-fixture.mts';

const SCRIPT = path.join(import.meta.dirname, 'app-boot-stages.sh');
const OLD = 'node-id-298.runtime.app.zerops';
const NEW = 'node-id-299.runtime.app.zerops';
/** One runtime log line as `zcli service log --format FULL` prints it. */
const line = (time: string, host: string, message: string) =>
  `<134>1 2026-11-17T${time}Z ${host} zerops@zerops 689 - - ${message}`;
/**
 * The old container keeps logging while the new one unpacks and boots; the old one's boot from an earlier deploy is
 * still among the newest lines. The first three lines are all the log holds when the push starts.
 */
const RUNTIME_LOG = [
  line('17:01:10.000000', OLD, '[boot-timing] stage=host.migrator ms=40000 outcome=ok'),
  line('17:01:20.000000', OLD, '[boot-timing] stage=host.start-to-serving ms=60000 outcome=ok'),
  line('18:41:00.000000', OLD, '{"event":"runtime.summary","fields":{"stage":"host.start-to-serving"}}'),
  line('18:42:11.176493', NEW, 'unpacked app release f927 with its Outbox Worker host in 31s'),
  line('18:42:11.329691', NEW, "━━━━  🙏 exec sh -c 'cd app && exec node scripts/zerops/app-host.mts'  ━━━━"),
  line('18:42:38.242021', NEW, '[boot-timing] stage=migrator.owner-migrations ms=18420 outcome=ok'),
  line('18:42:39.000000', OLD, '[boot-timing] stage=host.drain ms=1 outcome=ok'),
  line('18:43:58.476326', NEW, '[boot-timing] stage=host.migrator ms=104450 outcome=ok'),
  line('18:44:14.284324', NEW, '[app-host] accepting application traffic on port 3000'),
  line('18:44:14.284346', NEW, '[boot-timing] stage=host.start-to-serving ms=120334 outcome=ok'),
  line('18:44:20.000000', NEW, '{"event":"runtime.summary"}'),
].join('\n');

/**
 * Stands in for zcli: `service log` prints $BEFORE_LOG the first time (the push has just started: only the old
 * container's boot) and $RUNTIME_LOG from then on; every call fails when ZCLI_FAILS is set.
 */
const fakeZcli = `#!/usr/bin/env bash
[ -z "\${ZCLI_FAILS:-}" ] || exit 1
case "$1" in
  login) [ "$2" = token ] ;;
  service)
    if [ -e "$RUNNER_TEMP/zcli-read" ]; then printf '%s\\n' "$RUNTIME_LOG"; else printf '%s\\n' "$BEFORE_LOG"; fi
    touch "$RUNNER_TEMP/zcli-read"
    ;;
  *) exit 2 ;;
esac
`;
const BEFORE_LOG = RUNTIME_LOG.split('\n').slice(0, 3).join('\n');

const readStages = (extra: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* readBootStages() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const bin = path.join(directory, 'bin');
    yield* fs.makeDirectory(bin);
    yield* fs.writeFileString(path.join(bin, 'npm'), '#!/usr/bin/env bash\nexit 0\n');
    yield* fs.writeFileString(path.join(bin, 'zcli'), fakeZcli);
    yield* fs.chmod(path.join(bin, 'npm'), 0o700);
    yield* fs.chmod(path.join(bin, 'zcli'), 0o700);
    const summary = path.join(directory, 'summary.md');
    const env = {
      BEFORE_LOG,
      GITHUB_STEP_SUMMARY: summary,
      PATH: `${bin}:${yield* Config.String('PATH')}`,
      RUNNER_TEMP: directory,
      RUNTIME_LOG,
      ZEROPS_APP_SERVICE_ID: 'app-id',
      ZEROPS_PROJECT_ID: 'project-id',
      ZEROPS_TOKEN: 'token',
      ...extra,
    };
    const run = (command: string) =>
      collectToolingProcess(ChildProcess.make('bash', [SCRIPT, command], { cwd: directory, env, extendEnv: true }));
    const started = yield* run('start');
    // The start returns at once; the read goes on in the background until the new container has booted.
    const done = path.join(directory, 'app-boot-stages/done');
    yield* fs.exists(done).pipe(
      Effect.flatMap((exists) => (exists ? Effect.void : Effect.fail('reading'))),
      Effect.retry(Schedule.spaced('100 millis').pipe(Schedule.upTo('20 seconds'))),
    );
    const report = yield* run('report');
    const summaryText = (yield* fs.exists(summary)) ? yield* fs.readFileString(summary) : '';
    return { report, started, summaryText };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.live('reports the boot of the container that started serving after the push, in the log order', () =>
  Effect.gen(function* newestBoot() {
    const { report, started, summaryText } = yield* readStages();
    expect(started.status).toBe(0);
    expect(report.status).toBe(0);
    expect(report.stdout.trim().split('\n')).toEqual([
      `app container ${NEW}:`,
      '2026-11-17T18:42:11.176493Z  unpacked app release f927 with its Outbox Worker host in 31s',
      '2026-11-17T18:42:38.242021Z  [boot-timing] stage=migrator.owner-migrations ms=18420 outcome=ok',
      '2026-11-17T18:43:58.476326Z  [boot-timing] stage=host.migrator ms=104450 outcome=ok',
      '2026-11-17T18:44:14.284324Z  [app-host] accepting application traffic on port 3000',
      '2026-11-17T18:44:14.284346Z  [boot-timing] stage=host.start-to-serving ms=120334 outcome=ok',
    ]);
    expect(summaryText).toContain('### App container boot stages');
    expect(summaryText).toContain('stage=host.migrator ms=104450');
    expect(summaryText).not.toContain('ms=40000');
  }),
);

it.live('never fails the delivery: an unreadable log or a boot that has not ended is only reported', () =>
  Effect.gen(function* measurementOnly() {
    const unreadable = yield* readStages({ ZCLI_FAILS: '1' });
    expect(unreadable.report.status).toBe(0);
    expect(unreadable.report.stdout).toContain('the app runtime log could not be read');
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const unfinished = yield* collectToolingProcess(
      ChildProcess.make('bash', [SCRIPT, 'report'], { env: { RUNNER_TEMP: directory }, extendEnv: true }),
    );
    expect(unfinished.status).toBe(0);
    expect(unfinished.stdout).toContain('had not finished its boot');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
