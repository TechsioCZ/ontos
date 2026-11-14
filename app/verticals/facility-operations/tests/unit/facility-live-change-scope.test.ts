import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { afterAll, beforeAll, expect, it, rstest } from 'effect-rstest';

import { agendaRecordsData } from '../../src/ui/use-agenda.ts';

const { records } = rstest.hoisted(() => ({ records: rstest.fn() }));

rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: records }));

// The store only works in a document; Node gets the few window members it uses.
const events = new EventTarget();
const browserGlobals = {
  addEventListener: events.addEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  document: {},
  removeEventListener: events.removeEventListener.bind(events),
};
beforeAll(() => {
  for (const [name, value] of Object.entries(browserGlobals)) {
    Reflect.set(globalThis, name, value);
  }
});
afterAll(() => {
  for (const name of Object.keys(browserGlobals)) {
    Reflect.deleteProperty(globalThis, name);
  }
});

const dispatchChange = (apps: ModuleChangeDetail['apps']) => {
  globalThis.dispatchEvent(new CustomEvent<ModuleChangeDetail>(moduleChangeEvent, { detail: { apps } }));
};

it.live('agenda records ignore a live change from another vertical', () =>
  Effect.gen(function* unrelatedChange() {
    records.mockReset();
    records.mockReturnValue(Effect.succeed({ access: [], agendas: {} }));
    const agendas = ['assets'] as const;
    const unsubscribe = agendaRecordsData.subscribe(() => {
      agendaRecordsData.snapshot(agendas);
    }, agendas);
    yield* agendaRecordsData.preload(agendas);
    expect(records).toHaveBeenCalledTimes(1);
    dispatchChange(['work-tasks']);
    yield* Effect.sleep('10 millis');
    expect(records).toHaveBeenCalledTimes(1);
    dispatchChange(['facility-operations']);
    yield* Effect.sleep('10 millis');
    expect(records).toHaveBeenCalledTimes(2);
    unsubscribe();
  }),
);
