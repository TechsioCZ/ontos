import { startAutosave } from '@app/admin-ui';
import type { AutosaveOutcome } from '@app/admin-ui';
import { Effect, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';
import { ApplyCommandActionConflictProblemSchema } from '../../shared/apis/apply-command-action.ts';
import { CounterpartyIdSchema } from '../../shared/apis/records.ts';
import type { Occupancy, RecordsResponse, TenantContact, TenantDossier } from '../../shared/apis/records.ts';
import {
  caseChangesOf,
  caseDraftOf,
  caseUnchangedSince,
  contactsUnchangedSince,
  leasingAutosaveResult,
  rentDraftOf,
  rentTermsOf,
  rentUnchangedSince,
  sameContacts,
  sameRentDraft,
  validContacts,
} from '../../src/routes/[lang]/najmy/leasing-autosave.ts';
import type { RentDraft } from '../../src/routes/[lang]/najmy/leasing-autosave.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const counterpartyId = '44444444-4444-4444-8444-444444444444';
const lease: Occupancy = {
  contractRef: null,
  customerCounterpartyRef: {
    moduleId: 'party.registry',
    resourceId: counterpartyId,
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  endDate: null,
  externalBookingCorrelation: null,
  guestPartyRef: null,
  kind: 'LONG_TERM_LEASE',
  note: null,
  occupancyRef: {
    moduleId: 'property.leasing',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'property.leasing.occupancy',
    tenantId,
  },
  peopleCount: null,
  rentTerms: { currency: 'CZK', monthlyRentMinor: 1_850_000, paymentDay: 15, serviceChargesMinor: 250_050 },
  startDate: '2026-12-01',
  state: 'ACTIVE',
  unitRef: {
    moduleId: 'property.portfolio',
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'property.portfolio.unit',
    tenantId,
  },
};
const jana: TenantContact = {
  email: 'jana@atelier-horak.cz',
  id: '66666666-6666-4666-8666-666666666666',
  name: 'Jana Horáková',
  phone: '+420 777 123 456',
  role: 'Jednatelka',
};
const dossier: TenantDossier = {
  archived: false,
  caseState: 'IN_PROGRESS',
  contacts: [jana],
  counterpartyId: Schema.decodeUnknownSync(CounterpartyIdSchema)(counterpartyId),
  history: [],
};
const records = (occupancy: Occupancy, dossiers: readonly TenantDossier[]): RecordsResponse => ({
  occupancies: [occupancy],
  revision: 7,
  tenantDossiers: dossiers,
});
const conflictProblem = (code: 'action_invocation_state_invalid' | 'occupancy_conflict') =>
  Schema.decodeUnknownSync(ApplyCommandActionConflictProblemSchema)({
    _tag: 'ApplyCommandActionConflictProblem',
    code,
    detail: 'Nájmy se mezitím změnily.',
    status: 409,
    title: 'Konflikt',
    type: 'about:blank',
  });
const rent = rentDraftOf(lease.rentTerms);

describe('rent terms panel', () => {
  it('shows the stored rent in crowns and never saves an invalid amount or day', () => {
    expect(rent).toEqual({ monthly: '18500', paymentDay: '15', service: '2500.50' });
    expect(Option.isSome(rentTermsOf({ ...rent, monthly: '18 500,50' }))).toBe(true);
    expect(Option.isNone(rentTermsOf({ ...rent, monthly: '' }))).toBe(true);
    expect(Option.isNone(rentTermsOf({ ...rent, paymentDay: '0' }))).toBe(true);
    expect(Option.isNone(rentTermsOf({ ...rent, service: 'zdarma' }))).toBe(true);
  });

  it('resends a revision race only while this lease still has the rent the draft builds on', () => {
    const unchanged = rentUnchangedSince(lease.occupancyRef.resourceId, rent);
    expect(unchanged(records(lease, []))).toBe(true);
    const { rentTerms: _rentTerms, ...withoutRent } = lease;
    expect(unchanged(records(withoutRent, []))).toBe(false);
    const moved = {
      currency: 'CZK',
      monthlyRentMinor: 1_850_000,
      paymentDay: 20,
      serviceChargesMinor: 250_050,
    } as const;
    expect(unchanged(records({ ...lease, rentTerms: moved }, []))).toBe(false);
  });

  it.effect('adopts the returned revision and turns only the occupancy conflict into the conflict line', () =>
    Effect.gen(function* outcomes() {
      expect(yield* leasingAutosaveResult(Effect.succeed({ revision: 8 }))).toBe(8);
      expect(yield* leasingAutosaveResult(Effect.fail(conflictProblem('occupancy_conflict')))).toBe('conflict');
      expect(yield* leasingAutosaveResult(Effect.fail(conflictProblem('action_invocation_state_invalid')))).toBe(
        'failed',
      );
    }),
  );
});

describe('dossier contacts and case', () => {
  it('saves contacts only with a name and a plausible e-mail', () => {
    expect(validContacts([jana])).toBe(true);
    expect(validContacts([{ ...jana, name: ' ' }])).toBe(false);
    expect(validContacts([{ ...jana, email: 'jana@' }])).toBe(false);
    expect(sameContacts([jana], [{ ...jana, role: ' Jednatelka ' }])).toBe(true);
    const unchanged = contactsUnchangedSince(counterpartyId, [jana]);
    expect(unchanged(records(lease, [dossier]))).toBe(true);
    expect(unchanged(records(lease, [{ ...dossier, contacts: [] }]))).toBe(false);
  });

  it('sends the case state alone until details are filled in, then requires all of them', () => {
    const empty = caseDraftOf(dossier);
    expect(caseChangesOf({ ...empty, state: 'CONFIRMED' }, dossier)).toEqual(Option.some({ caseState: 'CONFIRMED' }));
    expect(Option.isNone(caseChangesOf({ ...empty, subject: 'Kancelář 2. patro' }, dossier))).toBe(true);
    const filled = caseChangesOf(
      { ...empty, deadline: '2026-12-15', owner: 'Petr Novák', subject: 'Kancelář 2. patro', value: '120 000' },
      dossier,
    );
    expect(Option.getOrThrow(filled).caseDetails?.estimatedValueMinor).toEqual(Option.some(12_000_000));
    expect(caseUnchangedSince(counterpartyId, empty)(records(lease, [dossier]))).toBe(true);
    expect(caseUnchangedSince(counterpartyId, empty)(records(lease, [{ ...dossier, caseState: 'NEW' }]))).toBe(false);
  });
});

const panel = Effect.fnUntraced(function* panel(outcome: AutosaveOutcome) {
  const sent: RentDraft[] = [];
  const controller = yield* startAutosave(rent, {
    equals: sameRentDraft,
    isValid: (value: RentDraft) => Option.isSome(rentTermsOf(value)),
    save: (value: RentDraft) => Effect.sync(() => sent.push(value)).pipe(Effect.as(outcome)),
  });
  return { controller, sent };
});

describe('rent terms panel autosave', () => {
  it.effect('saves a typed rent after the quiet time; an invalid day stays local', () =>
    Effect.gen(function* typed() {
      const { controller, sent } = yield* panel('saved');
      controller.change({ ...rent, paymentDay: '40' });
      controller.flush();
      expect(controller.status()).toBe('invalid');
      controller.change({ ...rent, monthly: '19000' });
      yield* TestClock.adjust('800 millis');
      expect(sent.map(({ monthly }) => monthly)).toEqual(['19000']);
      expect(controller.status()).toBe('saved');
    }),
  );

  it.effect('holds a conflicting draft instead of sending it again', () =>
    Effect.gen(function* conflict() {
      const { controller, sent } = yield* panel('conflict');
      controller.change({ ...rent, service: '3000' });
      controller.flush();
      yield* Effect.yieldNow;
      expect(controller.status()).toBe('conflict');
      controller.change({ ...rent, service: '3500' });
      yield* TestClock.adjust('1 second');
      expect(sent).toHaveLength(1);
    }),
  );
});
