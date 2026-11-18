import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';
import { parse } from 'yaml';

import { collectToolingProcess } from '../tests/tooling-process-fixture.mts';

/**
 * The stage delivery's unit caches (zerops-stage.yml build shards) under the cache rules of
 * scripts/tests/cache-budget.test.mts: an entry is named by its units' identity rows, never by commit or run, and a
 * shard saves only an entry it did not restore exactly.
 */
const APP = path.resolve(import.meta.dirname, '../..');
const REPOSITORY = path.resolve(APP, '..');
const STAGE_WORKFLOW = '.github/workflows/zerops-stage.yml';
const KEY_SCRIPT = 'scripts/ci/cache-entry-key.sh';
const IDENTITY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

const StepSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  if: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
  with: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))),
});
const WorkflowSchema = Schema.Struct({
  jobs: Schema.Record(Schema.String, Schema.Struct({ steps: Schema.optional(Schema.Array(StepSchema)) })),
});

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
