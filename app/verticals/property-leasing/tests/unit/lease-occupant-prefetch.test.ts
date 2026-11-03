import { moduleChangeEvent, moduleWriteEvent } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Fiber, Option, Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import { OccupancySchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import {
  leaseInputOf,
  leaseOccupant,
  leaseRecords,
  occupantKey,
  preloadLeaseOccupants,
  preloadPage,
  renderedLeaseOccupantRows,
} from '../../src/routes/[lang]/najmy/lease-occupant.ts';

const { reads } = rstest.hoisted(() => ({
  reads: {
    agreements: rstest.fn(),
    counterparty: rstest.fn(),
    directory: rstest.fn(),
    guest: rstest.fn(),
    properties: rstest.fn(),
    records: rstest.fn(),
  },
}));
rstest.mock('@app/party-registry/api/client', () => ({
  executeCounterpartyRead: reads.counterparty,
  executePartyDetail: reads.guest,
  listCustomers: reads.directory,
}));
rstest.mock('@app/property-portfolio/clients/records', () => ({ executeRecords: reads.properties }));
rstest.mock('@app/legal-agreements/clients/records', () => ({ executeRecords: reads.agreements }));
rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: reads.records }));
const tenantId = '70000000-0000-4000-8000-000000000020';
const id = (index: number) => `76000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const context = { legalEntityId: id(90), principalId: id(91), tenantId };
const input = leaseInputOf(context);
const row = (index: number, guest = false) =>
  Schema.decodeSync(OccupancySchema)({
    contractRef: null,
    customerCounterpartyRef: guest
      ? null
      : {
          moduleId: 'party.registry',
          resourceId: id(index + 10),
          resourceType: 'party.registry.counterparty',
          tenantId,
        },
    endDate: null,
    externalBookingCorrelation: null,
    guestPartyRef: guest
      ? { moduleId: 'party.registry', resourceId: id(index + 20), resourceType: 'party.registry.party', tenantId }
      : null,
    kind: guest ? 'SHORT_STAY' : 'LONG_TERM_LEASE',
    note: null,
    occupancyRef: {
      moduleId: 'property.leasing',
      resourceId: id(index),
      resourceType: 'property.leasing.occupancy',
      tenantId,
    },
    peopleCount: null,
    startDate: '2026-10-01',
    state: 'ACTIVE',
    unitRef: {
      moduleId: 'property.portfolio',
      resourceId: id(index + 30),
      resourceType: 'property.portfolio.unit',
      tenantId,
    },
  });
const detail = (index: number, revision = 7, guest = false) => ({ ...input, record: row(index, guest), revision });
const events = new EventTarget();
beforeAll(() => {
  rstest.stubGlobal('document', {});
  rstest.stubGlobal('addEventListener', events.addEventListener.bind(events));
  rstest.stubGlobal('removeEventListener', events.removeEventListener.bind(events));
  rstest.stubGlobal('dispatchEvent', events.dispatchEvent.bind(events));
});
afterAll(() => {
  rstest.unstubAllGlobals();
  return browserRuntime.dispose();
});
beforeEach(() => {
  rstest.resetAllMocks();
  reads.counterparty.mockReturnValue(Effect.succeed({ party: { displayName: 'Tenant' } }));
  reads.guest.mockReturnValue(Effect.succeed({ party: { displayName: Option.some('Guest') } }));
  reads.directory.mockReturnValue(Effect.succeed([]));
  reads.properties.mockReturnValue(Effect.succeed({ properties: [], units: [] }));
  reads.agreements.mockReturnValue(Effect.succeed({ contracts: [] }));
  reads.records.mockReturnValue(
    Effect.succeed(
      Schema.decodeSync(RecordsResponseSchema)({ occupancies: [row(1), row(2, true), row(3, true)], revision: 7 }),
    ),
  );
  globalThis.dispatchEvent(new Event(moduleChangeEvent));
});

it.live('base records settle without a full-table guest-identity burst', () =>
  Effect.gen(function* usefulBase() {
    const current = yield* leaseRecords.read(input);
    expect(current.records.occupancies).toHaveLength(3);
    expect(reads.guest).not.toHaveBeenCalled();
    expect(reads.counterparty).not.toHaveBeenCalled();
  }),
);

it.live('warms only the current supplied rows through independently governed tenant and guest reads', () =>
  Effect.gen(function* warmsRows() {
    yield* preloadLeaseOccupants(input, [row(2, true), row(1)], 7);
    expect(reads.guest).toHaveBeenCalledWith({ partyRef: row(2, true).guestPartyRef }, expect.any(String));
    expect(reads.counterparty).toHaveBeenCalledWith(
      { counterpartyRef: row(1).customerCounterpartyRef },
      expect.any(String),
    );
    expect(reads.guest).toHaveBeenCalledTimes(1);
    expect(leaseOccupant.snapshot(detail(3, 7, true)).state).toBe('pending');
    expect(yield* leaseOccupant.read(detail(2, 7, true))).toBe('Guest');
    expect(reads.guest).toHaveBeenCalledTimes(1);
  }),
);

it('keys actual revision, occupant reference and full tenant/principal/company/module identity', () => {
  const original = occupantKey(detail(1));
  for (const field of ['tenantId', 'principalId', 'legalEntityId'] as const) {
    const changed = leaseInputOf({ ...context, [field]: id(99) });
    expect(leaseRecords.key(changed)).not.toBe(leaseRecords.key(input));
    expect(occupantKey({ ...detail(1), ...changed })).not.toBe(original);
  }
  expect(occupantKey(detail(1, 8))).not.toBe(original);
  expect(occupantKey(detail(1, 7, true))).not.toBe(original);
  expect(original).toContain('property.leasing');
});

it.live('missing context and cross-tenant rows never enter the reusable background cache', () =>
  Effect.gen(function* noScopeReuse() {
    yield* preloadLeaseOccupants(leaseInputOf(), [row(1)], 7);
    yield* preloadLeaseOccupants(leaseInputOf({ ...context, principalId: '' }), [row(1)], 7);
    yield* preloadLeaseOccupants(leaseInputOf({ ...context, tenantId: id(99) }), [row(1)], 7);
    expect(reads.counterparty).not.toHaveBeenCalled();
  }),
);

it.live('denied tenant access remains failed and retries without consulting the customer list', () =>
  Effect.gen(function* retriesDenied() {
    reads.counterparty.mockReturnValueOnce(Effect.fail({ _tag: 'CounterpartyReadForbiddenProblem', status: 403 }));
    yield* preloadLeaseOccupants(input, [row(1)], 7);
    expect(leaseOccupant.snapshot(detail(1)).state).toBe('failed');
    expect(yield* leaseOccupant.read(detail(1))).toBe('Tenant');
    expect(reads.counterparty).toHaveBeenCalledTimes(2);
    expect(reads.directory).not.toHaveBeenCalled();
    expect(reads.guest).not.toHaveBeenCalled();
  }),
);

it.live('two background rows dedupe a foreground join and cancel queued rows without cancelling that join', () =>
  Effect.gen(function* cancelsRows() {
    const started = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    const stopped = yield* Deferred.make<boolean>();
    let active = 0;
    let total = 0;
    reads.counterparty.mockImplementation(() =>
      Effect.gen(function* blockedTenant() {
        active += 1;
        total += 1;
        if (total === 2) {
          yield* Deferred.succeed(started, true);
        }
        return yield* Deferred.await(release).pipe(Effect.as({ party: { displayName: 'Tenant' } }));
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            active -= 1;
            if (active === 1) {
              Deferred.doneUnsafe(stopped, Effect.succeed(true));
            }
          }),
        ),
      ),
    );
    const background = yield* Effect.forkChild(preloadLeaseOccupants(input, [row(1), row(2), row(3)], 7));
    yield* Deferred.await(started);
    expect(active).toBe(2);
    const foreground = yield* Effect.forkChild(leaseOccupant.read(detail(1)));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(background);
    yield* Deferred.await(stopped);
    expect(active).toBe(1);
    expect(total).toBe(2);
    yield* Deferred.succeed(release, true);
    expect(yield* Fiber.join(foreground)).toBe('Tenant');
    expect(total).toBe(2);
  }),
);

it.live('live and settled-write invalidation discard the previous occupant with unchanged row revision', () =>
  Effect.gen(function* invalidates() {
    yield* leaseOccupant.read(detail(1));
    for (const event of [moduleChangeEvent, moduleWriteEvent]) {
      globalThis.dispatchEvent(new Event(event));
      expect(leaseOccupant.snapshot(detail(1)).state).toBe('pending');
      yield* leaseOccupant.read(detail(1));
    }
    expect(reads.counterparty).toHaveBeenCalledTimes(3);
  }),
);

it.live('cold direct URLs prepare the exact authorized row and do not read unknown occupants', () =>
  Effect.gen(function* directPreload() {
    yield* Effect.promise(() => preloadPage({ context, routeParams: {}, search: `?resourceId=${id(2)}` }));
    expect(leaseOccupant.snapshot(detail(2, 7, true)).state).toBe('ready');
    expect(reads.guest).toHaveBeenCalledTimes(1);
    yield* Effect.promise(() => preloadPage({ context, routeParams: {}, search: `?resourceId=${id(99)}` }));
    expect(reads.guest).toHaveBeenCalledTimes(1);
    expect(reads.counterparty).not.toHaveBeenCalled();
  }),
);

it.live('a denied primary refresh removes stale records and their write flag', () =>
  Effect.gen(function* deniedBase() {
    yield* leaseRecords.read(input);
    reads.records.mockReturnValue(Effect.fail({ _tag: 'RecordsForbiddenProblem' }));
    yield* leaseRecords.refresh(input);
    expect(leaseRecords.snapshot(input).state).toBe('failed');
    expect(leaseRecords.snapshot(input)).not.toHaveProperty('value');
  }),
);

it.live('caps speculative work at 200 rendered rows', () =>
  Effect.gen(function* boundsRows() {
    yield* preloadLeaseOccupants(
      input,
      Array.from({ length: 202 }, (_, index) => row(index + 1)),
      9,
    );
    expect(reads.counterparty).toHaveBeenCalledTimes(200);
    expect(leaseOccupant.snapshot(detail(201, 9)).state).toBe('pending');
  }),
);

it.live('an unrelated foreground row starts outside the two occupied background slots', () =>
  Effect.gen(function* foregroundPriority() {
    const started = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    const foregroundStarted = yield* Deferred.make<boolean>();
    let total = 0;
    reads.counterparty.mockImplementation(() =>
      Effect.gen(function* blockedTenant() {
        total += 1;
        if (total === 2) {
          yield* Deferred.succeed(started, true);
        }
        if (total === 3) {
          yield* Deferred.succeed(foregroundStarted, true);
        }
        return yield* Deferred.await(release).pipe(Effect.as({ party: { displayName: 'Tenant' } }));
      }),
    );
    const background = yield* Effect.forkChild(preloadLeaseOccupants(input, [row(1), row(2), row(3)], 7));
    yield* Deferred.await(started);
    const foreground = yield* Effect.forkChild(leaseOccupant.read(detail(4)));
    yield* Deferred.await(foregroundStarted);
    expect(total).toBe(3);
    yield* Fiber.interrupt(background);
    yield* Deferred.succeed(release, true);
    expect(yield* Fiber.join(foreground)).toBe('Tenant');
    expect(total).toBe(3);
  }),
);

it('does not reuse incomplete context across mounts or partial identity changes', () => {
  const missing = leaseInputOf(undefined, 'mount-a');
  expect(leaseRecords.key(leaseInputOf(undefined, 'mount-b'))).not.toBe(leaseRecords.key(missing));
  expect(leaseRecords.key(leaseInputOf({ ...context, principalId: '' }, 'mount-a'))).not.toBe(
    leaseRecords.key(missing),
  );
});

it('does not warm hidden table rows on lease or counterparty detail URLs', () => {
  const visible = [row(1), row(2)];
  expect(renderedLeaseOccupantRows(undefined, undefined, visible)).toEqual(visible);
  expect(renderedLeaseOccupantRows(id(1), undefined, visible)).toEqual([]);
  expect(renderedLeaseOccupantRows(undefined, id(1), visible)).toEqual([]);
});
