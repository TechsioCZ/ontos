// @rstest-environment happy-dom
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import {
  CounterpartyReadApi,
  CounterpartyReadForbiddenProblemSchema,
  CounterpartyReadResponseSchema,
} from '../../../party-registry/shared/apis/counterparty-read.ts';
import type {
  CounterpartyReadRequest,
  CounterpartyReadResponse,
} from '../../../party-registry/shared/apis/counterparty-read.ts';
import { PartyDetailApi, PartyDetailResponseSchema } from '../../../party-registry/shared/apis/party-detail.ts';
import type { PartyDetailRequest } from '../../../party-registry/shared/apis/party-detail.ts';
import { CustomerListApi } from '../../../party-registry/shared/apis/customer-list.ts';
import type { CustomerListRequest } from '../../../party-registry/shared/apis/customer-list.ts';
import {
  RecordsApi as PropertyRecordsApi,
  RecordsResponseSchema as PropertyRecordsResponseSchema,
} from '../../../property-portfolio/shared/apis/records.ts';
import {
  RecordsApi as AgreementRecordsApi,
  RecordsResponseSchema as AgreementRecordsResponseSchema,
} from '../../../legal-agreements/shared/apis/records.ts';
import { moduleChangeEvent, moduleWriteEvent, pageDataWorkEvent } from '@app/shared-contracts/page-data';
import type { PageDataWork } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Fiber, Schema } from 'effect';
import { afterAll, beforeEach, expect, it } from 'effect-rstest';
import {
  OccupancySchema,
  RecordsApi,
  RecordsForbiddenProblemSchema,
  RecordsResponseSchema,
} from '../../shared/apis/records.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import {
  leaseInputOf,
  leaseOccupant,
  leaseRecords,
  occupantKey,
  preloadLeaseOccupants,
  preloadPage,
} from '../../src/routes/[lang]/najmy/lease-occupant.ts';

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
const timestamp = '2026-10-01T00:00:00.000Z';
const partyRef = { moduleId: 'party.registry', resourceId: id(80), resourceType: 'party.registry.party', tenantId };
const tenantAnswer = (payload: CounterpartyReadRequest) =>
  Schema.decodeUnknownSync(CounterpartyReadResponseSchema)({
    ...payload,
    createdAt: timestamp,
    currentRoles: [],
    legalEntityRef: {
      moduleId: 'core.identity',
      resourceId: context.legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
    party: {
      archived: false,
      canonicalPartyRef: partyRef,
      displayName: 'Tenant',
      partyType: 'PERSON',
      storedPartyRef: partyRef,
    },
  });
const guestAnswer = ({ partyRef: ref }: PartyDetailRequest) =>
  Schema.decodeUnknownSync(PartyDetailResponseSchema)({
    currentFactAssertions: [],
    party: {
      archivedAt: null,
      businessName: null,
      createdAt: timestamp,
      displayName: 'Guest',
      firstName: null,
      lastName: null,
      partyRef: ref,
      partyType: 'PERSON',
      revision: 1,
      updatedAt: timestamp,
    },
    resolution: { aliasChain: [], canonicalPartyRef: ref, kind: 'DIRECT', requestedPartyRef: ref },
  });
const baseRecords = Schema.decodeUnknownSync(RecordsResponseSchema)({
  occupancies: [row(1), row(2, true), row(3, true)],
  revision: 7,
});
interface RecordedReads {
  counterparty: { correlation: string | undefined; payload: CounterpartyReadRequest }[];
  directory: CustomerListRequest[];
  guest: { correlation: string | undefined; payload: PartyDetailRequest }[];
}
const reads: RecordedReads = { counterparty: [], directory: [], guest: [] };
let counterpartyAnswer: (
  payload: CounterpartyReadRequest,
) => Effect.Effect<CounterpartyReadResponse, typeof CounterpartyReadForbiddenProblemSchema.Type> = (payload) =>
  Effect.succeed(tenantAnswer(payload));
let recordsAnswer: Effect.Effect<typeof RecordsResponseSchema.Type, typeof RecordsForbiddenProblemSchema.Type> =
  Effect.succeed(baseRecords);
const Counterparties = CounterpartyReadApi.prefix('/party-registry-api');
const Guests = PartyDetailApi.prefix('/party-registry-api');
const Customers = CustomerListApi.prefix('/party-registry-api');
const Properties = PropertyRecordsApi.prefix('/property-portfolio-api');
const Agreements = AgreementRecordsApi.prefix('/legal-agreements-api');
const Leases = RecordsApi.prefix('/property-leasing-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'legal-agreements': '/legal-agreements-api',
    'party-registry': '/party-registry-api',
    'property-leasing': '/property-leasing-api',
    'property-portfolio': '/property-portfolio-api',
  }).application,
  serveApi(
    Counterparties,
    HttpApiBuilder.group(Counterparties, 'counterpartyRead', (g) =>
      g.handle('execute', ({ payload, request }) =>
        Effect.gen(function* readTenant() {
          reads.counterparty.push({ correlation: request.headers['x-correlation-id'], payload });
          return yield* counterpartyAnswer(payload);
        }),
      ),
    ),
  ),
  serveApi(
    Guests,
    HttpApiBuilder.group(Guests, 'partyDetail', (g) =>
      g.handle('execute', ({ payload, request }) =>
        Effect.sync(() => {
          reads.guest.push({ correlation: request.headers['x-correlation-id'], payload });
          return guestAnswer(payload);
        }),
      ),
    ),
  ),
  serveApi(
    Customers,
    HttpApiBuilder.group(Customers, 'customerList', (g) =>
      g.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.directory.push(payload);
          return { items: [] };
        }),
      ),
    ),
  ),
  serveApi(
    Properties,
    HttpApiBuilder.group(Properties, 'records', (g) =>
      g.handle('execute', () =>
        Effect.succeed(
          Schema.decodeUnknownSync(PropertyRecordsResponseSchema)({
            assets: [],
            properties: [],
            revision: 7,
            units: [],
          }),
        ),
      ),
    ),
  ),
  serveApi(
    Agreements,
    HttpApiBuilder.group(Agreements, 'records', (g) =>
      g.handle('execute', () =>
        Effect.succeed(
          Schema.decodeUnknownSync(AgreementRecordsResponseSchema)({ contracts: [], documents: [], revision: 7 }),
        ),
      ),
    ),
  ),
  serveApi(
    Leases,
    HttpApiBuilder.group(Leases, 'records', (g) => g.handle('execute', () => recordsAnswer)),
  ),
);
afterAll(() => browserRuntime.dispose());
beforeEach(() => {
  reads.counterparty.length = 0;
  reads.directory.length = 0;
  reads.guest.length = 0;
  counterpartyAnswer = (payload) => Effect.succeed(tenantAnswer(payload));
  recordsAnswer = Effect.succeed(baseRecords);
  window.dispatchEvent(new Event(moduleChangeEvent));
});

it.live('base records settle without a full-table guest-identity burst', () =>
  Effect.gen(function* usefulBase() {
    yield* pinTestDocument;
    const current = yield* leaseRecords.read(input);
    expect(current.records.occupancies).toHaveLength(3);
    expect(reads.guest).toHaveLength(0);
    expect(reads.counterparty).toHaveLength(0);
  }).pipe(Effect.provide(network)),
);

it.live('warms only the current supplied rows through independently governed tenant and guest reads', () =>
  Effect.gen(function* warmsRows() {
    yield* pinTestDocument;
    yield* preloadLeaseOccupants(input, [row(2, true), row(1)], 7);
    expect(reads.guest).toContainEqual({
      correlation: expect.any(String),
      payload: { partyRef: row(2, true).guestPartyRef },
    });
    expect(reads.counterparty).toContainEqual({
      correlation: expect.any(String),
      payload: { counterpartyRef: row(1).customerCounterpartyRef },
    });
    expect(reads.guest).toHaveLength(1);
    expect(leaseOccupant.snapshot(detail(3, 7, true)).state).toBe('pending');
    expect(yield* leaseOccupant.read(detail(2, 7, true))).toBe('Guest');
    expect(reads.guest).toHaveLength(1);
  }).pipe(Effect.provide(network)),
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
    yield* pinTestDocument;
    yield* preloadLeaseOccupants(leaseInputOf(), [row(1)], 7);
    yield* preloadLeaseOccupants(leaseInputOf({ ...context, principalId: '' }), [row(1)], 7);
    yield* preloadLeaseOccupants(leaseInputOf({ ...context, tenantId: id(99) }), [row(1)], 7);
    expect(reads.counterparty).toHaveLength(0);
  }).pipe(Effect.provide(network)),
);

it.live('denied tenant access remains failed and retries without consulting the customer list', () =>
  Effect.gen(function* retriesDenied() {
    yield* pinTestDocument;
    counterpartyAnswer = (payload) =>
      reads.counterparty.length === 1
        ? Effect.fail(
            CounterpartyReadForbiddenProblemSchema.make({
              detail: 'Denied',
              status: 403,
              title: 'Forbidden',
              type: 'https://ontos.dev/problems/counterparty-read-forbidden',
            }),
          )
        : Effect.succeed(tenantAnswer(payload));
    yield* preloadLeaseOccupants(input, [row(1)], 7);
    expect(leaseOccupant.snapshot(detail(1)).state).toBe('failed');
    expect(yield* leaseOccupant.read(detail(1))).toBe('Tenant');
    expect(reads.counterparty).toHaveLength(2);
    expect(reads.directory).toHaveLength(0);
    expect(reads.guest).toHaveLength(0);
  }).pipe(Effect.provide(network)),
);

it.live('two background rows dedupe a foreground join and cancel queued rows without cancelling that join', () =>
  Effect.gen(function* cancelsRows() {
    yield* pinTestDocument;
    const started = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    const stopped = yield* Deferred.make<boolean>();
    let active = 0;
    let total = 0;
    // PageDataWork tracks the client load lifetime. Cancelling a fetch need not stop its server handler.
    const onWork = (event: CustomEvent<PageDataWork>) => {
      active += 1;
      event.detail.onSettled(() => {
        active -= 1;
        if (active === 1) {
          Deferred.doneUnsafe(stopped, Effect.succeed(true));
        }
      });
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => window.addEventListener(pageDataWorkEvent, onWork)),
      () => Effect.sync(() => window.removeEventListener(pageDataWorkEvent, onWork)),
    );
    counterpartyAnswer = (payload) =>
      Effect.gen(function* blockedTenant() {
        total += 1;
        if (total === 2) {
          yield* Deferred.succeed(started, true);
        }
        return yield* Deferred.await(release).pipe(Effect.as(tenantAnswer(payload)));
      });
    const background = yield* Effect.forkChild(preloadLeaseOccupants(input, [row(1), row(2), row(3)], 7));
    yield* Deferred.await(started);
    window.removeEventListener(pageDataWorkEvent, onWork);
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
  }).pipe(Effect.scoped, Effect.provide(network)),
);

it.live('live and settled-write invalidation discard the previous occupant with unchanged row revision', () =>
  Effect.gen(function* invalidates() {
    yield* pinTestDocument;
    yield* leaseOccupant.read(detail(1));
    for (const event of [moduleChangeEvent, moduleWriteEvent]) {
      window.dispatchEvent(new Event(event));
      expect(leaseOccupant.snapshot(detail(1)).state).toBe('pending');
      yield* leaseOccupant.read(detail(1));
    }
    expect(reads.counterparty).toHaveLength(3);
  }).pipe(Effect.provide(network)),
);

it.live('cold direct URLs prepare the exact authorized row and do not read unknown occupants', () =>
  Effect.gen(function* directPreload() {
    yield* pinTestDocument;
    yield* Effect.promise(() => preloadPage({ context, routeParams: {}, search: `?resourceId=${id(2)}` }));
    expect(leaseOccupant.snapshot(detail(2, 7, true)).state).toBe('ready');
    expect(reads.guest).toHaveLength(1);
    yield* Effect.promise(() => preloadPage({ context, routeParams: {}, search: `?resourceId=${id(99)}` }));
    expect(reads.guest).toHaveLength(1);
    expect(reads.counterparty).toHaveLength(0);
  }).pipe(Effect.provide(network)),
);

it.live('a denied primary refresh removes stale records and their write flag', () =>
  Effect.gen(function* deniedBase() {
    yield* pinTestDocument;
    yield* leaseRecords.read(input);
    recordsAnswer = Effect.fail(
      RecordsForbiddenProblemSchema.make({
        detail: 'Denied',
        status: 403,
        title: 'Forbidden',
        type: 'https://ontos.dev/problems/records-forbidden',
      }),
    );
    yield* leaseRecords.refresh(input);
    expect(leaseRecords.snapshot(input).state).toBe('failed');
    expect(leaseRecords.snapshot(input)).not.toHaveProperty('value');
  }).pipe(Effect.provide(network)),
);

it.live('caps speculative work at 200 rendered rows', () =>
  Effect.gen(function* boundsRows() {
    yield* pinTestDocument;
    yield* preloadLeaseOccupants(
      input,
      Array.from({ length: 202 }, (_, index) => row(index + 1)),
      9,
    );
    expect(reads.counterparty).toHaveLength(200);
    expect(leaseOccupant.snapshot(detail(201, 9)).state).toBe('pending');
  }).pipe(Effect.provide(network)),
);

it.live('an unrelated foreground row starts outside the two occupied background slots', () =>
  Effect.gen(function* foregroundPriority() {
    yield* pinTestDocument;
    const started = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    const foregroundStarted = yield* Deferred.make<boolean>();
    let total = 0;
    counterpartyAnswer = (payload) =>
      Effect.gen(function* blockedTenant() {
        total += 1;
        if (total === 2) {
          yield* Deferred.succeed(started, true);
        }
        if (total === 3) {
          yield* Deferred.succeed(foregroundStarted, true);
        }
        return yield* Deferred.await(release).pipe(Effect.as(tenantAnswer(payload)));
      });
    const background = yield* Effect.forkChild(preloadLeaseOccupants(input, [row(1), row(2), row(3)], 7));
    yield* Deferred.await(started);
    const foreground = yield* Effect.forkChild(leaseOccupant.read(detail(4)));
    yield* Deferred.await(foregroundStarted);
    expect(total).toBe(3);
    yield* Fiber.interrupt(background);
    yield* Deferred.succeed(release, true);
    expect(yield* Fiber.join(foreground)).toBe('Tenant');
    expect(total).toBe(3);
  }).pipe(Effect.provide(network)),
);

it('does not reuse incomplete context across mounts or partial identity changes', () => {
  const missing = leaseInputOf(undefined, 'mount-a');
  expect(leaseRecords.key(leaseInputOf(undefined, 'mount-b'))).not.toBe(leaseRecords.key(missing));
  expect(leaseRecords.key(leaseInputOf({ ...context, principalId: '' }, 'mount-a'))).not.toBe(
    leaseRecords.key(missing),
  );
});
