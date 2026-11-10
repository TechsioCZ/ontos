import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import React from 'react';
import type { ReactNode } from 'react';
import { activities } from '../../src/routes/[lang]/aktivity/page.tsx';

const mocks = rstest.hoisted(() => ({ records: rstest.fn() }));
rstest.mock('../../src/api/records-consumer.ts', () => ({ executeRecords: mocks.records }));
rstest.mock('@app/work-tasks/clients/records', () => ({ executeRecords: rstest.fn() }));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useRouterState: () => '',
}));
rstest.mock('../../src/routes/ultramodern-route-head', () => ({ UltramodernRouteHead: () => null }));
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
  // The owner's Node-only test config compiles TSX with the classic React runtime.
  rstest.stubGlobal('React', React);
  for (const [key, value] of Object.entries(globals)) {
    Reflect.set(globalThis, key, value);
  }
});
afterAll(() => {
  rstest.unstubAllGlobals();
  for (const key of Object.keys(globals)) {
    Reflect.deleteProperty(globalThis, key);
  }
});

// An empty resource id keys the same entry as an unfiltered read; the test counts reads only.
const input = { legalEntityId: 'company-a', resourceId: '' };

const dispatchChange = (apps: ModuleChangeDetail['apps']) => {
  events.dispatchEvent(new CustomEvent<ModuleChangeDetail>(moduleChangeEvent, { detail: { apps } }));
};

beforeEach(() => {
  rstest.resetAllMocks();
  activities.invalidate();
  mocks.records.mockReturnValue(Effect.fail('offline'));
});

it.live('live changes of apps the activities do not show read nothing', () =>
  Effect.gen(function* unrelatedChange() {
    yield* activities.preload(input);
    const unsubscribe = activities.subscribe(() => {
      activities.snapshot(input);
    }, input);
    expect(mocks.records).toHaveBeenCalledTimes(1);
    dispatchChange(['work-tasks']);
    yield* Effect.sleep('10 millis');
    expect(mocks.records).toHaveBeenCalledTimes(1);
    unsubscribe();
  }),
);

it.live('a live change of crm-activities reloads the mounted activities', () =>
  Effect.gen(function* ownChange() {
    yield* activities.preload(input);
    const unsubscribe = activities.subscribe(() => {
      activities.snapshot(input);
    }, input);
    dispatchChange(['crm-activities']);
    yield* Effect.sleep('10 millis');
    expect(mocks.records).toHaveBeenCalledTimes(2);
    unsubscribe();
  }),
);
