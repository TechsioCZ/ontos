import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Array as EffectArray, Effect, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

import { loadDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { DATABASE_IDENTITIES } from '../../database/identity-enrollment.ts';

const ROOT_PACKAGE_JSON_PATH = '../../package.json';

const TriggerSchema = Schema.Struct({ 'paths-ignore': Schema.optional(Schema.Array(Schema.String)) });
const WorkflowSchema = Schema.Struct({
  on: Schema.Struct({
    merge_group: Schema.optional(Schema.Struct({ types: Schema.Array(Schema.String) })),
    pull_request: TriggerSchema,
    push: TriggerSchema,
  }),
});

const readWorkflow = (name: string) =>
  Schema.decodeUnknownSync(WorkflowSchema)(
    parse(readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf-8')),
  );

const GATES_WORKFLOW = 'ultramodern-workspace-gates.yml';
const GATES_WORKFLOW_URL = new URL(`../../../.github/workflows/${GATES_WORKFLOW}`, import.meta.url);
/** The fixed system PATH a workflow step script runs with in these tests. */
const STEP_PATH = '/usr/bin:/bin';
/** The step after which a build shard's outputs are downloadable by the target's proving shards. */
const UPLOAD_STEP = "Upload the shard's build outputs";
/** The condition of the Node shard that runs the Node proof. */
const NODE_PROOF_CONDITION = "matrix.proof == 'node'";

const skipsGates = (changedPaths: readonly string[], ignored: readonly string[]) =>
  changedPaths.every((changedPath) => ignored.some((pattern) => path.matchesGlob(changedPath, pattern)));

const ROOT_DOCUMENTATION_TRIGGERS = [
  readWorkflow(GATES_WORKFLOW).on.push,
  readWorkflow('quality-audit.yml').on.push,
  readWorkflow('quality-audit.yml').on.pull_request,
];

it('deploys nothing and audits nothing for changes to repository-root documentation only', () => {
  for (const trigger of ROOT_DOCUMENTATION_TRIGGERS) {
    const ignored = trigger['paths-ignore'] ?? [];
    expect(skipsGates(['docs/contexts/tax/CONTEXT.md', 'CONTEXT-MAP.md', 'README.md', 'AGENTS.md'], ignored)).toBe(
      true,
    );
    for (const gatedPath of [
      'app/tools/oxlint/effect-native/rules/index.mts',
      'app/docs/architecture/DEPLOYMENT.md',
      'app/AGENTS.md',
      '.github/workflows/ultramodern-workspace-gates.yml',
      'lefthook.yml',
    ]) {
      expect(skipsGates(['docs/index.md', gatedPath], ignored)).toBe(false);
    }
  }
});

it('reports the required Workspace gates check on every pull request and merge group', () => {
  const workflow = readWorkflow(GATES_WORKFLOW);
  // A filtered pull request would never report the check the main ruleset requires, and could never merge.
  expect(workflow.on.pull_request['paths-ignore']).toBeUndefined();
  expect(workflow.on.merge_group).toEqual({ types: ['checks_requested'] });
});

/** A GitHub Actions `${{ … }}` expression, written without JavaScript template placeholders. */
const expression = (body: string) => `\${{ ${body} }}`;

const WorkflowStepSchema = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  id: Schema.optional(Schema.String),
  if: Schema.optional(Schema.String),
  name: Schema.String,
  run: Schema.optional(Schema.String),
  'timeout-minutes': Schema.optional(Schema.Number),
  'working-directory': Schema.optional(Schema.String),
});

const GatesWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    'queue-proof': Schema.Struct({
      if: Schema.String,
      outputs: Schema.Record(Schema.String, Schema.String),
      permissions: Schema.Record(Schema.String, Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
    }),
    'workspace-gates': Schema.Struct({
      if: Schema.String,
      name: Schema.String,
      needs: Schema.Array(Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
    }),
  }),
});

const readGatesWorkflow = () =>
  Schema.decodeUnknownSync(GatesWorkflowSchema)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')));

const QUEUE_PROOF_JOB = 'queue-proof';
const NODE_ARTIFACT_BUILD_JOB = 'node-artifact-build';
const CLOUDFLARE_ARTIFACT_BUILD_JOB = 'cloudflare-artifact-build';
const WORKSPACE_GATE_JOB = 'workspace-gate';
const FORMAT_AND_LINT_JOB = 'format-and-lint';
/** The gates that start once the merge queue proof is checked. */
const ROOT_GATE_JOBS = [
  WORKSPACE_GATE_JOB,
  'static-contracts',
  FORMAT_AND_LINT_JOB,
  'service-integration',
  NODE_ARTIFACT_BUILD_JOB,
  CLOUDFLARE_ARTIFACT_BUILD_JOB,
] as const;
/** Every gate job; each target's artifact proofs run inside its own build shards. */
const GATE_JOBS = ROOT_GATE_JOBS;
const GatedJobsSchema = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({ if: Schema.optional(Schema.String), needs: Schema.optional(Schema.Array(Schema.String)) }),
  ),
});

/** Whether a workflow step's script succeeds when Actions runs it with these variables. */
const stepPasses = (script: string, environment: Readonly<Record<string, string>>) => {
  try {
    execFileSync('/bin/bash', ['-eo', 'pipefail', '-c', script], {
      env: { PATH: STEP_PATH, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
};

it('skips the gates on main only for a commit the merge queue already proved', () => {
  const proof = readGatesWorkflow().jobs[QUEUE_PROOF_JOB];
  // Only a push or dispatch on main can carry a proven commit; pull requests and merge groups run every gate.
  expect(proof.if).toBe(
    "(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main'",
  );
  expect(proof.permissions).toEqual({ actions: 'read' });
  expect(proof.outputs.proven).toBe(expression('steps.proof.outputs.proven'));
  // The proof is this workflow's successful merge group run on this exact commit, read from GitHub.
  const lookup = proof.steps.find(({ id }) => id === 'proof')?.run ?? '';
  expect(lookup).toContain('runs?head_sha=$GITHUB_SHA&event=merge_group&status=success');
  expect(lookup).toContain('actions/runs/$GITHUB_RUN_ID');
  const { jobs } = Schema.decodeUnknownSync(GatedJobsSchema)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')));
  for (const gate of ROOT_GATE_JOBS) {
    expect(jobs[gate]?.needs).toEqual([QUEUE_PROOF_JOB]);
    expect(jobs[gate]?.if).toBe(expression("!cancelled() && needs.queue-proof.outputs.proven != 'true'"));
  }
});

it('requires every gate, or the merge queue proof, in the one Workspace gates check', () => {
  const gates = readGatesWorkflow().jobs['workspace-gates'];
  // The main ruleset requires this check by name.
  expect(gates.name).toBe('Workspace gates');
  expect(gates.if).toBe(expression('always()'));
  expect(gates.needs).toEqual([QUEUE_PROOF_JOB, ...GATE_JOBS]);
  const script = gates.steps.at(-1)?.run ?? 'exit 1';
  const needs = (proof: { proven?: string; result: string }, results: readonly string[]) =>
    JSON.stringify({
      [QUEUE_PROOF_JOB]: { outputs: proof.proven === undefined ? {} : { proven: proof.proven }, result: proof.result },
      ...Object.fromEntries(GATE_JOBS.map((gate, index) => [gate, { outputs: {}, result: results[index] }])),
    });
  const allPassed = GATE_JOBS.map(() => 'success');
  const allSkipped = GATE_JOBS.map(() => 'skipped');
  // A pull request or merge group: no proof job, every gate must pass.
  expect(stepPasses(script, { NEEDS_JSON: needs({ result: 'skipped' }, allPassed) })).toBe(true);
  expect(stepPasses(script, { NEEDS_JSON: needs({ result: 'skipped' }, ['failure', ...allPassed.slice(1)]) })).toBe(
    false,
  );
  expect(stepPasses(script, { NEEDS_JSON: needs({ result: 'skipped' }, ['cancelled', ...allPassed.slice(1)]) })).toBe(
    false,
  );
  expect(stepPasses(script, { NEEDS_JSON: needs({ result: 'skipped' }, allSkipped) })).toBe(false);
  // A proven commit on main: every gate skipped.
  expect(stepPasses(script, { NEEDS_JSON: needs({ proven: 'true', result: 'success' }, allSkipped) })).toBe(true);
  // An unproven commit on main runs the gates, and so does a failed lookup, which also fails the check.
  expect(stepPasses(script, { NEEDS_JSON: needs({ proven: 'false', result: 'success' }, allPassed) })).toBe(true);
  expect(stepPasses(script, { NEEDS_JSON: needs({ proven: 'false', result: 'success' }, allSkipped) })).toBe(false);
  expect(stepPasses(script, { NEEDS_JSON: needs({ result: 'failure' }, allPassed) })).toBe(false);
});

it('runs every job after the gates even when a merge-queue-proven run skipped them', () => {
  const { jobs } = Schema.decodeUnknownSync(GatedJobsSchema)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')));
  const ancestors = (job: string): ReadonlySet<string> =>
    new Set((jobs[job]?.needs ?? []).flatMap((parent) => [parent, ...ancestors(parent)]));
  // A skipped ancestor skips a job whose `if` relies on the implicit success(), so every job that the
  // skipped gates precede must decide with !cancelled() (or always()) and check its own needs' results.
  const afterGates = Object.keys(jobs).filter((job) => GATE_JOBS.some((gate) => ancestors(job).has(gate)));
  expect(afterGates).toContain('workspace-gates');
  for (const job of afterGates) {
    // The job name leads the subject, so a failure names the job.
    expect(`${job}: ${jobs[job]?.if ?? ''}`).toMatch(/^[a-z-]+: \$\{\{ (?:!cancelled\(\)|always\(\))/u);
  }
});

const ArtifactBuildJobSchema = Schema.Struct({
  name: Schema.String,
  permissions: Schema.Record(Schema.String, Schema.String),
  steps: Schema.Array(
    Schema.Struct({
      env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      if: Schema.optional(Schema.String),
      name: Schema.String,
      run: Schema.optional(Schema.String),
      uses: Schema.optional(Schema.String),
      with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
  strategy: Schema.Struct({
    matrix: Schema.Struct({
      include: Schema.Array(Schema.Struct({ proof: Schema.String, shard: Schema.Number, units: Schema.String })),
      shard: Schema.Array(Schema.Number),
    }),
  }),
});
const ArtifactBuildWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    [CLOUDFLARE_ARTIFACT_BUILD_JOB]: ArtifactBuildJobSchema,
    [NODE_ARTIFACT_BUILD_JOB]: ArtifactBuildJobSchema,
  }),
});
const TopologyUnitsSchema = Schema.Struct({
  shell: Schema.Struct({ id: Schema.String, path: Schema.String }),
  verticals: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String })),
});

const sorted = (values: readonly string[]) => EffectArray.sort(values, Order.String);

it('builds every delivery unit of the topology in exactly one build shard of each target', () => {
  const { jobs } = Schema.decodeUnknownSync(ArtifactBuildWorkflowSchema)(
    parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')),
  );
  const topology = Schema.decodeUnknownSync(TopologyUnitsSchema)(
    JSON.parse(readFileSync(new URL('../../topology/reference-topology.json', import.meta.url), 'utf-8')),
  );
  const units = [topology.shell, ...topology.verticals].map((unit) => unit.path);
  for (const [job, script] of [
    [NODE_ARTIFACT_BUILD_JOB, 'build'],
    [CLOUDFLARE_ARTIFACT_BUILD_JOB, 'cloudflare:build'],
  ] as const) {
    const { steps, strategy } = jobs[job];
    // Every shard builds units, and the target's shards build every unit once, with the target's script.
    expect(strategy.matrix.include.map(({ shard }) => shard)).toEqual(strategy.matrix.shard);
    const built = strategy.matrix.include.flatMap(({ units: shardUnits }) => shardUnits.split(/\s+/u).filter(Boolean));
    expect(sorted(built)).toEqual(sorted(units));
    expect(steps.some(({ run }) => run?.includes(`"\${filters[@]}" run ${script}\n`) === true)).toBe(true);
  }
});

it('supplies a placeholder public URL for every unit in Cloudflare builds and output proofs', () => {
  const { jobs } = Schema.decodeUnknownSync(ArtifactBuildWorkflowSchema)(
    parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')),
  );
  const topology = Schema.decodeUnknownSync(TopologyUnitsSchema)(
    JSON.parse(readFileSync(new URL('../../topology/reference-topology.json', import.meta.url), 'utf-8')),
  );
  for (const name of [
    "Build the shard's Cloudflare artifacts one unit at a time",
    'Generate federated types and verify the Worker outputs',
  ]) {
    const step = jobs[CLOUDFLARE_ARTIFACT_BUILD_JOB].steps.find((candidate) => candidate.name === name);
    expect(step, name).toBeDefined();
    for (const { id } of [topology.shell, ...topology.verticals]) {
      const variable = `ULTRAMODERN_PUBLIC_URL_${id.replaceAll('-', '_').toUpperCase()}`;
      expect(step?.env?.[variable], `${name}: ${variable}`).toBe(`https://${id}.invalid`);
    }
  }
});

const readArtifactBuildJobs = () =>
  Schema.decodeUnknownSync(ArtifactBuildWorkflowSchema)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8'))).jobs;

it('proves each target on its own shards only after every other shard of the target uploaded its outputs', () => {
  const jobs = readArtifactBuildJobs();
  for (const [job, proofs, artifacts, downloadCondition] of [
    [NODE_ARTIFACT_BUILD_JOB, ['node'], 'node-units-*', NODE_PROOF_CONDITION],
    [CLOUDFLARE_ARTIFACT_BUILD_JOB, ['outputs'], 'cloudflare-units-*', "matrix.proof != 'none'"],
  ] as const) {
    const { name, permissions, steps, strategy } = jobs[job];
    // Each proof runs on exactly one shard; the other shards only build.
    const hosted = strategy.matrix.include.map(({ proof }) => proof).filter((proof) => proof !== 'none');
    expect(sorted(hosted)).toEqual([...proofs]);
    expect(permissions).toEqual({ actions: 'read', contents: 'read' });
    // The proving shard waits for every other shard of this job, by the job's own name, before it
    // downloads them; every step after the shard's own upload runs only on a proving shard.
    const prefix = name.slice(0, name.indexOf('${{'));
    const upload = steps.findIndex((step) => step.name === UPLOAD_STEP);
    const wait = steps.findIndex(({ run }) => run?.startsWith('bash scripts/wait-for-build-shards.sh') === true);
    const download = steps.findIndex(({ uses }) => uses?.startsWith('actions/download-artifact@') === true);
    expect(steps[wait]?.run).toBe(
      `bash scripts/wait-for-build-shards.sh '${prefix}' ${strategy.matrix.shard.length} '${name}'`,
    );
    expect(upload).toBeGreaterThan(-1);
    expect(upload < wait && wait < download).toBe(true);
    for (const step of steps.slice(upload + 1)) {
      expect(`${step.name}: ${step.if ?? ''}`).toMatch(/matrix\.proof (?:!= 'none'|== '[a-z]+')$/u);
    }
    // Only the target's proving shards download, on the condition its workflow job states.
    expect(steps[download]?.if).toBe(downloadCondition);
    expect(steps[download]?.with?.pattern).toBe(artifacts);
  }
});

/** Runs the shard wait with a `gh` that answers the jobs API with these jobs, as `gh api --jq` would. */
const waitForBuildShards = (jobs: readonly { conclusion: string | null; name: string }[]) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-wait-shards-'));
  try {
    const gh = path.join(directory, 'gh');
    writeFileSync(gh, '#!/bin/sh\n[ "$1" = api ] && [ "$3" = --jq ] || exit 2\nprintf %s "$FAKE_JOBS" | jq -r "$4"\n');
    chmodSync(gh, 0o755);
    execFileSync(
      '/bin/bash',
      [fileURLToPath(new URL('../wait-for-build-shards.sh', import.meta.url)), 'Build x (', '3', 'Build x (1/3)'],
      {
        env: {
          FAKE_JOBS: JSON.stringify({ jobs }),
          GITHUB_REPOSITORY: 'owner/repository',
          GITHUB_RUN_ID: '1',
          PATH: `${directory}:${STEP_PATH}`,
          WAIT_FOR_BUILD_SHARDS_INTERVAL: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      },
    );
    return true;
  } catch {
    return false;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

it('waits for the other build shards of its own target and fails when one does not succeed', () => {
  const last = 'Build x (3/3)';
  const others = [
    { conclusion: 'success', name: 'Build x (2/3)' },
    { conclusion: 'success', name: last },
  ];
  const unrelated = [
    { conclusion: null, name: 'Build x (1/3)' },
    { conclusion: 'failure', name: 'Static Contracts' },
  ];
  expect(waitForBuildShards([...others, ...unrelated])).toBe(true);
  // Another proving shard of the target is still running its proof, but its outputs are uploaded.
  const proving = {
    conclusion: null,
    name: last,
    steps: [
      { conclusion: 'success', name: UPLOAD_STEP },
      { conclusion: null, name: 'Wait for the other build shards' },
    ],
  };
  expect(waitForBuildShards([others[0], proving, ...unrelated])).toBe(true);
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped']) {
    expect(waitForBuildShards([others[0], { conclusion, name: last }, ...unrelated])).toBe(false);
  }
});

const GateCommandsWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    [FORMAT_AND_LINT_JOB]: Schema.Struct({
      steps: Schema.Array(
        Schema.Struct({
          env: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number]))),
          name: Schema.optional(Schema.String),
          run: Schema.optional(Schema.String),
        }),
      ),
      strategy: Schema.Struct({ matrix: Schema.Struct({ shard: Schema.Array(Schema.Number) }) }),
    }),
    'static-contracts': Schema.Struct({
      steps: Schema.Array(
        Schema.Struct({
          parallel: Schema.optional(Schema.Array(Schema.Struct({ run: Schema.String }))),
          run: Schema.optional(Schema.String),
        }),
      ),
    }),
    [WORKSPACE_GATE_JOB]: Schema.Struct({
      strategy: Schema.Struct({
        matrix: Schema.Struct({
          include: Schema.Array(Schema.Struct({ commands: Schema.String, name: Schema.String })),
        }),
      }),
    }),
  }),
});
const RootScriptsSchema = Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) });
const WorkspacePackagesSchema = Schema.Struct({ packages: Schema.Array(Schema.String) });
const WORKSPACE_TEST_TASKS = ['test:unit', 'test:component'];

const unitTestPackages = () => {
  const { packages } = Schema.decodeUnknownSync(WorkspacePackagesSchema)(
    parse(readFileSync(new URL('../../pnpm-workspace.yaml', import.meta.url), 'utf-8')),
  );
  return packages.flatMap((pattern) => {
    expect(pattern).toMatch(/^[a-z-]+(?:\/\*)?$/u);
    const directories = pattern.endsWith('/*')
      ? readdirSync(new URL(`../../${pattern.slice(0, -2)}/`, import.meta.url), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${pattern.slice(0, -2)}/${entry.name}`)
      : [pattern];
    return directories.flatMap((directory) => {
      const url = new URL(`../../${directory}/package.json`, import.meta.url);
      if (!existsSync(url)) {
        return [];
      }
      const manifest = Schema.decodeUnknownSync(
        Schema.Struct({ name: Schema.String, scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
      )(JSON.parse(readFileSync(url, 'utf-8')));
      return [{ directory, name: manifest.name, scripts: manifest.scripts ?? {} }];
    });
  });
};

type UnitTestPackage = ReturnType<typeof unitTestPackages>[number];

const selectedTestPackages = (filters: readonly string[], packages: readonly UnitTestPackage[]) => {
  for (const filter of filters) {
    expect(
      filter === '!.' ||
        packages.some(({ directory, name }) => [name, `./${directory}`].includes(filter.replace(/^!/u, ''))),
    ).toBe(true);
  }
  const includes = filters.filter((filter) => !filter.startsWith('!'));
  return packages.filter(({ directory, name }) => {
    const matches = (filter: string) => filter === name || filter === `./${directory}`;
    return (
      (includes.length === 0 || includes.some(matches)) &&
      !filters.some((filter) => filter.startsWith('!') && matches(filter.slice(1)))
    );
  });
};

// Parse the supported pnpm forms without executing any workspace test command.
const rootUnitCoverage = (script: string, packages: readonly UnitTestPackage[]) => {
  const coverage: string[] = [];
  for (const command of script.split(/\s*&&\s*/u)) {
    const tokens = [...command.matchAll(/'[^']*'|"[^"]*"|[^\s'"]+/gu)].map(([token]) =>
      token.startsWith("'") || token.startsWith('"') ? token.slice(1, -1) : token,
    );
    expect(tokens.shift()).toBe('pnpm');
    const recursive = tokens[0] === '-r';
    if (recursive) {
      tokens.shift();
    }
    const filters: string[] = [];
    const options: string[] = [];
    while (tokens[0]?.startsWith('--')) {
      const option = tokens.shift() ?? '';
      if (option === '--filter') {
        filters.push(tokens.shift() ?? '');
      } else {
        options.push(option);
      }
    }
    const selected = selectedTestPackages(filters, packages);
    if (recursive) {
      expect(sorted(options)).toEqual(sorted(['--no-sort', '--workspace-concurrency=1', '--if-present']));
      expect(tokens.shift()).toBe('run');
      const task = tokens.shift() ?? '';
      expect(WORKSPACE_TEST_TASKS).toContain(task);
      expect(tokens).toEqual(['--pool.maxWorkers', '1']);
      for (const item of selected.filter((candidate) => candidate.scripts[task] !== undefined)) {
        // Forwarding Rstest flags through a shell chain would send them to its last command.
        expect(item.scripts[task]).toMatch(/^rstest(?:\s[^&]*)?$/u);
        coverage.push(`${item.name}:${task}`);
      }
    } else {
      expect(options).toEqual([]);
      expect(filters).toHaveLength(1);
      expect(selected).toHaveLength(1);
      const [item] = selected;
      expect(item).toBeDefined();
      if (item === undefined) {
        continue;
      }
      if (tokens[0] === 'exec') {
        expect(tokens).toEqual(['exec', 'rstest', '--project', 'unit', '--pool.maxWorkers', '1']);
        expect(item.scripts['test:unit']).toBe('rstest --project unit && pnpm test:types');
        coverage.push(`${item.name}:test:unit`);
      } else if (tokens[0] === 'test:types') {
        expect(tokens).toEqual(['test:types']);
        expect(item.scripts['test:types']).toBeDefined();
        coverage.push(`${item.name}:test:types`);
      } else {
        const task = tokens.shift() ?? '';
        expect(WORKSPACE_TEST_TASKS).toContain(task);
        expect(item.scripts[task]).toMatch(/^vitest run /u);
        expect(tokens).toEqual(['--maxWorkers', '1']);
        coverage.push(`${item.name}:${task}`);
      }
    }
  }
  const expected = packages.flatMap(({ name, scripts }) =>
    WORKSPACE_TEST_TASKS.filter((task) => scripts[task] !== undefined).map((task) => `${name}:${task}`),
  );
  const types = packages
    .filter(({ scripts }) => scripts['test:unit']?.endsWith(' && pnpm test:types'))
    .map(({ name }) => `${name}:test:types`);
  expect(sorted(coverage)).toEqual(sorted([...expected, ...types]));
  return coverage;
};

const readGateCommandJobs = () =>
  Schema.decodeUnknownSync(GateCommandsWorkflowSchema)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8'))).jobs;
const gateCommands = () =>
  readGateCommandJobs()[WORKSPACE_GATE_JOB].strategy.matrix.include.map(({ commands }) =>
    commands.split('\n').filter(Boolean),
  );

it('runs every workspace gate check in some workspace-gate entry', () => {
  const commands = gateCommands().flat();
  for (const check of [
    'pnpm typecheck',
    'pnpm typecheck:lint-rules',
    'pnpm test:lint-rules',
    'pnpm api:check:ontos',
    'pnpm shell:ui-candidates:check',
    'pnpm test:scripts',
    'pnpm module-entrypoints:check',
    'pnpm test:generation',
  ]) {
    expect(commands).toContain(check);
  }
  const staticChecks = readGateCommandJobs()['static-contracts'].steps.flatMap(({ parallel, run }) =>
    parallel ? parallel.map((step) => step.run) : [run ?? ''],
  );
  expect(staticChecks).toContain('mise exec -- pnpm database-access:check');
});

it('runs the root unit and component tests of every workspace package in exactly one shard', () => {
  const { scripts } = Schema.decodeUnknownSync(RootScriptsSchema)(
    JSON.parse(readFileSync(new URL(ROOT_PACKAGE_JSON_PATH, import.meta.url), 'utf-8')),
  );
  const packages = unitTestPackages();
  const expected = packages.flatMap(({ name, scripts: packageScripts }) =>
    WORKSPACE_TEST_TASKS.filter((task) => packageScripts[task] !== undefined).map((task) => `${name}:${task}`),
  );
  const rootCoverage = rootUnitCoverage(scripts['test:unit'] ?? '', packages);
  expect(sorted(rootCoverage.filter((task) => !task.endsWith(':test:types')))).toEqual(sorted(expected));
  const shards = gateCommands().flatMap((commands) => {
    const [unit, component, ...rest] = commands;
    if (unit === undefined || !unit.endsWith(' run test:unit')) {
      return [];
    }
    const filters = unit.replace(/^pnpm -r --no-sort --if-present /u, '').replace(/ run test:unit$/u, '');
    // Each shard runs test:component over the same packages, after test:unit, and nothing else.
    expect(component).toBe(`pnpm -r --no-sort --if-present ${filters} run test:component`);
    expect(rest).toEqual([]);
    return [
      [...filters.matchAll(/--filter (?<filter>\S+)/gu)].map(({ groups }) => groups?.filter?.replaceAll("'", '') ?? ''),
    ];
  });
  const named = shards.filter((filters) => filters.every((filter) => !filter.startsWith('!')));
  const remainder = shards.filter((filters) => filters.some((filter) => filter.startsWith('!')));
  expect(named.length + remainder.length).toBe(shards.length);
  // One shard runs every package the others do not name, excluding the workspace root like `pnpm -r`.
  expect(remainder).toHaveLength(1);
  const namedPackages = named.flat();
  expect(sorted(remainder[0] ?? [])).toEqual(sorted(['!.', ...namedPackages.map((filter) => `!${filter}`)]));
  expect(new Set(namedPackages).size).toBe(namedPackages.length);
  for (const filter of namedPackages) {
    expect(filter).toMatch(/^\.\/(?:apps|packages|verticals)\/[a-z-]+$/u);
    expect(() => readFileSync(new URL(`../../${filter}/package.json`, import.meta.url))).not.toThrow();
  }
  const shardCoverage = shards.flatMap((filters) =>
    selectedTestPackages(filters, packages).flatMap(({ name, scripts: packageScripts }) =>
      WORKSPACE_TEST_TASKS.filter((task) => packageScripts[task] !== undefined).map((task) => `${name}:${task}`),
    ),
  );
  expect(sorted(shardCoverage)).toEqual(sorted(expected));
});

it('rejects runner flags that the selected package runner cannot consume', () => {
  const packages = unitTestPackages();
  expect(() => rootUnitCoverage('pnpm --filter akros-storefront test:unit --pool.maxWorkers 1', packages)).toThrow();
  expect(() =>
    rootUnitCoverage('pnpm --filter @app/shared-contracts test:unit --pool.maxWorkers 1', packages),
  ).toThrow();
  const recursive =
    "pnpm -r --no-sort --workspace-concurrency=2 --filter '!@app/shared-contracts' --filter '!akros-storefront'";
  expect(() => rootUnitCoverage(`${recursive} --if-present run test:unit --pool.maxWorkers 1`, packages)).toThrow();
});

it('rejects an omitted or repeated workspace test command', () => {
  const { scripts } = Schema.decodeUnknownSync(RootScriptsSchema)(
    JSON.parse(readFileSync(new URL(ROOT_PACKAGE_JSON_PATH, import.meta.url), 'utf-8')),
  );
  const packages = unitTestPackages();
  const commands = (scripts['test:unit'] ?? '').split(' && ');
  expect(() => rootUnitCoverage(commands.slice(0, -1).join(' && '), packages)).toThrow();
  expect(() => rootUnitCoverage([...commands, commands.at(-1) ?? ''].join(' && '), packages)).toThrow();
});

it('formats and lints every tracked file in exactly one pre-commit hook shard', () => {
  const lint = readGateCommandJobs()[FORMAT_AND_LINT_JOB];
  const step = lint.steps.find(({ run }) => run?.includes('--files-from-stdin') === true);
  const shards = Number(step?.env?.SHARDS);
  expect(lint.strategy.matrix.shard).toEqual(Array.from({ length: shards }, (_, index) => index + 1));
  const run = step?.run ?? 'exit 1';
  // The hook sees its shard's files, and a file it fixes fails the gate.
  expect(run).toContain('lefthook run pre-commit --files-from-stdin --no-auto-install');
  expect(run.trimEnd().endsWith('git diff --exit-code HEAD')).toBe(true);
  const select = run.slice(0, run.indexOf('mise exec'));
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-lint-shards-'));
  try {
    const selected = Array.from({ length: shards }, (_, index) => {
      execFileSync('/bin/bash', ['-eo', 'pipefail', '-c', select], {
        cwd: repository,
        env: { PATH: STEP_PATH, RUNNER_TEMP: directory, SHARD: String(index + 1), SHARDS: String(shards) },
      });
      return readFileSync(path.join(directory, 'shard-files'), 'utf-8').split('\0').filter(Boolean);
    });
    const tracked = execFileSync('/usr/bin/git', ['ls-files', '-z'], {
      cwd: repository,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean);
    expect(sorted(selected.flat())).toEqual(sorted(tracked));
    for (const files of selected) {
      expect(files.length).toBeGreaterThan(0);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

const RUNTIME_IDENTITY_URLS = Object.fromEntries(
  DATABASE_IDENTITIES.filter(({ urlKey }) => urlKey !== 'DATABASE_URL').map(({ role, urlKey }) => [urlKey, role]),
);
const AUDIT_STEP = 'Audit runtime database identities against the checked-in grant manifest';
const IdentityGateJobSchema = Schema.Struct({
  // Unquoted placeholder IDs parse as numbers.
  env: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number]))),
  steps: Schema.Array(WorkflowStepSchema),
});
const IdentityGateJobsSchema = Schema.Struct({
  jobs: Schema.Struct({
    'node-artifact-build': Schema.Struct({
      ...IdentityGateJobSchema.fields,
      services: Schema.Record(
        Schema.String,
        Schema.Struct({
          env: Schema.Record(Schema.String, Schema.String),
          image: Schema.String,
          options: Schema.String,
          ports: Schema.Array(Schema.String),
        }),
      ),
    }),
    'service-integration': IdentityGateJobSchema,
  }),
});

const INITIALIZE_CI_IDENTITIES = 'Initialize the fresh CI database identities from the grant manifest';
const INTEGRATION_SUITE_CONDITION = "matrix.suite == 'integration'";

it('initializes every fresh CI database before reconcile bootstrap without changing deployment role policy', () => {
  const { jobs } = Schema.decodeUnknownSync(IdentityGateJobsSchema)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')));
  for (const { condition, consumers, job, start } of [
    {
      condition: null,
      consumers: [
        'Remove the pre-seeded runtime role to prove deployment bootstrap ordering',
        'Run the assembled stage migrator artifact against the fresh database',
        'Apply and verify Core, Auth, and Contacts migrations, plus Party Registry',
      ],
      job: jobs['service-integration'],
      start: 'Start fresh PostgreSQL and SpiceDB services',
    },
    {
      condition: NODE_PROOF_CONDITION,
      consumers: ['Migrate the Node proof database and provision its runtime identities'],
      job: jobs['node-artifact-build'],
      start: 'Install the app workspace',
    },
  ]) {
    const { steps } = job;
    const initializers = steps.filter(({ name }) => name === INITIALIZE_CI_IDENTITIES);
    expect(initializers).toHaveLength(1);
    const [initialize] = initializers;
    expect(initialize?.run).toBe('mise exec -- pnpm db:bootstrap-runtime-role');
    expect(initialize?.['working-directory']).toBe('app');
    // Only this step may initialize passwords, only against its loopback development fixture.
    expect(initialize?.env).toEqual({
      DATABASE_LOGIN_ROLE_POLICY: 'initialize-local',
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development',
    });
    expect(initialize?.if ?? null).toBe(condition);
    const initialized = steps.findIndex(({ name }) => name === INITIALIZE_CI_IDENTITIES);
    const started = steps.findIndex(({ name }) => name === start);
    expect(started).toBeGreaterThanOrEqual(0);
    expect(initialized).toBeGreaterThan(started);
    for (const consumer of consumers) {
      expect(steps.findIndex(({ name }) => name === consumer)).toBeGreaterThan(initialized);
    }
    expect(job.env?.DATABASE_LOGIN_ROLE_POLICY).toBeUndefined();
    for (const step of steps.filter(({ name }) => name !== INITIALIZE_CI_IDENTITIES)) {
      expect(step.env?.DATABASE_LOGIN_ROLE_POLICY).toBeUndefined();
      expect(step.run ?? '').not.toContain('initialize-local');
    }
  }
  // Service integration and browser share the unconditional initializer. The artifact still proves stage.
  const integration = jobs['service-integration'].steps;
  expect(integration.find(({ name }) => name.startsWith('Apply and verify Core'))?.if).toBeUndefined();
  const migrator = integration.find(({ name }) => name.startsWith('Run the assembled stage migrator'));
  expect(migrator?.if).toBe(INTEGRATION_SUITE_CONDITION);
  expect(migrator?.env?.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT).toBe('stage');
});

it('runs migration equivalence proofs only against the owned CI maintenance database', () => {
  const { jobs } = Schema.decodeUnknownSync(IdentityGateJobsSchema)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')));
  const integration = jobs['service-integration'].steps.find(({ run }) => run === 'mise exec -- pnpm test:integration');
  expect(integration?.if).toBe(INTEGRATION_SUITE_CONDITION);
  expect(integration?.env).toEqual({
    MIGRATION_EQUIVALENCE_TEST_DATABASE_URL: 'postgresql://ontos_ci_admin:ontos_ci_admin@localhost:5433/postgres',
    MIGRATION_EQUIVALENCE_TEST_SANDBOX: 'owned-postgres18',
  });
});

it('gives every CI database tool a separate login per runtime identity and audits their grants', () => {
  const { jobs } = Schema.decodeUnknownSync(IdentityGateJobsSchema)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')));
  const integration = jobs['service-integration'];
  for (const [key, role] of Object.entries(RUNTIME_IDENTITY_URLS)) {
    expect(integration.env?.[key]).toBe(`postgresql://${role}:${role}@localhost:5433/ontos_ci`);
  }
  const { steps } = integration;
  const migrations = steps.findIndex(({ name }) => name.startsWith('Apply and verify Core, Auth, and Contacts'));
  const audit = steps.findIndex(({ name }) => name === AUDIT_STEP);
  expect(migrations).toBeGreaterThanOrEqual(0);
  expect(audit).toBe(migrations + 1);
  expect(steps[audit]?.if).toBe(INTEGRATION_SUITE_CONDITION);
  expect(steps[audit]?.run).toBe('mise exec -- pnpm database-trust:audit');
});

it.effect('proves Node artifacts against a migrated PostgreSQL database with every declared login identity', () =>
  Effect.gen(function* proveNodeDatabaseIdentities() {
    const { jobs } = Schema.decodeUnknownSync(IdentityGateJobsSchema)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')));
    const node = jobs['node-artifact-build'];
    const environment = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(node.env);
    const service = node.services['proof-postgres'];
    expect(service?.image).toBe(expression("matrix.proof == 'node' && 'postgres:18.6-alpine' || ''"));
    expect(service?.ports).toContain('5433:5432');
    const admin = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(environment.DATABASE_ADMIN_URL);
    expect(admin.username).toBe(service?.env.POSTGRES_USER);
    expect(admin.password).toBe(service?.env.POSTGRES_PASSWORD);
    expect(admin.pathname).toBe(`/${service?.env.POSTGRES_DB ?? ''}`);
    expect(service?.options).toContain(`pg_isready -U ${admin.username} -d ${service?.env.POSTGRES_DB ?? ''}`);
    const provision = node.steps.findIndex(
      ({ name }) => name === 'Migrate the Node proof database and provision its runtime identities',
    );
    const proof = node.steps.findIndex(({ run }) => run === 'mise exec -- pnpm node:proof');
    expect(provision).toBeGreaterThanOrEqual(0);
    expect(provision).toBeLessThan(proof);
    expect(node.steps[provision]?.if).toBe(NODE_PROOF_CONDITION);
    expect(node.steps[provision]?.run).toBe('mise exec -- pnpm db:migrate');
    expect(node.steps[proof]?.env).toBeUndefined();
    for (const identity of DATABASE_IDENTITIES) {
      const connection = yield* loadDatabaseConfig({ environment, envPath: '/dev/null', identity });
      expect(connection.expectedRole).toBe(identity.role);
      const runtime = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(connection.connectionString);
      expect(runtime.username).toBe(identity.role);
      expect(runtime.pathname).toBe(`/${service?.env.POSTGRES_DB ?? ''}`);
      expect(runtime.hostname).toBe(admin.hostname);
      expect(Number(runtime.port)).toBe(Number(admin.port));
    }
  }),
);
