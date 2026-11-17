import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';

import { DeliveryPlanSchema, MUTATION_MARKER } from '../zerops/delivery-plan.mts';
import type { Comparison, RunMutation } from '../zerops/delivery-plan.mts';
import { collectToolingProcess } from './tooling-process-fixture.mts';

const app = path.resolve(import.meta.dirname, '../..');
const HISTORY = 'scripts/zerops/read-delivery-history.sh';
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const WORKFLOW = '.github/workflows/zerops-stage.yml';
const run = (id: number, number: number, conclusion: string | null, status = 'completed') => ({
  conclusion,
  head_branch: 'demo/sales-crm',
  head_sha: id === 10 ? BASE : 'c'.repeat(40),
  id,
  path: WORKFLOW,
  run_attempt: 1,
  run_number: number,
  status,
});
const jobs = (markerConclusion: string | null) => ({
  jobs: [
    {
      steps: [
        { conclusion: 'success', name: 'Checkout', status: 'completed' },
        ...(markerConclusion === null
          ? []
          : [{ conclusion: markerConclusion, name: MUTATION_MARKER, status: 'completed' }]),
      ],
    },
  ],
});

/**
 * A `gh api <path> [--jq <filter>]` that answers from fixture files named by the path; an unknown path fails like an
 * API error. The zip endpoint answers with the fixture zip's bytes.
 */
const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = api ] || exit 9
route="$2"
shift 2
filter='.'
if [ "\${1:-}" = --jq ]; then filter="$2"; fi
name="$(printf '%s' "$route" | tr -c 'A-Za-z0-9' '_')"
if [ -f "$FIXTURES/$name.zip" ]; then cat "$FIXTURES/$name.zip"; exit 0; fi
[ -f "$FIXTURES/$name.json" ] || { echo "no fixture for $route" >&2; exit 1; }
jq -c "$filter" "$FIXTURES/$name.json"
`;
const fixtureName = (route: string) => route.replaceAll(/[^A-Za-z0-9]/gu, '_');

/** The API answers, as JSON text by route, and the services of each plan artifact, by its zip route. */
const readHistory = (
  fixtures: Readonly<Record<string, string>>,
  zips: Readonly<Record<string, readonly string[]>> = {},
) =>
  Effect.gen(function* runHistoryReader() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const bin = path.join(directory, 'bin');
    const data = path.join(directory, 'fixtures');
    yield* fs.makeDirectory(bin);
    yield* fs.makeDirectory(data);
    yield* fs.writeFileString(path.join(bin, 'gh'), fakeGh);
    yield* fs.chmod(path.join(bin, 'gh'), 0o700);
    for (const [route, body] of Object.entries(fixtures)) {
      yield* fs.writeFileString(path.join(data, `${fixtureName(route)}.json`), body);
    }
    for (const [route, services] of Object.entries(zips)) {
      const staging = path.join(directory, `zip-${fixtureName(route)}`);
      yield* fs.makeDirectory(staging);
      yield* fs.writeFileString(path.join(staging, 'plan.json'), JSON.stringify({ schemaVersion: 2, services }));
      const zipped = yield* collectToolingProcess(
        ChildProcess.make('zip', ['-q', path.join(data, `${fixtureName(route)}.zip`), 'plan.json'], { cwd: staging }),
      );
      expect(zipped.status, zipped.stderr).toBe(0);
    }
    const result = yield* collectToolingProcess(
      ChildProcess.make('bash', [HISTORY], {
        cwd: app,
        env: {
          FIXTURES: data,
          GITHUB_REPOSITORY: 'owner/repo',
          GITHUB_RUN_NUMBER: '20',
          GITHUB_SHA: HEAD,
          PATH: `${bin}:${yield* Config.String('PATH')}`,
          RUNNER_TEMP: directory,
        },
      }),
    );
    expect(result.status, result.stderr).toBe(0);
    return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(result.stdout);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const RUNS = 'repos/owner/repo/actions/workflows/zerops-stage.yml/runs?branch=demo%2Fsales-crm&per_page=50';
const COMPARE = `repos/owner/repo/compare/${BASE}...${HEAD}?per_page=1`;
const jobsOf = (id: number) => `repos/owner/repo/actions/runs/${String(id)}/jobs?filter=all&per_page=100`;
const artifactsOf = (id: number) => `repos/owner/repo/actions/runs/${String(id)}/artifacts?name=zerops-delivery-plan`;

it.effect('reads the newest green run as the base, every later run that changed stage, and the comparison', () =>
  Effect.gen(function* historyRead() {
    const history = yield* readHistory(
      {
        [artifactsOf(13)]: JSON.stringify({ artifacts: [{ id: 77 }] }),
        [COMPARE]: JSON.stringify({
          files: [{ filename: 'app/n1-storefront/src/a.ts' }, { filename: 'b.ts', previous_filename: 'a.ts' }],
          status: 'ahead',
        }),
        [jobsOf(12)]: JSON.stringify(jobs(null)),
        [jobsOf(13)]: JSON.stringify(jobs('success')),
        [RUNS]: JSON.stringify({
          workflow_runs: [
            run(13, 13, 'failure'),
            run(12, 12, 'cancelled'),
            run(10, 10, 'success'),
            run(9, 9, 'failure'),
            { ...run(14, 14, 'success'), head_branch: 'other' },
          ],
        }),
      },
      { 'repos/owner/repo/actions/artifacts/77/zip': ['storefront', 'shop'] },
    );
    expect(history).toMatchObject({
      comparison: {
        ancestor: true,
        base: BASE,
        changedPaths: ['a.ts', 'app/n1-storefront/src/a.ts', 'b.ts'],
        truncated: false,
      },
      mutations: [
        { mutated: true, runId: 13, services: ['storefront', 'shop'] },
        { mutated: false, runId: 12, services: null },
      ],
    });
  }),
);

it.effect('leaves every part it cannot read empty, so the plan deploys every service', () =>
  Effect.gen(function* unreadableHistory() {
    expect(yield* readHistory({})).toEqual({ comparison: null, mutations: [], runs: null });
    const partial = yield* readHistory({
      [COMPARE]: JSON.stringify({
        files: Array.from({ length: 300 }, (_, index) => ({ filename: `f${String(index)}` })),
        status: 'ahead',
      }),
      [jobsOf(13)]: JSON.stringify(jobs('success')),
      [RUNS]: JSON.stringify({ workflow_runs: [run(13, 13, 'failure'), run(10, 10, 'success')] }),
    });
    expect(partial).toMatchObject({
      comparison: { truncated: true },
      mutations: [{ mutated: true, runId: 13, services: null }],
    });
    const diverged = yield* readHistory({
      [COMPARE]: JSON.stringify({ files: [], status: 'diverged' }),
      [RUNS]: JSON.stringify({ workflow_runs: [run(10, 10, 'success')] }),
    });
    expect(diverged).toMatchObject({ comparison: { ancestor: false } });
  }),
);

/** Runs the real planner on this checkout's HEAD with a history whose base is HEAD's parent-free stand-in. */
interface HistoryFixture {
  readonly comparison: Comparison | null;
  readonly mutations: readonly RunMutation[];
  readonly runs: readonly ReturnType<typeof run>[];
}
const planWith = (history: HistoryFixture) =>
  Effect.gen(function* realPlanner() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(directory, 'history.json'), JSON.stringify(history));
    const head = (yield* collectToolingProcess(
      ChildProcess.make('git', ['rev-parse', 'HEAD'], { cwd: app }),
    )).stdout.trim();
    const result = yield* collectToolingProcess(
      ChildProcess.make('node', ['scripts/zerops/delivery-plan-cli.mts', 'plan', directory], {
        cwd: app,
        env: {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_OUTPUT: path.join(directory, 'outputs'),
          GITHUB_RUN_ATTEMPT: '1',
          GITHUB_RUN_NUMBER: '20',
          GITHUB_SHA: head,
        },
        extendEnv: true,
      }),
    );
    expect(result.status, result.stderr).toBe(0);
    const plan = yield* Schema.decodeEffect(Schema.fromJsonString(DeliveryPlanSchema))(
      yield* fs.readFileString(path.join(directory, 'plan.json')),
    );
    return { outputs: yield* fs.readFileString(path.join(directory, 'outputs')), plan };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
const greenBase = { mutations: [], runs: [run(10, 10, 'success')] };
const changing = (changedPaths: readonly string[]) => ({
  ...greenBase,
  comparison: { ancestor: true, base: BASE, changedPaths, truncated: false },
});

it.live('executes the real planner: an unreadable comparison deploys every service', () =>
  Effect.gen(function* unreadableComparison() {
    const { outputs, plan } = yield* planWith({ ...greenBase, comparison: null });
    expect(plan.base).toBe(BASE);
    expect(plan.full).toBe(true);
    for (const service of ['app', 'storefront', 'shop', 'n1', 'full']) {
      expect(outputs).toContain(`${service}=true\n`);
    }
  }),
);

it.live("executes the real planner over this commit's reference graph: CI-only changes deploy nothing", () =>
  Effect.gen(function* ciOnly() {
    // A test beside the delivery scripts is no delivery script: no service reads it.
    const { outputs, plan } = yield* planWith(
      changing([
        '.github/workflows/ultramodern-workspace-gates.yml',
        'app/scripts/tests/ci-workflows.test.mts',
        'app/scripts/zerops/app-boot-stages.test.mts',
      ]),
    );
    expect(plan.full).toBe(false);
    expect(plan.services).toEqual([]);
    expect(outputs).toContain('any=false\n');
  }),
);

it.live("executes the real planner over this commit's reference graph: what stage runs deploys every service", () =>
  Effect.gen(function* deliveredInputs() {
    for (const changed of [
      WORKFLOW,
      'app/scripts/zerops/app-host.mts',
      'app/scripts/run-zerops-migrator.mjs',
      'app/scripts/ops/stage-warmup.mts',
      'app/scripts/zerops/push-service.sh',
    ]) {
      const { plan } = yield* planWith(changing([changed]));
      expect(plan.full, changed).toBe(true);
    }
  }),
);
