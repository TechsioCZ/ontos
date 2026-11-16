import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';
import { parse } from 'yaml';

import { collectToolingProcess } from './tooling-process-fixture.mts';

/**
 * The repository's Actions cache holds 10 GiB. On 2026-11-15 the gates' unit output cache wrote a full 1.7 GiB set on
 * every pull request run (keyed by merge sha, run id and attempt) and evicted the stage deploy's unit caches, so the
 * next deploy rebuilt all 28 units. A cache key names what decides the cache's content, never the commit or the run.
 */
const APP = path.resolve(import.meta.dirname, '../..');
const REPOSITORY = path.resolve(APP, '..');
const STAGE_WORKFLOW = '.github/workflows/zerops-stage.yml';
const SOURCES = [
  '.github/workflows/ultramodern-workspace-gates.yml',
  STAGE_WORKFLOW,
  '.github/actions/install-app/action.yml',
] as const;
const PER_RUN =
  /github\.(?:sha|run_id|run_attempt|event\.pull_request\.head\.sha)|\$\{?GITHUB_(?:SHA|RUN_ID|RUN_ATTEMPT)\b|\.github\/workflows\//u;
const CACHE_ACTION = /^actions\/cache(?:\/restore|\/save)?@/u;

/**
 * The caches whose content is the commit or the run itself, so their key must name it. Every other key fails on any
 * per-commit or per-run part.
 */
const PER_RUN_ALLOWED = new Map([
  // The deploy ledger: one record per attempt (well under 1 KiB), read back by prefix to find the last verified one.
  ['zerops-stage-attempt-v1-', 'one delivery attempt record per run, under 1 KiB'],
  ['zerops-stage-delivery-v1-', 'one verified source pin record per run, under 1 KiB'],
  // Saved only by main pushes (warm-caches): the incremental TS-Go state of that commit, restored by prefix.
  ['tsgo-', 'the TS-Go incremental build of one main commit, saved by main pushes only'],
]);

const StepSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  if: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
  with: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))),
});
type Step = typeof StepSchema.Type;
const WorkflowSchema = Schema.Struct({
  jobs: Schema.Record(Schema.String, Schema.Struct({ steps: Schema.optional(Schema.Array(StepSchema)) })),
});
const ActionSchema = Schema.Struct({ runs: Schema.Struct({ steps: Schema.Array(StepSchema) }) });

interface CacheStep {
  readonly key: string;
  readonly label: string;
  readonly save: boolean;
  readonly step: Step;
}

/** A key's text with every `steps.<id>.outputs.*` it reads replaced by what that step computes it from. */
const resolveKey = (key: string, steps: readonly Step[], installApp: readonly Step[]): string =>
  key.replaceAll(
    /\$\{\{\s*steps\.(?<id>[\w-]+)\.outputs\.(?<output>[\w-]+)\s*\}\}/gu,
    (whole, id: string, output: string) => {
      const source = steps.find((candidate) => candidate.id === id);
      if (source === undefined) {
        return whole;
      }
      if (CACHE_ACTION.test(source.uses ?? '')) {
        return resolveKey(String(source.with?.key ?? ''), steps, installApp);
      }
      // The install action names the TS-Go cache in its own `typescript-build` step.
      if (source.uses === './.github/actions/install-app' && output === 'typescript-build-key') {
        return installApp.find((candidate) => candidate.id === 'typescript-build')?.run ?? whole;
      }
      return source.run ?? whole;
    },
  );

const cacheSteps = Effect.gen(function* readCacheSteps() {
  const fs = yield* FileSystem.FileSystem;
  const found: CacheStep[] = [];
  const installApp = (yield* Schema.decodeUnknownEffect(ActionSchema)(
    parse(yield* fs.readFileString(path.join(REPOSITORY, '.github/actions/install-app/action.yml'))),
  )).runs.steps;
  for (const source of SOURCES) {
    const document: unknown = parse(yield* fs.readFileString(path.join(REPOSITORY, source)));
    const jobs = source.endsWith('action.yml')
      ? [['install-app', (yield* Schema.decodeUnknownEffect(ActionSchema)(document)).runs.steps] as const]
      : Object.entries((yield* Schema.decodeUnknownEffect(WorkflowSchema)(document)).jobs).map(
          ([job, { steps }]) => [job, steps ?? []] as const,
        );
    for (const [job, steps] of jobs) {
      for (const step of steps.filter(({ uses }) => CACHE_ACTION.test(uses ?? ''))) {
        const raw = [step.with?.key, step.with?.['restore-keys']].map((value) => String(value ?? '')).join('\n');
        found.push({
          key: resolveKey(raw, steps, installApp),
          label: `${path.basename(source)} ${job} › ${step.name ?? step.uses ?? ''}`,
          save: (step.uses ?? '').startsWith('actions/cache/save@'),
          step,
        });
      }
    }
  }
  return found;
});

const allowedFor = (key: string) => [...PER_RUN_ALLOWED.keys()].find((prefix) => key.includes(prefix));

it.effect('names no cache by commit, run or workflow file unless its content is that commit or run', () =>
  Effect.gen(function* perRunKeys() {
    const steps = yield* cacheSteps;
    expect(steps.length).toBeGreaterThan(10);
    const offenders = steps
      .filter(({ key }) => PER_RUN.test(key) && allowedFor(key) === undefined)
      .map(({ key, label }) => `${label}: ${key}`);
    expect(offenders).toEqual([]);
    // Every allow-list entry still names a real cache, so the list cannot outlive what it excuses.
    for (const prefix of PER_RUN_ALLOWED.keys()) {
      expect(
        steps.some(({ key }) => key.includes(prefix)),
        prefix,
      ).toBe(true);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('saves a content-keyed cache only when the run did not restore that exact entry', () =>
  Effect.gen(function* savesOnlyNew() {
    const saves = (yield* cacheSteps).filter(({ key, save }) => save && allowedFor(key) === undefined);
    const always = saves.filter(({ step }) => !/cache-hit != 'true'/u.test(step.if ?? ''));
    // The main-only TS-Go save is allow-listed above; every other save skips an exact hit.
    expect(always.map(({ label }) => label)).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

/**
 * The only conditions a content-keyed save may have: its exact entry was not restored, and its key was named. Anything
 * else (for example "only when something was built") leaves a cache restored through a prefix without an entry under
 * its own name, so it depends on the fallback forever (run 43725413089: six stage shards reused and saved nothing).
 */
const SAVE_CLAUSE = /^steps\.[\w-]+\.outputs\.(?:cache-hit != 'true'|key != '')$/u;

it.effect('makes every content-keyed save depend only on its exact entry not being restored', () =>
  Effect.gen(function* saveClauses() {
    const saves = (yield* cacheSteps).filter(({ key, save }) => save && allowedFor(key) === undefined);
    const offenders = saves.flatMap(({ label, step }) =>
      (step.if ?? '')
        .split('&&')
        .map((clause) => clause.trim())
        // Which runs may write (an input, the ref) is policy; what a step produced may only be the exact hit and key.
        .filter((clause) => clause.includes('steps.') && !SAVE_CLAUSE.test(clause))
        .map((clause) => `${label}: ${clause}`),
    );
    expect(offenders).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const KEY_SCRIPT = 'scripts/ci/cache-entry-key.sh';
const IDENTITY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const runKey = (input: string, env: Readonly<Record<string, string>> = {}) =>
  collectToolingProcess(
    ChildProcess.make('bash', ['-c', `printf '%s' "$INPUT" | bash ${KEY_SCRIPT} gates-units-v2-Linux-X64-3-`], {
      cwd: APP,
      env: { INPUT: input, ...env },
      extendEnv: true,
    }),
  );

it.live(
  'names the same entry for the same identities in any order, a new one for a changed unit, and refuses doubt',
  () =>
    Effect.gen(function* keyScript() {
      const first = yield* runKey(`crm=${IDENTITY}\ntax=${IDENTITY}\n`);
      const again = yield* runKey(`tax=${IDENTITY}\ncrm=${IDENTITY}\n`);
      const changed = yield* runKey(`crm=${IDENTITY}\ntax=${OTHER}\n`);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toMatch(/^key=gates-units-v2-Linux-X64-3-[a-f0-9]{64}\n$/u);
      expect(again.stdout).toBe(first.stdout);
      expect(changed.stdout).not.toBe(first.stdout);
      // Stage identity rows (unit, identity, inputs part, variables) name entries the same way.
      const row = yield* runKey(`crm\t${IDENTITY}\tfiles\tNODE_ENV=1a2b\n`);
      expect(row.status, row.stderr).toBe(0);
      for (const [label, input, reason] of [
        ['no identities', '', 'no unit identities on stdin'],
        ['no identity', 'crm=\n', 'not a unit identity: crm='],
        ['short identity', 'crm=abc\n', 'not a unit identity'],
      ] as const) {
        const result = yield* runKey(input);
        expect(result.status, label).toBe(1);
        expect(result.stderr, label).toContain(reason);
        expect(result.stdout, label).toBe('');
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live('refuses to name an entry when the hash fails', () =>
  Effect.gen(function* failingHash() {
    const fs = yield* FileSystem.FileSystem;
    const bin = yield* fs.makeTempDirectoryScoped({ prefix: 'cache-key-stub-' });
    yield* fs.writeFileString(path.join(bin, 'sha256sum'), '#!/bin/sh\nexit 1\n');
    yield* fs.chmod(path.join(bin, 'sha256sum'), 0o700);
    const result = yield* runKey(`crm=${IDENTITY}\n`, { PATH: `${bin}:${yield* Config.String('PATH')}` });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const stepRun = (source: string, job: string, name: string) =>
  Effect.gen(function* findRun() {
    const fs = yield* FileSystem.FileSystem;
    const workflow = yield* Schema.decodeUnknownEffect(WorkflowSchema)(
      parse(yield* fs.readFileString(path.join(REPOSITORY, source))),
    );
    const run = (workflow.jobs[job]?.steps ?? []).find((step) => step.name === name)?.run;
    if (run === undefined) {
      return yield* Effect.die(`no run script in ${job} › ${name}`);
    }
    return run;
  });
const runStep = (cwd: string, script: string, env: Readonly<Record<string, string>>) =>
  collectToolingProcess(
    ChildProcess.make('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd,
      env,
      extendEnv: true,
    }),
  );

it.live("runs the stage shard's naming step: a key from its units' rows, and a failure on a missing row", () =>
  Effect.gen(function* stageNaming() {
    const fs = yield* FileSystem.FileSystem;
    const script = yield* stepRun(STAGE_WORKFLOW, 'build', "Name the shard's unit cache entry");
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'stage-unit-key-' });
    yield* fs.makeDirectory(path.join(root, 'app/scripts/ci'), { recursive: true });
    yield* fs.copyFile(path.join(APP, KEY_SCRIPT), path.join(root, 'app', KEY_SCRIPT));
    const identities = path.join(root, 'temp/zerops-unit-identities');
    yield* fs.makeDirectory(identities, { recursive: true });
    const name = (shards: string, digests: string) =>
      Effect.gen(function* nameEntry() {
        yield* fs.writeFileString(path.join(identities, 'shards.tsv'), shards);
        yield* fs.writeFileString(path.join(identities, 'digests.tsv'), digests);
        const outputs = path.join(root, 'outputs');
        yield* fs.writeFileString(outputs, '');
        const result = yield* runStep(root, script, {
          GITHUB_OUTPUT: outputs,
          RUNNER_TEMP: path.join(root, 'temp'),
          SHARD: '2',
        });
        return { output: yield* fs.readFileString(outputs), result };
      });
    const rows = `crm\t${IDENTITY}\tf\tv\ntax\t${IDENTITY}\tf\tv\nshell-super-app\t${OTHER}\tf\tv\n`;
    const unchanged = yield* name('2\tcrm tax\n', rows);
    expect(unchanged.result.status, unchanged.result.stderr).toBe(0);
    expect(unchanged.output).toMatch(/^key=zerops-units-v2-2-[a-f0-9]{64}\n$/u);
    // Another shard's unit changing leaves this shard's entry; one of its own units changing names a new one.
    const otherShard = yield* name('2\tcrm tax\n', rows.replace(OTHER, IDENTITY));
    expect(otherShard.output).toBe(unchanged.output);
    const ownChanged = yield* name('2\tcrm tax\n', rows.replace(`tax\t${IDENTITY}`, `tax\t${OTHER}`));
    expect(ownChanged.output).not.toBe(unchanged.output);
    // A unit without its row, or a shard without its list, names nothing and fails the step.
    for (const [shards, digests] of [
      ['2\tcrm tax\n', `crm\t${IDENTITY}\tf\tv\n`],
      ['0\tshell-super-app\n', rows],
    ] as const) {
      const missing = yield* name(shards, digests);
      expect(missing.result.status).not.toBe(0);
      expect(missing.output).toBe('');
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("runs the gates shard's naming step with the unit digests the cache tool prints", () =>
  Effect.gen(function* gatesNaming() {
    const fs = yield* FileSystem.FileSystem;
    const script = yield* stepRun(
      '.github/workflows/ultramodern-workspace-gates.yml',
      'node-artifact-build',
      "Name the shard's unit output cache entry",
    );
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'gates-unit-key-' });
    yield* fs.makeDirectory(path.join(root, 'scripts/ci'), { recursive: true });
    yield* fs.copyFile(path.join(APP, KEY_SCRIPT), path.join(root, KEY_SCRIPT));
    const bin = path.join(root, 'bin');
    yield* fs.makeDirectory(bin);
    // `mise exec -- node scripts/ci/unit-output-cache.mts digest --unit …` answers from $DIGESTS, or fails.
    yield* fs.writeFileString(
      path.join(bin, 'mise'),
      `#!/usr/bin/env bash\n[ -n "\${DIGESTS:-}" ] || exit 5\nprintf "%s" "$DIGESTS"\n`,
    );
    yield* fs.chmod(path.join(bin, 'mise'), 0o700);
    const searchPath = `${bin}:${yield* Config.String('PATH')}`;
    const name = (digests: string) =>
      Effect.gen(function* nameEntry() {
        const outputs = path.join(root, 'outputs');
        yield* fs.writeFileString(outputs, '');
        const result = yield* runStep(root, script, {
          DIGESTS: digests,
          GITHUB_OUTPUT: outputs,
          PATH: searchPath,
          RUNNER_ARCH: 'X64',
          RUNNER_OS: 'Linux',
          SHARD: '3',
          SHARD_UNITS: 'verticals/crm verticals/tax',
        });
        return { output: yield* fs.readFileString(outputs), result };
      });
    const kept = yield* name(`crm=${IDENTITY}\ntax=${IDENTITY}\n`);
    expect(kept.result.status, kept.result.stderr).toBe(0);
    expect(kept.output).toMatch(/^key=gates-units-v2-Linux-X64-3-[a-f0-9]{64}\n$/u);
    expect((yield* name(`crm=${IDENTITY}\ntax=${IDENTITY}\n`)).output).toBe(kept.output);
    expect((yield* name(`crm=${IDENTITY}\ntax=${OTHER}\n`)).output).not.toBe(kept.output);
    // A failing digest (pipefail) fails the step without a key, so nothing is saved under a guess.
    const failed = yield* name('');
    expect(failed.result.status).not.toBe(0);
    expect(failed.output).toBe('');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

/** Evaluates a step `if` made of `steps.<id>.outputs.<name> ==|!= '<value>'` clauses joined by `&&`. */
const evaluateIf = (condition: string, outputs: Readonly<Record<string, string>>) =>
  condition.split('&&').every((clause) => {
    const match = /^steps\.(?<ref>[\w-]+\.outputs\.[\w-]+) (?<op>==|!=) '(?<value>[^']*)'$/u.exec(clause.trim());
    if (match?.groups === undefined) {
      throw new Error(`unsupported condition: ${clause}`);
    }
    const actual = outputs[match.groups.ref ?? ''] ?? '';
    return match.groups.op === '==' ? actual === match.groups.value : actual !== match.groups.value;
  });

const StageBuildSchema = Schema.Struct({
  jobs: Schema.Struct({ build: Schema.Struct({ steps: Schema.Array(StepSchema) }) }),
});

it.live(
  "saves the stage shard's entry after a reuse through a fallback, never after an exact hit, and after a build",
  () =>
    Effect.gen(function* stageSaveDecision() {
      const fs = yield* FileSystem.FileSystem;
      const { steps } = (yield* Schema.decodeUnknownEffect(StageBuildSchema)(
        parse(yield* fs.readFileString(path.join(REPOSITORY, STAGE_WORKFLOW))),
      )).jobs.build;
      const named = (name: string) => {
        const step = steps.find((candidate) => candidate.name === name);
        if (step === undefined) {
          throw new Error(`no step ${name}`);
        }
        return step;
      };
      const saveIf = named("Save the shard's unit builds").if ?? '';
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'stage-save-' });
      for (const script of [KEY_SCRIPT, 'scripts/zerops/reuse-shard-units.sh']) {
        yield* fs.makeDirectory(path.dirname(path.join(root, 'app', script)), { recursive: true });
        yield* fs.copyFile(path.join(APP, script), path.join(root, 'app', script));
      }
      const temp = path.join(root, 'temp');
      const identities = path.join(temp, 'zerops-unit-identities');
      yield* fs.makeDirectory(identities, { recursive: true });
      yield* fs.writeFileString(path.join(identities, 'shards.tsv'), '2\tcrm tax\n');
      yield* fs.writeFileString(
        path.join(identities, 'digests.tsv'),
        `crm\t${IDENTITY}\tf\tv\ntax\t${IDENTITY}\tf\tv\n`,
      );
      const cache = path.join(temp, 'zerops-unit-cache');
      const fill = (units: readonly string[]) =>
        Effect.gen(function* fillCache() {
          yield* fs.remove(cache, { force: true, recursive: true });
          yield* fs.makeDirectory(cache, { recursive: true });
          for (const unit of units) {
            yield* fs.makeDirectory(path.join(cache, unit), { recursive: true });
            yield* fs.writeFileString(path.join(cache, unit, 'zerops-entry.mjs'), 'export {};\n');
            yield* fs.writeFileString(path.join(cache, unit, '.zerops-build-digest'), `${IDENTITY}\n`);
          }
        });
      const stepOutputs = (cwd: string, name: string, env: Readonly<Record<string, string>>) =>
        Effect.gen(function* runForOutputs() {
          const outputs = path.join(root, 'outputs');
          yield* fs.writeFileString(outputs, '');
          const result = yield* runStep(cwd, named(name).run ?? '', {
            GITHUB_OUTPUT: outputs,
            RUNNER_TEMP: temp,
            SHARD: '2',
            UNIT_CACHE_DIR: cache,
            ...env,
          });
          expect(result.status, `${name}: ${result.stderr}`).toBe(0);
          return Object.fromEntries(
            (yield* fs.readFileString(outputs))
              .split('\n')
              .filter((line) => line.includes('='))
              .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
          );
        });
      const decide = (restored: readonly string[], cacheHit: boolean) =>
        Effect.gen(function* decideSave() {
          yield* fill(restored);
          const naming = yield* stepOutputs(root, "Name the shard's unit cache entry", {});
          const reuse = yield* stepOutputs(path.join(root, 'app'), "Reuse the shard's unchanged units", {});
          const save = evaluateIf(saveIf, {
            'reuse.outputs.reused': reuse.reused ?? '',
            'unit-cache-key.outputs.key': naming.key ?? '',
            'unit-cache.outputs.cache-hit': cacheHit ? 'true' : 'false',
          });
          return { cached: (yield* fs.readDirectory(cache)).toSorted(), reused: reuse.reused, save };
        });
      // Restored through a prefix (another entry, here with a foreign unit) and every unit reused: saved, exactly them.
      const fallback = yield* decide(['crm', 'retired', 'tax'], false);
      expect(fallback).toStrictEqual({ cached: ['crm', 'tax'], reused: 'true', save: true });
      // The exact entry restored and reused: nothing saved.
      const exact = yield* decide(['crm', 'tax'], true);
      expect(exact).toStrictEqual({ cached: ['crm', 'tax'], reused: 'true', save: false });
      // Nothing restored: the shard builds (reused=false), and the built set is saved.
      const cold = yield* decide([], false);
      expect(cold.reused).toBe('false');
      expect(cold.save).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
