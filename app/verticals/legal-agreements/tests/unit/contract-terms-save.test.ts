import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { ApplyCommandActionConflictProblemSchema } from '../../shared/apis/apply-command-action.ts';
import type { Contract } from '../../shared/apis/records.ts';
import {
  sameTermsDraft,
  termsSaveResult,
  termsCommandOf,
  termsDraftOf,
  termsUnchangedSince,
} from '../../src/routes/[lang]/smlouvy/contract-terms-draft.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const contractRef = {
  moduleId: 'legal.agreements',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'legal.agreements.contract',
  tenantId,
} as const;
const contract: Contract = {
  contractRef,
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
const saved = termsDraftOf(contract);
const conflictProblem = (code: 'action_invocation_state_invalid' | 'agreements_conflict') =>
  Schema.decodeUnknownSync(ApplyCommandActionConflictProblemSchema)({
    _tag: 'ApplyCommandActionConflictProblem',
    code,
    detail: 'Smlouvy se mezitím změnily.',
    status: 409,
    title: 'Konflikt',
    type: 'about:blank',
  });

describe('contract terms draft', () => {
  it('shows the stored amounts in crowns and ignores surrounding spaces', () => {
    expect(saved).toMatchObject({ monthly: '18500', paymentDay: '15', service: '2500.50' });
    expect(sameTermsDraft(saved, { ...saved, subject: ' Nájem kanceláře ' })).toBe(true);
    expect(sameTermsDraft(saved, { ...saved, noticePeriod: '3 měsíce' })).toBe(false);
  });

  it('never saves an invalid amount or payment day, and a contract without rent ignores the rent fields', () => {
    expect(Option.isSome(termsCommandOf(contractRef, { ...saved, monthly: '18 500,50' }))).toBe(true);
    expect(Option.isNone(termsCommandOf(contractRef, { ...saved, monthly: '18.500.5' }))).toBe(true);
    expect(Option.isNone(termsCommandOf(contractRef, { ...saved, paymentDay: '32' }))).toBe(true);
    expect(Option.isNone(termsCommandOf(contractRef, { ...saved, service: 'zdarma' }))).toBe(true);
    const withoutRent = Option.getOrThrow(termsCommandOf(contractRef, { ...saved, monthly: '', paymentDay: '0' }));
    expect('rentTerms' in withoutRent).toBe(false);
  });

  it('clears an emptied text field and sends the rent in minor units', () => {
    const command = Option.getOrThrow(
      termsCommandOf(contractRef, { ...saved, monthly: '18 500,50', responsiblePerson: ' ' }),
    );
    expect('responsiblePerson' in command).toBe(false);
    expect(command.rentTerms).toEqual({
      currency: 'CZK',
      monthlyRentMinor: 1_850_050,
      paymentDay: 15,
      serviceChargesMinor: 250_050,
    });
  });

  it('resends a revision race only while these terms are still the version the draft builds on', () => {
    const unchanged = termsUnchangedSince(contractRef.resourceId, saved);
    expect(unchanged([contract])).toBe(true);
    expect(unchanged([{ ...contract, noticePeriod: '6 měsíců' }])).toBe(false);
    expect(unchanged([])).toBe(false);
  });

  it.effect('adopts the returned revision and turns only the agreements conflict into the conflict line', () =>
    Effect.gen(function* outcomes() {
      expect(yield* termsSaveResult(Effect.succeed({ revision: 9 }))).toBe(9);
      expect(yield* termsSaveResult(Effect.fail(conflictProblem('agreements_conflict')))).toBe('conflict');
      expect(yield* termsSaveResult(Effect.fail(conflictProblem('action_invocation_state_invalid')))).toBe('failed');
    }),
  );
});
