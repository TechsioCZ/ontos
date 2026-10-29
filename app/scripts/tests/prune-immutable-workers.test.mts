import { readFileSync } from 'node:fs';

import { ConfigProvider, Duration, Effect, Layer, Option, Schedule, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { parse } from 'yaml';

import { DIGEST_VERSION } from '../ci/deploy-plan.mts';
import {
  IMMUTABLE_WORKER_NAME,
  PRUNE_GRACE,
  activeCompositionWorkers,
  deleteReleases,
  ledgerWorkers,
  mentionedImmutableWorkers,
  MAIN_CANDIDATE_ARTIFACT,
  MAIN_CANDIDATE_FILE,
  MAIN_CANDIDATE_RETENTION,
  MAIN_STAGE_PRODUCER,
  UNFINISHED_RUN_STATUSES,
  oldestReleasesFreeing,
  planImmutableWorkerPrune,
  plannedNewWorkers,
  plannedRetainedWorkers,
  retainedMainCandidateWorkers,
  stageCoordination,
  unfinishedForeignStageWriters,
} from '../ci/prune-immutable-workers.mts';
import type { AccountWorker, KeepSources } from '../ci/prune-immutable-workers.mts';
import { RECEIPTS_PER_UNIT, createGitHubClient, emptyLedger, recordUnitReceipt } from '../ci/release-ledger.mts';
import type { GitHubClient, ReleaseLedger } from '../ci/release-ledger.mts';
import { ImmutableProviderWriteRetrySchedule } from '../immutable-application-release.mts';

const ACCOUNT_ID = 'e'.repeat(32);
const NOW = Date.parse('2026-10-29T12:00:00Z');
const DAY = 86_400_000;
const hex = (seed: string) => seed.repeat(56).slice(0, 56);
const backend = (seed: string) => `ontos-${hex(seed)}`;
const assets = (seed: string) => `assets-${hex(seed)}`;

/** A Worker created `ageDays` before {@link NOW} and never modified since. */
const worker = (name: string, ageDays = 10): AccountWorker => ({
  createdOn: NOW - ageDays * DAY,
  modifiedOn: NOW - ageDays * DAY,
  name,
});
const SHELL_INGRESS = 'app-shell-super-app';
const pair = (seed: string, ageDays = 10) => [worker(backend(seed), ageDays), worker(assets(seed), ageDays)];

const keepNothing: KeepSources = { active: new Set(), binding: new Set(), candidate: new Set(), ledger: new Set() };

const plan = (workers: readonly AccountWorker[], keep: Partial<KeepSources> = {}) =>
  planImmutableWorkerPrune({ grace: PRUNE_GRACE, keep: { ...keepNothing, ...keep }, now: NOW, workers });

it('keeps every release the active and candidate compositions, the ledger or a service binding name', () => {
  const pruned = plan([...pair('1'), ...pair('2'), ...pair('3'), ...pair('4'), ...pair('5'), worker(SHELL_INGRESS)], {
    active: new Set([backend('1')]),
    binding: new Set([backend('4'), SHELL_INGRESS]),
    candidate: new Set([assets('2')]),
    ledger: new Set([backend('3'), assets('3')]),
  });
  // A release named by one Worker keeps both: the composition names the backend, the assets Worker serves its contract.
  expect(pruned.kept).toEqual({ active: 2, binding: 2, candidate: 2, grace: 0, ledger: 2 });
  expect(pruned.releases).toEqual([{ createdOn: NOW - 10 * DAY, workers: [backend('5'), assets('5')] }]);
  expect(pruned.accountWorkers).toBe(11);
  expect(pruned.immutableWorkers).toBe(10);
});

it('keeps every release created or changed within the grace window of an upload in flight', () => {
  const recent = (name: string, minutes: number): AccountWorker => ({
    createdOn: NOW - 10 * DAY,
    modifiedOn: NOW - minutes * 60_000,
    name,
  });
  const pruned = plan([
    worker(backend('a'), 0.05),
    worker(assets('a'), 0.05),
    recent(backend('b'), 30),
    worker(assets('b')),
    recent(backend('c'), Duration.toMinutes(PRUNE_GRACE) + 1),
  ]);
  expect(pruned.kept.grace).toBe(4);
  expect(pruned.releases.map(({ workers }) => workers)).toEqual([[backend('c')]]);
});

it('never treats a Worker of any other name shape as an immutable release', () => {
  const others = [
    SHELL_INGRESS,
    'app-akros-storefront',
    `ontos-${hex('a').slice(1)}`,
    `ontos-${hex('a')}0`,
    `ontos-${hex('a').toUpperCase().replace(/^./u, 'A')}`,
    `ontos-${hex('a')}-staging`,
    `om-stage-${hex('a')}`,
    `shell-${hex('a')}`,
  ];
  for (const name of others) {
    expect(IMMUTABLE_WORKER_NAME.test(name)).toBe(false);
  }
  const pruned = plan(others.map((name) => worker(name, 400)));
  expect(pruned.immutableWorkers).toBe(0);
  expect(pruned.releases).toEqual([]);
});

it('orders releases oldest first, each backend before its assets Worker, and frees only what is needed', () => {
  const pruned = plan([worker(assets('d'), 3), worker(backend('d'), 3), ...pair('e', 30), worker(assets('f'), 20)]);
  expect(pruned.releases.map(({ workers }) => workers)).toEqual([
    [backend('e'), assets('e')],
    [assets('f')],
    [backend('d'), assets('d')],
  ]);
  expect(oldestReleasesFreeing(pruned.releases, 3).map(({ workers }) => workers)).toEqual([
    [backend('e'), assets('e')],
    [assets('f')],
  ]);
  expect(oldestReleasesFreeing(pruned.releases, 0)).toEqual([]);
});

it('reads every immutable Worker a composition document names, and nothing that only resembles one', () => {
  const document = JSON.stringify({
    backend: { baseUrl: `https://${backend('1')}.edution.workers.dev/`, workerName: backend('1') },
    binding: `ONTOS_RELEASE_${hex('9')}`,
    contract: { url: `https://${assets('2')}.edution.workers.dev/.well-known/ontos-module-manifest.json` },
    longer: `ontos-${hex('3')}0`,
    prefixed: `xontos-${hex('4')}`,
  });
  expect([...mentionedImmutableWorkers(document)].toSorted()).toEqual([assets('2'), backend('1')].toSorted());
});

/** A ledger receipt of one unit release, recorded `ageDays` before {@link NOW}. */
const recordedRelease = (ledger: ReleaseLedger, unitId: string, seed: string, ageDays: number) =>
  recordUnitReceipt(ledger, {
    digest: seed.repeat(64).slice(0, 64),
    now: new Date(NOW - ageDays * DAY),
    receipt: {
      artifacts: {},
      assetsVersionId: `assets-version-${seed}`,
      backend: { versionId: `backend-version-${seed}`, workerName: backend(seed) },
      plan: {
        appId: unitId,
        assetsOrigin: `https://${assets(seed)}.edution.workers.dev/`,
        assetsScriptName: assets(seed),
        backendScriptName: backend(seed),
        buildMarker: seed.repeat(64).slice(0, 64),
        sourceRevision: seed.repeat(40).slice(0, 40),
      },
    },
    runId: '1',
    unitId,
  });

it('keeps the Workers of exactly the receipts a later plan may reuse, a bounded few per unit', () => {
  const run = { digestVersion: DIGEST_VERSION, now: new Date(NOW), runId: '9', sourceRevision: 'f'.repeat(40) };
  let ledger = recordedRelease(emptyLedger(run), 'tax', '6', 100);
  for (const ageDays of [5, 4, 3, 2, 1]) {
    ledger = recordedRelease(ledger, 'projects', String(6 - ageDays), ageDays);
  }
  const foreign = recordedRelease({ ...emptyLedger(run), digestVersion: 'another-scheme' }, 'party', '7', 1);
  const kept = ledgerWorkers({ current: [], trusted: [ledger, foreign] }, new Date(NOW));
  // The newest receipts of `projects`; the expired `tax` receipt and the other digest scheme's receipt are gone.
  expect(RECEIPTS_PER_UNIT).toBe(3);
  expect([...kept].toSorted()).toEqual(['3', '4', '5'].flatMap((seed) => [assets(seed), backend(seed)]).toSorted());
});

it('keeps every receipt this run selected, even an older digest past the bound of three newer ones', () => {
  const run = { digestVersion: DIGEST_VERSION, now: new Date(NOW), runId: '9', sourceRevision: 'f'.repeat(40) };
  // A content reversion: the plan retains the receipt of digest 1, older than the three newer digests 2 to 4.
  let history = recordedRelease(emptyLedger(run), 'projects', '1', 40);
  for (const seed of ['2', '3', '4']) {
    history = recordedRelease(history, 'projects', seed, 5 - Number(seed));
  }
  const selected = Object.values(history.units).find(({ receipt }) => receipt.plan.backendScriptName === backend('1'));
  if (selected === undefined) {
    throw new Error('the fixture records digest 1');
  }
  // The plan's ledger is the merge (three newest) plus the receipt it keeps, exactly as the planner carries it.
  const current: ReleaseLedger = { ...history, units: { ...history.units, [selected.digest]: selected } };
  const deployPlan = {
    units: [
      {
        mode: 'retain',
        receipt: Option.some({ plan: { assetsScriptName: assets('1'), backendScriptName: backend('1') } }),
      },
    ] as const,
  };
  const kept = ledgerWorkers({ current: [current], trusted: [history] }, new Date(NOW));
  expect([...kept].toSorted()).toEqual(
    ['1', '2', '3', '4'].flatMap((seed) => [assets(seed), backend(seed)]).toSorted(),
  );
  // The pre-upload guard keeps the plan's retained receipts whatever ledger it is given.
  const guarded = plan([...pair('1', 40), ...pair('2'), ...pair('5', 50)], {
    candidate: plannedRetainedWorkers(deployPlan),
    ledger: ledgerWorkers({ current: [], trusted: [history] }, new Date(NOW)),
  });
  expect(guarded.releases.map(({ workers }) => workers)).toEqual([[backend('5'), assets('5')]]);
});

it('counts two new Workers for every unit the release builds or uploads again', () => {
  expect(
    plannedNewWorkers({
      units: [
        { mode: 'build', receipt: Option.none() },
        {
          mode: 'retain',
          receipt: Option.some({ plan: { assetsScriptName: assets('1'), backendScriptName: backend('1') } }),
        },
        { mode: 'reupload', receipt: Option.none() },
      ],
    }),
  ).toBe(4);
});

const GITHUB_API = 'https://api.github.test';
const REPOSITORY = 'TechsioCZ/ontos';
const RUNS_ROUTE = '/actions/runs';
const GATES = 'ultramodern-workspace-gates.yml';
const COMPOSITION_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${'d'.repeat(32)}/values/active`;

/** A provider answering every request with one status and body, recording each request. */
const provider = (answer: (method: string, url: string, search: URLSearchParams) => Response) => {
  const requests: string[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      return HttpClientResponse.fromWeb(request, answer(request.method, url.pathname, url.searchParams));
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(ImmutableProviderWriteRetrySchedule, Schedule.forever),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: 'prune-test-token',
        GH_TOKEN: 'prune-test-github-token',
        GITHUB_API_URL: GITHUB_API,
        GITHUB_REPOSITORY: REPOSITORY,
        ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: COMPOSITION_URL,
      }),
    ),
  );
  return { layer, requests };
};

for (const [name, answer] of [
  ['no published composition', () => new Response(null, { status: 404 })],
  ['a refused composition read', () => new Response(null, { status: 403 })],
  ['a composition that does not decode', () => Response.json({ composition: { modules: [backend('1')] } })],
] as const) {
  it.effect(`fails closed on ${name}, so nothing can be pruned`, () =>
    Effect.gen(function* failClosedComposition() {
      const fixture = provider(answer);
      const failure = yield* activeCompositionWorkers.pipe(Effect.provide(fixture.layer), Effect.flip);
      expect(failure.message).toMatch(/nothing is pruned$/u);
      expect(fixture.requests.every((request) => request.startsWith('GET '))).toBe(true);
    }),
  );
}

it.live('deletes each release backend first and keeps its assets Worker when the backend stays', () =>
  Effect.gen(function* deleteInPairs() {
    const scripts = `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts`;
    const fixture = provider(
      (method, url) =>
        new Response(null, { status: method === 'DELETE' && url === `${scripts}/${backend('2')}` ? 409 : 404 }),
    );
    const outcome = yield* deleteReleases(
      [
        { createdOn: 0, workers: [backend('1'), assets('1')] },
        { createdOn: 1, workers: [backend('2'), assets('2')] },
      ],
      { concurrency: 1, coordinationInterval: Duration.zero, requestsPerSecond: 1000, timeBudget: Duration.minutes(1) },
      Effect.succeedNone,
    ).pipe(Effect.provide(fixture.layer));

    expect(outcome.deleted).toEqual([backend('1'), assets('1')]);
    expect(outcome.failed.map(({ worker: name }) => name)).toEqual([backend('2')]);
    expect(fixture.requests).not.toContain(`DELETE ${scripts}/${assets('2')}`);
  }),
);

it.live('defers every release past the time budget to the next prune', () =>
  Effect.gen(function* exhaustedBudget() {
    const fixture = provider(() => new Response(null, { status: 404 }));
    const outcome = yield* deleteReleases(
      [{ createdOn: 0, workers: [backend('1'), assets('1')] }],
      { concurrency: 4, coordinationInterval: Duration.zero, requestsPerSecond: 3, timeBudget: Duration.zero },
      Effect.succeedNone,
    ).pipe(Effect.provide(fixture.layer));
    expect(outcome).toEqual({ deferred: 1, deleted: [], failed: [], halted: Option.none() });
    expect(fixture.requests).toEqual([]);
  }),
);

const threeReleases = [
  { createdOn: 0, workers: [backend('1'), assets('1')] },
  { createdOn: 1, workers: [backend('2'), assets('2')] },
  { createdOn: 2, workers: [backend('3'), assets('3')] },
];

it.live('stops deleting before an aged release another stage writer reused is activated, and keeps it', () =>
  Effect.gen(function* coordinatedDeletion() {
    const fixture = provider(() => new Response(null, { status: 404 }));
    // Release 2 is older than the grace window and unreferenced when planned; then a main deploy run reuses it and
    // heads for its activation, which the next coordination check sees.
    let checks = 0;
    const coordination = Effect.sync(() => {
      checks += 1;
      return checks === 1 ? Option.none<string>() : Option.some('another stage writer is unfinished');
    });
    const outcome = yield* deleteReleases(
      threeReleases,
      {
        concurrency: 1,
        coordinationInterval: Duration.zero,
        requestsPerSecond: 1000,
        timeBudget: Duration.minutes(1),
      },
      coordination,
    ).pipe(Effect.provide(fixture.layer));

    expect(outcome.deleted).toEqual([backend('1'), assets('1')]);
    expect(outcome.deferred).toBe(2);
    expect(outcome.halted).toEqual(Option.some('another stage writer is unfinished'));
    expect(fixture.requests.filter((request) => request.includes(hex('2')))).toEqual([]);
    // Once stopped, it stays stopped: the third release asks nothing more.
    expect(checks).toBe(2);
  }),
);

it.live('shares one coordination answer across the deletions of its interval', () =>
  Effect.gen(function* sharedCoordination() {
    const fixture = provider(() => new Response(null, { status: 404 }));
    let checks = 0;
    const outcome = yield* deleteReleases(
      threeReleases,
      {
        concurrency: 4,
        coordinationInterval: Duration.minutes(1),
        requestsPerSecond: 1000,
        timeBudget: Duration.minutes(1),
      },
      Effect.sync(() => {
        checks += 1;
        return Option.none<string>();
      }),
    ).pipe(Effect.provide(fixture.layer));
    expect(outcome.deleted).toHaveLength(6);
    expect(checks).toBe(1);
  }),
);

interface ListedRun {
  readonly branch?: string;
  readonly id: number;
  readonly status: string;
  readonly workflow: string;
}

/**
 * A GitHub and composition storage fixture: the repository's runs, listed by status a page at a time (newest first,
 * as GitHub lists them), and the active composition answer.
 */
const coordinationFixture = (runs: readonly ListedRun[], composition: () => Response) =>
  provider((_method, url, search) => {
    if (url.endsWith(RUNS_ROUTE)) {
      const perPage = Number(search.get('per_page'));
      const page = Number(search.get('page'));
      const listed = runs.filter(({ status }) => status === search.get('status'));
      return Response.json({
        total_count: listed.length,
        workflow_runs: listed.slice((page - 1) * perPage, page * perPage).map(({ branch, id, status, workflow }) => ({
          head_branch: branch ?? 'main',
          id,
          path: `.github/workflows/${workflow}`,
          status,
        })),
      });
    }
    return composition();
  });

const STATUS_REQUESTS = UNFINISHED_RUN_STATUSES.map(
  (status) => `GET /repos/TechsioCZ/ontos/actions/runs?page=1&per_page=100&status=${status}`,
).toSorted();

it.effect(
  'stops deletion while a main deploy run or an initial cutover is unfinished, before reading anything else',
  () =>
    Effect.gen(function* unfinishedStageWriter() {
      for (const workflow of [GATES, 'initial-composition-cutover.yml']) {
        for (const status of UNFINISHED_RUN_STATUSES) {
          const fixture = coordinationFixture(
            [
              { id: 1, status: 'completed', workflow },
              { id: 2, status, workflow },
              { id: 3, status, workflow: 'quality-audit.yml' },
            ],
            () => {
              throw new Error('the composition is not read while a stage writer is unfinished');
            },
          );
          const halt = yield* stageCoordination(new Set([backend('1')])).pipe(Effect.provide(fixture.layer));
          expect(halt).toEqual(Option.some(`another stage writer is unfinished (${workflow} run 2)`));
          expect(fixture.requests.toSorted()).toEqual(STATUS_REQUESTS);
        }
      }
    }),
);

it.effect('stops deletion when the active composition can no longer be read or proven unchanged', () =>
  Effect.gen(function* unprovenComposition() {
    const fixture = coordinationFixture([{ id: 1, status: 'completed', workflow: GATES }], () =>
      Response.json({ composition: { modules: [backend('2')] } }),
    );
    const halt = yield* stageCoordination(new Set([backend('1')])).pipe(Effect.provide(fixture.layer));
    expect(Option.getOrThrow(halt)).toMatch(/^coordination could not be proven: /u);
  }),
);

it.effect('stops deletion when the stage writer runs cannot be read', () =>
  Effect.gen(function* unreadableRuns() {
    const fixture = provider(() => new Response(null, { status: 502 }));
    const halt = yield* stageCoordination(new Set()).pipe(Effect.provide(fixture.layer));
    expect(Option.getOrThrow(halt)).toMatch(/^coordination could not be proven: GitHub answered 502/u);
  }),
);

it.effect('finds an old rerun of a main deploy however many newer runs completed, past the first page', () =>
  Effect.gen(function* oldRerunBeyondFirstPage() {
    const others = Array.from({ length: 130 }, (_, index) => ({
      id: 1000 - index,
      status: 'in_progress',
      workflow: 'quality-audit.yml',
    }));
    const completed = Array.from({ length: 40 }, (_, index) => ({
      id: 900 - index,
      status: 'completed',
      workflow: GATES,
    }));
    const fixture = coordinationFixture(
      [...completed, ...others, { id: 7, status: 'in_progress', workflow: GATES }],
      () => {
        throw new Error('not read');
      },
    );
    const unfinished = yield* unfinishedForeignStageWriters.pipe(Effect.provide(fixture.layer));
    expect(unfinished).toEqual(['ultramodern-workspace-gates.yml run 7']);
    expect(fixture.requests).toContain(
      'GET /repos/TechsioCZ/ontos/actions/runs?page=2&per_page=100&status=in_progress',
    );
  }),
);

it.effect('counts main deploy runs only on main, and a cutover from any branch', () =>
  Effect.gen(function* writerBranches() {
    const fixture = coordinationFixture(
      [
        { branch: 'feature', id: 1, status: 'queued', workflow: GATES },
        { branch: 'feature', id: 2, status: 'waiting', workflow: 'initial-composition-cutover.yml' },
      ],
      () => {
        throw new Error('not read');
      },
    );
    const unfinished = yield* unfinishedForeignStageWriters.pipe(Effect.provide(fixture.layer));
    expect(unfinished).toEqual(['initial-composition-cutover.yml run 2']);
  }),
);

it.effect('proves nothing from a run listing that changed between its pages or that GitHub would truncate', () =>
  Effect.gen(function* incompleteListing() {
    // A run that completed between the pages shifts the next page by one: a run is skipped, and the count shows it.
    let served = 0;
    const shifting = provider((_method, url, search) => {
      if (!url.endsWith(RUNS_ROUTE) || search.get('status') !== 'in_progress') {
        return Response.json({ total_count: 0, workflow_runs: [] });
      }
      served += 1;
      const page = Number(search.get('page'));
      const total = served === 1 ? 150 : 149;
      const ids = Array.from({ length: total }, (_, index) => index + 1).filter((id) => served === 1 || id !== 1);
      return Response.json({
        total_count: total,
        workflow_runs: ids.slice((page - 1) * 100, page * 100).map((id) => ({
          head_branch: 'main',
          id,
          path: '.github/workflows/quality-audit.yml',
          status: 'in_progress',
        })),
      });
    });
    const shifted = yield* stageCoordination(new Set()).pipe(Effect.provide(shifting.layer));
    expect(Option.getOrThrow(shifted)).toMatch(/the in_progress runs changed while they were listed/u);

    const truncated = provider((_method, url) =>
      url.endsWith(RUNS_ROUTE) ? Response.json({ total_count: 1001, workflow_runs: [] }) : Response.json({}),
    );
    const halt = yield* stageCoordination(new Set()).pipe(Effect.provide(truncated.layer));
    expect(Option.getOrThrow(halt)).toMatch(/more than GitHub lists/u);
  }),
);

const REPOSITORY_ID = 7;
const MAIN_RUN = {
  event: 'push',
  head_branch: 'main',
  head_repository: { full_name: REPOSITORY, id: REPOSITORY_ID },
  head_sha: 'a'.repeat(40),
  path: MAIN_STAGE_PRODUCER.workflowPath,
  repository: { full_name: REPOSITORY, id: REPOSITORY_ID },
};

/** GitHub's artifact listing of main deploy candidates (`ageDays` old each), their producer runs and archives. */
const candidateGitHub = (
  artifacts: readonly {
    readonly ageDays: number;
    readonly expired?: boolean;
    readonly id: number;
    readonly run?: Partial<typeof MAIN_RUN>;
  }[],
) => {
  const requests: string[] = [];
  const fetchStub: typeof globalThis.fetch = (input) => {
    const url = new URL(new Request(input).url);
    requests.push(`${url.pathname}${url.search}`);
    const runId = /\/actions\/runs\/(?<id>\d+)$/u.exec(url.pathname)?.groups?.id;
    const produced = artifacts.find(({ id }) => String(id) === runId);
    if (produced !== undefined) {
      return Promise.resolve(Response.json({ ...MAIN_RUN, ...produced.run, id: produced.id }));
    }
    if (url.pathname.endsWith('/actions/artifacts')) {
      const page = Number(url.searchParams.get('page'));
      return Promise.resolve(
        Response.json({
          artifacts: artifacts.slice((page - 1) * 100, page * 100).map((artifact) => ({
            created_at: new Date(NOW - artifact.ageDays * DAY).toISOString(),
            expired: artifact.expired ?? false,
            id: artifact.id,
            name: url.searchParams.get('name'),
            workflow_run: {
              head_branch: artifact.run?.head_branch ?? 'main',
              head_repository_id: REPOSITORY_ID,
              head_sha: 'a'.repeat(40),
              id: artifact.id,
              repository_id: REPOSITORY_ID,
            },
          })),
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };
  const client = createGitHubClient({
    apiUrl: GITHUB_API,
    fetch: fetchStub,
    repository: REPOSITORY,
    token: 'prune-test-github-token',
  });
  return { client, requests };
};

/** A client whose archives are the given candidate documents by artifact id. */
const withArchives = (client: GitHubClient, documents: Readonly<Record<number, string | undefined>>): GitHubClient => ({
  ...client,
  downloadArtifact: (artifactId) => {
    const document = documents[artifactId];
    return Promise.resolve(new Map(document === undefined ? [] : [[MAIN_CANDIDATE_FILE, Buffer.from(document)]]));
  },
});

it.effect('keeps every Worker a retained main deploy candidate names, so a publication rerun finds them', () =>
  Effect.gen(function* retainedMainCandidates() {
    const { client, requests } = candidateGitHub([
      { ageDays: 1, id: 11 },
      { ageDays: 3, id: 12 },
      { ageDays: 5, expired: true, id: 13 },
      { ageDays: 6, id: 14, run: { event: 'pull_request' } },
      { ageDays: 6, id: 15, run: { head_branch: 'feature' } },
      { ageDays: 6, id: 16, run: { path: '.github/workflows/quality-audit.yml' } },
    ]);
    const documents = {
      11: JSON.stringify({ modules: [{ assets: assets('1'), backend: backend('1') }] }),
      12: JSON.stringify({ shell: backend('2') }),
      13: JSON.stringify({ shell: backend('3') }),
      14: JSON.stringify({ shell: backend('4') }),
      15: JSON.stringify({ shell: backend('5') }),
      16: JSON.stringify({ shell: backend('6') }),
    };
    const kept = yield* retainedMainCandidateWorkers(withArchives(client, documents), NOW);
    expect([...kept].toSorted()).toEqual([assets('1'), backend('1'), backend('2')].toSorted());
    expect(requests[0]).toBe(
      `/repos/TechsioCZ/ontos/actions/artifacts?name=${MAIN_CANDIDATE_ARTIFACT}&per_page=100&page=1`,
    );
  }),
);

it.effect('reads every retained main candidate page, and fails rather than keep a partial set', () =>
  Effect.gen(function* everyMainCandidate() {
    // Newest first: two full pages within retention, then a page reaching archives too old to be unexpired.
    const recent = Array.from({ length: 250 }, (_, index) => ({ ageDays: 1, id: 100 + index }));
    const aged = Array.from({ length: 150 }, (_, index) => ({ ageDays: 9, expired: true, id: 1000 + index }));
    const pages = candidateGitHub([...recent, ...aged]);
    const documents = Object.fromEntries(recent.map(({ id }) => [id, JSON.stringify({ shell: backend('1') })]));
    const kept = yield* retainedMainCandidateWorkers(withArchives(pages.client, documents), NOW);
    expect([...kept]).toEqual([backend('1')]);
    expect(pages.requests.filter((request) => request.includes('/actions/artifacts?'))).toHaveLength(3);

    // Every page full of candidates still within retention: GitHub lists more than can be read.
    const endless = candidateGitHub(Array.from({ length: 1000 }, (_, index) => ({ ageDays: 1, id: 2000 + index })));
    const partial = yield* Effect.flip(retainedMainCandidateWorkers(withArchives(endless.client, {}), NOW));
    expect(partial.message).toBe('the retained main deploy candidates could not be listed; nothing is pruned');
    expect(String(partial.cause)).toMatch(
      /more approved-application-composition-candidate artifacts are listed than 10 pages hold/u,
    );

    // An archive without its candidate keeps nothing it should have named: the read fails.
    const missing = candidateGitHub([{ ageDays: 1, id: 11 }]);
    const absent = yield* Effect.flip(retainedMainCandidateWorkers(withArchives(missing.client, {}), NOW));
    expect(absent.message).toBe('the main deploy candidate 11 could not be read; nothing is pruned');

    // An archive whose candidate is not a JSON document fails the read too.
    const garbled = yield* Effect.flip(
      retainedMainCandidateWorkers(withArchives(missing.client, { 11: `{"shell":"${backend('1')}"` }), NOW),
    );
    expect(garbled.message).toBe('the main deploy candidate 11 could not be read; nothing is pruned');
  }),
);

const GatesWorkflowSchema = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      if: Schema.optionalKey(Schema.String),
      steps: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            with: Schema.optionalKey(
              Schema.Struct({
                name: Schema.optionalKey(Schema.Unknown),
                path: Schema.optionalKey(Schema.Unknown),
                'retention-days': Schema.optionalKey(Schema.Unknown),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
});

it('mirrors the main deploy workflow: its candidate archive, file, retention and producer runs', () => {
  const { jobs } = Schema.decodeUnknownSync(GatesWorkflowSchema)(
    parse(readFileSync(new URL(`../../../${MAIN_STAGE_PRODUCER.workflowPath}`, import.meta.url), 'utf-8')),
  );
  const archives = Object.values(jobs)
    .flatMap(({ steps }) => steps ?? [])
    .flatMap((step) =>
      step.with?.name === MAIN_CANDIDATE_ARTIFACT && step.with['retention-days'] !== undefined ? [step.with] : [],
    );
  expect(archives).toEqual([
    expect.objectContaining({
      path: `\${{ runner.temp }}/${MAIN_CANDIDATE_FILE}`,
      'retention-days': Duration.toDays(MAIN_CANDIDATE_RETENTION),
    }),
  ]);
  // Only pushes and dispatches on main deploy.
  const deploys = jobs['deploy-target']?.if ?? '';
  for (const event of MAIN_STAGE_PRODUCER.events) {
    expect(deploys).toContain(`github.event_name == '${event}'`);
  }
  expect(deploys).toContain(`github.ref == 'refs/heads/${MAIN_STAGE_PRODUCER.branch}'`);
});
