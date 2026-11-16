import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { afterAll, beforeAll, expect, it, rstest } from 'effect-rstest';

import { leaseInputOf, leaseRecords } from '../../src/routes/[lang]/najmy/lease-occupant.ts';

const { records } = rstest.hoisted(() => ({ records: rstest.fn() }));

rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: records }));
rstest.mock('@app/legal-agreements/clients/records', () => ({
  executeRecords: () => Effect.succeed({ contracts: [] }),
}));
rstest.mock('@app/property-portfolio/clients/records', () => ({
  executeRecords: () => Effect.succeed({ properties: [], units: [] }),
}));
rstest.mock('../../src/routes/[lang]/najmy/party-customers.ts', () => ({
  listCustomers: () => Effect.succeed([]),
}));

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

const input = leaseInputOf({ legalEntityId: 'company-a', principalId: 'manager-a', tenantId: 'tenant-a' });

const dispatchChange = (apps: ModuleChangeDetail['apps']) => {
  globalThis.dispatchEvent(new CustomEvent<ModuleChangeDetail>(moduleChangeEvent, { detail: { apps } }));
};

it.live('lease records ignore a live change from an app they do not show', () =>
  Effect.gen(function* unrelatedChange() {
    records.mockReset();
    records.mockReturnValue(Effect.succeed({ occupancies: [], revision: 1 }));
    const unsubscribe = leaseRecords.subscribe(() => {
      leaseRecords.snapshot(input);
    }, input);
    yield* leaseRecords.preload(input);
    expect(records).toHaveBeenCalledTimes(1);
    dispatchChange(['finance-billing']);
    yield* Effect.sleep('10 millis');
    expect(records).toHaveBeenCalledTimes(1);
    dispatchChange(['party-registry']);
    yield* Effect.sleep('10 millis');
    expect(records).toHaveBeenCalledTimes(2);
    unsubscribe();
  }),
);
