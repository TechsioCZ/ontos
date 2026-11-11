import { startDraftSave } from '@app/admin-ui';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import type { SaveOutcome } from '@app/admin-ui';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { ApplyCommandActionConflictProblemSchema } from '../../shared/apis/apply-command-action.ts';
import { CounterpartyIdSchema } from '../../shared/apis/records.ts';
import type { Occupancy, RecordsResponse, TenantContact, TenantDossier } from '../../shared/apis/records.ts';
import {
  caseChangesOf,
  caseDraftOf,
  caseUnchangedSince,
  contactsUnchangedSince,
  leasingSaveResult,
  rentDraftOf,
  rentTermsOf,
  rentUnchangedSince,
  sameContacts,
  sameRentDraft,
  validContacts,
} from '../../src/routes/[lang]/najmy/leasing-save.ts';
import type { RentDraft } from '../../src/routes/[lang]/najmy/leasing-save.ts';
import {
  ConflictOutcomeSchema,
  FailedOutcomeSchema,
  ProposedOutcomeSchema,
  SavedOutcomeSchema,
  additionResultOf,
  settleAddition,
} from '../../src/routes/[lang]/najmy/occupancy-command.ts';
import type { OccupancyOutcome } from '../../src/routes/[lang]/najmy/occupancy-command.ts';

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
const proposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2026-11-14T10:00:00.000Z',
  proposalId: '77777777-7777-4777-8777-777777777777',
});

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

  it.effect('turns only the occupancy conflict into the conflict outcome and adopts the returned revision', () =>
    Effect.gen(function* outcomes() {
      expect(yield* leasingSaveResult(Effect.succeed({ revision: 8 }))).toBe(8);
      expect(yield* leasingSaveResult(Effect.fail(conflictProblem('occupancy_conflict')))).toBe('conflict');
      expect(yield* leasingSaveResult(Effect.fail(conflictProblem('action_invocation_state_invalid')))).toBe('failed');
    }),
  );

  it.effect('reports a change parked for approval as proposed and reports nothing for a commit', () =>
    Effect.gen(function* outcomes() {
      const reported: ActionProposalAccepted[] = [];
      const report = (parked: ActionProposalAccepted) => {
        reported.push(parked);
      };
      expect(yield* leasingSaveResult(Effect.succeed(proposal), report)).toBe('proposed');
      expect(reported).toEqual([proposal]);
      expect(yield* leasingSaveResult(Effect.succeed({ resourceRef: null, revision: 9 }), report)).toBe(9);
      expect(reported).toEqual([proposal]);
    }),
  );

  it.effect('keeps the draft unconfirmed on its base when the rent is parked for approval', () =>
    Effect.gen(function* parked() {
      const controller = yield* startDraftSave<RentDraft, never>(rent, {
        equals: sameRentDraft,
        isValid: (value) => Option.isSome(rentTermsOf(value)),
        save: () =>
          leasingSaveResult(Effect.succeed(proposal)).pipe(
            Effect.map((result): SaveOutcome => (result === 'proposed' ? 'proposed' : 'failed')),
          ),
      });
      controller.change({ ...rent, monthly: '19000' });
      controller.save();
      yield* Effect.yieldNow;
      expect(controller.status()).toBe('proposed');
      expect(controller.confirmed()).toEqual(rent);
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

const panel = Effect.fnUntraced(function* panel(outcome: SaveOutcome) {
  const sent: RentDraft[] = [];
  const controller = yield* startDraftSave(rent, {
    equals: sameRentDraft,
    isValid: (value: RentDraft) => Option.isSome(rentTermsOf(value)),
    save: (value: RentDraft) =>
      Effect.sync(() => {
        sent.push(value);
      }).pipe(Effect.as(outcome)),
  });
  return { controller, sent };
});

describe('rent terms panel save', () => {
  it.live('typing sends nothing; the save sends once; an invalid day is refused locally', () =>
    Effect.gen(function* typed() {
      const { controller, sent } = yield* panel('saved');
      controller.change({ ...rent, monthly: '19000' });
      yield* Effect.sleep('1 second');
      expect(sent).toHaveLength(0);
      controller.change({ ...rent, paymentDay: '40' });
      controller.save();
      expect(controller.status()).toBe('invalid');
      expect(sent).toHaveLength(0);
      controller.change({ ...rent, monthly: '19000' });
      controller.save();
      yield* Effect.yieldNow;
      expect(sent.map(({ monthly }) => monthly)).toEqual(['19000']);
      expect(controller.status()).toBe('saved');
    }),
  );

  it.effect('discard puts the confirmed rent back and sends nothing', () =>
    Effect.gen(function* discard() {
      const { controller, sent } = yield* panel('saved');
      controller.change({ ...rent, service: '3000' });
      controller.discard();
      expect(controller.status()).toBe('idle');
      expect(sent).toHaveLength(0);
    }),
  );

  it.effect('holds a conflicting draft instead of sending it again', () =>
    Effect.gen(function* conflict() {
      const { controller, sent } = yield* panel('conflict');
      controller.change({ ...rent, service: '3000' });
      controller.save();
      yield* Effect.yieldNow;
      expect(controller.status()).toBe('conflict');
      controller.change({ ...rent, service: '3500' });
      controller.save();
      yield* Effect.yieldNow;
      expect(sent).toHaveLength(1);
    }),
  );
});

describe('an addition (registration sheet, notice, logged entry)', () => {
  const saved = SavedOutcomeSchema.make({ resourceRef: null, revision: 8 });

  it('turns a conflict left after the resend into a failed save with its reason, so Uložit sends it again', () => {
    expect(additionResultOf(ConflictOutcomeSchema.make({}))).toEqual({
      reason: Option.some('conflict'),
      status: 'failed',
    });
    expect(additionResultOf(FailedOutcomeSchema.make({ reason: 'validation' }))).toEqual({
      reason: Option.some('validation'),
      status: 'failed',
    });
    expect(additionResultOf(saved)).toEqual({ reason: Option.none(), status: 'saved' });
    expect(additionResultOf(ProposedOutcomeSchema.make({ proposal }))).toEqual({
      reason: Option.none(),
      status: 'proposed',
    });
  });

  it.effect('refreshes the lease-related lists after every outcome and re-reads after a save or conflict', () =>
    Effect.gen(function* settled() {
      const seen: string[] = [];
      const parked: ActionProposalAccepted[] = [];
      const settle = (outcome: OccupancyOutcome) =>
        settleAddition(Effect.succeed(outcome), {
          invalidate: () => {
            seen.push('invalidate');
          },
          onProposal: (accepted) => {
            parked.push(accepted);
          },
          reload: Effect.sync(() => {
            seen.push('reload');
          }),
        });
      expect(yield* settle(saved)).toEqual(saved);
      expect(seen).toEqual(['invalidate', 'reload']);
      seen.length = 0;
      yield* settle(FailedOutcomeSchema.make({ reason: 'forbidden' }));
      expect(seen).toEqual(['invalidate']);
      seen.length = 0;
      yield* settle(ConflictOutcomeSchema.make({}));
      expect(seen).toEqual(['invalidate', 'reload']);
      seen.length = 0;
      yield* settle(ProposedOutcomeSchema.make({ proposal }));
      expect(seen).toEqual(['invalidate']);
      expect(parked).toEqual([proposal]);
    }),
  );
});
