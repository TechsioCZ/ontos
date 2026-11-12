import { pageDataScopeKey, moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail } from '@app/shared-contracts/page-data';
import { Effect, Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import { OpportunitySchema } from '../../shared/model/opportunity.ts';
import { opportunityRelatedData } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-related.ts';

const mocks = rstest.hoisted(() => ({
  contracts: rstest.fn(),
  orders: rstest.fn(),
  tasks: rstest.fn(),
}));
rstest.mock('@app/shared-contracts', () => ({
  ...rstest.requireActual<object>('@app/shared-contracts'),
  documentNavigationModules: () => new Set(['work.tasks', 'demo.merchandise', 'legal.agreements']),
}));
rstest.mock('@app/merchandise/clients/records', () => ({ listOrders: mocks.orders }));
rstest.mock('@app/legal-agreements/clients/records', () => ({ executeRecords: mocks.contracts }));
rstest.mock('@app/work-tasks/clients/records', () => ({ executeRecords: mocks.tasks }));

const events = new EventTarget();
const globals = {
  addEventListener: events.addEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  document: {},
  removeEventListener: events.removeEventListener.bind(events),
};
beforeAll(() => {
  for (const [key, value] of Object.entries(globals)) {
    Reflect.set(globalThis, key, value);
  }
});
afterAll(() => {
  for (const key of Object.keys(globals)) {
    Reflect.deleteProperty(globalThis, key);
  }
});

const context = { legalEntityId: 'company-a', principalId: 'principal-a', tenantId: 'tenant-a' };
const opportunity = Schema.decodeSync(OpportunitySchema)({
  amountMinor: 100,
  createdAt: '2026-11-03T00:00:00Z',
  currency: 'CZK',
  expectedCloseDate: '2026-11-03',
  id: '10000000-0000-4000-8000-000000000001',
  lines: [],
  partyId: '10000000-0000-4000-8000-000000000002',
  probability: 10,
  stage: 'LEAD',
  stageHistory: [],
  title: 'Visible case',
  updatedAt: '2026-11-03T00:00:00Z',
});
const input = {
  counterpartyId: 'customer-a',
  opportunity,
  revision: 7,
  scope: pageDataScopeKey(context, 'demo.sales-pipeline') ?? '',
};

const dispatchChange = (apps: ModuleChangeDetail['apps']) => {
  events.dispatchEvent(new CustomEvent<ModuleChangeDetail>(moduleChangeEvent, { detail: { apps } }));
};
const reads = () => [mocks.contracts, mocks.orders, mocks.tasks].reduce((sum, mock) => sum + mock.mock.calls.length, 0);

beforeEach(() => {
  rstest.resetAllMocks();
  opportunityRelatedData.invalidate();
  mocks.contracts.mockReturnValue(Effect.succeed({ contracts: [] }));
  mocks.orders.mockReturnValue(Effect.succeed([]));
  mocks.tasks.mockReturnValue(Effect.succeed({ items: [] }));
});

it.live('live changes of apps the related sections do not show read nothing', () =>
  Effect.gen(function* unrelatedChange() {
    yield* opportunityRelatedData.preload(input);
    const unsubscribe = opportunityRelatedData.subscribe(() => {
      opportunityRelatedData.snapshot(input);
    }, input);
    const before = reads();
    dispatchChange(['party-registry']);
    yield* Effect.sleep('10 millis');
    expect(reads()).toBe(before);
    unsubscribe();
  }),
);

it.live('a live change of work-tasks reloads the mounted related sections', () =>
  Effect.gen(function* taskChange() {
    yield* opportunityRelatedData.preload(input);
    const unsubscribe = opportunityRelatedData.subscribe(() => {
      opportunityRelatedData.snapshot(input);
    }, input);
    const before = reads();
    dispatchChange(['work-tasks']);
    yield* Effect.sleep('10 millis');
    expect(reads()).toBeGreaterThan(before);
    unsubscribe();
  }),
);
