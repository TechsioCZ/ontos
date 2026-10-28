// The stage demo release job's runner-side orchestration. It waits for this run's jobs (barrier B1: the release
// script tests; barrier B2: every expected build), streams each finished unit's build output into its immutable
// upload as soon as that unit's build succeeds, and writes the stage release ledger at its checkpoints.
// GitHub is read only through `gh api` and every child process goes through the OpsShell seam, so the tests put
// `gh` and `pnpm` shims on the child PATH. Owner secrets reach an upload only through its redacted environment.
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  Cause,
  Clock,
  Config,
  Console,
  DateTime,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  Semaphore,
} from 'effect';
import { Command, Flag } from 'effect/cli';

import { OpsShellLive, runCommand } from '../ops/ops-shell.mts';
import type { OpsShellService, SecretValues } from '../ops/ops-shell.mts';
import { hostArtifactName, storefrontArtifactName, unitArtifactName } from './deploy-plan.mts';
import {
  createGitHubClient,
  parseLedger,
  readZipEntries,
  recordDatabase,
  recordUnitReceipt,
  serializeLedger,
} from './release-ledger.mts';

export class ReleaseStreamError extends Schema.TaggedError<ReleaseStreamError>()('ReleaseStreamError', {
  message: Schema.String,
}) {}

const failure = (message: string) => new ReleaseStreamError({ message });

const SHELL_ID = 'shell-super-app';
const OUTBOX_HOST = 'outbox-host';
const STOREFRONT = 'akros-storefront';
const SHA256 = /^[\da-f]{64}$/u;
/** The workflow's job names; the barriers find this run's jobs by them. */
export const RELEASE_TESTS_JOB = 'Test the release scripts';
export const HOST_BUILD_JOB = 'Build the outbox host';
export const STOREFRONT_BUILD_JOB = 'Build akros-storefront';
export const unitBuildJob = (unitId: string) => `Build ${unitId}`;

/** Where this run is and how often it polls GitHub. `childEnv` extends every child process environment. */
export interface StreamSettings {
  readonly childEnv: SecretValues;
  /** A job that is still not listed after this long is missing, not merely not created yet. */
  readonly missingJobGrace: Duration.Duration;
  readonly pollInterval: Duration.Duration;
  readonly repository: string;
  readonly runId: string;
  readonly scratch: string;
  readonly workspaceRoot: string;
}

const JobSchema = Schema.Struct({
  conclusion: Schema.OptionFromNullOr(Schema.String),
  name: Schema.String,
  status: Schema.String,
});
export type RunJob = typeof JobSchema.Type;
const JobsPageJson = Schema.fromJsonString(
  Schema.Struct({ jobs: Schema.Array(JobSchema), total_count: Schema.Number }),
);
const ArtifactsPageJson = Schema.fromJsonString(
  Schema.Struct({
    artifacts: Schema.Array(Schema.Struct({ expired: Schema.Boolean, id: Schema.Number, name: Schema.String })),
  }),
);
const ArtifactRefSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  sourceRevision: Schema.optionalKey(Schema.String),
});
const UnitModeSchema = Schema.Literals(['retain', 'reupload', 'build']);
const PlannedUnitSchema = Schema.Struct({
  artifact: Schema.OptionFromNullOr(ArtifactRefSchema),
  digest: Schema.String,
  id: Schema.String,
  mode: UnitModeSchema,
  path: Schema.String,
  receipt: Schema.OptionFromNullOr(Schema.Unknown),
});
type PlannedUnit = typeof PlannedUnitSchema.Type;
/** The parts of deploy-plan.mts's plan the release reads. */
const DeployPlanSchema = Schema.Struct({
  host: Schema.Struct({
    artifact: Schema.OptionFromNullOr(ArtifactRefSchema),
    digest: Schema.OptionFromNullOr(Schema.String),
    mode: Schema.Literals(['retain', 'build']),
  }),
  storefront: Schema.Struct({
    artifact: Schema.OptionFromNullOr(ArtifactRefSchema),
    digest: Schema.String,
    mode: Schema.Literals(['reuse', 'build']),
  }),
  units: Schema.Array(PlannedUnitSchema),
});
export type DeployPlan = typeof DeployPlanSchema.Type;
const UnitStateSchema = Schema.Struct({
  /** The build output the release used; empty for a retained module, which needs none. */
  artifactName: Schema.String,
  digest: Schema.String,
  id: Schema.String,
  mode: UnitModeSchema,
  status: Schema.Literals(['waiting', 'uploading', 'uploaded', 'retained', 'failed']),
});
type UnitState = typeof UnitStateSchema.Type;
const UnitStatesJson = Schema.fromJsonString(Schema.Array(UnitStateSchema));
const OwnerSecretsSchema = Schema.Record(Schema.String, Schema.String);
const SecretBundleJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const OwnerSecretsJson = Schema.fromJsonString(OwnerSecretsSchema);
const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const DatabaseRecordJson = Schema.fromJsonString(
  Schema.Struct({ identityFp: Schema.String, inputsDigest: Schema.String, stateHash: Schema.String }),
);
const DatabasePlanLineJson = Schema.fromJsonString(
  Schema.Struct({
    authorityPhase: Schema.String,
    light: Schema.Boolean,
    loginsOk: Schema.Boolean,
    reason: Schema.String,
    stateHash: Schema.OptionFromNullOr(Schema.String),
  }),
);

const decodeJson = <A,>(schema: Schema.Codec<A, string>, text: string, what: string) =>
  Schema.decodeUnknownEffect(schema)(text).pipe(Effect.mapError(() => failure(`${what} is malformed`)));

const encodeJson = <A,>(schema: Schema.Codec<A, string>, value: A, what: string) =>
  Schema.encodeEffect(schema)(value).pipe(Effect.mapError(() => failure(`${what} cannot be encoded`)));

const github = (settings: StreamSettings, route: string) =>
  runCommand({ args: ['api', route], command: 'gh', env: settings.childEnv }).pipe(
    Effect.mapError(() => failure(`gh api ${route.split('?')[0] ?? route} failed`)),
  );

/** The latest attempt of every job of this run, so a re-run of failed jobs sees its new attempts. */
export const listRunJobs = (
  settings: StreamSettings,
): Effect.Effect<readonly RunJob[], ReleaseStreamError, OpsShellService> => {
  const page = (
    number: number,
    collected: readonly RunJob[],
  ): Effect.Effect<readonly RunJob[], ReleaseStreamError, OpsShellService> =>
    github(
      settings,
      `repos/${settings.repository}/actions/runs/${settings.runId}/jobs?filter=latest&per_page=100&page=${String(number)}`,
    ).pipe(
      Effect.flatMap((text) => decodeJson(JobsPageJson, text, 'the run jobs page')),
      Effect.flatMap(({ jobs, total_count: total }) => {
        const all = [...collected, ...jobs];
        return jobs.length < 100 || all.length >= total ? Effect.succeed(all) : page(number + 1, all);
      }),
    );
  return page(1, []);
};

export type JobState =
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'pending' }
  | { readonly kind: 'success' };

export const jobState = (jobs: readonly RunJob[], name: string, pastGrace: boolean): JobState => {
  const matching = jobs.filter((job) => job.name === name);
  const [job] = matching;
  if (job === undefined) {
    return pastGrace ? { kind: 'failed', message: `${name} is missing from this run` } : { kind: 'pending' };
  }
  if (matching.length > 1) {
    return { kind: 'failed', message: `${name} names more than one job of this run` };
  }
  if (job.status !== 'completed') {
    return { kind: 'pending' };
  }
  const conclusion = Option.getOrElse(job.conclusion, () => 'without a conclusion');
  return conclusion === 'success' ? { kind: 'success' } : { kind: 'failed', message: `${name} ended ${conclusion}` };
};

type JobGate = Deferred.Deferred<true, ReleaseStreamError>;

const settleJob = (gate: JobGate, state: JobState, timedOut: boolean, name: string) => {
  if (state.kind === 'success') {
    return Deferred.succeed(gate, true);
  }
  if (state.kind === 'failed') {
    return Deferred.fail(gate, failure(state.message));
  }
  return timedOut ? Deferred.fail(gate, failure(`timed out waiting for ${name}`)) : Effect.succeed(false);
};

/**
 * Polls this run's jobs once per interval and settles each job's gate: success when it succeeded, failure on any
 * other conclusion, when it is missing after the grace period, or at the deadline. Returns once all are settled.
 */
const settleJobs = (settings: StreamSettings, gates: ReadonlyMap<string, JobGate>, deadline: number) =>
  Effect.gen(function* settleRunJobs() {
    const started = yield* Clock.currentTimeMillis;
    const openGates = Effect.filter([...gates], ([, gate]) => Effect.map(Deferred.isDone(gate), (done) => !done));
    const round: Effect.Effect<void, ReleaseStreamError, OpsShellService> = Effect.gen(function* pollRunJobs() {
      const open = yield* openGates;
      if (open.length === 0) {
        return yield* Effect.void;
      }
      const jobs = yield* listRunJobs(settings);
      const now = yield* Clock.currentTimeMillis;
      const pastGrace = now - started >= Duration.toMillis(settings.missingJobGrace);
      for (const [name, gate] of open) {
        yield* settleJob(gate, jobState(jobs, name, pastGrace), now >= deadline, name);
      }
      if ((yield* openGates).length === 0) {
        return yield* Effect.void;
      }
      yield* Effect.sleep(settings.pollInterval);
      return yield* round;
    });
    return yield* round;
  });

/**
 * The poller as the stream forks it: when polling itself fails (an API error or a malformed job list), every gate
 * still open fails with it, so no unit waits for a poller that no longer runs or enforces the deadline.
 */
const superviseJobs = (settings: StreamSettings, gates: ReadonlyMap<string, JobGate>, deadline: number) =>
  settleJobs(settings, gates, deadline).pipe(
    Effect.onError((cause) => {
      const reason = Cause.findErrorOption(cause).pipe(
        Option.map(({ message }) => message),
        Option.getOrElse(() => 'polling stopped unexpectedly'),
      );
      return Effect.forEach(
        gates.values(),
        (gate) => Deferred.fail(gate, failure(`could not follow this run's build jobs: ${reason}`)),
        { discard: true },
      );
    }),
  );

const makeGates = (names: readonly string[]) =>
  Effect.gen(function* makeJobGates() {
    const gates = new Map<string, JobGate>();
    for (const name of names) {
      gates.set(name, yield* Deferred.make<true, ReleaseStreamError>());
    }
    return gates;
  });

/** Waits until every named job of this run succeeded. Any other conclusion, a missing job or the deadline fails. */
export const awaitJobs = (settings: StreamSettings, names: readonly string[], deadline: number) =>
  Effect.gen(function* awaitRunJobs() {
    const gates = yield* makeGates(names);
    yield* settleJobs(settings, gates, deadline);
    yield* Effect.forEach([...gates.values()], Deferred.await, { discard: true });
  });

/** The newest unexpired artifact of that name uploaded by this run (artifact ids only grow). */
const runArtifactId = (settings: StreamSettings, name: string) =>
  github(
    settings,
    `repos/${settings.repository}/actions/runs/${settings.runId}/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
  ).pipe(
    Effect.flatMap((text) => decodeJson(ArtifactsPageJson, text, 'the run artifacts page')),
    Effect.flatMap(({ artifacts }) => {
      let newest = -1;
      for (const artifact of artifacts) {
        if (artifact.name === name && !artifact.expired && artifact.id > newest) {
          newest = artifact.id;
        }
      }
      return newest < 0 ? Effect.fail(failure(`this run has no artifact ${name}`)) : Effect.succeed(newest);
    }),
  );

const unwritable = (artifactId: number) => () => failure(`artifact ${String(artifactId)} could not be written`);

/** Downloads one artifact through the REST zip endpoint and writes its files into a directory. */
export const downloadArtifact = (settings: StreamSettings, artifactId: number, directory: string) =>
  Effect.gen(function* downloadRunArtifact() {
    const fs = yield* FileSystem.FileSystem;
    const id = String(artifactId);
    yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(unwritable(artifactId)));
    const zip = path.join(directory, `.artifact-${id}.zip`);
    yield* runCommand({
      args: [
        '-c',
        'gh api "$1" >"$2"',
        'artifact-download',
        `repos/${settings.repository}/actions/artifacts/${id}/zip`,
        zip,
      ],
      command: 'bash',
      env: settings.childEnv,
    }).pipe(Effect.mapError(() => failure(`artifact ${id} could not be downloaded`)));
    const archive = yield* fs.readFile(zip).pipe(Effect.mapError(unwritable(artifactId)));
    const entries = yield* Effect.try({
      catch: () => failure(`artifact ${id} is not a readable zip archive`),
      try: () => readZipEntries(Buffer.from(archive)),
    });
    const root = path.resolve(directory);
    const files: string[] = [];
    for (const [name, bytes] of entries) {
      const target = path.resolve(root, name);
      if (name.endsWith('/') || !target.startsWith(`${root}${path.sep}`)) {
        return yield* failure(`artifact ${id} holds an unexpected entry`);
      }
      yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(Effect.mapError(unwritable(artifactId)));
      yield* fs.writeFile(target, bytes).pipe(Effect.mapError(unwritable(artifactId)));
      files.push(target);
    }
    yield* fs.remove(zip).pipe(Effect.mapError(unwritable(artifactId)));
    return files;
  });

export const readPlan = (file: string) =>
  Effect.gen(function* readDeployPlan() {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file).pipe(Effect.mapError(() => failure('the deploy plan is unreadable')));
    return yield* decodeJson(Schema.fromJsonString(DeployPlanSchema), text, 'the deploy plan');
  });

const writeAtomically = (file: string, text: string) =>
  Effect.gen(function* writeFileAtomically() {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${file}.tmp`, text, { mode: 0o600 });
    yield* fs.rename(`${file}.tmp`, file);
  }).pipe(Effect.mapError(() => failure(`${path.basename(file)} could not be written`)));

const elapsed = (started: number) =>
  Clock.currentTimeMillis.pipe(Effect.map((now) => `${String(Math.round((now - started) / 1000))} s`));

export interface StreamOptions {
  readonly deadline: number;
  readonly logs: string;
  readonly parallelism: number;
  readonly planFile: string;
  /** The stored secrets file the digest check of an artifact built at another revision fingerprints. */
  readonly rawSecretsFile: Redacted.Redacted;
  readonly receipts: string;
  /** The prepared owner-keyed release secret bundle. */
  readonly secretsFile: Redacted.Redacted;
  readonly stateFile: string;
  /** Created by the release job when a later step failed: no unit starts after it appears. */
  readonly stopFile: string;
}

/** One streaming release: its settings, progress and the gates of the build jobs it waits for. */
interface StreamRun {
  readonly builds: ReadonlyMap<string, JobGate>;
  readonly options: StreamOptions;
  readonly settings: StreamSettings;
  readonly stateLock: Semaphore.Semaphore;
  readonly states: Ref.Ref<ReadonlyMap<string, UnitState>>;
  readonly stopped: Ref.Ref<boolean>;
}

const setStatus = (run: StreamRun, id: string, status: UnitState['status']) =>
  run.stateLock.withPermits(1)(
    Effect.gen(function* saveUnitState() {
      const next = yield* Ref.updateAndGet(run.states, (current) => {
        const state = current.get(id);
        return state === undefined ? current : new Map(current).set(id, { ...state, status });
      });
      const text = yield* encodeJson(UnitStatesJson, [...next.values()], 'the unit states');
      yield* writeAtomically(run.options.stateFile, `${text}\n`);
    }),
  );

const unitLog = (run: StreamRun, unit: PlannedUnit) => path.join(run.options.logs, `${unit.id}.log`);
/** Where scripts/ci/build-edge-unit.sh packs a unit's release plan and the inputs.json of its digest. */
const unitReleaseDirectory = (unitId: string) => `.codex/reports/releases/${unitId}`;
const unitInputsFile = (unitId: string) => `${unitReleaseDirectory(unitId)}/inputs.json`;

/** Marks the unit failed and stops new work: units still waiting for their build never start. */
const failUnit = (run: StreamRun, unit: PlannedUnit, message: string) =>
  Effect.gen(function* failStreamUnit() {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(unitLog(run, unit), `${message}\n`, { flag: 'a' }).pipe(Effect.ignore);
    yield* Console.error(`::error title=Release unit failed::${message}`);
    yield* setStatus(run, unit.id, 'failed');
    yield* Ref.set(run.stopped, true);
    for (const gate of run.builds.values()) {
      yield* Deferred.fail(gate, failure('not started after an earlier unit failed'));
    }
    return false;
  });

/** One release script command for the unit; its output goes to the unit's log only. */
const releaseCli = (run: StreamRun, unit: PlannedUnit, args: readonly string[], env: SecretValues) =>
  runCommand({
    args: [
      '-c',
      'exec "$@" >>"$RELEASE_UNIT_LOG" 2>&1',
      'release-unit',
      'pnpm',
      'exec',
      'node',
      unit.id === SHELL_ID ? 'scripts/immutable-shell-release.mts' : 'scripts/immutable-application-release.mts',
      ...args,
    ],
    command: 'bash',
    cwd: run.settings.workspaceRoot,
    env: { ...run.settings.childEnv, ...env, RELEASE_UNIT_LOG: Redacted.make(unitLog(run, unit)) },
  }).pipe(
    Effect.as(true),
    Effect.catchTag('OpsCommandError', () => Effect.succeed(false)),
  );

const unpackUnit = (run: StreamRun, unit: PlannedUnit, artifactId: number) =>
  Effect.gen(function* unpackUnitOutput() {
    const fs = yield* FileSystem.FileSystem;
    const { settings } = run;
    const files = yield* downloadArtifact(settings, artifactId, path.join(settings.scratch, 'edge-units', unit.id));
    const archive = files.find((file) => path.basename(file) === 'edge-unit.tar.zst');
    if (archive === undefined) {
      return yield* failure(`${unit.id}: the build artifact holds no edge-unit.tar.zst`);
    }
    yield* runCommand({
      args: ['--extract', '--zstd', '--file', archive],
      command: 'tar',
      cwd: settings.workspaceRoot,
      env: settings.childEnv,
    }).pipe(Effect.mapError(() => failure(`${unit.id}: the build output could not be unpacked`)));
    for (const required of [
      path.join(unit.path, '.output/wrangler.json'),
      `${unitReleaseDirectory(unit.id)}/plan.json`,
      unitInputsFile(unit.id),
    ]) {
      if (!(yield* fs.exists(path.join(settings.workspaceRoot, required)).pipe(Effect.orElseSucceed(() => false)))) {
        return yield* failure(`${unit.id}: the build output has no ${required}`);
      }
    }
    // Release scripts require a clean checkout; build outputs are ignored files only.
    const status = yield* runCommand({
      args: ['status', '--porcelain=v1', '--untracked-files=all'],
      command: 'git',
      cwd: settings.workspaceRoot,
      env: settings.childEnv,
    }).pipe(Effect.mapError(() => failure(`${unit.id}: the checkout status is unreadable`)));
    if (status.trim() !== '') {
      return yield* failure(`${unit.id}: unpacking its build output left the checkout dirty`);
    }
    return yield* Effect.void;
  });

/** The owner's prepared secret object as redacted JSON, never logged. */
const ownerSecrets = (secretsFile: Redacted.Redacted, unitId: string) =>
  Effect.gen(function* readOwnerSecrets() {
    const fs = yield* FileSystem.FileSystem;
    const bundle = yield* fs
      .readFileString(Redacted.value(secretsFile))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(SecretBundleJson)), Effect.option);
    const owner = bundle.pipe(
      Option.flatMap((record) =>
        Object.hasOwn(record, unitId) ? Schema.decodeUnknownOption(OwnerSecretsSchema)(record[unitId]) : Option.none(),
      ),
    );
    if (Option.isNone(owner)) {
      return Option.none<Redacted.Redacted>();
    }
    const encoded = yield* Schema.encodeEffect(OwnerSecretsJson)(owner.value).pipe(Effect.option);
    return encoded.pipe(Option.map((text) => Redacted.make(text)));
  });

const retainUnit = (run: StreamRun, unit: PlannedUnit, receipt: string, started: number) =>
  Effect.gen(function* retainStreamUnit() {
    const text = yield* encodeJson(UnknownJson, Option.getOrNull(unit.receipt), `${unit.id} receipt`);
    yield* writeAtomically(receipt, text);
    if (unit.id === SHELL_ID) {
      // The Shell ingress needs the build output of its kept Workers.
      yield* unpackUnit(run, unit, Option.match(unit.artifact, { onNone: () => 0, onSome: ({ id }) => id }));
    }
    if (!(yield* releaseCli(run, unit, ['verify-retained', '--receipt-file', receipt], {}))) {
      return yield* failUnit(
        run,
        unit,
        `${unit.id}: its retained Workers no longer match the ledger receipt; re-run with force_full`,
      );
    }
    yield* Console.error(`retained ${unit.id} after a live check in ${yield* elapsed(started)}`);
    yield* setStatus(run, unit.id, 'retained');
    return true;
  });

const uploadUnit = (run: StreamRun, unit: PlannedUnit, receipt: string, started: number) =>
  Effect.gen(function* uploadStreamUnit() {
    const fs = yield* FileSystem.FileSystem;
    const secrets = yield* ownerSecrets(run.options.secretsFile, unit.id);
    if (Option.isNone(secrets)) {
      return yield* failUnit(
        run,
        unit,
        `::error title=Missing release secrets::${unit.id} has no valid owner secret object; upload not started`,
      );
    }
    const artifactName =
      unit.mode === 'build'
        ? unitArtifactName(unit.id, unit.digest)
        : Option.match(unit.artifact, { onNone: () => '', onSome: ({ name }) => name });
    const artifactId =
      unit.mode === 'build'
        ? yield* runArtifactId(run.settings, artifactName)
        : Option.match(unit.artifact, { onNone: () => 0, onSome: ({ id }) => id });
    yield* unpackUnit(run, unit, artifactId);
    // The release script retries a transient Cloudflare failure (unknown error 10013, internal 10021, 429/5xx,
    // dropped connections) up to three times, removing the attempt's half release first so the same identity
    // uploads again; any other failure ends the unit at once.
    const uploaded = yield* releaseCli(
      run,
      unit,
      [
        'deploy',
        '--app-directory',
        unit.path,
        '--plan-file',
        `${unitReleaseDirectory(unit.id)}/plan.json`,
        '--receipt-file',
        receipt,
        '--artifact-name',
        artifactName,
        '--inputs-file',
        unitInputsFile(unit.id),
      ],
      { ALL_RELEASE_SECRETS_FILE: run.options.rawSecretsFile, ONTOS_IMMUTABLE_RELEASE_SECRETS: secrets.value },
    );
    if (!uploaded) {
      const tail = yield* fs.readFileString(unitLog(run, unit)).pipe(Effect.orElseSucceed(() => ''));
      yield* Console.error(`::group::${unit.id} upload log\n${tail.split('\n').slice(-80).join('\n')}\n::endgroup::`);
      return yield* failUnit(
        run,
        unit,
        `${unit.id}: upload failed (see its upload log; a unit that failed only transiently left no half release, so re-running the job retries it)`,
      );
    }
    yield* Console.error(`uploaded ${unit.id} in ${yield* elapsed(started)}`);
    yield* setStatus(run, unit.id, 'uploaded');
    return true;
  });

/** A failed release job stops the stream: units still waiting never start, running uploads finish. */
const watchStopFile = (run: StreamRun) =>
  Effect.gen(function* watchReleaseStop() {
    const fs = yield* FileSystem.FileSystem;
    const watch: Effect.Effect<void> = Effect.gen(function* pollStopFile() {
      if (yield* fs.exists(run.options.stopFile).pipe(Effect.orElseSucceed(() => false))) {
        yield* Ref.set(run.stopped, true);
        for (const gate of run.builds.values()) {
          yield* Deferred.fail(gate, failure('not started: a later release step failed'));
        }
        return yield* Effect.void;
      }
      yield* Effect.sleep(run.settings.pollInterval);
      return yield* watch;
    });
    return yield* watch;
  });

const releaseUnit = (run: StreamRun, unit: PlannedUnit) =>
  Effect.gen(function* releaseStreamUnit() {
    if (yield* Ref.get(run.stopped)) {
      yield* Console.error(`${unit.id}: not started after an earlier unit failed`);
      return false;
    }
    const started = yield* Clock.currentTimeMillis;
    yield* setStatus(run, unit.id, 'uploading');
    const receipt = path.join(run.options.receipts, `${unit.id}.json`);
    return yield* unit.mode === 'retain'
      ? retainUnit(run, unit, receipt, started)
      : uploadUnit(run, unit, receipt, started);
  }).pipe(Effect.catchTag('ReleaseStreamError', (cause) => failUnit(run, unit, cause.message)));

const awaitAndRelease = (run: StreamRun, uploads: Semaphore.Semaphore, unit: PlannedUnit) => {
  const gate = run.builds.get(unitBuildJob(unit.id));
  const ready: Effect.Effect<unknown, ReleaseStreamError> = gate === undefined ? Effect.void : Deferred.await(gate);
  return ready.pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        Effect.flatMap(Ref.get(run.stopped), (stopped) =>
          stopped
            ? Effect.as(Console.error(`${unit.id}: ${cause.message}`), false)
            : failUnit(run, unit, `${unit.id}: ${cause.message}`),
        ),
      onSuccess: () => uploads.withPermits(1)(releaseUnit(run, unit)),
    }),
  );
};

/**
 * Uploads, or verifies, every served unit. Retained units are checked live against their ledger receipt; the others
 * start as soon as their output exists (reupload) or their build job succeeds (build), at most `parallelism` at a
 * time. The first failure stops new work; uploads already running finish, so none leaves a half release behind.
 */
export const streamUploads = (settings: StreamSettings, options: StreamOptions) =>
  Effect.scoped(
    Effect.gen(function* streamReleaseUploads() {
      const fs = yield* FileSystem.FileSystem;
      const plan = yield* readPlan(options.planFile);
      yield* fs.makeDirectory(options.receipts, { recursive: true });
      yield* fs.makeDirectory(options.logs, { recursive: true });
      const initial = new Map<string, UnitState>();
      for (const unit of plan.units) {
        initial.set(unit.id, {
          artifactName:
            unit.mode === 'build'
              ? unitArtifactName(unit.id, unit.digest)
              : Option.match(unit.artifact, { onNone: () => '', onSome: ({ name }) => name }),
          digest: unit.digest,
          id: unit.id,
          mode: unit.mode,
          status: 'waiting',
        });
      }
      const run: StreamRun = {
        builds: yield* makeGates(plan.units.filter(({ mode }) => mode === 'build').map(({ id }) => unitBuildJob(id))),
        options,
        settings,
        stateLock: yield* Semaphore.make(1),
        states: yield* Ref.make<ReadonlyMap<string, UnitState>>(initial),
        stopped: yield* Ref.make(false),
      };
      yield* writeAtomically(
        options.stateFile,
        `${yield* encodeJson(UnitStatesJson, [...initial.values()], 'the unit states')}\n`,
      );
      const uploads = yield* Semaphore.make(Math.max(1, options.parallelism));
      // The scope interrupts the poller and the stop watch once every unit has finished.
      yield* superviseJobs(settings, run.builds, options.deadline).pipe(Effect.forkScoped);
      yield* watchStopFile(run).pipe(Effect.forkScoped);
      const outcomes = yield* Effect.forEach(plan.units, (unit) => awaitAndRelease(run, uploads, unit), {
        concurrency: 'unbounded',
      });
      return outcomes.every(Boolean);
    }),
  );

export interface LedgerOptions {
  readonly databaseRecord: string;
  readonly ledgerFile: string;
  readonly receipts: string;
  readonly runId: string;
  readonly stateFile: string;
}

const readJsonFile = <A,>(file: string, schema: Schema.Codec<A, string>) =>
  Effect.gen(function* readOptionalJsonFile() {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)), Effect.option);
  });

/** Records every receipt this run uploaded or verified, and the database it prepared, into the ledger. */
export const recordLedger = (options: LedgerOptions) =>
  Effect.gen(function* recordReleaseLedger() {
    const fs = yield* FileSystem.FileSystem;
    const now = yield* DateTime.nowAsDate;
    const text = yield* fs
      .readFileString(options.ledgerFile)
      .pipe(Effect.mapError(() => failure('the release ledger is unreadable')));
    let ledger = yield* Effect.try({
      catch: () => failure('the release ledger is malformed'),
      try: () => parseLedger(text),
    });
    const states = Option.getOrElse(
      yield* readJsonFile(options.stateFile, UnitStatesJson),
      (): readonly UnitState[] => [],
    );
    for (const state of states.filter(({ status }) => status === 'uploaded' || status === 'retained')) {
      const receipt = yield* readJsonFile(path.join(options.receipts, `${state.id}.json`), UnknownJson);
      const current = ledger;
      const recorded = receipt.pipe(
        Option.flatMap((value) =>
          Option.liftThrowable(recordUnitReceipt)(current, {
            digest: state.digest,
            now,
            receipt: value,
            runId: options.runId,
            unitId: state.id,
          }),
        ),
      );
      if (Option.isSome(recorded)) {
        ledger = recorded.value;
      } else {
        yield* Console.error(`::warning::${state.id}: its receipt could not be recorded in the ledger`);
      }
    }
    const record = yield* readJsonFile(options.databaseRecord, DatabaseRecordJson);
    if (Option.isSome(record)) {
      const current = ledger;
      const recorded = Option.liftThrowable(recordDatabase)(current, { ...record.value, now, runId: options.runId });
      if (Option.isSome(recorded)) {
        ledger = recorded.value;
      } else {
        yield* Console.error('::warning::the database preparation record could not be recorded in the ledger');
      }
    }
    yield* writeAtomically(options.ledgerFile, serializeLedger(ledger));
    return ledger;
  });

export interface DatabasePath {
  readonly mode: 'full' | 'light';
  readonly reason: string;
}

/** The light path needs `stage-demo-migrate.mts --plan` to have succeeded and every one of its conditions to hold. */
export const databasePath = (text: string, exitCode: number): DatabasePath => {
  const decisions = text
    .split(/\r?\n/u)
    .flatMap((line) => Option.toArray(Schema.decodeUnknownOption(DatabasePlanLineJson)(line)));
  const decision = decisions.at(-1);
  if (exitCode !== 0 || decision === undefined) {
    return { mode: 'full', reason: 'plan-unavailable' };
  }
  const reason = /^[a-z-]+$/u.test(decision.reason) ? decision.reason : 'unknown';
  const light =
    decision.light &&
    decision.authorityPhase === 'active' &&
    decision.loginsOk &&
    Option.exists(decision.stateHash, (hash) => SHA256.test(hash));
  return light
    ? { mode: 'light', reason }
    : { mode: 'full', reason: reason === 'matching-preparation' ? 'unknown' : reason };
};

export interface HostFacts {
  readonly force: boolean;
  /** The live host's artifact digest from `await-outbox-admission.mts --probe`; none when unreachable. */
  readonly liveDigest: Option.Option<string>;
  /** The recovery configuration apply report's `changed`; anything but `false` counts as changed. */
  readonly recoveryChanged: string;
  readonly sourceRevision: string;
}

export interface HostDecision {
  readonly deploy: boolean;
  readonly digest: string;
  readonly reason: string;
  readonly sourceRevision: string;
}

/** Whether the outbox host deploys, and the revision its artifact was built from. */
export const hostDecision = (
  plan: Pick<DeployPlan, 'host'>,
  facts: HostFacts,
): Effect.Effect<HostDecision, ReleaseStreamError> => {
  const { artifact, mode } = plan.host;
  const digest = Option.getOrElse(plan.host.digest, () => '');
  if (!SHA256.test(digest)) {
    return Effect.fail(failure('the deploy plan has no outbox host digest'));
  }
  if (mode === 'retain' && Option.isNone(artifact)) {
    return Effect.fail(failure('the deploy plan retains the outbox host without its artifact'));
  }
  const sourceRevision =
    mode === 'build'
      ? facts.sourceRevision
      : Option.match(artifact, { onNone: () => '', onSome: (ref) => ref.sourceRevision ?? '' });
  const decide = (deploy: boolean, reason: string) => Effect.succeed({ deploy, digest, reason, sourceRevision });
  if (mode === 'build') {
    return decide(true, 'host-inputs-changed');
  }
  if (facts.force) {
    return decide(true, 'outbox-only-retry');
  }
  if (facts.recoveryChanged !== 'false') {
    return decide(true, 'recovery-configuration-changed');
  }
  return Option.match(facts.liveDigest, {
    onNone: () => decide(true, 'status-unavailable'),
    onSome: (live) => (live === digest ? decide(false, 'live-host-matches') : decide(true, 'status-mismatch')),
  });
};

/** Waits for a background step's `exit-code` file, prints its log and returns its exit status. */
export const joinBackground = (directory: string, deadline: number, pollInterval: Duration.Duration) =>
  Effect.gen(function* joinBackgroundStep() {
    const fs = yield* FileSystem.FileSystem;
    const exitFile = path.join(directory, 'exit-code');
    const wait: Effect.Effect<boolean> = Effect.gen(function* waitForExitCode() {
      if (yield* fs.exists(exitFile).pipe(Effect.orElseSucceed(() => false))) {
        return true;
      }
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return false;
      }
      yield* Effect.sleep(pollInterval);
      return yield* wait;
    });
    if (!(yield* wait)) {
      yield* Console.error(`::error title=Background step timed out::${path.basename(directory)} did not finish`);
      return 1;
    }
    const output = yield* fs.readFileString(path.join(directory, 'stream.log')).pipe(Effect.orElseSucceed(() => ''));
    if (output !== '') {
      yield* Console.log(output.trimEnd());
    }
    const code = Number((yield* fs.readFileString(exitFile).pipe(Effect.orElseSucceed(() => ''))).trim());
    return Number.isInteger(code) ? code : 1;
  });

/** Fetches the host or storefront build output: this run's (after its build job succeeded) or the plan's kept one. */
export const fetchBuildArtifact = (
  settings: StreamSettings,
  plan: DeployPlan,
  kind: typeof OUTBOX_HOST | typeof STOREFRONT,
  directory: string,
  deadline: number,
) =>
  Effect.gen(function* fetchPlannedArtifact() {
    const target =
      kind === OUTBOX_HOST ? { ...plan.host, digest: Option.getOrElse(plan.host.digest, () => '') } : plan.storefront;
    if (target.mode === 'build') {
      if (!SHA256.test(target.digest)) {
        return yield* failure(`the deploy plan has no ${kind} digest`);
      }
      // Barrier B2 for this artifact: its build job of this run must succeed first.
      yield* awaitJobs(settings, [kind === OUTBOX_HOST ? HOST_BUILD_JOB : STOREFRONT_BUILD_JOB], deadline);
      const name = kind === OUTBOX_HOST ? hostArtifactName(target.digest) : storefrontArtifactName(target.digest);
      return yield* downloadArtifact(settings, yield* runArtifactId(settings, name), directory);
    }
    if (Option.isNone(target.artifact)) {
      return yield* failure(`the deploy plan reuses ${kind} without its artifact`);
    }
    return yield* downloadArtifact(settings, target.artifact.value.id, directory);
  });

/**
 * The host-only plan an outbox-only retry deploys: the newest trusted prebuilt host artifact of this digest. It never
 * builds: a revision without one needs a full release.
 */
export const outboxHostPlan = (digest: string, artifact: Option.Option<typeof ArtifactRefSchema.Type>) =>
  Option.match(artifact, {
    onNone: () =>
      Effect.fail(failure(`no trusted prebuilt outbox host artifact ${hostArtifactName(digest)}; run a full release`)),
    onSome: (found) =>
      encodeJson(
        Schema.fromJsonString(DeployPlanSchema),
        {
          host: { artifact: Option.some(found), digest: Option.some(digest), mode: 'retain' },
          storefront: { artifact: Option.none(), digest: '', mode: 'reuse' },
          units: [],
        },
        'the outbox host plan',
      ),
  });

const trustedHostArtifact = (digest: string) =>
  Effect.gen(function* findTrustedHostArtifact() {
    const [repository, token, apiUrl] = yield* Effect.all([
      Config.String('GITHUB_REPOSITORY'),
      Config.Redacted('GH_TOKEN'),
      Config.String('GITHUB_API_URL').pipe(Config.withDefault('https://api.github.com')),
    ]);
    const client = createGitHubClient({
      apiUrl,
      fetch: fetch.bind(globalThis),
      repository,
      token: Redacted.value(token),
    });
    const [found] = yield* Effect.tryPromise({
      catch: () => failure('the trusted outbox host artifacts could not be listed'),
      try: async () => await client.trustedArtifacts(hostArtifactName(digest), 1),
    });
    return Option.fromNullOr(found).pipe(
      Option.map(({ artifact, run }) => ({ id: artifact.id, name: artifact.name, sourceRevision: run.head_sha ?? '' })),
    );
  });

/** Step outputs, one `key=value` line each, for `>>"$GITHUB_OUTPUT"`. */
const printOutputs = (outputs: Readonly<Record<string, string>>) =>
  Console.log(
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );

const runSettings = Effect.gen(function* readRunSettings() {
  const [repository, runId, scratch] = yield* Effect.all([
    Config.String('GITHUB_REPOSITORY'),
    Config.String('GITHUB_RUN_ID'),
    Config.String('RUNNER_TEMP'),
  ]);
  return {
    childEnv: {},
    missingJobGrace: Duration.minutes(2),
    pollInterval: Duration.seconds(10),
    repository,
    runId,
    scratch,
    workspaceRoot: path.resolve(import.meta.dirname, '../..'),
  } satisfies StreamSettings;
});
const deadlineAfter = (seconds: number) => Clock.currentTimeMillis.pipe(Effect.map((now) => now + seconds * 1000));
const timeoutFlag = Flag.Int('timeout-seconds');

const awaitCommand = Command.make(
  'await',
  { jobs: Flag.String('job').pipe(Flag.atLeast(1)), timeout: timeoutFlag },
  ({ jobs, timeout }) =>
    Effect.gen(function* awaitCommandEffect() {
      yield* awaitJobs(yield* runSettings, jobs, yield* deadlineAfter(timeout));
      return yield* Console.log(`${jobs.join(', ')} succeeded`);
    }),
);

const streamCommand = Command.make(
  'stream',
  {
    logs: Flag.String('logs'),
    parallelism: Flag.Int('parallelism'),
    plan: Flag.String('plan'),
    receipts: Flag.String('receipts'),
    state: Flag.String('state'),
    stopFile: Flag.String('stop-file'),
    timeout: timeoutFlag,
  },
  (flags) =>
    Effect.gen(function* streamCommandEffect() {
      const [secretsFile, rawSecretsFile] = yield* Effect.all([
        Config.Redacted('ALL_RELEASE_SECRETS_FILE'),
        Config.Redacted('RAW_RELEASE_SECRETS_FILE'),
      ]);
      const ok = yield* streamUploads(yield* runSettings, {
        deadline: yield* deadlineAfter(flags.timeout),
        logs: flags.logs,
        parallelism: flags.parallelism,
        planFile: flags.plan,
        rawSecretsFile,
        receipts: flags.receipts,
        secretsFile,
        stateFile: flags.state,
        stopFile: flags.stopFile,
      });
      return ok ? yield* Effect.void : yield* failure('not every unit reached stage; see the unit errors above');
    }),
);

const joinCommand = Command.make(
  'join',
  { directory: Flag.String('directory'), timeout: timeoutFlag },
  ({ directory, timeout }) =>
    Effect.gen(function* joinCommandEffect() {
      const code = yield* joinBackground(directory, yield* deadlineAfter(timeout), Duration.seconds(2));
      return code === 0 ? yield* Effect.void : yield* failure(`the background step exited ${String(code)}`);
    }),
);

const ledgerCommand = Command.make(
  'ledger',
  {
    databaseRecord: Flag.String('database-record'),
    ledger: Flag.String('ledger'),
    receipts: Flag.String('receipts'),
    state: Flag.String('state'),
  },
  (flags) =>
    Effect.gen(function* ledgerCommandEffect() {
      const ledger = yield* recordLedger({
        databaseRecord: flags.databaseRecord,
        ledgerFile: flags.ledger,
        receipts: flags.receipts,
        runId: yield* Config.String('GITHUB_RUN_ID'),
        stateFile: flags.state,
      });
      return yield* Console.log(
        `ledger: ${String(Object.keys(ledger.units).length)} unit receipts, host ${ledger.host?.digest.slice(0, 12) ?? 'none'}, database ${ledger.database === null ? 'none' : 'recorded'}`,
      );
    }),
);

const databasePathCommand = Command.make(
  'database-path',
  { databasePlan: Flag.String('database-plan'), exitCode: Flag.Int('exit-code') },
  ({ databasePlan, exitCode }) =>
    Effect.gen(function* databasePathCommandEffect() {
      const fs = yield* FileSystem.FileSystem;
      const decision = databasePath(
        yield* fs.readFileString(databasePlan).pipe(Effect.orElseSucceed(() => '')),
        exitCode,
      );
      const message = `Database preparation: ${decision.mode === 'light' ? 'light path, the sealed chain is skipped' : 'full sealed chain'} (${decision.reason})`;
      yield* Console.error(message);
      const summary = yield* Config.option(Config.String('GITHUB_STEP_SUMMARY'));
      if (Option.isSome(summary)) {
        yield* fs.writeFileString(summary.value, `${message}\n`, { flag: 'a' });
      }
      return yield* printOutputs({ mode: decision.mode, reason: decision.reason });
    }),
);

const hostDecisionCommand = Command.make(
  'host-decision',
  {
    force: Flag.String('force'),
    liveDigest: Flag.String('live-digest'),
    plan: Flag.String('plan'),
    recoveryChanged: Flag.String('recovery-changed'),
  },
  (flags) =>
    Effect.gen(function* hostDecisionCommandEffect() {
      const decision = yield* hostDecision(yield* readPlan(flags.plan), {
        force: flags.force === 'true',
        liveDigest: flags.liveDigest === '' ? Option.none() : Option.some(flags.liveDigest),
        recoveryChanged: flags.recoveryChanged,
        sourceRevision: yield* Config.String('GITHUB_SHA'),
      });
      yield* Console.error(
        `Outbox host ${decision.digest.slice(0, 12)}: ${decision.deploy ? 'deploys' : 'kept'} (${decision.reason})`,
      );
      return yield* printOutputs({
        deploy: String(decision.deploy),
        digest: decision.digest,
        reason: decision.reason,
        'source-revision': decision.sourceRevision,
      });
    }),
);

const fetchCommand = Command.make(
  'fetch',
  {
    artifact: Flag.String('artifact'),
    output: Flag.String('output'),
    plan: Flag.String('plan'),
    timeout: timeoutFlag.pipe(Flag.withDefault(1500)),
  },
  (flags) =>
    Effect.gen(function* fetchCommandEffect() {
      if (flags.artifact !== OUTBOX_HOST && flags.artifact !== STOREFRONT) {
        return yield* failure(`--artifact must be ${OUTBOX_HOST} or ${STOREFRONT}`);
      }
      const files = yield* fetchBuildArtifact(
        yield* runSettings,
        yield* readPlan(flags.plan),
        flags.artifact,
        flags.output,
        yield* deadlineAfter(flags.timeout),
      );
      return yield* Console.log(`fetched ${flags.artifact}: ${files.map((file) => path.basename(file)).join(', ')}`);
    }),
);

const hostPlanCommand = Command.make(
  'host-plan',
  { digest: Flag.String('digest'), output: Flag.String('output') },
  ({ digest, output }) =>
    Effect.gen(function* hostPlanCommandEffect() {
      if (!SHA256.test(digest)) {
        return yield* failure('--digest must be the outbox host digest');
      }
      const text = yield* outboxHostPlan(digest, yield* trustedHostArtifact(digest));
      yield* writeAtomically(output, `${text}\n`);
      return yield* Console.log(`outbox host ${digest.slice(0, 12)}: deploying its trusted prebuilt artifact`);
    }),
);

if (import.meta.main) {
  const cli = Command.make('release-stream').pipe(
    Command.withSubcommands([
      awaitCommand,
      hostPlanCommand,
      streamCommand,
      joinCommand,
      ledgerCommand,
      databasePathCommand,
      hostDecisionCommand,
      fetchCommand,
    ]),
  );
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(Command.run({ version: '1.0.0' })(cli)).pipe(
        Layer.provide(OpsShellLive),
        Layer.provide(NodeServices.layer),
      ),
    ).pipe(Effect.scoped),
  );
}
