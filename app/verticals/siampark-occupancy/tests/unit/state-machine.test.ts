import { describe, expect, it } from 'effect-rstest';
import { Effect, Exit, Schema } from 'effect';

import { OccupancySchema } from '../../shared/apis/records.ts';
import type { Occupancy, OccupancyState } from '../../shared/apis/records.ts';
import {
  occupancyPeriodsOverlap,
  transitionOccupancy,
  unavailableOccupancyValidators,
} from '../../src/services/persistence.service.ts';
import type { OccupancyValidators } from '../../src/services/persistence.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const scope = { legalEntityId, tenantId };
const unitRef = {
  moduleId: 'siampark.property',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'siampark.property.unit',
  tenantId,
} as const;
const customerCounterpartyRef = {
  moduleId: 'party.registry',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const occupancyRef = {
  moduleId: 'siampark.occupancy',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'siampark.occupancy.occupancy',
  tenantId,
} as const;
const contractRef = {
  moduleId: 'siampark.agreements',
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'siampark.agreements.contract',
  tenantId,
} as const;
const draft: Occupancy = {
  contractRef: null,
  customerCounterpartyRef,
  endDate: '2027-10-05',
  externalBookingCorrelation: null,
  guestPartyRef: null,
  kind: 'LONG_TERM_LEASE',
  note: null,
  occupancyRef,
  peopleCount: null,
  startDate: '2026-10-05',
  state: 'DRAFT',
  unitRef,
};
const empty: OccupancyState = { bookingObservations: [], occupancies: [] };
const validators: OccupancyValidators = {
  contract: (ref) =>
    Effect.succeed({
      contractRef: ref,
      counterpartyRef: customerCounterpartyRef,
      endDate: '2027-10-05',
      kind: 'LEASE',
      lifecycleState: 'ACTIVE',
      startDate: '2026-10-05',
      unitRef,
    }),
  counterparty: (ref) => Effect.succeed({ activeCustomer: true, archived: false, counterpartyRef: ref, legalEntityId }),
  guest: (ref) => Effect.succeed({ archived: false, partyRef: ref }),
  unit: (ref) => Effect.succeed({ legalEntityId, lifecycleState: 'ACTIVE', unitRef: ref }),
};
const rejected = <Success, Failure>(effect: Effect.Effect<Success, Failure>) =>
  Effect.exit(effect).pipe(Effect.tap((exit) => Effect.sync(() => expect(Exit.isFailure(exit)).toBe(true))));

describe('Occupancy state transitions', () => {
  it.effect('edits only a draft period and preserves its customer, unit and lifecycle anchors', () =>
    Effect.gen(function* editsDraftPeriod() {
      const created = yield* transitionOccupancy(empty, { _tag: 'CreateDraft', record: draft }, scope, validators);
      const edited = yield* transitionOccupancy(
        created.snapshot,
        { _tag: 'UpdateDraft', endDate: '2027-11-05', occupancyRef, startDate: '2026-11-05' },
        scope,
        validators,
      );
      expect(edited.snapshot.occupancies).toEqual([{ ...draft, endDate: '2027-11-05', startDate: '2026-11-05' }]);
      expect(created.snapshot.occupancies).toEqual([draft]);
      yield* rejected(
        transitionOccupancy(
          edited.snapshot,
          { _tag: 'UpdateDraft', endDate: '2026-11-05', occupancyRef, startDate: '2026-11-05' },
          scope,
          validators,
        ),
      );
      yield* rejected(
        transitionOccupancy(
          edited.snapshot,
          {
            _tag: 'UpdateDraft',
            endDate: null,
            occupancyRef: { ...occupancyRef, tenantId: legalEntityId },
            startDate: '2026-11-05',
          },
          scope,
          validators,
        ),
      );
      const confirmed = yield* transitionOccupancy(
        edited.snapshot,
        { _tag: 'Confirm', occupancyRef },
        scope,
        validators,
      );
      yield* rejected(
        transitionOccupancy(
          confirmed.snapshot,
          { _tag: 'UpdateDraft', endDate: null, occupancyRef, startDate: '2026-12-05' },
          scope,
          validators,
        ),
      );
      expect(confirmed.snapshot.occupancies[0]?.state).toBe('CONFIRMED');
    }),
  );
  it.effect('creates, confirms and activates a lease only with its covering active Contract', () =>
    Effect.gen(function* testEffect() {
      const created = yield* transitionOccupancy(empty, { _tag: 'CreateDraft', record: draft }, scope, validators);
      const confirmed = yield* transitionOccupancy(
        created.snapshot,
        { _tag: 'Confirm', occupancyRef },
        scope,
        validators,
      );
      yield* rejected(
        transitionOccupancy(
          confirmed.snapshot,
          { _tag: 'Activate', contractRef: null, occupancyRef },
          scope,
          validators,
        ),
      );
      const active = yield* transitionOccupancy(
        confirmed.snapshot,
        { _tag: 'Activate', contractRef, occupancyRef },
        scope,
        validators,
      );
      expect(active.snapshot.occupancies[0]?.state).toBe('ACTIVE');
      expect(active.snapshot.occupancies[0]?.contractRef).toEqual(contractRef);
    }),
  );
  it.effect('uses half-open periods and rejects overlapping confirmed or active occupancies', () =>
    Effect.gen(function* testEffect() {
      expect(
        occupancyPeriodsOverlap(
          { endDate: '2026-10-10', startDate: '2026-10-05' },
          { endDate: '2026-10-12', startDate: '2026-10-10' },
        ),
      ).toBe(false);
      expect(
        occupancyPeriodsOverlap({ endDate: null, startDate: '2026-10-05' }, { endDate: null, startDate: '2027-01-01' }),
      ).toBe(true);
      const other = {
        ...draft,
        occupancyRef: { ...occupancyRef, resourceId: '77777777-7777-4777-8777-777777777777' },
        state: 'ACTIVE' as const,
      };
      yield* rejected(
        transitionOccupancy(
          { ...empty, occupancies: [draft, other] },
          { _tag: 'Confirm', occupancyRef },
          scope,
          validators,
        ),
      );
      const adjacent = { ...other, endDate: draft.startDate, startDate: '2026-01-01' };
      const accepted = yield* transitionOccupancy(
        { ...empty, occupancies: [draft, adjacent] },
        { _tag: 'Confirm', occupancyRef },
        scope,
        validators,
      );
      expect(accepted.snapshot.occupancies[0]?.state).toBe('CONFIRMED');
    }),
  );
  it.effect('rejects cross-tenant refs, wrong legal entity, unusable Unit and missing provider validation', () =>
    Effect.gen(function* testEffect() {
      yield* rejected(
        transitionOccupancy(
          empty,
          { _tag: 'CreateDraft', record: { ...draft, unitRef: { ...unitRef, tenantId: legalEntityId } } },
          scope,
          validators,
        ),
      );
      yield* rejected(
        transitionOccupancy(empty, { _tag: 'CreateDraft', record: draft }, scope, {
          ...validators,
          unit: (ref) => Effect.succeed({ legalEntityId: tenantId, lifecycleState: 'ACTIVE', unitRef: ref }),
        }),
      );
      yield* rejected(
        transitionOccupancy(empty, { _tag: 'CreateDraft', record: draft }, scope, {
          ...validators,
          unit: (ref) => Effect.succeed({ legalEntityId, lifecycleState: 'OUT_OF_SERVICE', unitRef: ref }),
        }),
      );
      yield* rejected(
        transitionOccupancy(empty, { _tag: 'CreateDraft', record: draft }, scope, unavailableOccupancyValidators),
      );
    }),
  );
  it.effect('rejects inactive, wrong-customer and shorter contracts on activation', () =>
    Effect.gen(function* testEffect() {
      const state = { ...empty, occupancies: [{ ...draft, state: 'CONFIRMED' as const }] };
      for (const change of [
        { lifecycleState: 'DRAFT' as const },
        { endDate: '2026-11-01' },
        { counterpartyRef: { ...customerCounterpartyRef, resourceId: '77777777-7777-4777-8777-777777777777' } },
      ]) {
        yield* rejected(
          transitionOccupancy(state, { _tag: 'Activate', contractRef, occupancyRef }, scope, {
            ...validators,
            contract: (ref) => validators.contract(ref).pipe(Effect.map((record) => ({ ...record, ...change }))),
          }),
        );
      }
    }),
  );
  it.effect('records a simulated failed booking and retry correlation without inventing a booking master', () =>
    Effect.gen(function* testEffect() {
      const guestPartyRef = {
        moduleId: 'party.registry',
        resourceId: '77777777-7777-4777-8777-777777777777',
        resourceType: 'party.registry.party',
        tenantId,
      } as const;
      const record: Occupancy = {
        ...draft,
        customerCounterpartyRef: null,
        endDate: '2026-10-10',
        guestPartyRef,
        kind: 'SHORT_STAY',
        peopleCount: 2,
        state: 'CONFIRMED',
      };
      const observationId = '88888888-8888-4888-8888-888888888888';
      const failed = yield* transitionOccupancy(
        empty,
        { _tag: 'ImportBooking', correlation: 'booking:A103', observationId, outcome: 'FAILED', record },
        scope,
        validators,
      );
      expect(failed.snapshot.occupancies).toEqual([]);
      expect(failed.resourceRef).toBeNull();
      expect(failed.snapshot.bookingObservations[0]).toMatchObject({
        integrationKind: 'BOOKING',
        observationId,
        occupancyRef: null,
        ownerResourceRef: record.unitRef,
        providerLabel: 'DEMO',
      });
      expect(failed.snapshot.bookingObservations[0]?.attemptedAt).toBe(
        failed.snapshot.bookingObservations[0]?.completedAt,
      );
      expect(failed.snapshot.bookingObservations[0]?.resultSummary).toContain('SIMULATED: FAILED');
      yield* rejected(
        transitionOccupancy(
          failed.snapshot,
          {
            _tag: 'RetryBooking',
            observationId,
            record: { ...record, unitRef: { ...record.unitRef, resourceId: '99999999-9999-4999-8999-999999999999' } },
          },
          scope,
          validators,
        ),
      );
      yield* rejected(
        transitionOccupancy(
          empty,
          { _tag: 'ImportBooking', correlation: 'booking:unavailable', observationId, outcome: 'FAILED', record },
          scope,
          unavailableOccupancyValidators,
        ),
      );
      const conflicting = yield* transitionOccupancy(
        {
          ...empty,
          occupancies: [
            { ...record, occupancyRef: { ...record.occupancyRef, resourceId: '99999999-9999-4999-8999-999999999999' } },
          ],
        },
        { _tag: 'ImportBooking', correlation: 'booking:conflict', observationId, outcome: 'SUCCESS', record },
        scope,
        validators,
      );
      expect(conflicting.snapshot.occupancies).toHaveLength(1);
      expect(conflicting.snapshot.bookingObservations[0]).toMatchObject({
        occupancyRef: null,
        ownerResourceRef: unitRef,
        state: 'CONFLICT',
      });
      const retried = yield* transitionOccupancy(
        failed.snapshot,
        { _tag: 'RetryBooking', observationId, record },
        scope,
        validators,
      );
      expect(retried.snapshot.bookingObservations[0]).toMatchObject({
        attempts: 2,
        correlation: 'booking:A103',
        mode: 'SIMULATED',
        observationId,
        ownerResourceRef: record.occupancyRef,
        state: 'SUCCESS',
      });
      expect(retried.snapshot.occupancies[0]?.externalBookingCorrelation).toBe('booking:A103');
      yield* rejected(
        transitionOccupancy(retried.snapshot, { _tag: 'RetryBooking', observationId, record }, scope, validators),
      );
    }),
  );
  it.effect('rejects impossible calendar dates structurally', () =>
    rejected(Schema.decodeEffect(OccupancySchema)({ ...draft, startDate: '2026-02-31' })),
  );
});
