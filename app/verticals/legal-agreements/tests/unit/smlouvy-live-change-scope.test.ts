import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { Effect } from 'effect';
import { afterAll, beforeAll, expect, it, rstest } from 'effect-rstest';
import type { Contract } from '../../shared/apis/records.ts';
import { agreementCustomerData } from '../../src/routes/[lang]/smlouvy/agreements-data.ts';

const mocks = rstest.hoisted(() => ({ counterparty: rstest.fn() }));

rstest.mock('@app/party-registry/api/client', () => ({ executeCounterpartyRead: mocks.counterparty }));
rstest.mock('@app/property-portfolio/clients/records', () => ({ executeRecords: () => Effect.fail('unused') }));
rstest.mock('@app/property-leasing/clients/records', () => ({ executeRecords: () => Effect.fail('unused') }));
rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: () => Effect.fail('unused') }));

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

const tenantId = '11111111-1111-4111-8111-111111111111';
const contract: Contract = {
  contractRef: {
    moduleId: 'legal.agreements',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'legal.agreements.contract',
    tenantId,
  },
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  endDate: '2027-10-05',
  kind: 'LEASE',
  lifecycleState: 'ACTIVE',
  note: null,
  occupancyRef: null,
  propertyRef: null,
  renewalNoticeDate: null,
  rentTerms: { currency: 'CZK', monthlyRentMinor: 1_850_000, paymentDay: 15, serviceChargesMinor: 250_050 },
  responsiblePerson: 'Jana Nováková',
  signatureState: 'SIGNED',
  startDate: '2026-10-05',
  subject: 'Nájem kanceláře',
  supersedesContractRef: null,
  unitRef: null,
};
const input = { contract, revision: 1, scope: 'live-change-scope-test' };

const liveChange = (apps: readonly string[]) =>
  Effect.sync(() => globalThis.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps } })));

it.live('a counterparty name reloads only when a module it shows changed', () =>
  Effect.gen(function* counterpartyScope() {
    mocks.counterparty.mockImplementation(() => Effect.succeed({ party: { displayName: 'Acme' } }));
    yield* agreementCustomerData.read(input).pipe(Effect.ignore);
    // The page's hook reads the snapshot on every notification, which is what makes the key observed.
    const unsubscribe = agreementCustomerData.subscribe(() => {
      agreementCustomerData.snapshot(input);
    }, input);
    const before = mocks.counterparty.mock.calls.length;

    yield* liveChange(['property-leasing', 'merchandise']);
    yield* Effect.sleep('10 millis');
    expect(mocks.counterparty.mock.calls.length).toBe(before);

    yield* liveChange(['party-registry']);
    yield* Effect.sleep('100 millis');
    expect(mocks.counterparty.mock.calls.length).toBe(before + 1);

    unsubscribe();
  }),
);
