import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';

import { NodeServices } from '@effect/platform-node';
import { Clock, Config, DateTime, Duration, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { DIGEST_VERSION } from '../ci/deploy-plan.mts';
import { OpsShellLive, runCommand } from '../ops/ops-shell.mts';
import { emptyLedger, parseLedger, recordUnitReceipt, serializeLedger } from '../ci/release-ledger.mts';
import {
  databasePath,
  hostRelease,
  jobState,
  joinBackground,
  outboxHostPlan,
  publishedHostArtifact,
  readPlan,
  recordLedger,
  streamUploads,
  unitBuildJob,
} from '../ci/release-stream.mts';
import type { RunJob, StreamSettings } from '../ci/release-stream.mts';

const REVISION = 'a'.repeat(40);
const UTF8 = 'utf-8';
const OWNER_SECRET = 'synthetic-owner-secret-never-logged';
const ALPHA = 'alpha';
const BETA = 'beta';
const UNIT_STATES = 'units.json';
const ALPHA_BUILD = 'Build alpha';
const digestOf = (seed: string) => createHash('sha256').update(seed).digest('hex');
const services = OpsShellLive.pipe(Layer.provideMerge(NodeServices.layer));

/** A stored (uncompressed) zip, as the artifact endpoint returns for `compression-level: 0`. */
const storedZip = (entries: Readonly<Record<string, Buffer>>) => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const fileName = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02_01_4b_50, 0);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

const receiptFor = (unitId: string) => ({
  artifacts: {},
  assetsVersionId: `assets-${unitId}`,
  backend: { versionId: `backend-${unitId}`, workerName: `ontos-${unitId}` },
  plan: {
    appId: unitId,
    assetsOrigin: `https://assets-${unitId}.example.test/`,
    assetsScriptName: `ontos-assets-${unitId}`,
    backendScriptName: `ontos-${unitId}`,
    buildMarker: digestOf('marker'),
    sourceRevision: REVISION,
  },
});

// `gh api <route>`: job lists advance one snapshot per call, or hold a snapshot until its `until` file exists; a
// snapshot can also fail the call or answer a malformed body. Artifacts and their zips come from fixture files.
const GH_SHIM = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const dir = process.env.SHIM_DIR;
const route = process.argv[3];
appendFileSync(dir + '/gh.log', route + '\\n');
if (route.includes('/jobs?')) {
  const snapshots = JSON.parse(readFileSync(dir + '/jobs.json', 'utf8'));
  const index = existsSync(dir + '/jobs.index') ? Number(readFileSync(dir + '/jobs.index', 'utf8')) : 0;
  const snapshot = snapshots[Math.min(index, snapshots.length - 1)];
  if (snapshot.until === undefined || existsSync(snapshot.until)) {
    writeFileSync(dir + '/jobs.index', String(index + 1));
  }
  if (snapshot.answer === 'error') {
    process.exit(1);
  }
  if (snapshot.answer === 'malformed') {
    process.stdout.write('{"jobs":"not a list"}');
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ jobs: snapshot.jobs, total_count: snapshot.jobs.length }));
} else if (/artifacts\\/\\d+\\/zip$/.test(route)) {
  process.stdout.write(readFileSync(dir + '/zips/' + route.match(/artifacts\\/(\\d+)\\/zip$/)[1] + '.zip'));
} else if (route.includes('/artifacts?name=')) {
  const name = decodeURIComponent(route.match(/name=([^&]+)/)[1]);
  const artifacts = JSON.parse(readFileSync(dir + '/artifacts.json', 'utf8'))[name] ?? [];
  process.stdout.write(JSON.stringify({ artifacts, total_count: artifacts.length }));
} else {
  process.exit(1);
}
`;

// `pnpm exec node <release script> <command> ...`: records what ran and writes the receipt a real upload would.
const PNPM_SHIM = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [, , , , script, command, ...args] = process.argv;
const flag = (name) => args[args.indexOf(name) + 1];
const dir = process.env.SHIM_DIR;
appendFileSync(dir + '/pnpm.log', JSON.stringify({
  args,
  command,
  rawSecretsFile: process.env.ALL_RELEASE_SECRETS_FILE ?? '',
  script,
  secrets: process.env.ONTOS_IMMUTABLE_RELEASE_SECRETS ?? '',
}) + '\\n');
if (command === 'verify-retained') {
  process.exit(process.env.SHIM_RETAINED_GONE === '1' ? 1 : 0);
}
const plan = JSON.parse(readFileSync(flag('--plan-file'), 'utf8'));
if ((process.env.SHIM_FAIL_UNITS ?? '').split(',').includes(plan.appId)) {
  console.log('release CLI exit 1');
  process.exit(1);
}
writeFileSync(flag('--receipt-file'), JSON.stringify(plan.receipt));
console.log('receipt written');
`;

interface Fixture {
  readonly logs: string;
  readonly planFile: string;
  readonly rawSecretsFile: string;
  readonly receipts: string;
  readonly root: string;
  readonly secretsFile: string;
  readonly shim: string;
  readonly stateFile: string;
  readonly workspace: string;
}

interface UnitSpec {
  readonly artifactId?: number;
  readonly id: string;
  readonly mode: 'build' | 'retain' | 'reupload';
}

const PnpmCallSchema = Schema.fromJsonString(
  Schema.Struct({
    args: Schema.Array(Schema.String),
    command: Schema.String,
    rawSecretsFile: Schema.String,
    secrets: Schema.String,
  }),
);
const UnitStatesSchema = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })),
);

const unitDigest = (unitId: string) => digestOf(unitId);
const job = (name: string, status: string, conclusion: string | null = null) => ({ conclusion, name, status });
type RunJobFixture = ReturnType<typeof job>;

const settingsFor = (fixture: Fixture, extra: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* fixtureSettings() {
    const inherited = yield* Config.String('PATH');
    const childEnv = Object.fromEntries(
      Object.entries({ PATH: `${path.join(fixture.shim, 'bin')}:${inherited}`, SHIM_DIR: fixture.shim, ...extra }).map(
        ([key, value]) => [key, Redacted.make(value)],
      ),
    );
    return {
      childEnv,
      missingJobGrace: Duration.minutes(2),
      pollInterval: Duration.millis(5),
      repository: 'example/ontos',
      runId: '42',
      scratch: path.join(fixture.root, 'runner-temp'),
      workspaceRoot: fixture.workspace,
    } satisfies StreamSettings;
  });

/**
 * One unit's packed build output: its ignored `.output`, its release plan and the inputs.json of its digest, exactly as
 * scripts/ci/build-edge-unit.sh packs it.
 */
const packUnit = (fixture: Fixture, unitId: string, artifactId: number) =>
  Effect.gen(function* packUnitOutput() {
    const staging = path.join(fixture.root, 'staging', String(artifactId));
    mkdirSync(path.join(staging, 'verticals', unitId, '.output'), { recursive: true });
    const releases = path.join(staging, '.codex/reports/releases', unitId);
    mkdirSync(releases, { recursive: true });
    writeFileSync(path.join(staging, 'verticals', unitId, '.output/wrangler.json'), '{}');
    writeFileSync(path.join(releases, 'plan.json'), JSON.stringify({ appId: unitId, receipt: receiptFor(unitId) }));
    writeFileSync(path.join(releases, 'inputs.json'), JSON.stringify({ unitId }));
    const archive = path.join(fixture.root, 'staging', `${String(artifactId)}.tar.zst`);
    yield* runCommand({
      args: ['--create', '--zstd', '--file', archive, '-C', staging, 'verticals', '.codex'],
      command: 'tar',
    });
    mkdirSync(path.join(fixture.shim, 'zips'), { recursive: true });
    writeFileSync(
      path.join(fixture.shim, 'zips', `${String(artifactId)}.zip`),
      storedZip({ 'edge-unit.tar.zst': readFileSync(archive) }),
    );
  });

const makeFixture = (units: readonly UnitSpec[], secretOwners: readonly string[] = units.map(({ id }) => id)) =>
  Effect.gen(function* createFixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'release-stream-'));
    const workspace = path.join(root, 'app');
    const shim = path.join(root, 'shim');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(path.join(shim, 'bin'), { recursive: true });
    writeFileSync(path.join(workspace, '.gitignore'), '.output/\n.codex/\n');
    for (const args of [
      ['init', '--quiet'],
      ['add', '.gitignore'],
      ['-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'fixture'],
    ]) {
      yield* runCommand({ args, command: 'git', cwd: workspace });
    }
    for (const [name, source] of [
      ['gh', GH_SHIM],
      ['pnpm', PNPM_SHIM],
    ] as const) {
      writeFileSync(path.join(shim, 'bin', name), source);
      chmodSync(path.join(shim, 'bin', name), 0o755);
    }
    writeFileSync(path.join(shim, 'artifacts.json'), '{}');
    writeFileSync(path.join(shim, 'jobs.json'), '[{"jobs":[]}]');
    const fixture: Fixture = {
      logs: path.join(root, 'upload-logs'),
      planFile: path.join(root, 'deploy-plan.json'),
      rawSecretsFile: path.join(root, 'raw.json'),
      receipts: path.join(root, 'receipts'),
      root,
      secretsFile: path.join(root, 'bundle.json'),
      shim,
      stateFile: path.join(root, UNIT_STATES),
      workspace,
    };
    writeFileSync(
      fixture.secretsFile,
      JSON.stringify(Object.fromEntries(secretOwners.map((id) => [id, { SECRET: OWNER_SECRET }]))),
    );
    writeFileSync(
      fixture.planFile,
      JSON.stringify({
        host: { artifact: null, digest: digestOf('host'), mode: 'build', owners: [] },
        storefront: { artifact: null, digest: digestOf('storefront'), mode: 'build' },
        units: units.map((unit) => ({
          artifact:
            unit.artifactId === undefined
              ? null
              : { id: unit.artifactId, name: `edge-unit-${unit.id}-${unitDigest(unit.id)}` },
          digest: unitDigest(unit.id),
          id: unit.id,
          mode: unit.mode,
          package: `@app/${unit.id}`,
          path: `verticals/${unit.id}`,
          receipt: unit.mode === 'retain' ? receiptFor(unit.id) : null,
        })),
      }),
    );
    return fixture;
  });

interface JobsSnapshot {
  readonly answer?: 'error' | 'malformed';
  readonly jobs: readonly RunJobFixture[];
  readonly until?: string;
}

const writeJobs = (fixture: Fixture, snapshots: readonly JobsSnapshot[]) =>
  writeFileSync(path.join(fixture.shim, 'jobs.json'), JSON.stringify(snapshots));

const publishArtifacts = (fixture: Fixture, artifacts: Readonly<Record<string, readonly number[]>>) =>
  writeFileSync(
    path.join(fixture.shim, 'artifacts.json'),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(artifacts).map(([name, ids]) => [name, ids.map((id) => ({ expired: false, id, name }))]),
      ),
    ),
  );

const startFile = (fixture: Fixture) => path.join(fixture.root, 'start');
const stopFile = (fixture: Fixture) => path.join(fixture.root, 'stop');

/** Uploads are allowed from the start (the database light path) unless `allowed` is false. */
const stream = (
  fixture: Fixture,
  extra: Readonly<Record<string, string>> = {},
  {
    allowed = true,
    deadlineMillis = 60_000,
    parallelism = 8,
  }: { readonly allowed?: boolean; readonly deadlineMillis?: number; readonly parallelism?: number } = {},
) =>
  Effect.gen(function* runStream() {
    const now = yield* Clock.currentTimeMillis;
    if (allowed) {
      writeFileSync(startFile(fixture), '');
    }
    return yield* streamUploads(yield* settingsFor(fixture, extra), {
      deadline: now + deadlineMillis,
      logs: fixture.logs,
      parallelism,
      planFile: fixture.planFile,
      rawSecretsFile: Redacted.make(fixture.rawSecretsFile),
      receipts: fixture.receipts,
      secretsFile: Redacted.make(fixture.secretsFile),
      startFile: startFile(fixture),
      stateFile: fixture.stateFile,
      stopFile: stopFile(fixture),
    });
  });

const pnpmCalls = (fixture: Fixture) =>
  existsSync(path.join(fixture.shim, 'pnpm.log'))
    ? readFileSync(path.join(fixture.shim, 'pnpm.log'), UTF8)
        .trim()
        .split('\n')
        .map((line) => Schema.decodeUnknownSync(PnpmCallSchema)(line))
    : [];
const uploadedUnits = (fixture: Fixture) =>
  pnpmCalls(fixture)
    .filter(({ command }) => command === 'deploy')
    .map(({ args }) => args[args.indexOf('--app-directory') + 1]?.replace('verticals/', ''));
const states = (fixture: Fixture) =>
  Object.fromEntries(
    Schema.decodeUnknownSync(UnitStatesSchema)(readFileSync(fixture.stateFile, UTF8)).map(({ id, status }) => [
      id,
      status,
    ]),
  );
const ghLog = (fixture: Fixture) => readFileSync(path.join(fixture.shim, 'gh.log'), UTF8);
const unitLogText = (fixture: Fixture, unitId: string) => readFileSync(path.join(fixture.logs, `${unitId}.log`), UTF8);
const removeRoot = (root: string) => Effect.sync(() => rmSync(root, { force: true, recursive: true }));

it.live('uploads each unit as soon as its own build succeeds, in completion order', () =>
  Effect.acquireUseRelease(
    makeFixture([
      { id: ALPHA, mode: 'build' },
      { id: BETA, mode: 'build' },
    ]),
    (fixture) =>
      Effect.gen(function* outOfOrderCompletion() {
        yield* packUnit(fixture, ALPHA, 11);
        yield* packUnit(fixture, BETA, 12);
        publishArtifacts(fixture, {
          [`edge-unit-${ALPHA}-${unitDigest(ALPHA)}`]: [11],
          [`edge-unit-${BETA}-${unitDigest(BETA)}`]: [12],
        });
        // Alpha's build finishes only after beta's upload wrote its receipt.
        writeJobs(fixture, [
          {
            jobs: [job(unitBuildJob(ALPHA), 'in_progress'), job(unitBuildJob(BETA), 'completed', 'success')],
            until: path.join(fixture.receipts, `${BETA}.json`),
          },
          { jobs: [job(unitBuildJob(ALPHA), 'completed', 'success'), job(unitBuildJob(BETA), 'completed', 'success')] },
        ]);
        expect(yield* stream(fixture)).toBe(true);
        expect(uploadedUnits(fixture)).toEqual([BETA, ALPHA]);
        expect(states(fixture)).toEqual({ [ALPHA]: 'uploaded', [BETA]: 'uploaded' });
        for (const call of pnpmCalls(fixture)) {
          // Owner secrets travel only in the child's environment, never in its arguments.
          expect(call.secrets).toContain(OWNER_SECRET);
          expect(call.args.join(' ')).not.toContain(OWNER_SECRET);
          expect(call.rawSecretsFile).toBe(fixture.rawSecretsFile);
          expect(call.args).toContain('--artifact-name');
          // The upload proves an earlier revision's output through the inputs.json its build packed.
          const unitId = call.args[call.args.indexOf('--app-directory') + 1]?.replace('verticals/', '');
          expect(call.args[call.args.indexOf('--inputs-file') + 1]).toBe(
            `.codex/reports/releases/${unitId}/inputs.json`,
          );
        }
        expect(existsSync(path.join(fixture.receipts, `${ALPHA}.json`))).toBe(true);
        expect(existsSync(path.join(fixture.receipts, `${BETA}.json`))).toBe(true);
      }),
    ({ root }) => removeRoot(root),
  ).pipe(Effect.provide(services)),
);

it.live('fails on a failed build without uploading it or starting later units', () =>
  Effect.acquireUseRelease(
    makeFixture([
      { id: ALPHA, mode: 'build' },
      { id: BETA, mode: 'build' },
    ]),
    (fixture) =>
      Effect.gen(function* failedBuild() {
        writeJobs(fixture, [
          { jobs: [job(unitBuildJob(ALPHA), 'completed', 'failure'), job(unitBuildJob(BETA), 'in_progress')] },
        ]);
        expect(yield* stream(fixture)).toBe(false);
        expect(uploadedUnits(fixture)).toEqual([]);
        expect(states(fixture)).toEqual({ [ALPHA]: 'failed', [BETA]: 'waiting' });
        expect(unitLogText(fixture, ALPHA)).toContain('Build alpha ended failure');
      }),
    ({ root }) => removeRoot(root),
  ).pipe(Effect.provide(services)),
);

for (const answer of ['error', 'malformed'] as const) {
  it.live(`fails every waiting unit at once when the run job list answers ${answer}`, () =>
    Effect.acquireUseRelease(
      makeFixture([
        { id: ALPHA, mode: 'build' },
        { id: BETA, mode: 'build' },
      ]),
      (fixture) =>
        Effect.gen(function* pollerFails() {
          writeJobs(fixture, [{ answer, jobs: [] }]);
          // The stream's own deadline is a minute away: only the failed poller may end it this quickly.
          const ok = yield* stream(fixture).pipe(
            Effect.timeoutOrElse({
              duration: Duration.seconds(10),
              orElse: () => Effect.die(new Error('the stream kept waiting for a failed poller')),
            }),
          );
          expect(ok).toBe(false);
          expect(uploadedUnits(fixture)).toEqual([]);
          const statuses = Object.values(states(fixture));
          expect(statuses).toContain('failed');
          expect(statuses.every((status) => status === 'failed' || status === 'waiting')).toBe(true);
          const logs = [ALPHA, BETA]
            .filter((id) => existsSync(path.join(fixture.logs, `${id}.log`)))
            .map((id) => unitLogText(fixture, id))
            .join('');
          expect(logs).toContain("could not follow this run's build jobs");
        }),
      ({ root }) => removeRoot(root),
    ).pipe(Effect.provide(services)),
  );
}

/** Simulates the release job's failure step: creates the stop file once the marker file exists. */
const touchWhenExists = (marker: string, target: string): Effect.Effect<void> =>
  Effect.suspend(() =>
    existsSync(marker)
      ? Effect.sync(() => writeFileSync(target, ''))
      : Effect.sleep(Duration.millis(5)).pipe(Effect.andThen(touchWhenExists(marker, target))),
  );

it.live('starts no waiting unit once a later release step failed, while finished uploads stay recorded', () =>
  Effect.acquireUseRelease(
    makeFixture([
      { id: ALPHA, mode: 'build' },
      { artifactId: 61, id: BETA, mode: 'reupload' },
    ]),
    (fixture) =>
      Effect.gen(function* stopsAfterJobFailure() {
        yield* packUnit(fixture, BETA, 61);
        // Alpha's build never finishes; the release job fails a later step once beta is uploaded.
        writeJobs(fixture, [{ jobs: [job(unitBuildJob(ALPHA), 'in_progress')] }]);
        const stop = touchWhenExists(path.join(fixture.receipts, `${BETA}.json`), stopFile(fixture));
        const [ok] = yield* Effect.all([stream(fixture), stop], { concurrency: 2 });
        expect(ok).toBe(false);
        expect(states(fixture)).toEqual({ [ALPHA]: 'waiting', [BETA]: 'uploaded' });
        expect(uploadedUnits(fixture)).toEqual([BETA]);
      }),
    ({ root }) => removeRoot(root),
  ).pipe(Effect.provide(services)),
);

/** The unpacked inputs.json of a unit: its build output is fetched and ready to upload. */
const unpackedInputs = (fixture: Fixture, unitId: string) =>
  path.join(fixture.workspace, '.codex/reports/releases', unitId, 'inputs.json');

/** Resolves once the condition holds, polling the fixture files. */
const whenTrue = (condition: () => boolean): Effect.Effect<void> =>
  Effect.suspend(() =>
    condition() ? Effect.void : Effect.sleep(Duration.millis(5)).pipe(Effect.andThen(whenTrue(condition))),
  );

it.live('uploads nothing before the release job allows it, while it already unpacks and verifies retained units', () =>
  Effect.acquireUseRelease(
    makeFixture([
      { artifactId: 71, id: ALPHA, mode: 'reupload' },
      { id: BETA, mode: 'retain' },
    ]),
    (fixture) =>
      Effect.gen(function* holdsUploadsUntilStart() {
        yield* packUnit(fixture, ALPHA, 71);
        // The full sealed chain: the release job allows uploads only after its migrations finished.
        const migrations = Effect.gen(function* finishMigrations() {
          yield* whenTrue(() => existsSync(unpackedInputs(fixture, ALPHA)) && existsSync(fixture.stateFile));
          yield* whenTrue(() => states(fixture)[BETA] === 'retained');
          // Give a premature upload every chance to happen before the start file appears.
          yield* Effect.sleep(Duration.millis(50));
          const premature = uploadedUnits(fixture);
          writeFileSync(startFile(fixture), '');
          return premature;
        });
        // One permit: a unit waiting for the start file must not hold it, or the retained check could never run.
        const [ok, premature] = yield* Effect.all(
          [stream(fixture, {}, { allowed: false, parallelism: 1 }), migrations],
          { concurrency: 2 },
        );
        expect(premature).toEqual([]);
        expect(ok).toBe(true);
        expect(uploadedUnits(fixture)).toEqual([ALPHA]);
        expect(states(fixture)).toEqual({ [ALPHA]: 'uploaded', [BETA]: 'retained' });
      }),
    ({ root }) => removeRoot(root),
  ).pipe(Effect.provide(services)),
);

it.live('uploads nothing when the release job fails before it allows uploads', () =>
  Effect.acquireUseRelease(
    makeFixture([{ artifactId: 72, id: ALPHA, mode: 'reupload' }]),
    (fixture) =>
      Effect.gen(function* stopsBeforeStart() {
        yield* packUnit(fixture, ALPHA, 72);
        // A failed migration: the stop file appears instead of the start file.
        const failedMigration = touchWhenExists(unpackedInputs(fixture, ALPHA), stopFile(fixture));
        const [ok] = yield* Effect.all([stream(fixture, {}, { allowed: false }), failedMigration], {
          concurrency: 2,
        });
        expect(ok).toBe(false);
        expect(uploadedUnits(fixture)).toEqual([]);
        expect(states(fixture)).toEqual({ [ALPHA]: 'waiting' });
        expect(existsSync(path.join(fixture.receipts, `${ALPHA}.json`))).toBe(false);
      }),
    ({ root }) => removeRoot(root),
  ).pipe(Effect.provide(services)),
);

it.live('never uploads a unit waiting for the start file once another unit failed, even after the start', () =>
  Effect.acquireUseRelease(
    makeFixture([
      { artifactId: 74, id: ALPHA, mode: 'reupload' },
      { id: BETA, mode: 'build' },
    ]),
    (fixture) =>
      Effect.gen(function* failsWhileWaitingAtStart() {
        yield* packUnit(fixture, ALPHA, 74);
        // Beta's build fails only once alpha is unpacked and waits for the migrations to finish.
        writeJobs(fixture, [
          { jobs: [job(unitBuildJob(BETA), 'in_progress')], until: unpackedInputs(fixture, ALPHA) },
          { jobs: [job(unitBuildJob(BETA), 'completed', 'failure')] },
        ]);
        // The migrations finish after the failure: the release job allows uploads it cannot yet know must not start.
        const migrations = Effect.gen(function* finishMigrationsAfterFailure() {
          yield* whenTrue(() => existsSync(fixture.stateFile) && states(fixture)[BETA] === 'failed');
          writeFileSync(startFile(fixture), '');
        });
        const [ok] = yield* Effect.all([stream(fixture, {}, { allowed: false }), migrations], { concurrency: 2 });
        expect(ok).toBe(false);
        expect(uploadedUnits(fixture)).toEqual([]);
        expect(states(fixture)).toEqual({ [ALPHA]: 'waiting', [BETA]: 'failed' });
        expect(existsSync(path.join(fixture.receipts, `${ALPHA}.json`))).toBe(false);
      }),
    ({ root }) => removeRoot(root),
  ).pipe(Effect.provide(services)),
);

it.live('fails a unit still waiting for the database preparation at the deadline', () =>
  Effect.acquireUseRelease(
    makeFixture([{ artifactId: 73, id: ALPHA, mode: 'reupload' }]),
    (fixture) =>
      Effect.gen(function* startDeadline() {
        yield* packUnit(fixture, ALPHA, 73);
        expect(yield* stream(fixture, {}, { allowed: false, deadlineMillis: 200 })).toBe(false);
        expect(uploadedUnits(fixture)).toEqual([]);
        expect(states(fixture)).toEqual({ [ALPHA]: 'failed' });
        expect(unitLogText(fixture, ALPHA)).toContain('timed out waiting for the database preparation');
      }),
    ({ root }) => removeRoot(root),
  ).pipe(Effect.provide(services)),
);

it.live('follows a re-run attempt of a failed build and takes its newest artifact', () =>
  Effect.acquireUseRelease(
    makeFixture([{ id: ALPHA, mode: 'build' }]),
    (fixture) =>
      Effect.gen(function* secondAttempt() {
        yield* packUnit(fixture, ALPHA, 22);
        publishArtifacts(fixture, { [`edge-unit-${ALPHA}-${unitDigest(ALPHA)}`]: [21, 22] });
        // filter=latest lists only attempt 2 of the re-run job: queued, then successful.
        writeJobs(fixture, [
          { jobs: [job(unitBuildJob(ALPHA), 'queued')] },
          { jobs: [job(unitBuildJob(ALPHA), 'completed', 'success')] },
        ]);
        expect(yield* stream(fixture)).toBe(true);
        expect(ghLog(fixture)).toContain('artifacts/22/zip');
        expect(ghLog(fixture)).toContain('jobs?filter=latest');
        expect(ghLog(fixture)).not.toContain('artifacts/21/zip');
      }),
    ({ root }) => removeRoot(root),
  ).pipe(Effect.provide(services)),
);

it.live('with an empty build matrix verifies retained units and re-uploads kept outputs without job lookups', () =>
  Effect.acquireUseRelease(
    makeFixture([
      { id: ALPHA, mode: 'retain' },
      { artifactId: 31, id: BETA, mode: 'reupload' },
    ]),
    (fixture) =>
      Effect.gen(function* emptyMatrix() {
        yield* packUnit(fixture, BETA, 31);
        expect(yield* stream(fixture)).toBe(true);
        expect(states(fixture)).toEqual({ [ALPHA]: 'retained', [BETA]: 'uploaded' });
        expect(pnpmCalls(fixture).map(({ command }) => command)).toEqual(
          expect.arrayContaining(['verify-retained', 'deploy']),
        );
        expect(ghLog(fixture)).not.toContain('/jobs?');
        expect(JSON.parse(readFileSync(path.join(fixture.receipts, `${ALPHA}.json`), UTF8))).toEqual(receiptFor(ALPHA));
      }),
    ({ root }) => removeRoot(root),
  ).pipe(Effect.provide(services)),
);

it.live('fails a retained unit whose live Workers no longer match its receipt', () =>
  Effect.acquireUseRelease(
    makeFixture([{ id: ALPHA, mode: 'retain' }]),
    (fixture) =>
      Effect.gen(function* retainedGone() {
        expect(yield* stream(fixture, { SHIM_RETAINED_GONE: '1' })).toBe(false);
        expect(unitLogText(fixture, ALPHA)).toContain('re-run with force_full');
      }),
    ({ root }) => removeRoot(root),
  ).pipe(Effect.provide(services)),
);

it.live('records a name-only error and starts no upload for an owner without secrets', () =>
  Effect.acquireUseRelease(
    makeFixture([{ artifactId: 41, id: 'projects', mode: 'reupload' }], []),
    (fixture) =>
      Effect.gen(function* missingOwner() {
        yield* packUnit(fixture, 'projects', 41);
        expect(yield* stream(fixture)).toBe(false);
        const log = unitLogText(fixture, 'projects');
        expect(log).toContain('projects has no valid owner secret object; upload not started');
        expect(log).not.toContain(OWNER_SECRET);
        expect(uploadedUnits(fixture)).toEqual([]);
        expect(existsSync(path.join(fixture.receipts, 'projects.json'))).toBe(false);
      }),
    ({ root }) => removeRoot(root),
  ).pipe(Effect.provide(services)),
);

it.live('fails a unit whose upload fails and keeps its log tail', () =>
  Effect.acquireUseRelease(
    makeFixture([{ artifactId: 51, id: ALPHA, mode: 'reupload' }]),
    (fixture) =>
      Effect.gen(function* failedUpload() {
        yield* packUnit(fixture, ALPHA, 51);
        expect(yield* stream(fixture, { SHIM_FAIL_UNITS: ALPHA })).toBe(false);
        expect(unitLogText(fixture, ALPHA)).toContain('release CLI exit 1');
        expect(existsSync(path.join(fixture.receipts, `${ALPHA}.json`))).toBe(false);
      }),
    ({ root }) => removeRoot(root),
  ).pipe(Effect.provide(services)),
);

const listed = (status: string, conclusion: string | null): RunJob => ({
  conclusion: Option.fromNullOr(conclusion),
  name: ALPHA_BUILD,
  status,
});

it('treats a job that never appears as missing only after the grace period', () => {
  expect(jobState([], ALPHA_BUILD, false)).toEqual({ kind: 'pending' });
  expect(jobState([], ALPHA_BUILD, true)).toEqual({
    kind: 'failed',
    message: 'Build alpha is missing from this run',
  });
  expect(jobState([listed('completed', 'cancelled')], ALPHA_BUILD, false)).toEqual({
    kind: 'failed',
    message: 'Build alpha ended cancelled',
  });
  expect(jobState([listed('completed', 'skipped')], ALPHA_BUILD, false)).toEqual({
    kind: 'failed',
    message: 'Build alpha ended skipped',
  });
  expect(jobState([listed('queued', null)], ALPHA_BUILD, true)).toEqual({ kind: 'pending' });
  expect(jobState([listed('completed', 'success')], ALPHA_BUILD, false)).toEqual({ kind: 'success' });
});

it.effect('records every uploaded or verified receipt and the prepared database in the ledger', () =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(os.tmpdir(), 'release-stream-ledger-'))),
    (root) =>
      Effect.gen(function* recordsLedger() {
        const now = yield* DateTime.nowAsDate;
        const ledgerFile = path.join(root, 'ledger.json');
        writeFileSync(
          ledgerFile,
          serializeLedger(
            emptyLedger({ digestVersion: 'ontos-deploy-plan-v1', now, runId: '41', sourceRevision: REVISION }),
          ),
        );
        mkdirSync(path.join(root, 'receipts'));
        for (const id of [ALPHA, BETA]) {
          writeFileSync(path.join(root, 'receipts', `${id}.json`), JSON.stringify(receiptFor(id)));
        }
        writeFileSync(
          path.join(root, UNIT_STATES),
          JSON.stringify([
            { artifactName: '', digest: unitDigest(ALPHA), id: ALPHA, mode: 'build', status: 'uploaded' },
            { artifactName: '', digest: unitDigest(BETA), id: BETA, mode: 'retain', status: 'retained' },
            { artifactName: '', digest: unitDigest('gamma'), id: 'gamma', mode: 'build', status: 'failed' },
          ]),
        );
        const record = {
          identityFp: digestOf('identity'),
          inputsDigest: digestOf('inputs'),
          stateHash: digestOf('state'),
        };
        writeFileSync(path.join(root, 'database.json'), JSON.stringify(record));
        yield* recordLedger({
          databaseRecord: path.join(root, 'database.json'),
          ledgerFile,
          receipts: path.join(root, 'receipts'),
          runId: '42',
          stateFile: path.join(root, UNIT_STATES),
        });
        const ledger = parseLedger(readFileSync(ledgerFile, UTF8));
        expect(new Set(Object.keys(ledger.units))).toEqual(new Set([unitDigest(ALPHA), unitDigest(BETA)]));
        expect(ledger.units[unitDigest(ALPHA)]?.runId).toBe('42');
        expect(ledger.database).toMatchObject({ ...record, runId: '42' });
      }),
    removeRoot,
  ).pipe(Effect.provide(services)),
);

const planLines = (decision: Readonly<Record<string, boolean | string | null>>) =>
  `log line\n${JSON.stringify(decision)}\n`;

it('takes the database light path only when the plan command succeeded and every condition holds', () => {
  const light = {
    authorityPhase: 'active',
    light: true,
    loginsOk: true,
    reason: 'matching-preparation',
    stateHash: digestOf('state'),
  };
  expect(databasePath(planLines(light), 0)).toEqual({ mode: 'light', reason: 'matching-preparation' });
  expect(databasePath(planLines(light), 1).mode).toBe('full');
  expect(databasePath('', 0)).toEqual({ mode: 'full', reason: 'plan-unavailable' });
  expect(databasePath(planLines({ ...light, authorityPhase: 'migrated' }), 0).mode).toBe('full');
  expect(databasePath(planLines({ ...light, loginsOk: false }), 0).mode).toBe('full');
  expect(databasePath(planLines({ ...light, stateHash: null }), 0).mode).toBe('full');
  expect(databasePath(planLines({ ...light, light: false, reason: 'state-changed' }), 0)).toEqual({
    mode: 'full',
    reason: 'state-changed',
  });
  expect(databasePath(planLines({ ...light, light: false, reason: 'untrusted\nreason' }), 0).reason).toBe('unknown');
});

it.effect('names the host artifact the release deploys and the revision it was built from', () =>
  Effect.gen(function* namesHostRelease() {
    const digest = digestOf('host');
    const retained = {
      host: {
        artifact: Option.some({ id: 7, name: 'outbox-host', sourceRevision: REVISION }),
        digest: Option.some(digest),
        mode: 'retain' as const,
      },
    };
    const built = { host: { artifact: Option.none(), digest: Option.some(digest), mode: 'build' as const } };
    const thisRun = 'c'.repeat(40);
    expect(yield* hostRelease(retained, thisRun)).toEqual({ digest, sourceRevision: REVISION });
    expect(yield* hostRelease(built, thisRun)).toEqual({ digest, sourceRevision: thisRun });
    const noDigest = yield* Effect.flip(hostRelease({ host: { ...built.host, digest: Option.none() } }, thisRun));
    expect(noDigest.message).toContain('no outbox host digest');
    const noArtifact = yield* Effect.flip(
      hostRelease({ host: { ...retained.host, artifact: Option.none() } }, thisRun),
    );
    expect(noArtifact.message).toContain('without its artifact');
  }),
);

it.live('joins a background step by its exit status and fails a step that never finishes', () =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(os.tmpdir(), 'release-stream-join-'))),
    (root) =>
      Effect.gen(function* joinsBackground() {
        const soon = (yield* Clock.currentTimeMillis) + 50;
        expect(yield* joinBackground(root, soon, Duration.millis(5))).toBe(1);
        writeFileSync(path.join(root, 'stream.log'), 'uploaded alpha in 3 s\n');
        writeFileSync(path.join(root, 'exit-code'), '0\n');
        expect(yield* joinBackground(root, soon, Duration.millis(5))).toBe(0);
        writeFileSync(path.join(root, 'exit-code'), '3\n');
        expect(yield* joinBackground(root, soon, Duration.millis(5))).toBe(3);
      }),
    removeRoot,
  ).pipe(Effect.provide(services)),
);

it.live('plans an outbox-only retry from the trusted prebuilt host only, never a build', () =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(os.tmpdir(), 'release-stream-host-plan-'))),
    (root) =>
      Effect.gen(function* plansOutboxRetry() {
        const digest = digestOf('host');
        const missing = yield* Effect.flip(outboxHostPlan(digest, Option.none()));
        expect(missing.message).toContain('run a full release');
        const file = path.join(root, 'plan.json');
        const artifact = { id: 9, name: `outbox-host-${digest}`, sourceRevision: REVISION };
        writeFileSync(file, yield* outboxHostPlan(digest, Option.some(artifact)));
        const plan = yield* readPlan(file);
        expect(plan.units).toEqual([]);
        expect(plan.host).toEqual({ artifact: Option.some(artifact), digest: Option.some(digest), mode: 'retain' });
        // The retry deploys that artifact, built at its own revision.
        expect(yield* hostRelease(plan, 'c'.repeat(40))).toEqual({ digest, sourceRevision: REVISION });
      }),
    removeRoot,
  ).pipe(Effect.provide(services)),
);

it('outbox-only selects the revision matching every live owner, not the newest content-equal build', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  const revisionB = 'b'.repeat(40);
  const revisionC = 'c'.repeat(40);
  const digest = digestOf('host');
  const markers = { [ALPHA]: digestOf('alpha-at-A'), [BETA]: digestOf('beta-at-A') };
  const ledgerAt = (sourceRevision: string, runId: string) => {
    let ledger = emptyLedger({ digestVersion: DIGEST_VERSION, now, runId, sourceRevision });
    for (const unitId of [ALPHA, BETA] as const) {
      const receipt = receiptFor(unitId);
      ledger = recordUnitReceipt(ledger, {
        digest: unitDigest(unitId),
        now,
        receipt: {
          ...receipt,
          plan: {
            ...receipt.plan,
            buildMarker: sourceRevision === REVISION ? markers[unitId] : digestOf(`${unitId}-at-${sourceRevision}`),
            sourceRevision,
          },
        },
        runId,
        unitId,
      });
    }
    return ledger;
  };
  const builtAt = (sourceRevision: string, id: number) => ({
    artifact: { created_at: now.toISOString(), expired: false, id, name: `outbox-host-${digest}` },
    run: { head_sha: sourceRevision, id },
  });
  const published = builtAt(REVISION, 1);
  // The newest run failed after uploading owners; another dispatch only built. Neither published these markers.
  const artifacts = [builtAt(revisionC, 3), builtAt(revisionB, 2), published];
  const ledgers = [ledgerAt(revisionC, '3'), ledgerAt(REVISION, '1')];
  const select = (selectedArtifacts = artifacts, selectedMarkers: Readonly<Record<string, string>> = markers) =>
    publishedHostArtifact({
      artifacts: selectedArtifacts,
      digest,
      ledgers,
      markers: selectedMarkers,
      now,
    });
  expect(select()).toEqual(published);
  expect(select(artifacts.slice(0, 2))).toBeUndefined();
  expect(select(artifacts, { ...markers, [BETA]: digestOf(`beta-at-${revisionC}`) })).toBeUndefined();
  expect(select(artifacts, {})).toBeUndefined();
  expect(publishedHostArtifact({ artifacts, digest, ledgers: [], markers, now })).toBeUndefined();
});
