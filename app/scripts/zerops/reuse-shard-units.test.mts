import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';
import { parse } from 'yaml';

import { collectToolingProcess } from '../tests/tooling-process-fixture.mts';

const APP = path.resolve(import.meta.dirname, '../..');
const REUSE = 'scripts/zerops/reuse-shard-units.sh';
const WORKFLOW = path.resolve(APP, '../.github/workflows/zerops-stage.yml');
const DIGEST = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const NEEDS_BUILD = 3;
const BUILD_SHARD_CONDITION = "needs.deliver.outputs.build_units == 'true'";
const FORCE_OFF = "env.ZEROPS_FORCE_BUILD != 'true'";
const NOT_REUSED = "steps.reuse.outputs.reused != 'true'";
const REUSE_STEP = "Reuse the shard's unchanged units";
const IDENTITY_STEP = 'Write the unit identities and shard lists';
const BUILD_STEP = "Build the shard's units";
const UNITS_ARCHIVE = 'units.tar.zst';
const BUILD_FALSE = 'build=false';
const TAKE_STEP = "Take this commit's units from the earlier builds by identity";
const DECIDE_STEP = 'Decide where the units come from';

const StepSchema = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number]))),
  id: Schema.optional(Schema.String),
  if: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
});
const JobSchema = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))),
  if: Schema.optional(Schema.String),
  needs: Schema.optional(Schema.Array(Schema.String)),
  steps: Schema.Array(StepSchema),
});
const WorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({ build: JobSchema, deliver: JobSchema }),
});

const workflow = Effect.gen(function* readWorkflow() {
  const fs = yield* FileSystem.FileSystem;
  return (yield* Schema.decodeUnknownEffect(WorkflowSchema)(parse(yield* fs.readFileString(WORKFLOW)))).jobs;
});
const stepRun = (job: typeof JobSchema.Type, name: string) =>
  Effect.gen(function* findStep() {
    const step = job.steps.find((candidate) => candidate.name === name);
    if (step?.run === undefined) {
      return yield* Effect.die(`no run script in step ${name}`);
    }
    return step.run;
  });

const front = (job: typeof JobSchema.Type, name: string) => job.steps.find((candidate) => candidate.name === name);

/** Runs a script the way GitHub runs a `run:` step: bash, errexit and pipefail, in the given directory. */
const runStep = (cwd: string, script: string, env: Readonly<Record<string, string>>) =>
  collectToolingProcess(
    ChildProcess.make('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd,
      env,
      extendEnv: true,
    }),
  );
const runReuse = (cwd: string, args: readonly string[]) =>
  collectToolingProcess(ChildProcess.make('bash', [REUSE, ...args], { cwd, extendEnv: true }));

/**
 * A shard's working copy (app/ with the reuse script), this commit's identity tables and a restored unit cache:
 * units `crm` and `tax` in shard 2, both cached with their entry, a source map and the identity they were built for.
 */
const BOTH_CURRENT = { crm: DIGEST, tax: DIGEST };
const SHARDS_FILE = 'shards.tsv';
const DIGESTS_FILE = 'digests.tsv';
const IDENTITIES_TEMP = 'temp/zerops-unit-identities';
const BUILD_APP = 'scripts/zerops/build-app.sh';

const fixture = (cached: Readonly<Record<string, string>>) =>
  Effect.gen(function* makeFixture() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'reuse-shard-units-' });
    const app = path.join(root, 'app');
    yield* fs.makeDirectory(path.join(app, 'scripts/zerops'), { recursive: true });
    yield* fs.copyFile(path.join(APP, REUSE), path.join(app, REUSE));
    const identities = path.join(root, 'identities');
    yield* fs.makeDirectory(identities);
    yield* fs.writeFileString(path.join(identities, SHARDS_FILE), '0\tshell-super-app\n2\tcrm tax\n');
    yield* fs.writeFileString(
      path.join(identities, DIGESTS_FILE),
      `shell-super-app\t${OTHER}\tf\tv\ncrm\t${DIGEST}\tf\tv\ntax\t${DIGEST}\tf\tv\n`,
    );
    const cache = path.join(root, 'cache');
    for (const [unit, digest] of Object.entries(cached)) {
      yield* fs.makeDirectory(path.join(cache, unit), { recursive: true });
      yield* fs.writeFileString(path.join(cache, unit, 'zerops-entry.mjs'), `export const unit = '${unit}';\n`);
      yield* fs.writeFileString(path.join(cache, unit, 'index.js.map'), '{}');
      yield* fs.writeFileString(path.join(cache, unit, '.zerops-build-digest'), `${digest}\n`);
    }
    const archive = path.join(root, UNITS_ARCHIVE);
    return { app, archive, cache, identities, root };
  });

const archiveEntries = (archive: string) =>
  Effect.gen(function* listArchive() {
    const listed = yield* collectToolingProcess(ChildProcess.make('tar', ['--list', '--zstd', '--file', archive]));
    expect(listed.status, listed.stderr).toBe(0);
    return listed.stdout
      .split('\n')
      .map((line) => line.replace(/\/$/u, ''))
      .filter((line) => line !== '')
      .toSorted();
  });

it.live('reuses a shard whose cached units all carry this commit identity, and packs them as a build does', () =>
  Effect.gen(function* reuseAll() {
    const fs = yield* FileSystem.FileSystem;
    const { app, archive, cache, identities } = yield* fixture(BOTH_CURRENT);
    const result = yield* runReuse(app, ['reuse', identities, '2', cache, archive]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('shard 2: reused 2 units by identity, nothing built: crm tax');
    expect(yield* fs.readFileString(path.join(app, 'verticals/crm/dist/.zerops-build-digest'))).toBe(`${DIGEST}\n`);
    const entries = yield* archiveEntries(archive);
    expect(entries).toContain('verticals/crm/dist/zerops-entry.mjs');
    expect(entries).toContain('verticals/tax/dist/.zerops-build-digest');
    // Source maps never ship; the shard's other units are not touched.
    expect(entries.some((entry) => entry.endsWith('.map'))).toBe(false);
    expect(entries.some((entry) => entry.startsWith('apps/'))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  'builds instead of reusing on any doubt: changed inputs, a missing build or entry, no identity, no unit list',
  () =>
    Effect.gen(function* doubts() {
      const fs = yield* FileSystem.FileSystem;
      const cases: readonly (readonly [
        string,
        Readonly<Record<string, string>>,
        (f: Fixture) => Effect.Effect<void, unknown, FileSystem.FileSystem>,
        string,
        string,
      ])[] = [
        [
          'changed inputs',
          { crm: DIGEST, tax: OTHER },
          () => Effect.void,
          '2',
          "tax's cached build is for other inputs",
        ],
        ['evicted cache', {}, () => Effect.void, '2', 'crm has no cached build'],
        [
          'build without entry',
          { crm: DIGEST, tax: DIGEST },
          (f) => fs.remove(path.join(f.cache, 'tax/zerops-entry.mjs')),
          '2',
          'tax has no cached build',
        ],
        [
          'no identity',
          { crm: DIGEST, tax: DIGEST },
          (f) => fs.writeFileString(path.join(f.identities, DIGESTS_FILE), `crm\t${DIGEST}\tf\tv\n`),
          '2',
          'tax has no identity for this commit',
        ],
        [
          'repeated identity',
          { crm: DIGEST, tax: DIGEST },
          (f) =>
            fs.writeFileString(
              path.join(f.identities, DIGESTS_FILE),
              `crm\t${DIGEST}\tf\tv\ncrm\t${DIGEST}\tf\tv\ntax\t${DIGEST}\tf\tv\n`,
            ),
          '2',
          'crm has no identity for this commit',
        ],
        ['no unit list', { crm: DIGEST, tax: DIGEST }, () => Effect.void, '5', 'shard 5: no unit list for this commit'],
      ];
      for (const [label, cached, change, shard, reason] of cases) {
        const f = yield* fixture(cached);
        yield* change(f);
        const result = yield* runReuse(f.app, ['reuse', f.identities, shard, f.cache, f.archive]);
        expect(result.status, label).toBe(NEEDS_BUILD);
        expect(result.stdout, label).toContain(reason);
        // Nothing was laid out or packed: the build path starts from a clean shard.
        expect(yield* fs.exists(f.archive), label).toBe(false);
        expect(yield* fs.exists(path.join(f.app, 'verticals/crm/dist')), label).toBe(false);
      }
      const usage = yield* runReuse((yield* fixture(BOTH_CURRENT)).app, ['reuse', 'only-one-argument']);
      expect(usage.status).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
type Fixture = Effect.Success<ReturnType<typeof fixture>>;

it.live("runs the workflow's reuse step: reused, must build, and a failing script fails the step", () =>
  Effect.gen(function* reuseStep() {
    const fs = yield* FileSystem.FileSystem;
    const script = yield* stepRun((yield* workflow).build, REUSE_STEP);
    for (const [label, cached, output] of [
      ['all unchanged', { crm: DIGEST, tax: DIGEST }, 'reused=true'],
      ['one changed', { crm: DIGEST, tax: OTHER }, 'reused=false'],
      ['cache miss', {}, 'reused=false'],
    ] as const) {
      const f = yield* fixture(cached);
      yield* fs.makeDirectory(path.join(f.root, IDENTITIES_TEMP), { recursive: true });
      for (const file of [SHARDS_FILE, DIGESTS_FILE]) {
        yield* fs.copyFile(path.join(f.identities, file), path.join(f.root, IDENTITIES_TEMP, file));
      }
      const outputs = path.join(f.root, 'outputs');
      yield* fs.writeFileString(outputs, '');
      const result = yield* runStep(f.app, script, {
        GITHUB_OUTPUT: outputs,
        RUNNER_TEMP: path.join(f.root, 'temp'),
        SHARD: '2',
        UNIT_CACHE_DIR: f.cache,
      });
      expect(result.status, `${label}: ${result.stderr}`).toBe(0);
      expect((yield* fs.readFileString(outputs)).trim(), label).toBe(output);
    }
    // A broken script (here: its tables cannot be read) is a failure, never a silent build or reuse.
    const f = yield* fixture(BOTH_CURRENT);
    yield* fs.writeFileString(path.join(f.app, REUSE), '#!/usr/bin/env bash\nexit 7\n');
    const outputs = path.join(f.root, 'outputs');
    yield* fs.writeFileString(outputs, '');
    const broken = yield* runStep(f.app, script, {
      GITHUB_OUTPUT: outputs,
      RUNNER_TEMP: path.join(f.root, 'temp'),
      SHARD: '2',
      UNIT_CACHE_DIR: f.cache,
    });
    expect(broken.status).toBe(7);
    expect(yield* fs.readFileString(outputs)).toBe('');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

/** PATH stubs: `mise exec -- …` runs the command, `node` answers build-shard-units.mts (one shard or `all`) with a fixed deal. */
const stubs = (root: string) =>
  Effect.gen(function* writeStubs() {
    const fs = yield* FileSystem.FileSystem;
    const bin = path.join(root, 'bin');
    yield* fs.makeDirectory(bin);
    yield* fs.writeFileString(
      path.join(bin, 'mise'),
      '#!/usr/bin/env bash\n[ "$1" = exec ] && shift\n[ "$1" = -- ] && shift\nexec "$@"\n',
    );
    yield* fs.writeFileString(
      path.join(bin, 'node'),
      [
        '#!/usr/bin/env bash',
        'deal() { case "$1" in 0) echo shell-super-app ;; 2) echo crm tax ;; *) echo "unit-$1" ;; esac; }',
        'if [ "$2" != all ]; then deal "$2"; exit 0; fi',
        String.raw`for shard in $(seq 0 $(($3 - 1))); do printf '%s\t%s\n' "$shard" "$(deal "$shard")"; done`,
        '',
      ].join('\n'),
    );
    yield* fs.chmod(path.join(bin, 'mise'), 0o700);
    yield* fs.chmod(path.join(bin, 'node'), 0o700);
    return bin;
  });

it.live("runs the workflow's identity step: the digest table from build-app.sh and one unit list per shard", () =>
  Effect.gen(function* identityStep() {
    const fs = yield* FileSystem.FileSystem;
    const script = yield* stepRun((yield* workflow).deliver, IDENTITY_STEP);
    const { app, root } = yield* fixture(BOTH_CURRENT);
    const bin = yield* stubs(root);
    const searchPath = `${bin}:${yield* Config.String('PATH')}`;
    yield* fs.writeFileString(
      path.join(app, BUILD_APP),
      `[ "$1" = --digests-only ] && printf 'crm\\t${DIGEST}\\tf\\tv\\n' >"$2"\n`,
    );
    const result = yield* runStep(app, script, { PATH: searchPath, RUNNER_TEMP: path.join(root, 'temp'), SHARDS: '7' });
    expect(result.status, result.stderr).toBe(0);
    const out = path.join(root, IDENTITIES_TEMP);
    expect(yield* fs.readFileString(path.join(out, DIGESTS_FILE))).toBe(`crm\t${DIGEST}\tf\tv\n`);
    const shards = (yield* fs.readFileString(path.join(out, SHARDS_FILE))).trim().split('\n');
    expect(shards).toHaveLength(7);
    expect(shards[0]).toBe('0\tshell-super-app');
    expect(shards[2]).toBe('2\tcrm tax');
    // A failing table write fails the job, so the shards build instead of reading a partial table.
    yield* fs.writeFileString(path.join(app, BUILD_APP), 'exit 4\n');
    const failed = yield* runStep(app, script, {
      PATH: searchPath,
      RUNNER_TEMP: path.join(root, 'temp2'),
      SHARDS: '7',
    });
    expect(failed.status).toBe(4);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("runs the workflow's build step: it builds, prunes foreign cached units and packs with the shared step", () =>
  Effect.gen(function* buildStep() {
    const fs = yield* FileSystem.FileSystem;
    const script = yield* stepRun((yield* workflow).build, BUILD_STEP);
    const { app, archive, cache, root } = yield* fixture({ crm: OTHER, retired: DIGEST });
    const bin = yield* stubs(root);
    const searchPath = `${bin}:${yield* Config.String('PATH')}`;
    yield* fs.writeFileString(
      path.join(app, BUILD_APP),
      'for unit in "$@"; do mkdir -p "verticals/$unit/dist"; echo built >"verticals/$unit/dist/zerops-entry.mjs"; done\n',
    );
    const result = yield* runStep(app, script, {
      PATH: searchPath,
      RUNNER_TEMP: root,
      SHARD: '2',
      SHARDS: '7',
      UNIT_CACHE_DIR: cache,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(yield* fs.exists(path.join(cache, 'retired'))).toBe(false);
    expect(yield* archiveEntries(archive)).toContain('verticals/tax/dist/zerops-entry.mjs');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('reuses only by identity, builds whenever any unit is unproven, and rebuild_units always builds', () =>
  Effect.gen(function* wiring() {
    const { build, deliver } = yield* workflow;
    expect(build.needs).toEqual(['deliver']);
    expect(build.if).toBe(BUILD_SHARD_CONDITION);
    const step = (name: string) => build.steps.find((candidate) => candidate.name === name);
    expect(step("Take this commit's unit identities")?.if).toBeUndefined();
    expect(step(REUSE_STEP)?.if).toBe(FORCE_OFF);
    for (const name of ['Install the app workspace', BUILD_STEP]) {
      expect(step(name)?.if, name).toBe(NOT_REUSED);
    }
    // Saved when named and not already in the cache under that name, reused or built (cache-budget.test.mts).
    expect(step("Save the shard's unit builds")?.if).toBe(
      "steps.unit-cache-key.outputs.key != '' && steps.unit-cache.outputs.cache-hit != 'true'",
    );
    expect(step("Upload the shard's unit builds")?.if).toBeUndefined();
    // The identities are computed in the build environment: the same declared variables, the same values.
    const identityStep = deliver.steps.find((candidate) => candidate.name === IDENTITY_STEP);
    for (const name of [
      'ONTOS_PUBLIC_ORIGIN',
      'ONTOS_SHOP_STOREFRONT_ORIGIN',
      'ONTOS_STOREFRONT_ORIGIN',
      'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT',
    ]) {
      expect(identityStep?.env?.[name], name).toBe(build.env?.[name]);
    }
    expect(deliver.env?.SHARDS).toBe(build.env?.SHARDS);
    expect(yield* stepRun(deliver, IDENTITY_STEP)).toContain('sh scripts/zerops/build-app.sh --digests-only');
    // The front path never runs for rebuild_units, and only its proof lets this job deliver without the matrix.
    expect(front(deliver, 'Find the newest earlier unit builds of this branch')?.if).toBe(
      "steps.plan.outputs.app == 'true' && inputs.rebuild_units != true",
    );
    const take = yield* stepRun(deliver, TAKE_STEP);
    expect(take).toContain('reuse-shard-units.sh take-units');
    expect(take).toContain('scripts/zerops/zerops-unit-build-seconds.mts');
    expect(front(deliver, TAKE_STEP)?.if).toBe("steps.plan.outputs.app == 'true' && inputs.rebuild_units != true");
    expect(front(deliver, DECIDE_STEP)?.env).toMatchObject({
      APP: `\${{ steps.plan.outputs.app }}`,
      TAKEN: `\${{ steps.taken.outcome }}`,
      ZEROPS_SECONDS: `\${{ steps.taken.outputs.seconds }}`,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live('runs the decision: the Zerops build builds the missing units only within its budget', () =>
  Effect.gen(function* decide() {
    const fs = yield* FileSystem.FileSystem;
    const { deliver } = yield* workflow;
    const script = yield* stepRun(deliver, DECIDE_STEP);
    const budget = String(front(deliver, DECIDE_STEP)?.env?.ZEROPS_BUILD_BUDGET_SECONDS);
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'decide-units-' });
    const decision = (env: Readonly<Record<string, string>>) =>
      Effect.gen(function* runDecision() {
        const output = path.join(root, `${String(Math.random())}.out`);
        const result = yield* runStep(root, script, {
          ...env,
          GITHUB_OUTPUT: output,
          ZEROPS_BUILD_BUDGET_SECONDS: budget,
        });
        expect(result.status, result.stderr).toBe(0);
        return (yield* fs.readFileString(output)).trim();
      });
    expect(yield* decision({ APP: 'false', TAKEN: 'skipped', ZEROPS_SECONDS: '' })).toBe(BUILD_FALSE);
    expect(yield* decision({ APP: 'true', TAKEN: 'success', ZEROPS_SECONDS: '0' })).toBe(BUILD_FALSE);
    expect(yield* decision({ APP: 'true', TAKEN: 'success', ZEROPS_SECONDS: budget })).toBe(BUILD_FALSE);
    expect(yield* decision({ APP: 'true', TAKEN: 'success', ZEROPS_SECONDS: String(Number(budget) + 1) })).toBe(
      'build=true',
    );
    expect(yield* decision({ APP: 'true', TAKEN: 'failure', ZEROPS_SECONDS: '' })).toBe('build=true');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const SHELL = 'shell-super-app';
const BRANCH = 'demo/sales-crm';
const TAKE_UNITS = 'take-units';
interface EarlierScenario {
  readonly missing: readonly string[];
  readonly name: string;
  readonly shards: readonly (readonly string[])[];
  readonly units: Readonly<Record<string, string>>;
}

/** An earlier run's unit artifacts: one archive per shard, as `pack` writes them, under <dir>/zerops-units-<n>/. */
const earlierArchives = (units: Readonly<Record<string, string>>, shards: readonly (readonly string[])[]) =>
  Effect.gen(function* makeEarlier() {
    const fs = yield* FileSystem.FileSystem;
    const { app, identities, root } = yield* fixture({});
    const archives = path.join(root, 'earlier');
    for (const [unit, digest] of Object.entries(units)) {
      const dist = path.join(app, unit === SHELL ? `apps/${SHELL}` : `verticals/${unit}`, 'dist');
      yield* fs.makeDirectory(dist, { recursive: true });
      yield* fs.writeFileString(path.join(dist, 'zerops-entry.mjs'), 'export {};\n');
      yield* fs.writeFileString(path.join(dist, '.zerops-build-digest'), `${digest}\n`);
    }
    for (const [shard, members] of shards.entries()) {
      const directory = path.join(archives, `zerops-units-${String(shard)}`);
      yield* fs.makeDirectory(directory, { recursive: true });
      const packed = yield* runReuse(app, ['pack', path.join(directory, UNITS_ARCHIVE), ...members]);
      expect(packed.status, packed.stderr).toBe(0);
    }
    return { app, archives, identities, root };
  });

const EARLIER_SCENARIOS: readonly EarlierScenario[] = [
  {
    missing: [],
    name: 'every unit, once, with this commit identity',
    shards: [[SHELL], ['crm', 'tax']],
    units: { crm: DIGEST, [SHELL]: OTHER, tax: DIGEST },
  },
  {
    missing: ['tax'],
    name: 'a unit built for other inputs',
    shards: [[SHELL], ['crm', 'tax']],
    units: { crm: DIGEST, [SHELL]: OTHER, tax: OTHER },
  },
  {
    missing: ['tax'],
    name: 'a unit missing from every archive',
    shards: [[SHELL], ['crm']],
    units: { crm: DIGEST, [SHELL]: OTHER },
  },
  {
    missing: ['crm'],
    name: 'a unit in two archives',
    shards: [
      [SHELL, 'crm'],
      ['crm', 'tax'],
    ],
    units: { crm: DIGEST, [SHELL]: OTHER, tax: DIGEST },
  },
];

/** Runs take-units over the earlier archives; returns the units laid out and the units written as missing. */
const takeUnits = (app: string, identities: string, archives: string) =>
  Effect.gen(function* runTakeUnits() {
    const fs = yield* FileSystem.FileSystem;
    const out = yield* fs.makeTempDirectoryScoped({ prefix: 'take-units-' });
    const dists = path.join(out, 'dists');
    const missingFile = path.join(out, 'missing.txt');
    const result = yield* runReuse(app, [TAKE_UNITS, identities, archives, dists, missingFile]);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const taken = [];
    for (const unit of [SHELL, 'crm', 'tax']) {
      const dir = unit === SHELL ? `apps/${SHELL}` : `verticals/${unit}`;
      if (yield* fs.exists(path.join(dists, dir, 'dist/zerops-entry.mjs'))) {
        taken.push(unit);
      }
    }
    const missing = (yield* fs.readFileString(missingFile)).split('\n').filter((line) => line.length > 0);
    return { missing, result, taken };
  });

for (const scenario of EARLIER_SCENARIOS) {
  it.live(`lends earlier unit builds unit by unit for ${scenario.name}`, () =>
    Effect.gen(function* takeEarlier() {
      const { app, archives, identities } = yield* earlierArchives(scenario.units, scenario.shards);
      const { missing, taken } = yield* takeUnits(app, identities, archives);
      expect(missing).toEqual(scenario.missing);
      expect(taken.toSorted()).toEqual(
        [SHELL, 'crm', 'tax'].filter((unit) => !scenario.missing.includes(unit)).toSorted(),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.live('lends units from the packed archive an earlier delivery pushed, which has no directory entries', () =>
  Effect.gen(function* takePushed() {
    const fs = yield* FileSystem.FileSystem;
    const { app, archives, identities, root } = yield* earlierArchives(
      { crm: DIGEST, [SHELL]: OTHER, tax: DIGEST },
      [],
    );
    const pushed = path.join(archives, 'zerops-units-0');
    yield* fs.makeDirectory(pushed, { recursive: true });
    const dists = path.join(root, 'laid-out');
    for (const dir of [`apps/${SHELL}/dist`, 'verticals/crm/dist']) {
      yield* fs.makeDirectory(path.dirname(path.join(dists, dir)), { recursive: true });
      yield* fs.copy(path.join(app, dir), path.join(dists, dir));
    }
    const packed = yield* collectToolingProcess(
      ChildProcess.make('sh', [
        path.join(APP, 'scripts/zerops/pack-prebuilt-units.sh'),
        dists,
        path.join(pushed, UNITS_ARCHIVE),
      ]),
    );
    expect(packed.status, packed.stderr).toBe(0);
    const { missing, taken } = yield* takeUnits(app, identities, archives);
    expect(missing).toEqual(['tax']);
    expect(taken.toSorted()).toEqual(['crm', SHELL]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live('lends nothing when there are no earlier archives or one is unreadable', () =>
  Effect.gen(function* noEarlier() {
    const fs = yield* FileSystem.FileSystem;
    const { app, identities, root } = yield* fixture({});
    const empty = path.join(root, 'none');
    expect((yield* takeUnits(app, identities, empty)).missing).toEqual([SHELL, 'crm', 'tax']);
    yield* fs.makeDirectory(path.join(empty, 'zerops-units-0'), { recursive: true });
    yield* fs.writeFileString(path.join(empty, 'zerops-units-0/units.tar.zst'), 'not an archive');
    const unreadable = yield* takeUnits(app, identities, empty);
    expect(unreadable.missing).toEqual([SHELL, 'crm', 'tax']);
    expect(unreadable.result.stdout).toContain('is unreadable');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

/** One entry of the Actions artifact listing. */
const artifact = (id: number, branch: string, created: string, expired = false) => ({
  created_at: created,
  expired,
  workflow_run: { head_branch: branch, id },
});

/**
 * A `gh` stub that answers this workflow's run listing from $GH_RUNS and the artifact listing from $GH_ANSWER, and
 * fails like an unreachable API when its answer is empty.
 */
const fakeGh = `#!/usr/bin/env bash
answer="\${GH_ANSWER:-}"
jq_filter=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --jq) jq_filter="$2"; shift 2 ;;
    */actions/workflows/zerops-stage.yml/runs*) answer="\${GH_RUNS:-}"; shift ;;
    *) shift ;;
  esac
done
[ -n "$answer" ] || exit 1
printf '%s' "$answer" | jq -r "$jq_filter"
`;

const REPOSITORY_ID = 1;
/** One entry of this workflow's run listing. */
const workflowRun = (id: number, event = 'push', headRepository = REPOSITORY_ID, branch = BRANCH) => ({
  event,
  head_branch: branch,
  head_repository: { id: headRepository },
  id,
  path: '.github/workflows/zerops-stage.yml',
  repository: { id: REPOSITORY_ID },
});

it.live(
  'names the newest other unexpired push or dispatch run of this workflow that holds unit builds, or nothing',
  () =>
    Effect.gen(function* earlierRun() {
      const fs = yield* FileSystem.FileSystem;
      const { app, root } = yield* fixture({});
      const bin = path.join(root, 'bin');
      yield* fs.makeDirectory(bin);
      yield* fs.writeFileString(path.join(bin, 'gh'), fakeGh);
      yield* fs.chmod(path.join(bin, 'gh'), 0o700);
      const searchPath = `${bin}:${yield* Config.String('PATH')}`;
      const runs = {
        workflow_runs: [
          workflowRun(30),
          workflowRun(28),
          workflowRun(27, 'workflow_dispatch'),
          workflowRun(26),
          // A pull request from a fork whose branch is named like the stage branch, running its own copy of the workflow.
          workflowRun(25, 'pull_request', 2),
          workflowRun(24, 'pull_request'),
        ],
      };
      // An empty answer makes the stub fail like an unreachable API.
      const run = (artifacts = '', listed = JSON.stringify(runs)) =>
        collectToolingProcess(
          ChildProcess.make('bash', [REUSE, 'earlier', BRANCH, '30'], {
            cwd: app,
            env: { GH_ANSWER: artifacts, GH_RUNS: listed, GITHUB_REPOSITORY: 'owner/repo', PATH: searchPath },
            extendEnv: true,
          }),
        );
      const listing = {
        artifacts: [
          artifact(30, BRANCH, '2026-11-16T03:00:00Z'),
          artifact(29, 'main', '2026-11-16T02:00:00Z'),
          artifact(28, BRANCH, '2026-11-16T01:00:00Z'),
          artifact(27, BRANCH, '2026-11-16T00:00:00Z'),
          artifact(26, BRANCH, '2026-11-16T04:00:00Z', true),
          artifact(25, BRANCH, '2026-11-16T05:00:00Z'),
          artifact(24, BRANCH, '2026-11-16T05:00:00Z'),
        ],
      };
      const found = yield* run(JSON.stringify(listing));
      expect(found.status, found.stderr).toBe(0);
      expect(found.stdout).toBe('run_id=28\n');
      const none = yield* run(JSON.stringify({ artifacts: [artifact(30, BRANCH, '2026-11-16T03:00:00Z')] }));
      expect(none.status).toBe(0);
      expect(none.stdout).toBe('');
      // Neither listing readable, or only the artifacts: no run is trusted, so none lends.
      for (const failed of [yield* run(), yield* run(JSON.stringify(listing), '')]) {
        expect(failed.status).toBe(0);
        expect(failed.stdout).toBe('');
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  'writes the identity table of a real build and builds nothing (build-app.sh --digests-only)',
  () =>
    Effect.gen(function* realDigests() {
      const fs = yield* FileSystem.FileSystem;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: 'unit-digests-' });
      const table = path.join(temp, DIGESTS_FILE);
      const result = yield* collectToolingProcess(
        ChildProcess.make('sh', [BUILD_APP, '--digests-only', table], {
          cwd: APP,
          env: {
            BUILD_LOG_DIR: path.join(temp, 'logs'),
            ONTOS_PUBLIC_ORIGIN: 'https://ontos-stage.web-revolution.cz',
            ONTOS_SHOP_STOREFRONT_ORIGIN: 'https://ontos-stage-shop.web-revolution.cz',
            ONTOS_STOREFRONT_ORIGIN: 'https://ontos-stage-akros.web-revolution.cz',
            UNIT_CACHE_DIR: path.join(temp, 'cache'),
          },
          extendEnv: true,
        }),
      );
      expect(result.status, result.stderr).toBe(0);
      const rows = (yield* fs.readFileString(table)).trim().split('\n');
      expect(rows.map((row) => row.split('\t')[0])).toContain('shell-super-app');
      expect(rows.every((row) => /^[a-z-]+\t[a-f0-9]{64}\t/u.test(row))).toBe(true);
      expect(result.stdout).toContain(`wrote the identities of ${String(rows.length)} units to ${table}`);
      expect(result.stdout).not.toMatch(/\bbuilt\b|kept /u);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  120_000,
);
