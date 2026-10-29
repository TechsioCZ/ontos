import { ConfigProvider, Duration, Effect, Layer, Schedule } from 'effect';
import { expect, it } from 'effect-rstest';
import { HttpClient, HttpClientResponse } from 'effect/http';

import { DIGEST_VERSION } from '../ci/deploy-plan.mts';
import {
  IMMUTABLE_WORKER_NAME,
  PRUNE_GRACE,
  activeCompositionWorkers,
  deleteReleases,
  ledgerWorkers,
  mentionedImmutableWorkers,
  oldestReleasesFreeing,
  planImmutableWorkerPrune,
  plannedNewWorkers,
} from '../ci/prune-immutable-workers.mts';
import type { AccountWorker, KeepSources } from '../ci/prune-immutable-workers.mts';
import { RECEIPTS_PER_UNIT, emptyLedger, recordUnitReceipt } from '../ci/release-ledger.mts';
import type { ReleaseLedger } from '../ci/release-ledger.mts';
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
  const kept = ledgerWorkers([ledger, foreign], new Date(NOW));
  // The newest receipts of `projects`; the expired `tax` receipt and the other digest scheme's receipt are gone.
  expect(RECEIPTS_PER_UNIT).toBe(3);
  expect([...kept].toSorted()).toEqual(['3', '4', '5'].flatMap((seed) => [assets(seed), backend(seed)]).toSorted());
});

it('counts two new Workers for every unit the release builds or uploads again', () => {
  expect(plannedNewWorkers({ units: [{ mode: 'build' }, { mode: 'retain' }, { mode: 'reupload' }] })).toBe(4);
});

const COMPOSITION_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${'d'.repeat(32)}/values/active`;

/** A provider answering every request with one status and body, recording each request. */
const provider = (answer: (method: string, url: string) => Response) => {
  const requests: string[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push(`${request.method} ${url.pathname}`);
      return HttpClientResponse.fromWeb(request, answer(request.method, url.pathname));
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(ImmutableProviderWriteRetrySchedule, Schedule.forever),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: 'prune-test-token',
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
      { concurrency: 1, requestsPerSecond: 1000, timeBudget: Duration.minutes(1) },
    ).pipe(Effect.provide(fixture.layer));

    expect(outcome.deleted).toEqual([backend('1'), assets('1')]);
    expect(outcome.failed.map(({ worker: name }) => name)).toEqual([backend('2')]);
    expect(fixture.requests).not.toContain(`DELETE ${scripts}/${assets('2')}`);
  }),
);

it.live('defers every release past the time budget to the next prune', () =>
  Effect.gen(function* exhaustedBudget() {
    const fixture = provider(() => new Response(null, { status: 404 }));
    const outcome = yield* deleteReleases([{ createdOn: 0, workers: [backend('1'), assets('1')] }], {
      concurrency: 4,
      requestsPerSecond: 3,
      timeBudget: Duration.zero,
    }).pipe(Effect.provide(fixture.layer));
    expect(outcome).toEqual({ deferred: 1, deleted: [], failed: [] });
    expect(fixture.requests).toEqual([]);
  }),
);
