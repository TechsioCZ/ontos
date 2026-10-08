import { DateTime, Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SellingLegalEntityVatRegistrationStateContractSchema } from '../../shared/domain/tax-source-read-contracts.ts';
import { SellingLegalEntityVatRegistrationStateSchema } from '../../src/domain/selling-legal-entity-vat-registration.ts';
import {
  resolveSellingLegalEntityVatRegistration,
  taxSourceContradiction,
} from '../../src/domain/selling-legal-entity-vat-registration-resolution.ts';
import type {
  EligibleTaxSourceAssertion,
  TaxSourceAuthorityPeriod,
} from '../../src/domain/selling-legal-entity-vat-registration-resolution.ts';

const at = (value: string) => DateTime.makeUnsafe(value);
const some = (value: string) => Option.some(at(value));

const sor = (overrides: Partial<TaxSourceAuthorityPeriod> = {}): TaxSourceAuthorityPeriod => ({
  authorityFrom: at('2025-01-01T00:00:00.000Z'),
  authorityTo: Option.none(),
  contractId: 'contract-1',
  contractRevisionId: 'contract-1-revision-1',
  evidenceSourceRefs: ['tax.vies'],
  systemOfRecordRef: 'erp.finance',
  ...overrides,
});

const assertion = (
  assertionId: string,
  overrides: Partial<Omit<EligibleTaxSourceAssertion, 'assertionId'>> = {},
): EligibleTaxSourceAssertion => ({
  assertionId,
  registrationMeaning: 'REGISTERED',
  sourceRef: 'erp.finance',
  validFrom: some('2026-01-01T00:00:00.000Z'),
  validTo: Option.none(),
  ...overrides,
});

const resolve = (
  eligibleAssertions: readonly EligibleTaxSourceAssertion[],
  evaluationTime: string,
  authorities: readonly TaxSourceAuthorityPeriod[] = [sor()],
) =>
  resolveSellingLegalEntityVatRegistration({
    completeState: { authorities, eligibleAssertions },
    evaluationTime: at(evaluationTime),
  });

const permutations = (items: readonly EligibleTaxSourceAssertion[]): EligibleTaxSourceAssertion[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, index) =>
        permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
      );

const stateOf = (...args: Parameters<typeof resolve>) => {
  const { reason, state } = resolve(...args);
  return { reason, state };
};

describe('#922 #925 Selling Legal Entity VAT Registration resolution', () => {
  it('#925 F11 #922 F10 an authoritative positive validity covering E is Current positive', () => {
    expect(resolve([assertion('a1')], '2026-06-01T00:00:00.000Z')).toEqual({
      authority: { outcome: 'AUTHORITY_ESTABLISHED', systemOfRecord: Option.some(sor()) },
      basisAssertionIds: ['a1'],
      evidenceDisagreementIds: [],
      reason: 'AUTHORITATIVE_POSITIVE',
      state: 'CURRENT_POSITIVE',
    });
  });

  it('#925 F12 #922 F16-F17 an authoritative ended or non-registered claim is known negative', () => {
    const ended = assertion('a2', {
      registrationMeaning: 'ENDED',
      validFrom: Option.none(),
      validTo: some('2026-06-01T00:00:00Z'),
    });
    expect(
      stateOf([assertion('a1', { validTo: some('2026-06-01T00:00:00Z') }), ended], '2026-07-01T00:00:00Z'),
    ).toEqual({
      reason: 'AUTHORITATIVE_NEGATIVE',
      state: 'KNOWN_ENDED_OR_NON_REGISTERED',
    });
    expect(stateOf([assertion('a3', { registrationMeaning: 'NON_REGISTERED' })], '2026-07-01T00:00:00Z').state).toBe(
      'KNOWN_ENDED_OR_NON_REGISTERED',
    );
  });

  it('#925 F13 F15 #959 F14 no authority, no authoritative row or a gap is UNKNOWN, never negative', () => {
    expect(stateOf([assertion('a1')], '2026-06-01T00:00:00Z', [])).toEqual({
      reason: 'AUTHORITY_MISSING',
      state: 'UNKNOWN',
    });
    expect(stateOf([], '2026-06-01T00:00:00Z')).toEqual({ reason: 'NO_AUTHORITATIVE_ASSERTION', state: 'UNKNOWN' });
    // Evidence-only rows never stand in for the System of Record (#957 F5, F10).
    expect(stateOf([assertion('e1', { sourceRef: 'tax.vies' })], '2026-06-01T00:00:00Z')).toEqual({
      reason: 'NO_AUTHORITATIVE_ASSERTION',
      state: 'UNKNOWN',
    });
    // A registration that only starts later leaves a gap before it.
    expect(stateOf([assertion('a1')], '2025-06-01T00:00:00Z')).toEqual({
      reason: 'NO_COVERING_ASSERTION',
      state: 'UNKNOWN',
    });
  });

  it('#925 F18-F20 #942 F7 an elapsed positive validity is STALE, never extended as last-known', () => {
    expect(resolve([assertion('a1', { validTo: some('2026-06-01T00:00:00Z') })], '2026-09-01T00:00:00Z')).toMatchObject(
      {
        basisAssertionIds: ['a1'],
        reason: 'VALIDITY_ELAPSED',
        state: 'STALE',
      },
    );
  });

  it('#925 F19 an open-ended System of Record validity stays Current without any TAX max-age', () => {
    expect(stateOf([assertion('a1')], '2036-01-01T00:00:00Z').state).toBe('CURRENT_POSITIVE');
  });

  it('#925 F21-F22 #959 F1-F3 F28 two Systems of Record covering E are UNRESOLVED with no technical winner', () => {
    const second = sor({
      contractId: 'contract-2',
      contractRevisionId: 'contract-2-revision-1',
      systemOfRecordRef: 'ares',
    });
    expect(resolve([assertion('a1')], '2026-06-01T00:00:00Z', [second, sor()])).toEqual({
      authority: { outcome: 'AUTHORITY_CONFLICT', systemOfRecord: Option.none() },
      basisAssertionIds: [],
      evidenceDisagreementIds: [],
      reason: 'AUTHORITY_CONFIGURATION_CONFLICT',
      state: 'UNRESOLVED',
    });
  });

  it('#925 F25-F26 incompatible authoritative claims covering E are UNRESOLVED, never newest-wins', () => {
    const negative = assertion('a2', {
      registrationMeaning: 'NON_REGISTERED',
      validFrom: some('2026-03-01T00:00:00Z'),
    });
    expect(resolve([assertion('a1'), negative], '2026-06-01T00:00:00Z')).toMatchObject({
      basisAssertionIds: ['a1', 'a2'],
      reason: 'INCOMPATIBLE_AUTHORITATIVE_ASSERTIONS',
      state: 'UNRESOLVED',
    });
  });

  it('#925 F7 only the System of Record covering E decides; an earlier System of Record no longer does', () => {
    const ended = sor({ authorityTo: Option.some(at('2026-03-01T00:00:00Z')) });
    const successor = sor({
      authorityFrom: at('2026-03-01T00:00:00Z'),
      contractId: 'contract-2',
      contractRevisionId: 'contract-2-revision-1',
      systemOfRecordRef: 'erp.new',
    });
    expect(stateOf([assertion('a1')], '2026-06-01T00:00:00Z', [ended, successor])).toEqual({
      reason: 'NO_AUTHORITATIVE_ASSERTION',
      state: 'UNKNOWN',
    });
    expect(stateOf([assertion('a1')], '2026-02-01T00:00:00Z', [ended, successor]).state).toBe('CURRENT_POSITIVE');
  });
});

describe('#958 #941 F5 half-open validity boundaries', () => {
  const bounded = assertion('a1', { validFrom: some('2026-01-01T00:00:00Z'), validTo: some('2026-06-01T00:00:00Z') });
  const ended = assertion('a2', {
    registrationMeaning: 'ENDED',
    validFrom: Option.none(),
    validTo: some('2026-06-01T00:00:00Z'),
  });

  it('E equal to validFrom is inside, E equal to validTo is outside', () => {
    expect(stateOf([bounded], '2026-01-01T00:00:00.000Z').state).toBe('CURRENT_POSITIVE');
    expect(stateOf([bounded], '2025-12-31T23:59:59.999Z').state).toBe('UNKNOWN');
    expect(stateOf([bounded], '2026-05-31T23:59:59.999Z').state).toBe('CURRENT_POSITIVE');
    expect(stateOf([bounded], '2026-06-01T00:00:00.000Z').state).toBe('STALE');
  });

  it('an ENDED claim is negative from its end instant on, never before it', () => {
    expect(stateOf([bounded, ended], '2026-05-31T23:59:59.999Z').state).toBe('CURRENT_POSITIVE');
    expect(stateOf([bounded, ended], '2026-06-01T00:00:00.000Z').state).toBe('KNOWN_ENDED_OR_NON_REGISTERED');
  });

  it('authority periods are half-open too', () => {
    const authority = sor({ authorityFrom: at('2026-01-01T00:00:00Z'), authorityTo: some('2026-06-01T00:00:00Z') });
    expect(stateOf([assertion('a1')], '2026-01-01T00:00:00.000Z', [authority]).state).toBe('CURRENT_POSITIVE');
    expect(stateOf([assertion('a1')], '2026-06-01T00:00:00.000Z', [authority]).reason).toBe('AUTHORITY_MISSING');
  });
});

describe('#958 F15-F19 #959 F7-F9 arrival order never decides', () => {
  it('a late historical A1 received after A2 neither changes the state at E nor the earlier history', () => {
    const a1 = assertion('a1', { validFrom: some('2025-01-01T00:00:00Z'), validTo: some('2026-01-01T00:00:00Z') });
    const a2 = assertion('a2', { validFrom: some('2026-01-01T00:00:00Z') });
    expect(stateOf([a2], '2026-06-01T00:00:00Z').state).toBe('CURRENT_POSITIVE');
    expect(resolve([a2, a1], '2026-06-01T00:00:00Z')).toEqual(resolve([a2], '2026-06-01T00:00:00Z'));
    expect(resolve([a2, a1], '2025-06-01T00:00:00Z').basisAssertionIds).toEqual(['a1']);
  });

  it('every permutation of the complete set yields the identical resolution', () => {
    const set = [
      assertion('a1', { validTo: some('2026-06-01T00:00:00Z') }),
      assertion('a2', {
        registrationMeaning: 'ENDED',
        validFrom: Option.none(),
        validTo: some('2026-06-01T00:00:00Z'),
      }),
      assertion('e1', { registrationMeaning: 'REGISTERED', sourceRef: 'tax.vies' }),
      assertion('e2', { registrationMeaning: 'NON_REGISTERED', sourceRef: 'tax.vies' }),
    ];
    for (const evaluationTime of ['2026-03-01T00:00:00Z', '2026-09-01T00:00:00Z']) {
      const expected = resolve(set, evaluationTime);
      for (const permutation of permutations(set)) {
        expect(resolve(permutation, evaluationTime)).toEqual(expected);
      }
    }
  });
});

describe('#959 F10-F11 F27 evidence disagreement never flips the authoritative state', () => {
  it('a contradicting evidence-role claim is listed while the state stays authoritative', () => {
    const viesNegative = assertion('e1', { registrationMeaning: 'NON_REGISTERED', sourceRef: 'tax.vies' });
    const viesPositive = assertion('e2', { sourceRef: 'tax.vies' });
    expect(resolve([assertion('a1'), viesNegative, viesPositive], '2026-06-01T00:00:00Z')).toMatchObject({
      basisAssertionIds: ['a1'],
      evidenceDisagreementIds: ['e1'],
      state: 'CURRENT_POSITIVE',
    });
    const negative = assertion('a2', { registrationMeaning: 'NON_REGISTERED' });
    expect(resolve([negative, viesNegative, viesPositive], '2026-06-01T00:00:00Z')).toMatchObject({
      evidenceDisagreementIds: ['e2'],
      state: 'KNOWN_ENDED_OR_NON_REGISTERED',
    });
  });
});

describe('#959 F1 F8 F25 authority roles are derived at the evaluated instant, never frozen at recording', () => {
  // Handoff: erp.finance is System of Record until 2026-03-01 with VIES as evidence, erp.next from then on without it.
  const former = sor({ authorityTo: some('2026-03-01T00:00:00Z') });
  const next = sor({
    authorityFrom: at('2026-03-01T00:00:00Z'),
    contractId: 'contract-2',
    contractRevisionId: 'contract-2-revision-1',
    evidenceSourceRefs: ['tax.ares'],
    systemOfRecordRef: 'erp.next',
  });

  it('each System of Record decides only its own authority window', () => {
    const formerClaim = assertion('a1', { validFrom: some('2026-01-01T00:00:00Z') });
    const nextClaim = assertion('b1', { sourceRef: 'erp.next', validFrom: some('2026-03-01T00:00:00Z') });
    expect(resolve([formerClaim, nextClaim], '2026-02-01T00:00:00Z', [former, next]).basisAssertionIds).toEqual(['a1']);
    expect(resolve([formerClaim, nextClaim], '2026-06-01T00:00:00Z', [former, next]).basisAssertionIds).toEqual(['b1']);
  });

  it('a source listed as evidence only before E never disagrees at E', () => {
    const nextClaim = assertion('b1', { sourceRef: 'erp.next', validFrom: some('2026-03-01T00:00:00Z') });
    const viesNegative = assertion('e1', { registrationMeaning: 'NON_REGISTERED', sourceRef: 'tax.vies' });
    const formerNegative = assertion('a2', { registrationMeaning: 'NON_REGISTERED' });
    expect(resolve([nextClaim, viesNegative, formerNegative], '2026-06-01T00:00:00Z', [former, next])).toMatchObject({
      basisAssertionIds: ['b1'],
      evidenceDisagreementIds: [],
      state: 'CURRENT_POSITIVE',
    });
    const aresNegative = assertion('e2', { registrationMeaning: 'NON_REGISTERED', sourceRef: 'tax.ares' });
    expect(
      resolve([nextClaim, viesNegative, aresNegative], '2026-06-01T00:00:00Z', [former, next]).evidenceDisagreementIds,
    ).toEqual(['e2']);
  });

  it('contradictions are judged under the System of Record covering each contradicting instant', () => {
    const formerOpen = assertion('a1', { validFrom: some('2026-01-01T00:00:00Z') });
    const viesNegative = assertion('e1', {
      registrationMeaning: 'NON_REGISTERED',
      sourceRef: 'tax.vies',
      validFrom: some('2026-04-01T00:00:00Z'),
    });
    // VIES contradicts erp.finance only after erp.finance stopped being System of Record and VIES evidence.
    expect(taxSourceContradiction(viesNegative, formerOpen, [former, next])).toEqual(Option.none());
    // The same pair overlapping inside the former window is a disagreement there.
    const viesEarly = assertion('e2', { registrationMeaning: 'NON_REGISTERED', sourceRef: 'tax.vies' });
    expect(taxSourceContradiction(viesEarly, formerOpen, [former, next])).toEqual(Option.some('EVIDENCE_DISAGREEMENT'));
    // Two claims of the same source conflict only while it is the System of Record.
    const formerNegativeLater = assertion('a2', {
      registrationMeaning: 'NON_REGISTERED',
      validFrom: some('2026-04-01T00:00:00Z'),
    });
    expect(taxSourceContradiction(formerNegativeLater, formerOpen, [former, next])).toEqual(Option.none());
    expect(taxSourceContradiction(formerNegativeLater, formerOpen, [sor()])).toEqual(
      Option.some('INCOMPATIBLE_AUTHORITATIVE_ASSERTIONS'),
    );
    // Under an authority gap or a configuration conflict there is no role, hence no TAX conflict.
    expect(taxSourceContradiction(formerNegativeLater, formerOpen, [])).toEqual(Option.none());
    const competing = sor({ contractId: 'contract-3', contractRevisionId: 'contract-3-revision-1' });
    expect(taxSourceContradiction(formerNegativeLater, formerOpen, [sor(), competing])).toEqual(Option.none());
  });
});

it('#938 F8-F9 the read contract publishes exactly the six-state domain vocabulary', () => {
  expect(SellingLegalEntityVatRegistrationStateContractSchema.literals).toEqual(
    SellingLegalEntityVatRegistrationStateSchema.literals,
  );
});
