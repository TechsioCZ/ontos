import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import type { ReactNode } from 'react';
import { taskRecords } from '../../src/routes/[lang]/ukoly/page.tsx';

const mocks = rstest.hoisted(() => ({ records: rstest.fn() }));
rstest.mock('../../src/api/records-consumer.ts', () => ({ executeRecords: mocks.records }));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({ useRouterState: () => '' }));
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
  for (const [key, value] of Object.entries(globals)) {
    Reflect.set(globalThis, key, value);
  }
});
afterAll(() => {
  for (const key of Object.keys(globals)) {
    Reflect.deleteProperty(globalThis, key);
  }
});

// oxlint-disable-next-line sonarjs/no-undefined-assignment -- The task list input models an absent party filter.
const input = { includeArchived: false, legalEntityId: 'company-a', partyId: undefined };

const dispatchChange = (apps: ModuleChangeDetail['apps']) => {
  events.dispatchEvent(new CustomEvent<ModuleChangeDetail>(moduleChangeEvent, { detail: { apps } }));
};

beforeEach(() => {
  rstest.resetAllMocks();
  taskRecords.invalidate();
  mocks.records.mockReturnValue(Effect.succeed({ revision: 1 }));
});

it.live('live changes of apps the task list does not show read nothing', () =>
  Effect.gen(function* unrelatedChange() {
    yield* taskRecords.preload(input);
    const unsubscribe = taskRecords.subscribe(() => {
      taskRecords.snapshot(input);
    }, input);
    expect(mocks.records).toHaveBeenCalledTimes(1);
    dispatchChange(['merchandise']);
    yield* Effect.sleep('10 millis');
    expect(mocks.records).toHaveBeenCalledTimes(1);
    unsubscribe();
  }),
);

// The read includes assignable principals and principal names, which Core identity changes ('shell') alter.
it.live('a Core identity change reloads the mounted task list at once', () =>
  Effect.gen(function* identityChange() {
    yield* taskRecords.preload(input);
    const unsubscribe = taskRecords.subscribe(() => {
      taskRecords.snapshot(input);
    }, input);
    dispatchChange(['shell']);
    yield* Effect.sleep('10 millis');
    expect(mocks.records).toHaveBeenCalledTimes(2);
    unsubscribe();
  }),
);
