import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  searchStageOwners,
  searchStageSubscriptions,
  searchStageTopics,
  summarizeSearchStageInventory,
} from '../demo/search-stage-state.mts';

const owners = {
  core: 'core.identity',
  crm: 'demo.crm',
  facility: 'facility.operations',
  finance: 'finance.billing',
  leasing: 'property.leasing',
  legal: 'legal.agreements',
  market: 'commerce.market-catalog',
  merchandise: 'demo.merchandise',
  party: 'party.registry',
  pipeline: 'demo.sales-pipeline',
  portfolio: 'property.portfolio',
  projects: 'projects.core',
  tasks: 'work.tasks',
  workforce: 'demo.workforce',
} as const;
const rebuildTopicWorker = ['search-rebuild-requested', 'rebuild-search'] as const;
const refreshTopicWorker = ['search-refresh-requested', 'refresh-search'] as const;

it('inventories the actual owner names, including owners without registered producers', () => {
  expect(new Set(searchStageOwners)).toEqual(new Set(Object.values(owners)));
  expect(new Set(searchStageOwners).size).toBe(searchStageOwners.length);
  expect(searchStageOwners).not.toContain('workforce.core');
  expect(searchStageOwners).not.toContain('demo.projects');
});

const subscriptionsFor = (owner: string) =>
  searchStageSubscriptions.filter(({ producerModuleKey }) => producerModuleKey === owner);
const expectTopicWorkers = (owner: string, pairs: readonly (readonly [string, string])[]) => {
  expect(subscriptionsFor(owner)).toEqual(
    pairs.map(([event, worker]) => ({
      consumerModuleKey: owner,
      producerModuleKey: owner,
      topic: `${owner}.${event}.v1`,
      workerKey: `${owner}.${worker}`,
    })),
  );
};

it('mirrors the six registered Market lifecycle/rebuild topic-worker pairs, not generic search events', () => {
  expectTopicWorkers(owners.market, [
    ['market-created', 'project-market-created-to-search'],
    ['market-definition-revised', 'project-market-definition-revised-to-search'],
    ['market-activated', 'project-market-activated-to-search'],
    ['market-suspended', 'project-market-suspended-to-search'],
    ['market-retired', 'project-market-retired-to-search'],
    rebuildTopicWorker,
  ]);
  for (const event of ['market-revised', 'search-changed', 'search-refresh-requested']) {
    expect(searchStageTopics).not.toContain(`commerce.market-catalog.${event}.v1`);
  }
});

it('distinguishes actual refresh/rebuild owners from changed/rebuild owners', () => {
  for (const owner of [
    owners.pipeline,
    owners.merchandise,
    owners.workforce,
    owners.tasks,
    owners.portfolio,
    owners.leasing,
    owners.facility,
  ]) {
    expectTopicWorkers(owner, [refreshTopicWorker, rebuildTopicWorker]);
    expect(searchStageTopics).not.toContain(`${owner}.search-changed.v1`);
  }
  for (const owner of [owners.crm, owners.finance, owners.legal]) {
    expectTopicWorkers(owner, [['search-changed', 'project-search'], rebuildTopicWorker]);
    expect(searchStageTopics).not.toContain(`${owner}.search-refresh-requested.v1`);
  }
  expect(searchStageTopics).not.toContain('demo.sales-pipeline.opportunity-won.v1');
  expect(searchStageSubscriptions.some(({ workerKey }) => workerKey.includes('draft-invoice'))).toBe(false);
});

it('keeps exact Party lifecycle and Core People registrations', () => {
  expectTopicWorkers(owners.party, [
    rebuildTopicWorker,
    ...[
      'party-created',
      'party-updated',
      'party-archived',
      'party-unarchived',
      'party-fact-corrected',
      'counterparty-created',
      'counterparty-role-added',
      'counterparty-role-ended',
      'contact-point-added',
      'contact-point-updated',
      'contact-point-ended',
      'official-identifier-added',
      'official-identifier-updated',
      'official-identifier-ended',
    ].map((event): readonly [string, string] => [event, `project-${event}-to-search`]),
  ]);
  expectTopicWorkers(owners.core, [
    ['people-search-rebuild-requested', 'rebuild-people-search'],
    ['principal-lifecycle-changed', 'project-people-lifecycle-search'],
    ['scoped-role-membership-changed', 'project-people-role-search'],
  ]);
  expect(new Set(searchStageTopics).size).toBe(searchStageTopics.length);
  expect(searchStageTopics.every((topic) => topic.endsWith('.v1'))).toBe(true);
});

it('mirrors the registered Projects refresh/rebuild workers without inventing document counts or readiness', () => {
  const inventory = summarizeSearchStageInventory([]);
  expectTopicWorkers(owners.projects, [refreshTopicWorker, rebuildTopicWorker]);
  expect(searchStageTopics.filter((topic) => topic.startsWith(`${owners.projects}.`))).toEqual([
    'projects.core.search-refresh-requested.v1',
    'projects.core.search-rebuild-requested.v1',
  ]);
  expect(inventory.find(({ owner }) => owner === owners.projects)).toEqual({
    liveCount: null,
    missingCount: null,
    owner: owners.projects,
    staleCount: null,
    status: 'producer_unverified',
  });
  expect(inventory.find(({ owner }) => owner === owners.workforce)).toEqual({
    liveCount: null,
    missingCount: null,
    owner: owners.workforce,
    staleCount: null,
    status: 'producer_unverified',
  });
  expect(inventory.find(({ owner }) => owner === owners.market)).toEqual({
    liveCount: null,
    missingCount: null,
    owner: owners.market,
    staleCount: null,
    status: 'unobserved',
  });
  expect(inventory.some(({ status }) => status === 'observed_stamps_current')).toBe(false);
});

// Synthetic aggregate observations only; these are not claimed stage/source counts.
const observed = {
  liveCount: 3,
  missingCount: 0,
  owner: owners.market,
  resourceType: 'commerce.market-catalog.market',
  staleCount: 0,
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const marketInventory = (rows: readonly (typeof observed)[]) =>
  summarizeSearchStageInventory(rows).find(({ owner }) => owner === observed.owner);

it('reports missing or stale live derived stamps as failures even alongside current observations', () => {
  expect(marketInventory([{ ...observed, missingCount: 1 }])?.status).toBe('derived_missing');
  expect(marketInventory([{ ...observed, staleCount: 1 }])?.status).toBe('derived_stale');
  expect(
    marketInventory([
      observed,
      { ...observed, missingCount: 1, staleCount: 1, tenantId: '22222222-2222-4222-8222-222222222222' },
    ]),
  ).toEqual({
    liveCount: 6,
    missingCount: 1,
    owner: observed.owner,
    staleCount: 1,
    status: 'derived_missing',
  });
  expect(
    marketInventory([observed, { ...observed, resourceType: 'another-observed-type', staleCount: 1 }])?.status,
  ).toBe('derived_stale');
});

it('limits positive evidence to observed stamps, never source completeness or an absent producer', () => {
  expect(marketInventory([observed])).toEqual({
    liveCount: 3,
    missingCount: 0,
    owner: observed.owner,
    staleCount: 0,
    status: 'observed_stamps_current',
  });
  expect(marketInventory([{ ...observed, liveCount: 0 }])?.status).toBe('unobserved');
  for (const owner of [owners.workforce, owners.projects]) {
    const row = summarizeSearchStageInventory([{ ...observed, owner }]).find((item) => item.owner === owner);
    expect(row?.liveCount).toBe(observed.liveCount);
    expect(row?.status).toBe('producer_unverified');
  }
});

it.effect('checks mirrored vertical subscriptions against source registrations without importing owner code', () =>
  Effect.gen(function* sourceRegistrationEvidence() {
    const fs = yield* FileSystem.FileSystem;
    for (const [owner, vertical] of [
      [owners.party, 'party-registry'],
      [owners.crm, 'crm'],
      [owners.pipeline, 'sales-pipeline'],
      [owners.merchandise, 'merchandise'],
      [owners.tasks, 'work-tasks'],
      [owners.finance, 'finance-billing'],
      [owners.legal, 'legal-agreements'],
      [owners.portfolio, 'property-portfolio'],
      [owners.leasing, 'property-leasing'],
      [owners.facility, 'facility-operations'],
      [owners.market, 'commerce-market-catalog'],
      [owners.workforce, 'workforce'],
      [owners.projects, 'projects'],
    ] as const) {
      const root = new URL(`../../verticals/${vertical}/`, import.meta.url);
      const registration = yield* fs.readFileString(new URL('vertical.registration.ts', root).pathname);
      const workers = registration
        .split('// <generated-module-registration-workers>')[1]
        ?.split('// </generated-module-registration-workers>')[0];
      expect(workers).toBeDefined();
      const subscriptions = subscriptionsFor(owner);
      if (subscriptions.length === 0) {
        // In-source ingestion declarations alone do not register an executable worker.
        expect(workers?.trim()).toBe('');
      }
      for (const { producerModuleKey, topic, workerKey } of subscriptions) {
        const suffix = workerKey.slice(owner.length + 1);
        const file = `src/workers/${suffix}.worker.ts`;
        const source = yield* fs.readFileString(new URL(file, root).pathname);
        expect(registration).toContain(`from './${file}'`);
        expect(source).toContain(`// @ontos-outbox-worker-key ${workerKey}`);
        expect(source).toContain(`// @ontos-outbox-worker-owner ${owner}`);
        expect(source).toContain(`// @ontos-outbox-worker-producer ${producerModuleKey}`);
        expect(source).toContain(`// @ontos-outbox-worker-topic ${topic}`);
        const direct = /export const (?<symbol>\w+)\s*=\s*defineOutboxWorker\(/u.exec(source);
        const factory =
          /export const \{\s*worker:\s*(?<symbol>\w+)\s*(?:,\s*handle:\s*\w+\s*,?)?\s*\}\s*=\s*definePartySearchWorker\(/u.exec(
            source,
          );
        const symbolGroup = 'symbol';
        const symbol = direct?.groups?.[symbolGroup] ?? factory?.groups?.[symbolGroup];
        expect(symbol, `${owner}: ${file} must export its registered worker`).toBeDefined();
        expect(workers).toContain(`${symbol},`);
      }
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
