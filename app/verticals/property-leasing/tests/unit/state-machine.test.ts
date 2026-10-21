import { dayOccupancy } from '../../src/routes/[lang]/najmy/occupancy-calendar.tsx';
import { describe, expect, it } from 'effect-rstest';
import { Effect, Exit, Schema } from 'effect';

import { OccupancySchema, OccupancyStateSchema, TenantCaseDetailsSchema } from '../../shared/apis/records.ts';
import type { Occupancy, OccupancyState } from '../../shared/apis/records.ts';
import {
  filterOccupancyRecords,
  occupancyHasConflict,
  occupancyPeriodsOverlap,
  transitionOccupancy,
  unavailableOccupancyValidators,
} from '../../src/services/persistence.service.ts';
import type { OccupancyValidators } from '../../src/services/persistence.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const scope = { legalEntityId, tenantId };
const unitRef = {
  moduleId: 'property.portfolio',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'property.portfolio.unit',
  tenantId,
} as const;
const customerCounterpartyRef = {
  moduleId: 'party.registry',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const occupancyRef = {
  moduleId: 'property.leasing',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'property.leasing.occupancy',
  tenantId,
} as const;
const contractRef = {
  moduleId: 'legal.agreements',
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'legal.agreements.contract',
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
  it.effect('records agreed rent on draft, confirmed and active leases and keeps it through activation', () =>
    Effect.gen(function* recordsRent() {
      const rentTerms = {
        currency: 'CZK',
        monthlyRentMinor: 1_850_000,
        paymentDay: 15,
        serviceChargesMinor: 320_000,
      } as const;
      const created = yield* transitionOccupancy(
        empty,
        { _tag: 'CreateDraft', record: { ...draft, rentTerms } },
        scope,
        validators,
      );
      expect(created.snapshot.occupancies[0]?.rentTerms).toEqual(rentTerms);
      const raised = { ...rentTerms, monthlyRentMinor: 1_900_000 };
      const edited = yield* transitionOccupancy(
        created.snapshot,
        { _tag: 'UpdateDraft', endDate: draft.endDate, occupancyRef, rentTerms: raised, startDate: draft.startDate },
        scope,
        validators,
      );
      expect(edited.snapshot.occupancies[0]?.rentTerms).toEqual(raised);
      const kept = yield* transitionOccupancy(
        edited.snapshot,
        { _tag: 'UpdateDraft', endDate: draft.endDate, occupancyRef, startDate: '2026-10-06' },
        scope,
        validators,
      );
      expect(kept.snapshot.occupancies[0]?.rentTerms).toEqual(raised);
      const confirmed = yield* transitionOccupancy(kept.snapshot, { _tag: 'Confirm', occupancyRef }, scope, validators);
      const active = yield* transitionOccupancy(
        confirmed.snapshot,
        { _tag: 'Activate', contractRef, occupancyRef },
        scope,
        validators,
      );
      expect(active.snapshot.occupancies[0]?.rentTerms).toEqual(raised);
      const indexed = yield* transitionOccupancy(
        active.snapshot,
        { _tag: 'SetRentTerms', occupancyRef, rentTerms: { ...raised, paymentDay: 10 } },
        scope,
        validators,
      );
      expect(indexed.snapshot.occupancies[0]?.rentTerms?.paymentDay).toBe(10);
      expect(indexed.snapshot.occupancies[0]?.state).toBe('ACTIVE');
      const completed = yield* transitionOccupancy(
        indexed.snapshot,
        { _tag: 'Complete', occupancyRef },
        scope,
        validators,
      );
      yield* rejected(
        transitionOccupancy(completed.snapshot, { _tag: 'SetRentTerms', occupancyRef, rentTerms }, scope, validators),
      );
      expect(Schema.decodeExit(OccupancySchema)({ ...draft, rentTerms: { ...rentTerms, paymentDay: 0 } })._tag).toBe(
        'Failure',
      );
      expect(Schema.decodeExit(OccupancySchema)(draft)._tag).toBe('Success');
    }),
  );
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

it.effect(
  'persists tenant contacts, server-authored communication, case changes and archival without erasing lease history',
  () =>
    Effect.gen(function* tenantDossierLifecycle() {
      const actor = { ...scope, principalId: '72000000-0000-4000-8000-000000000021' };
      const initial = { bookingObservations: [], occupancies: [draft] };
      const contacts = [
        {
          id: '81000000-0000-4000-8000-000000000001',
          name: 'Lucie Parková',
          role: 'Jednatelka',
          email: 'lucie@kavarna.demo',
          phone: '+420 777 101 101',
        },
        {
          id: '81000000-0000-4000-8000-000000000002',
          name: 'Petr Novák',
          role: 'Provozní',
          email: 'petr@kavarna.demo',
          phone: '+420 777 101 102',
        },
      ];
      const created = yield* transitionOccupancy(
        initial,
        { _tag: 'UpdateTenantDossier', occupancyRef, contacts },
        actor,
        unavailableOccupancyValidators,
      );
      const call = yield* transitionOccupancy(
        created.snapshot,
        {
          _tag: 'UpdateTenantDossier',
          occupancyRef,
          activity: { kind: 'CALL', summary: 'Domluven termín předání jednotky.' },
          caseState: 'IN_PROGRESS',
        },
        actor,
        unavailableOccupancyValidators,
      );
      const archived = yield* transitionOccupancy(
        call.snapshot,
        { _tag: 'UpdateTenantDossier', occupancyRef, archived: true },
        actor,
        unavailableOccupancyValidators,
      );
      const dossier = archived.snapshot.tenantDossiers?.[0];
      expect(dossier?.contacts).toEqual(contacts);
      expect(dossier?.caseState).toBe('IN_PROGRESS');
      expect(dossier?.archived).toBe(true);
      expect(dossier?.history.map((entry) => entry.kind)).toEqual(['CONTACTS', 'CASE', 'CALL', 'ARCHIVE']);
      expect(
        dossier?.history.every(
          (entry) => entry.authorPrincipalId === actor.principalId && entry.occurredAt.length > 10,
        ),
      ).toBe(true);
      expect(archived.snapshot.occupancies).toEqual(initial.occupancies);
      const restored = yield* transitionOccupancy(
        archived.snapshot,
        { _tag: 'UpdateTenantDossier', occupancyRef, archived: false },
        actor,
        unavailableOccupancyValidators,
      );
      expect(restored.snapshot.tenantDossiers?.[0]?.history).toHaveLength(5);
      expect(restored.snapshot.tenantDossiers?.[0]?.archived).toBe(false);
    }),
);

it.effect('rejects dossier updates without trusted author, for another tenant and with duplicate contacts', () =>
  Effect.gen(function* tenantDossierGuard() {
    const initial = { bookingObservations: [], occupancies: [draft] };
    const command = {
      _tag: 'UpdateTenantDossier' as const,
      occupancyRef,
      activity: { kind: 'NOTE' as const, summary: 'Předání.' },
    };
    expect(
      Exit.isFailure(yield* Effect.exit(transitionOccupancy(initial, command, scope, unavailableOccupancyValidators))),
    ).toBe(true);
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          transitionOccupancy(
            initial,
            { ...command, occupancyRef: { ...occupancyRef, tenantId: '99999999-9999-4999-8999-999999999999' } },
            { ...scope, principalId: 'actor' },
            unavailableOccupancyValidators,
          ),
        ),
      ),
    ).toBe(true);
    const contact = {
      id: '81000000-0000-4000-8000-000000000001',
      name: 'Lucie Parková',
      role: '',
      email: '',
      phone: '',
    };
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          transitionOccupancy(
            initial,
            { ...command, contacts: [contact, contact] },
            { ...scope, principalId: 'actor' },
            unavailableOccupancyValidators,
          ),
        ),
      ),
    ).toBe(true);
  }),
);

it('uses the source lease interval for each calendar day and immediately frees cancelled reservations', () => {
  const confirmed = { ...draft, state: 'CONFIRMED' as const, startDate: '2027-01-01', endDate: '2027-01-31' };
  expect(dayOccupancy([confirmed], unitRef.resourceId, '2027-01-15')).toBe(confirmed);
  expect(dayOccupancy([confirmed], unitRef.resourceId, '2027-01-31')).toBeUndefined();
  expect(dayOccupancy([{ ...confirmed, state: 'CANCELLED' }], unitRef.resourceId, '2027-01-15')).toBeUndefined();
  expect(dayOccupancy([{ ...confirmed, state: 'DRAFT' }], unitRef.resourceId, '2027-01-15')).toBeUndefined();
});

it.effect('stores complete tenant case metadata with actor and history across later status updates', () =>
  Effect.gen(function* caseMetadata() {
    const actor = { ...scope, principalId: '72000000-0000-4000-8000-000000000021' };
    const caseDetails = {
      subject: 'Prodloužení nájmu R101',
      owner: 'Vedení Siampark',
      deadline: '2026-11-15',
      estimatedValueMinor: 5_450_000,
    };
    const created = yield* transitionOccupancy(
      { ...empty, occupancies: [draft] },
      { _tag: 'UpdateTenantDossier', occupancyRef, caseState: 'IN_PROGRESS', caseDetails },
      actor,
      validators,
    );
    const changed = yield* transitionOccupancy(
      created.snapshot,
      { _tag: 'UpdateTenantDossier', occupancyRef, caseState: 'CONFIRMED' },
      actor,
      validators,
    );
    const reloaded = yield* Schema.decodeEffect(OccupancyStateSchema)(changed.snapshot);
    expect(reloaded.tenantDossiers?.[0]).toMatchObject({
      counterpartyId: customerCounterpartyRef.resourceId,
      caseState: 'CONFIRMED',
      caseDetails,
    });
    expect(reloaded.tenantDossiers?.[0]?.history).toHaveLength(3);
    expect(reloaded.tenantDossiers?.[0]?.history.every((entry) => entry.authorPrincipalId === actor.principalId)).toBe(
      true,
    );
    expect(Schema.decodeExit(TenantCaseDetailsSchema)({ ...caseDetails, estimatedValueMinor: null })._tag).toBe(
      'Success',
    );
    expect(Schema.decodeExit(TenantCaseDetailsSchema)({ ...caseDetails, deadline: '2026-02-31' })._tag).toBe('Failure');
    expect(Schema.decodeExit(TenantCaseDetailsSchema)({ ...caseDetails, estimatedValueMinor: -1 })._tag).toBe(
      'Failure',
    );
  }),
);

it.effect('manually reserves a stay with people and note without creating integration observations', () =>
  Effect.gen(function* manualStay() {
    const record: Occupancy = {
      ...draft,
      kind: 'SHORT_STAY',
      customerCounterpartyRef: null,
      guestPartyRef: {
        moduleId: 'party.registry',
        resourceType: 'party.registry.party',
        resourceId: '77777777-7777-4777-8777-777777777777',
        tenantId,
      },
      peopleCount: 3,
      note: 'Rodinný pobyt, příjezd odpoledne.',
    };
    const created = yield* transitionOccupancy(empty, { _tag: 'CreateDraft', record }, scope, validators);
    const confirmed = yield* transitionOccupancy(
      created.snapshot,
      { _tag: 'Confirm', occupancyRef },
      scope,
      validators,
    );
    const active = yield* transitionOccupancy(
      confirmed.snapshot,
      { _tag: 'Activate', contractRef: null, occupancyRef },
      scope,
      validators,
    );
    const completed = yield* transitionOccupancy(
      active.snapshot,
      { _tag: 'Complete', occupancyRef },
      scope,
      validators,
    );
    expect(completed.snapshot.occupancies[0]).toMatchObject({
      peopleCount: 3,
      note: record.note,
      state: 'COMPLETED',
      externalBookingCorrelation: null,
    });
    expect(completed.snapshot.bookingObservations).toEqual([]);
    const cancelled = yield* transitionOccupancy(
      confirmed.snapshot,
      { _tag: 'Cancel', occupancyRef },
      scope,
      validators,
    );
    expect(cancelled.snapshot.occupancies[0]?.state).toBe('CANCELLED');
  }),
);

describe('Counterparty dossier, audit, registration sheet and notices', () => {
  const actor = { ...scope, principalId: '77777777-7777-4777-8777-777777777777' };
  const prospect = { ...customerCounterpartyRef, resourceId: '88888888-8888-4888-8888-888888888888' };
  it.effect('S01: a prospect without a lease gets contacts and a timeline that unfiltered reads return', () =>
    Effect.gen(function* prospectDossier() {
      const noted = yield* transitionOccupancy(
        empty,
        {
          _tag: 'UpdateCounterpartyDossier',
          counterpartyRef: prospect,
          activity: { kind: 'NOTE', summary: 'První kontakt.' },
        },
        actor,
        validators,
      );
      expect(noted.resourceRef).toBeNull();
      const contacts = yield* transitionOccupancy(
        noted.snapshot,
        {
          _tag: 'UpdateCounterpartyDossier',
          counterpartyRef: prospect,
          contacts: [
            { id: '99999999-9999-4999-8999-999999999991', name: 'Eva Bílá', role: 'Jednatelka', email: '', phone: '' },
            { id: '99999999-9999-4999-8999-999999999992', name: 'Petr Bílý', role: 'Provoz', email: '', phone: '' },
          ],
          caseState: 'IN_PROGRESS',
        },
        actor,
        validators,
      );
      const dossier = filterOccupancyRecords(contacts.snapshot, 2, {}).tenantDossiers?.[0];
      expect(dossier?.contacts.map((contact) => contact.name)).toEqual(['Eva Bílá', 'Petr Bílý']);
      expect(dossier?.history.map((entry) => entry.kind)).toEqual(['NOTE', 'CONTACTS', 'CASE']);
      expect(dossier?.history.every((entry) => entry.authorPrincipalId === actor.principalId)).toBe(true);
      yield* rejected(
        transitionOccupancy(
          empty,
          { _tag: 'UpdateCounterpartyDossier', counterpartyRef: prospect, activity: { kind: 'NOTE', summary: 'x' } },
          actor,
          {
            ...validators,
            counterparty: (ref) =>
              Effect.succeed({ activeCustomer: true, archived: false, counterpartyRef: ref, legalEntityId: tenantId }),
          },
        ),
      );
    }),
  );
  it.effect('S10-02: cancellation is audited with author and time and frees the period', () =>
    Effect.gen(function* auditedCancel() {
      const created = yield* transitionOccupancy(empty, { _tag: 'CreateDraft', record: draft }, actor, validators);
      const confirmed = yield* transitionOccupancy(
        created.snapshot,
        { _tag: 'Confirm', occupancyRef },
        actor,
        validators,
      );
      const cancelled = yield* transitionOccupancy(
        confirmed.snapshot,
        { _tag: 'Cancel', occupancyRef },
        actor,
        validators,
      );
      const history = filterOccupancyRecords(cancelled.snapshot, 3, {
        resourceId: occupancyRef.resourceId,
      }).occupancyHistory;
      expect(history?.map((entry) => entry.kind)).toEqual(['CREATED', 'CONFIRMED', 'CANCELLED']);
      expect(history?.[2]?.summary).toContain('Potvrzeno → Zrušeno');
      expect(history?.[2]?.authorPrincipalId).toBe(actor.principalId);
      expect(
        occupancyHasConflict(cancelled.snapshot, {
          ...draft,
          occupancyRef: { ...occupancyRef, resourceId: '12121212-1212-4121-8121-121212121212' },
        }),
      ).toBe(false);
    }),
  );
  it.effect(
    'S10: registration sheet copies the record and notices are stored, never for drafts or bad recipients',
    () =>
      Effect.gen(function* sheetAndNotice() {
        const created = yield* transitionOccupancy(empty, { _tag: 'CreateDraft', record: draft }, actor, validators);
        const sheet = {
          _tag: 'CreateRegistrationSheet',
          occupancyRef,
          sheetId: 'abababab-abab-4bab-8bab-abababababab',
          occupants: [
            { name: 'Eva Bílá', birthDate: null, nationality: 'Česká republika', identityDocument: '', address: '' },
          ],
          purpose: 'Bydlení – nájem',
          note: '',
        } as const;
        yield* rejected(transitionOccupancy(created.snapshot, sheet, actor, validators));
        const confirmed = yield* transitionOccupancy(
          created.snapshot,
          { _tag: 'Confirm', occupancyRef },
          actor,
          validators,
        );
        const withSheet = yield* transitionOccupancy(confirmed.snapshot, sheet, actor, validators);
        expect(withSheet.snapshot.registrationSheets?.[0]).toMatchObject({
          number: expect.stringMatching(/^EL-\d{4}-001$/u),
          startDate: draft.startDate,
          endDate: draft.endDate,
          unitId: unitRef.resourceId,
        });
        yield* rejected(transitionOccupancy(withSheet.snapshot, sheet, actor, validators));
        const notice = {
          _tag: 'PrepareNotice',
          occupancyRef,
          noticeId: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
          channel: 'EMAIL',
          templateKey: 'lease-handover',
          recipient: 'eva@pekarna-bila.example',
          subject: 'Předání jednotky',
          body: 'Dobrý den, navrhněte termín předání.',
        } as const;
        yield* rejected(
          transitionOccupancy(withSheet.snapshot, { ...notice, recipient: 'není e-mail' }, actor, validators),
        );
        const prepared = yield* transitionOccupancy(withSheet.snapshot, notice, actor, validators);
        expect(prepared.snapshot.preparedNotices).toHaveLength(1);
        expect(prepared.snapshot.occupancyHistory?.map((entry) => entry.kind)).toEqual([
          'CREATED',
          'CONFIRMED',
          'REGISTRATION_SHEET',
          'NOTICE',
        ]);
      }),
  );
});
