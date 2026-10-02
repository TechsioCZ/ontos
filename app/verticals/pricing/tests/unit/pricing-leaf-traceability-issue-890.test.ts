import { createHash } from 'node:crypto';

import { NodeFileSystem } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ISSUE_738_ACCEPTED_NON_PRICING_PATH_HASHES,
  ISSUE_738_ACTIVE_PRICING_LEAVES,
  ISSUE_738_NON_PRICING_DISPOSITIONS,
  ISSUE_738_NON_PRICING_SCOPE_LEDGER,
  ISSUE_738_OUT_OF_SCOPE_PATH_PREFIXES,
  ISSUE_738_REVIEWED_NON_PRICING_PATH_HASHES,
  issue738LeafTraceability,
  issue738RoadmapAuthority,
} from './support/issue-738-leaf-traceability.ts';

const expectedActivePricingIssues = [
  751, 752, 753, 754, 755, 756, 757, 758, 759, 760, 761, 762, 763, 764, 765, 766, 767, 768, 769, 770, 771, 772, 773,
  774, 775, 776, 777, 778, 779, 780, 781, 782, 783, 784, 785, 786, 787, 788, 789, 790, 791, 792, 793, 795, 797, 799,
  800, 802, 803, 805, 807, 890,
] as const;
const expectedAuthorizedOwnerIssues = [333, 346, 452, 476, 479] as const;
const deferredIssueStart = 891;
const deferredIssueEnd = 905;
const worktreeRoot = new URL('../../../../../', import.meta.url);

describe('issue #890 leaf traceability for the #738 remediation', () => {
  it('covers every active leaf and authorized owner contract exactly once', () => {
    const implementationRows = issue738LeafTraceability.filter(
      (row) =>
        row.proofClassification !== 'contract-only' &&
        row.proofClassification !== 'deferred-boundary' &&
        row.proofClassification !== 'fixture-only',
    );
    const mappedPricingIssues = implementationRows
      .filter(({ owner }) => owner === 'pricing')
      .map(({ issue }) => issue)
      .toSorted((left, right) => left - right);
    const mappedOwnerIssues = implementationRows
      .filter(({ owner }) => owner !== 'pricing')
      .map(({ issue }) => issue)
      .toSorted((left, right) => left - right);

    expect(ISSUE_738_ACTIVE_PRICING_LEAVES).toEqual(expectedActivePricingIssues);
    expect(mappedPricingIssues).toEqual(expectedActivePricingIssues);
    expect(new Set(mappedPricingIssues).size).toBe(mappedPricingIssues.length);
    expect(mappedOwnerIssues).toEqual(expectedAuthorizedOwnerIssues);
    expect(new Set(mappedOwnerIssues).size).toBe(mappedOwnerIssues.length);

    const unpublishedConfirmationRows = issue738LeafTraceability.flatMap((row) =>
      'deferredProductionPublication' in row
        ? [
            {
              boundary: row.deferredProductionPublication,
              id: row.id,
              proofClassification: row.proofClassification,
              tests: row.tests,
            },
          ]
        : [],
    );
    expect(unpublishedConfirmationRows.map(({ id }) => id)).toEqual([
      'pricing-788-confirmation',
      'pricing-800-audit-and-visibility',
    ]);
    expect(
      unpublishedConfirmationRows.every(
        ({ boundary, proofClassification, tests }) =>
          boundary.disposition === 'intentionally-unpublished' &&
          boundary.issue === 902 &&
          boundary.status === 'park' &&
          proofClassification === 'owner-service-contract' &&
          tests.includes('app/verticals/pricing/tests/unit/commitment-confirmation-publication-boundary.test.ts'),
      ),
    ).toBe(true);
  });

  it('keeps PARK and LATER issues out of implementation ownership', () => {
    const deferredImplementationOwners = issue738LeafTraceability
      .filter(({ issue }) => issue >= deferredIssueStart && issue <= deferredIssueEnd)
      .map(({ issue }) => issue);
    const boundaryRows = issue738LeafTraceability.filter((row) => 'boundaryIssue' in row);

    expect(deferredImplementationOwners).toEqual([]);
    expect(boundaryRows.map((row) => ('boundaryIssue' in row ? row.boundaryIssue : undefined))).toEqual([
      894, 894, 894,
    ]);
    expect(boundaryRows.map(({ issue }) => issue)).toEqual([775, 775, 775]);
    expect(boundaryRows.map(({ proofClassification }) => proofClassification).toSorted()).toEqual([
      'contract-only',
      'deferred-boundary',
      'fixture-only',
    ]);
  });

  it('records the superseding #253 comment as roadmap authority', () => {
    expect(issue738RoadmapAuthority).toEqual({
      issue: 253,
      supersedingComment: 'https://github.com/TechsioCZ/ontos/issues/253#issuecomment-5661414584',
    });
  });
});

describe('issue #738 accepted remediation scope disposition', () => {
  it('covers every reviewed non-Pricing path and records the complete accepted disposition', () => {
    const ledgerPathRecords = ISSUE_738_NON_PRICING_SCOPE_LEDGER.map(({ path }) => ({
      path,
      pathHash: createHash('sha256').update(path).digest('hex'),
    }));
    const ledgerPaths = ledgerPathRecords.map(({ path }) => path);
    const reviewedPathHashes = new Set<string>(ISSUE_738_REVIEWED_NON_PRICING_PATH_HASHES);
    const reviewedPathRecords = ledgerPathRecords.filter(({ pathHash }) => reviewedPathHashes.has(pathHash));
    const reviewedNonPricingPaths = reviewedPathRecords.map(({ path }) => path);
    const acceptedPathHashes = new Set<string>(ISSUE_738_ACCEPTED_NON_PRICING_PATH_HASHES);
    const acceptedPathRecords = ledgerPathRecords.filter(({ pathHash }) => acceptedPathHashes.has(pathHash));
    const acceptedNonPricingPaths = acceptedPathRecords.map(({ path }) => path);
    const expectedLedgerPaths = [...new Set([...reviewedNonPricingPaths, ...acceptedNonPricingPaths])];
    const retainedLedgerPaths = ISSUE_738_NON_PRICING_SCOPE_LEDGER.filter(
      ({ disposition }) => disposition !== 'remove',
    ).map(({ path }) => path);
    const removedLedgerPaths = ISSUE_738_NON_PRICING_SCOPE_LEDGER.filter(
      ({ disposition }) => disposition === 'remove',
    ).map(({ path }) => path);

    expect(ISSUE_738_ACCEPTED_NON_PRICING_PATH_HASHES).toHaveLength(103);
    expect(acceptedPathHashes.size, 'accepted remediation fingerprints must be unique').toBe(103);
    expect(acceptedPathRecords).toHaveLength(103);
    expect(new Set(acceptedPathRecords.map(({ pathHash }) => pathHash))).toEqual(acceptedPathHashes);
    expect(reviewedNonPricingPaths).toHaveLength(94);
    expect(new Set(reviewedPathRecords.map(({ pathHash }) => pathHash))).toEqual(reviewedPathHashes);
    expect(new Set(ledgerPaths).size, 'the disposition map must not claim one path twice').toBe(ledgerPaths.length);
    expect(expectedLedgerPaths).toHaveLength(111);
    expect(ledgerPaths.toSorted()).toEqual(expectedLedgerPaths.toSorted());
    expect(retainedLedgerPaths.toSorted()).toEqual(acceptedNonPricingPaths.toSorted());
    expect(removedLedgerPaths).toHaveLength(8);
    expect(new Set(removedLedgerPaths.map((path) => createHash('sha256').update(path).digest('hex')))).toEqual(
      new Set([...reviewedPathHashes].filter((pathHash) => !acceptedPathHashes.has(pathHash))),
    );
    expect(
      acceptedNonPricingPaths.filter((path) =>
        ISSUE_738_OUT_OF_SCOPE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)),
      ),
    ).toEqual([]);
    expect(
      ISSUE_738_NON_PRICING_DISPOSITIONS.filter(
        ({ disposition, owner }) =>
          disposition === 'keep' &&
          (owner === 'catalog' || owner === 'commerce-customer-context' || owner === 'commerce-market-catalog'),
      ).map(({ owner }) => owner),
    ).toEqual(['catalog', 'commerce-customer-context', 'commerce-market-catalog']);
    expect(
      ISSUE_738_NON_PRICING_SCOPE_LEDGER.every(
        ({
          approvalOrPrEvidence,
          exactIssueEvidence,
          executionStatusEvidence,
          issues,
          reason,
          requiredByNowPricingLeaves,
        }) =>
          approvalOrPrEvidence.length > 0 &&
          exactIssueEvidence.length > 0 &&
          executionStatusEvidence.length > 0 &&
          issues.length > 0 &&
          reason.length > 0 &&
          requiredByNowPricingLeaves.length > 0,
      ),
    ).toBe(true);
    expect(
      ISSUE_738_NON_PRICING_SCOPE_LEDGER.filter(
        ({ exactIssueEvidence, executionStatusEvidence }) =>
          exactIssueEvidence.includes('HITL_REQUIRED') || executionStatusEvidence.includes('HITL_REQUIRED'),
      ).every(({ hitlRequired }) => hitlRequired),
    ).toBe(true);
  });
});

it.layer(NodeFileSystem.layer)('issue #890 leaf traceability checked-in paths', (suite) => {
  suite.effect('keeps row IDs unique and every file reference checked in', () =>
    Effect.gen(function* checkedInTraceabilityPaths() {
      const fileSystem = yield* FileSystem.FileSystem;
      const rowIds = issue738LeafTraceability.map(({ id }) => id);
      const referencedPaths = issue738LeafTraceability.flatMap(({ productionRefs, tests }) => [
        ...productionRefs,
        ...tests,
      ]);
      const pathExistence = yield* Effect.forEach((path: string) =>
        fileSystem.exists(new URL(path, worktreeRoot).pathname),
      )(referencedPaths);
      const missingPaths = referencedPaths.filter((_, index) => pathExistence[index] !== true);

      expect(new Set(rowIds).size).toBe(rowIds.length);
      expect(missingPaths).toEqual([]);
    }),
  );
});
