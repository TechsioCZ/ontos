import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem } from 'effect';
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
 * still among the newest lines.
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

/** Stands in for npm (the zcli install) and zcli: `service log` prints $RUNTIME_LOG, or fails when ZCLI_FAILS is set. */
const fakeZcli = `#!/usr/bin/env bash
[ -z "\${ZCLI_FAILS:-}" ] || exit 1
case "$1" in
  login) [ "$2" = token ] ;;
  service) printf '%s\\n' "$RUNTIME_LOG" ;;
  *) exit 2 ;;
esac
`;

const readStages = (runtimeLog: string, extra: Readonly<Record<string, string>> = {}) =>
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
      GITHUB_STEP_SUMMARY: summary,
      PATH: `${bin}:${yield* Config.String('PATH')}`,
      RUNNER_TEMP: directory,
      RUNTIME_LOG: runtimeLog,
      ZEROPS_APP_SERVICE_ID: 'app-id',
      ZEROPS_PROJECT_ID: 'project-id',
      ZEROPS_TOKEN: 'token',
      ...extra,
    };
    const run = (command: string) =>
      collectToolingProcess(ChildProcess.make('bash', [SCRIPT, command], { cwd: directory, env, extendEnv: true }));
    const started = yield* run('start');
    // The start returns at once; the report waits for the background read.
    const report = yield* run('report');
    const summaryText = (yield* fs.exists(summary)) ? yield* fs.readFileString(summary) : '';
    return { report, started, summaryText };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.live("reports only the boot of the container that started serving last, in the log's order", () =>
  Effect.gen(function* newestBoot() {
    const { report, started, summaryText } = yield* readStages(RUNTIME_LOG);
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

it.live('never fails the delivery: an unreadable log or a log without a finished boot is only reported', () =>
  Effect.gen(function* measurementOnly() {
    const unreadable = yield* readStages(RUNTIME_LOG, { ZCLI_FAILS: '1' });
    expect(unreadable.report.status).toBe(0);
    expect(unreadable.report.stdout).toContain('the app runtime log could not be read');
    const unfinished = yield* readStages(line('18:42:11.000000', NEW, 'unpacked app release f927 in 31s'));
    expect(unfinished.report.status).toBe(0);
    expect(unfinished.report.stdout).toContain('no completed app container boot');
  }),
);
