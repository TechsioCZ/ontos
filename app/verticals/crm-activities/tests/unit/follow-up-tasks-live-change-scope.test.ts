import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import React from 'react';
import type { ReactNode } from 'react';
import { followUpTasks } from '../../src/routes/[lang]/aktivity/page.tsx';

const mocks = rstest.hoisted(() => ({ workRecords: rstest.fn() }));
rstest.mock('../../src/api/records-consumer.ts', () => ({ executeRecords: rstest.fn() }));
rstest.mock('@app/work-tasks/clients/records', () => ({ executeRecords: mocks.workRecords }));
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

const dispatchChange = (apps: ModuleChangeDetail['apps']) => {
  events.dispatchEvent(new CustomEvent<ModuleChangeDetail>(moduleChangeEvent, { detail: { apps } }));
};

beforeEach(() => {
  rstest.resetAllMocks();
  followUpTasks.invalidate();
  mocks.workRecords.mockReturnValue(Effect.succeed({ items: [] }));
});

it.live('live changes of apps the follow-up tasks do not show read nothing', () =>
  Effect.gen(function* unrelatedChange() {
    yield* followUpTasks.preload('company-a');
    const unsubscribe = followUpTasks.subscribe(() => {
      followUpTasks.snapshot('company-a');
    }, 'company-a');
    expect(mocks.workRecords).toHaveBeenCalledTimes(1);
    dispatchChange(['party-registry']);
    yield* Effect.sleep('10 millis');
    expect(mocks.workRecords).toHaveBeenCalledTimes(1);
    unsubscribe();
  }),
);

it.live('a live change of work-tasks reloads the mounted follow-up tasks', () =>
  Effect.gen(function* taskChange() {
    yield* followUpTasks.preload('company-a');
    const unsubscribe = followUpTasks.subscribe(() => {
      followUpTasks.snapshot('company-a');
    }, 'company-a');
    dispatchChange(['work-tasks']);
    yield* Effect.sleep('10 millis');
    expect(mocks.workRecords).toHaveBeenCalledTimes(2);
    unsubscribe();
  }),
);
