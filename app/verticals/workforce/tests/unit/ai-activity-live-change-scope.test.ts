import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { afterAll, beforeAll, expect, it, rstest } from 'effect-rstest';

import { aiActivityData } from '../../src/routes/[lang]/prodej/zamestnanci/employees-data.ts';

const { records } = rstest.hoisted(() => ({ records: rstest.fn() }));

rstest.mock('../../src/api/records-consumer.ts', () => ({ executeRecords: records }));

const events = new EventTarget();
const browserGlobals = {
  addEventListener: events.addEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
};

beforeAll(() => {
  for (const [name, value] of Object.entries(browserGlobals)) {
    Reflect.set(globalThis, name, value);
  }
  Reflect.set(globalThis, 'document', {});
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'document');
  for (const name of Object.keys(browserGlobals)) {
    Reflect.deleteProperty(globalThis, name);
  }
});

// The AI activity feed is workforce data; a change committed by another module must not re-read it.
it.live('AI activity reloads on workforce changes only', () =>
  Effect.gen(function* scopedAiActivity() {
    records.mockReset();
    records.mockReturnValue(Effect.succeed({ aiActivity: [] }));
    yield* aiActivityData.preload('company-a');
    expect(records).toHaveBeenCalledTimes(1);
    const unsubscribe = aiActivityData.subscribe(() => {
      aiActivityData.snapshot('company-a');
    });
    events.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: ['tagging'] } }));
    yield* Effect.sleep('10 millis');
    expect(records).toHaveBeenCalledTimes(1);
    events.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: ['workforce'] } }));
    yield* Effect.sleep('10 millis');
    expect(records).toHaveBeenCalledTimes(2);
    unsubscribe();
  }),
);
