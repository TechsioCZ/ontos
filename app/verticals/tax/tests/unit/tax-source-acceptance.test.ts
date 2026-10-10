import { DateTime, Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  evaluateTaxSourceAssertionAcceptance,
  taxSourceAuthorityConfigurationConflict,
} from '../../src/domain/selling-legal-entity-vat-registration-resolution.ts';
import type { TaxSourceAuthorityPeriod } from '../../src/domain/selling-legal-entity-vat-registration-resolution.ts';
import { evaluateTaxSourceAuthority, evaluateTaxSourceEligibility } from '../../src/domain/tax-source-acceptance.ts';
import type { TaxSourceAssertionProposal, TaxSourceAuthority } from '../../src/domain/tax-source-acceptance.ts';

const instant = (value: string) => Option.some(DateTime.makeUnsafe(value));

const authority = (overrides: Partial<TaxSourceAuthority> = {}): TaxSourceAuthority => ({
  contractId: 'contract-1',
  contractRevisionId: 'contract-revision-1',
  evidenceSourceRefs: ['tax.vies'],
  systemOfRecordRef: 'erp.finance',
  ...overrides,
});

const proposal = (overrides: Partial<TaxSourceAssertionProposal> = {}): TaxSourceAssertionProposal => ({
  registrationMeaning: 'REGISTERED',
  validFrom: instant('2026-01-01T00:00:00.000Z'),
  validTo: Option.none(),
  ...overrides,
});

const authorityOf = (sourceRef: string, authorities: readonly TaxSourceAuthority[] = [authority()]) =>
  evaluateTaxSourceAuthority({ authoritiesAtInstant: authorities, sourceRef });

const period = (
  overrides: Partial<TaxSourceAuthority> = {},
  from = '2026-01-01T00:00:00.000Z',
  to?: string,
): TaxSourceAuthorityPeriod => ({
  ...authority(overrides),
  authorityFrom: DateTime.makeUnsafe(from),
  authorityTo: to === undefined ? Option.none() : instant(to),
});

const acceptanceOf = (
  sourceRef: string,
  authorities: readonly TaxSourceAuthorityPeriod[],
  overrides: Partial<TaxSourceAssertionProposal> = {},
) => {
  const assertion = proposal(overrides);
  return evaluateTaxSourceAssertionAcceptance({
    assertion: { ...assertion, eligibility: evaluateTaxSourceEligibility(assertion), sourceRef },
    authorities,
  });
};

describe('#957 F14-F26 stored Tax source eligibility holds at every instant', () => {
  it('#957 F25 an assertion with its declared validity is ELIGIBLE as resolution input', () => {
    expect(evaluateTaxSourceEligibility(proposal())).toBe('ELIGIBLE');
    expect(
      evaluateTaxSourceEligibility(
        proposal({ registrationMeaning: 'ENDED', validFrom: Option.none(), validTo: instant('2026-06-01T00:00:00Z') }),
      ),
    ).toBe('ELIGIBLE');
  });

  it('#957 F21 #958 F16 F26 validity is never derived: missing start or end instant is VALIDITY_UNKNOWN', () => {
    for (const candidate of [
      proposal({ validFrom: Option.none() }),
      proposal({ registrationMeaning: 'NON_REGISTERED', validFrom: Option.none() }),
      proposal({ registrationMeaning: 'ENDED', validTo: Option.none() }),
    ]) {
      expect(evaluateTaxSourceEligibility(candidate)).toBe('VALIDITY_UNKNOWN');
    }
  });
});

describe('#957 H F12 F25-F29 source acceptance is evaluated over the claimed validity under the authority contract', () => {
  it('#957 BDD valid source assertion passes acceptance: a permitted source with known validity is ACCEPTED', () => {
    expect(acceptanceOf('erp.finance', [period()])).toEqual({ outcome: 'ACCEPTED', reason: 'ACCEPTED' });
    expect(acceptanceOf('tax.vies', [period()])).toEqual({ outcome: 'ACCEPTED', reason: 'ACCEPTED' });
  });

  it('#957 H F29 without a contract covering the claim the assertion is UNVERIFIABLE, never ACCEPTED', () => {
    expect(acceptanceOf('erp.finance', [])).toEqual({ outcome: 'UNVERIFIABLE', reason: 'AUTHORITY_MISSING' });
    // A contract ending before the claim starts covers none of it.
    expect(acceptanceOf('erp.finance', [period({}, '2025-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z')])).toEqual({
      outcome: 'UNVERIFIABLE',
      reason: 'AUTHORITY_MISSING',
    });
  });

  it('#957 F2-F7 F12 F27 a source never permitted over the claim is REJECTED as SOURCE_NOT_PERMITTED', () => {
    expect(acceptanceOf('ares.registry', [period()])).toEqual({ outcome: 'REJECTED', reason: 'SOURCE_NOT_PERMITTED' });
  });

  it('#957 F28 #959 F2-F3 F28 competing covering revisions make the assertion NEEDS_REVIEW', () => {
    expect(
      acceptanceOf('erp.finance', [period(), period({ contractId: 'contract-2', contractRevisionId: 'revision-2' })]),
    ).toEqual({ outcome: 'NEEDS_REVIEW', reason: 'AUTHORITY_CONFIGURATION_CONFLICT' });
  });

  it('#957 F27-F28 a source with no role under any competing revision is REJECTED, not NEEDS_REVIEW', () => {
    const overlap = [
      period(),
      period({ contractId: 'contract-2', contractRevisionId: 'revision-2', systemOfRecordRef: 'ares.registry' }),
    ];
    expect(acceptanceOf('ares.registry', overlap)).toEqual({
      outcome: 'NEEDS_REVIEW',
      reason: 'AUTHORITY_CONFIGURATION_CONFLICT',
    });
    expect(acceptanceOf('tax.vies', overlap)).toEqual({
      outcome: 'NEEDS_REVIEW',
      reason: 'AUTHORITY_CONFIGURATION_CONFLICT',
    });
    expect(acceptanceOf('crm.unrelated', overlap)).toEqual({ outcome: 'REJECTED', reason: 'SOURCE_NOT_PERMITTED' });
  });

  it('#959 F2-F3 F28 the configuration conflict names the competing revisions over the claimed segments only', () => {
    const pastOverlap = [
      period(),
      period(
        { contractId: 'contract-2', contractRevisionId: 'revision-2', systemOfRecordRef: 'ares.registry' },
        '2026-01-01T00:00:00.000Z',
        '2026-01-15T00:00:00.000Z',
      ),
    ];
    const conflictOf = (overrides: Partial<TaxSourceAssertionProposal>) => {
      const assertion = proposal(overrides);
      return taxSourceAuthorityConfigurationConflict({
        assertion: { ...assertion, eligibility: evaluateTaxSourceEligibility(assertion), sourceRef: 'erp.finance' },
        authorities: pastOverlap,
      });
    };
    // A claim inside the past overlap needs review and names both revisions.
    expect(acceptanceOf('erp.finance', pastOverlap, { validTo: instant('2026-01-10T00:00:00Z') })).toEqual({
      outcome: 'NEEDS_REVIEW',
      reason: 'AUTHORITY_CONFIGURATION_CONFLICT',
    });
    expect(conflictOf({ validTo: instant('2026-01-10T00:00:00Z') })).toEqual(['contract-revision-1', 'revision-2']);
    // A claim only after the overlap, or one accepted in a later clean segment, records no configuration conflict.
    expect(conflictOf({ validFrom: instant('2026-02-01T00:00:00Z') })).toEqual([]);
    expect(conflictOf({})).toEqual([]);
  });

  it('#959 F7-F9 F25 authority is judged per instant: a role at any claimed instant across a handoff is ACCEPTED', () => {
    const handoff = [
      period({}, '2026-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
      period(
        { contractId: 'contract-2', contractRevisionId: 'revision-2', systemOfRecordRef: 'erp.next' },
        '2026-03-01T00:00:00.000Z',
      ),
    ];
    // The former System of Record claims from before the handoff; the next one claims only after it.
    expect(acceptanceOf('erp.finance', handoff)).toEqual({ outcome: 'ACCEPTED', reason: 'ACCEPTED' });
    expect(acceptanceOf('erp.next', handoff, { validFrom: instant('2026-04-01T00:00:00Z') })).toEqual({
      outcome: 'ACCEPTED',
      reason: 'ACCEPTED',
    });
    // The next System of Record claiming only before its handoff never has a role there.
    expect(acceptanceOf('erp.next', handoff, { validTo: instant('2026-02-01T00:00:00Z') })).toEqual({
      outcome: 'REJECTED',
      reason: 'SOURCE_NOT_PERMITTED',
    });
  });

  it('#957 F21 #958 F26 an ineligible assertion is UNVERIFIABLE with VALIDITY_UNKNOWN whatever the contract', () => {
    expect(acceptanceOf('erp.finance', [period()], { validFrom: Option.none() })).toEqual({
      outcome: 'UNVERIFIABLE',
      reason: 'VALIDITY_UNKNOWN',
    });
  });
});

describe('#957 F1-F13 #959 F1-F3 F28 authority acceptance is evaluated at one business instant', () => {
  it('#957 F12-F13 the covering System of Record decides and a listed evidence source only evidences', () => {
    expect(authorityOf('erp.finance')).toEqual({
      contractRevisionId: Option.some('contract-revision-1'),
      outcome: 'ACCEPTED',
      reason: 'ACCEPTED',
      role: 'SYSTEM_OF_RECORD',
    });
    expect(authorityOf('tax.vies')).toMatchObject({ outcome: 'ACCEPTED', role: 'EVIDENCE' });
  });

  it('#957 F2-F7 F27 a source with no role there is not permitted; no provider wins globally', () => {
    for (const sourceRef of ['ares.registry', 'integration.route.vies-v2']) {
      expect(authorityOf(sourceRef)).toEqual({
        contractRevisionId: Option.some('contract-revision-1'),
        outcome: 'REJECTED',
        reason: 'SOURCE_NOT_PERMITTED',
        role: 'NONE',
      });
    }
  });

  it('#957 F29 #959 F15-F16 without a covering revision the authority is unverifiable, not negative', () => {
    expect(authorityOf('erp.finance', [])).toEqual({
      contractRevisionId: Option.none(),
      outcome: 'UNVERIFIABLE',
      reason: 'AUTHORITY_MISSING',
      role: 'NONE',
    });
  });

  it('#957 F28 #959 F2-F3 F28 competing covering revisions need review and pick no technical winner', () => {
    expect(
      authorityOf('erp.finance', [
        authority(),
        authority({ contractId: 'contract-2', contractRevisionId: 'revision-2' }),
      ]),
    ).toEqual({
      contractRevisionId: Option.none(),
      outcome: 'NEEDS_REVIEW',
      reason: 'AUTHORITY_CONFIGURATION_CONFLICT',
      role: 'NONE',
    });
    expect(
      authorityOf('crm.unrelated', [
        authority(),
        authority({ contractId: 'contract-2', contractRevisionId: 'revision-2', systemOfRecordRef: 'ares.registry' }),
      ]),
    ).toEqual({
      contractRevisionId: Option.none(),
      outcome: 'REJECTED',
      reason: 'SOURCE_NOT_PERMITTED',
      role: 'NONE',
    });
  });
});
