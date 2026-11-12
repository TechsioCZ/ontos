import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { afterAll, beforeAll, expect, it, rstest } from 'effect-rstest';

import { employeeTagsData } from '../../src/routes/[lang]/prodej/zamestnanci/employees-data.ts';

const { tagRecords } = rstest.hoisted(() => ({ tagRecords: rstest.fn() }));

rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: rstest.fn() }));
rstest.mock('@app/tagging/clients/records', () => ({ recordsOfKind: tagRecords }));

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

// Employee tags come from the tagging module; a change of another module must not re-read them.
it.live('employee tags reload on tagging changes only', () =>
  Effect.gen(function* scopedEmployeeTags() {
    tagRecords.mockReset();
    tagRecords.mockReturnValue(Effect.succeed({ assignments: [], tags: [] }));
    yield* employeeTagsData.preload('company-a');
    expect(tagRecords).toHaveBeenCalledTimes(1);
    const unsubscribe = employeeTagsData.subscribe(() => {
      employeeTagsData.snapshot('company-a');
    });
    events.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: ['party-registry'] } }));
    yield* Effect.sleep('10 millis');
    expect(tagRecords).toHaveBeenCalledTimes(1);
    events.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: ['tagging'] } }));
    yield* Effect.sleep('10 millis');
    expect(tagRecords).toHaveBeenCalledTimes(2);
    unsubscribe();
  }),
);
