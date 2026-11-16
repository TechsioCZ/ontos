import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { afterAll, beforeAll, expect, it, rstest } from 'effect-rstest';

import { propertyRecords, recordsInput } from '../../src/routes/[lang]/nemovitosti/property-summary.ts';

const { records } = rstest.hoisted(() => ({ records: rstest.fn() }));

rstest.mock('../../src/api/records-client', () => ({ executeRecords: records }));
rstest.mock('@app/workforce/clients/records', () => ({ executeRecords: () => Effect.succeed({ items: [] }) }));

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

const input = recordsInput({ legalEntityId: 'company-a', principalId: 'manager-a', tenantId: 'tenant-a' });

const dispatchChange = (apps: ModuleChangeDetail['apps']) => {
  globalThis.dispatchEvent(new CustomEvent<ModuleChangeDetail>(moduleChangeEvent, { detail: { apps } }));
};

it.live('the property register ignores a live change from an app it does not show', () =>
  Effect.gen(function* unrelatedChange() {
    records.mockReset();
    records.mockReturnValue(Effect.succeed({ properties: [], revision: 1 }));
    const unsubscribe = propertyRecords.subscribe(() => {
      propertyRecords.snapshot(input);
    }, input);
    yield* propertyRecords.preload(input);
    expect(records).toHaveBeenCalledTimes(1);
    dispatchChange(['property-leasing']);
    yield* Effect.sleep('10 millis');
    expect(records).toHaveBeenCalledTimes(1);
    dispatchChange(['workforce']);
    yield* Effect.sleep('10 millis');
    expect(records).toHaveBeenCalledTimes(2);
    unsubscribe();
  }),
);
