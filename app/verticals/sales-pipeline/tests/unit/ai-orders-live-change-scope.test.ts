import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import type { ReactNode } from 'react';
import { aiOrders } from '../../src/routes/[lang]/prodej/schvalovani-ai/page.tsx';

const mocks = rstest.hoisted(() => ({ records: rstest.fn() }));
rstest.mock('@app/merchandise/clients/records', () => ({ executeRecords: mocks.records }));
rstest.mock('@modern-js/runtime/head', () => ({ Helmet: () => null }));
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
  aiOrders.invalidate();
  mocks.records.mockReturnValue(
    Effect.succeed({ aiChanges: { batches: [], changes: [], log: [] }, canWrite: false, revision: 1 }),
  );
});

it.live('live changes of apps the order proposals do not show read nothing', () =>
  Effect.gen(function* unrelatedChange() {
    yield* aiOrders.preload('company-a');
    const unsubscribe = aiOrders.subscribe(() => {
      aiOrders.snapshot('company-a');
    }, 'company-a');
    expect(mocks.records).toHaveBeenCalledTimes(1);
    dispatchChange(['party-registry']);
    yield* Effect.sleep('10 millis');
    expect(mocks.records).toHaveBeenCalledTimes(1);
    unsubscribe();
  }),
);

it.live('a live change of merchandise reloads the mounted order proposals', () =>
  Effect.gen(function* orderChange() {
    yield* aiOrders.preload('company-a');
    const unsubscribe = aiOrders.subscribe(() => {
      aiOrders.snapshot('company-a');
    }, 'company-a');
    dispatchChange(['merchandise']);
    yield* Effect.sleep('10 millis');
    expect(mocks.records).toHaveBeenCalledTimes(2);
    unsubscribe();
  }),
);
