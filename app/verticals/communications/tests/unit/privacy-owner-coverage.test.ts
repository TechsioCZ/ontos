import { describe, expect, it } from 'effect-rstest';

import { assessCommunicationsOwnerCoverage } from '../../shared/privacy-owner/coverage.ts';
import { assembleCommunicationsContribution } from '../../shared/privacy-owner/contribution.ts';
import { INVENTORY_CATEGORY_IDS, scopePartRef, scopePartRefs } from '../../shared/privacy-owner/inventory.ts';
import {
  allComplete,
  coverageOf,
  intentRef,
  observation,
  observedAt,
  ownerScope,
  requestRef,
} from './support/privacy-owner-fixtures.ts';

/**
 * [#1410 PRIV-COM-10/11, AC-08, BDD "Coverage a DSR vystupy zustavaji pravdive"] Communications' Owner Coverage Result: NO_DATA
 * only when every requested part is completely evidenced; an unobserved, partial, unavailable or foreign part never is.
 */
describe('Communications Owner Coverage Result', () => {
  it('is a provable complete NO_DATA only when every requested part is completely examined and empty', () => {
    const result = coverageOf(allComplete());
    expect(result.coverageStatus).toBe('COMPLETE');
    expect(result.contentStatus).toBe('NO_DATA');
    expect(result.coverageParts).toHaveLength(INVENTORY_CATEGORY_IDS.length);
  });

  it('reports FOUND with complete coverage when records exist', () => {
    const result = coverageOf(allComplete({ REQUEST_DECISION_INTENT: { foundContentRefs: [requestRef('r1')] } }));
    expect([result.coverageStatus, result.contentStatus]).toEqual(['COMPLETE', 'FOUND']);
  });

  it('never turns an unobserved part into NO_DATA: a missing observation is INDETERMINATE', () => {
    const result = coverageOf(
      allComplete().filter(({ category }) => category !== 'ATTEMPTS_PROVIDER_OBSERVATIONS_SUPPRESSION'),
    );
    expect(result.coverageStatus).toBe('INDETERMINATE');
    expect(result.contentStatus).toBe('UNKNOWN');
    expect(
      result.coverageParts.find(
        ({ scopeRef }) => scopeRef === scopePartRef('ATTEMPTS_PROVIDER_OBSERVATIONS_SUPPRESSION'),
      )?.unresolvedReason,
    ).toBe('REQUIRED_COMMUNICATIONS_OWNER_SCOPE_NOT_OBSERVED');
  });

  it('keeps a part with an unavailable backup partial, so an empty search is never full NO_DATA (AC-08)', () => {
    const result = coverageOf(
      allComplete({
        PROVIDER_COPY_WORKING_COPY_PROTECTION: {
          coverageStatus: 'PARTIAL',
          unresolvedReason: 'BACKUP_AND_RECOVERY_COPIES_NOT_OBSERVABLE_BY_OWNER',
        },
      }),
    );
    expect(result.coverageStatus).toBe('PARTIAL');
    expect(result.contentStatus).toBe('UNKNOWN');
  });

  it('ranks unavailable and indeterminate above partial, and never lets complete parts outvote them', () => {
    const result = coverageOf(
      allComplete({
        ORIGINAL_RECIPIENT_ENDPOINT: { coverageStatus: 'UNAVAILABLE', unresolvedReason: 'OWNER_RECORDS_UNAVAILABLE' },
        REQUEST_DECISION_INTENT: { coverageStatus: 'PARTIAL', unresolvedReason: 'SHARED' },
      }),
    );
    expect(result.coverageStatus).toBe('UNAVAILABLE');
  });

  it('rejects a duplicate observation of one part instead of choosing one', () => {
    const result = coverageOf([...allComplete(), observation('REQUEST_DECISION_INTENT')]);
    expect(result.coverageStatus).toBe('INDETERMINATE');
  });

  it('answers INDETERMINATE for another owner capability and for a part Communications does not own', () => {
    const foreign = coverageOf(allComplete(), ownerScope({ ownerCapability: 'commerce.tax' }));
    expect(foreign.coverageStatus).toBe('INDETERMINATE');
    expect(
      foreign.coverageParts.every(
        ({ unresolvedReason }) => unresolvedReason === 'NOT_A_COMMUNICATIONS_OWNER_CAPABILITY_SCOPE',
      ),
    ).toBe(true);
    const unknownPart = assessCommunicationsOwnerCoverage({
      assessedAt: observedAt,
      evidenceRefs: [],
      observations: allComplete(),
      scope: ownerScope({
        requestedScopePartRefs: [...scopePartRefs, 'communications.core/privacy-owner-scope/INVENTED'],
      }),
    });
    expect(unknownPart.coverageStatus).toBe('INDETERMINATE');
    expect(unknownPart.contentStatus).toBe('UNKNOWN');
  });

  it('judges exactly the requested parts and keeps each part observation time (no atomic snapshot claim)', () => {
    const subset = coverageOf(
      allComplete(),
      ownerScope({ requestedScopePartRefs: [scopePartRef('REQUEST_DECISION_INTENT')] }),
    );
    expect(subset.coverageParts.map(({ scopeRef }) => scopeRef)).toEqual([scopePartRef('REQUEST_DECISION_INTENT')]);
    expect(subset.coverageParts[0]?.observedAt).toBe(observedAt);
  });
});

const own = (contentRef: string, category: (typeof INVENTORY_CATEGORY_IDS)[number] = 'REQUEST_DECISION_INTENT') => ({
  category,
  containsOtherDataSubjects: false,
  contentRef,
  separable: true,
});

/** [#1410 PRIV-COM-11, BDD "Bezny nahled metadata neomezi zakonnou DSR zadost", #598] Right-specific contribution. */
describe('Communications right-specific Owner Contribution', () => {
  it('includes every held record for an access right: the ordinary metadata view is not a blanket limit', () => {
    const coverage = coverageOf(
      allComplete({ REQUEST_DECISION_INTENT: { foundContentRefs: [requestRef('r1'), intentRef('i1')] } }),
    );
    const contribution = assembleCommunicationsContribution({
      coverage,
      items: [own(requestRef('r1')), own(intentRef('i1'), 'ORIGINAL_RECIPIENT_ENDPOINT')],
      right: 'ACCESS',
    });
    expect(contribution.completion).toBe('COMPLETE');
    expect(contribution.includedContentRefs).toEqual([requestRef('r1'), intentRef('i1')]);
  });

  it('redacts the separable third-party part and excludes inseparable third-party content', () => {
    const coverage = coverageOf(
      allComplete({ REQUEST_DECISION_INTENT: { foundContentRefs: [requestRef('r1'), intentRef('i2')] } }),
    );
    const contribution = assembleCommunicationsContribution({
      coverage,
      items: [
        { ...own(requestRef('r1')), containsOtherDataSubjects: true, separable: true },
        { ...own(intentRef('i2')), containsOtherDataSubjects: true, separable: false },
      ],
      right: 'ACCESS',
    });
    expect(contribution.decisions.map(({ outcome }) => outcome)).toEqual(['REDACT', 'EXCLUDE']);
    expect(contribution.includedContentRefs).toEqual([requestRef('r1')]);
    expect(contribution.exclusions.map(({ scopeRef }) => scopeRef)).toEqual([intentRef('i2')]);
    // a lawful exclusion of another person's data does not make the contribution incomplete
    expect(contribution.completion).toBe('COMPLETE');
  });

  it('is incomplete whenever the coverage is, and cannot be completed from an absence in a list', () => {
    const partial = coverageOf(
      allComplete({ ORIGINAL_RECIPIENT_ENDPOINT: { coverageStatus: 'PARTIAL', unresolvedReason: 'SHARED_CONTACT' } }),
    );
    expect(assembleCommunicationsContribution({ coverage: partial, items: [], right: 'ACCESS' }).completion).toBe(
      'INCOMPLETE',
    );
  });

  it('does not decide portability from an invented legal basis: it needs a supplied eligibility per category', () => {
    const coverage = coverageOf(allComplete({ REQUEST_DECISION_INTENT: { foundContentRefs: [requestRef('r1')] } }));
    const unresolved = assembleCommunicationsContribution({
      coverage,
      items: [own(requestRef('r1'))],
      right: 'PORTABILITY',
    });
    expect(unresolved.completion).toBe('INCOMPLETE');
    expect(unresolved.unresolvedCategories).toEqual(['REQUEST_DECISION_INTENT']);
    expect(unresolved.includedContentRefs).toEqual([]);
    const supplied = assembleCommunicationsContribution({
      coverage,
      eligibility: { PORTABILITY: { REQUEST_DECISION_INTENT: true } },
      items: [own(requestRef('r1'))],
      right: 'PORTABILITY',
    });
    expect(supplied.completion).toBe('COMPLETE');
    const ineligible = assembleCommunicationsContribution({
      coverage,
      eligibility: { PORTABILITY: { REQUEST_DECISION_INTENT: false } },
      items: [own(requestRef('r1'))],
      right: 'PORTABILITY',
    });
    expect(ineligible.exclusions).toHaveLength(1);
  });
});
