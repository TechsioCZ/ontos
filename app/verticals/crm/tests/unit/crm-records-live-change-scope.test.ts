import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import type { ReactNode } from 'react';
import { crmRecordsData } from '../../src/crm/records.ts';

const mocks = rstest.hoisted(() => ({ records: rstest.fn() }));
rstest.mock('../../src/api/records-consumer.ts', () => ({ executeRecords: mocks.records }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: String }),
}));

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

const dispatchChange = (apps: ModuleChangeDetail['apps']) => {
  events.dispatchEvent(new CustomEvent<ModuleChangeDetail>(moduleChangeEvent, { detail: { apps } }));
};

beforeEach(() => {
  rstest.resetAllMocks();
  crmRecordsData.invalidate();
  mocks.records.mockReturnValue(Effect.succeed({ items: [], revision: 7 }));
});

it.live('live changes of apps the CRM records do not show read nothing', () =>
  Effect.gen(function* unrelatedChange() {
    yield* crmRecordsData.preload({});
    const unsubscribe = crmRecordsData.subscribe(() => {
      crmRecordsData.snapshot({});
    }, {});
    expect(mocks.records).toHaveBeenCalledTimes(1);
    dispatchChange(['party-registry']);
    yield* Effect.sleep('10 millis');
    expect(mocks.records).toHaveBeenCalledTimes(1);
    unsubscribe();
  }),
);

it.live('a live change of crm reloads the mounted CRM records', () =>
  Effect.gen(function* ownChange() {
    yield* crmRecordsData.preload({});
    const unsubscribe = crmRecordsData.subscribe(() => {
      crmRecordsData.snapshot({});
    }, {});
    dispatchChange(['crm']);
    yield* Effect.sleep('10 millis');
    expect(mocks.records).toHaveBeenCalledTimes(2);
    unsubscribe();
  }),
);

it.live('a Core identity change reloads the mounted CRM records and their assignee directory', () =>
  Effect.gen(function* identityChange() {
    yield* crmRecordsData.preload({});
    const unsubscribe = crmRecordsData.subscribe(() => {
      crmRecordsData.snapshot({});
    }, {});
    dispatchChange(['shell']);
    yield* Effect.sleep('10 millis');
    expect(mocks.records).toHaveBeenCalledTimes(2);
    unsubscribe();
  }),
);
