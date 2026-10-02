import { NodeFileSystem, NodeServices } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { describe, expect, it } from 'effect-rstest';

import {
  ISSUE_738_ACTIVE_PRICING_LEAVES,
  ISSUE_738_FIXED_BASE,
  ISSUE_738_NON_PRICING_DISPOSITIONS,
  ISSUE_738_NON_PRICING_SCOPE_LEDGER,
  ISSUE_738_OUT_OF_SCOPE_PATH_PREFIXES,
  ISSUE_738_PRICING_OWNED_PATH_PREFIXES,
  ISSUE_738_REVIEWED_HEAD,
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

it.layer(NodeServices.layer)('issue #738 fixed-base scope disposition', (suite) => {
  suite.effect('covers every reviewed non-Pricing path and records the accepted live disposition', () =>
    Effect.gen(function* exhaustiveNonPricingDisposition() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const reviewedChangedPaths = yield* spawner.lines(
        ChildProcess.make('git', [
          '-C',
          worktreeRoot.pathname,
          'diff',
          '--name-only',
          ISSUE_738_FIXED_BASE,
          ISSUE_738_REVIEWED_HEAD,
          '--',
        ]),
      );
      const [headParentsLine] = yield* spawner.lines(
        ChildProcess.make('git', ['-C', worktreeRoot.pathname, 'show', '--no-patch', '--format=%P', 'HEAD']),
      );
      const [firstParent, secondParent] = headParentsLine?.split(' ') ?? [];
      let firstParentReviewedBase: string | undefined;
      if (firstParent !== undefined && firstParent.length > 0) {
        [firstParentReviewedBase] = yield* spawner.lines(
          ChildProcess.make('git', ['-C', worktreeRoot.pathname, 'merge-base', ISSUE_738_REVIEWED_HEAD, firstParent]),
        );
      }
      let secondParentReviewedBase: string | undefined;
      if (secondParent !== undefined && secondParent.length > 0) {
        [secondParentReviewedBase] = yield* spawner.lines(
          ChildProcess.make('git', ['-C', worktreeRoot.pathname, 'merge-base', ISSUE_738_REVIEWED_HEAD, secondParent]),
        );
      }
      // Pull-request and merge-queue checkouts wrap the branch in a temporary merge whose first parent
      // is main. Follow the parent that contains the reviewed branch head before finding its integration.
      let branchHistoryHead = 'HEAD';
      if (firstParentReviewedBase !== ISSUE_738_REVIEWED_HEAD && secondParentReviewedBase === ISSUE_738_REVIEWED_HEAD) {
        branchHistoryHead = 'HEAD^2';
      }
      const [latestMergeParents] = yield* spawner.lines(
        ChildProcess.make('git', [
          '-C',
          worktreeRoot.pathname,
          'log',
          '--first-parent',
          '--merges',
          '--format=%P',
          '-1',
          branchHistoryHead,
        ]),
      );
      const integratedMainBase =
        latestMergeParents?.split(' ')[1] ??
        (yield* Effect.die('The #738 branch must retain its latest-main integration merge'));
      const liveTrackedChangedPaths = yield* spawner.lines(
        ChildProcess.make('git', ['-C', worktreeRoot.pathname, 'diff', '--name-only', integratedMainBase, '--']),
      );
      const liveUntrackedChangedPaths = yield* spawner.lines(
        ChildProcess.make('git', [
          '-C',
          worktreeRoot.pathname,
          'ls-files',
          '--others',
          '--exclude-standard',
          '--exclude=node_modules/**',
          '--',
          '.',
        ]),
      );
      const liveChangedPaths = [...new Set([...liveTrackedChangedPaths, ...liveUntrackedChangedPaths])];
      const reviewedNonPricingPaths = reviewedChangedPaths.filter(
        (path) => path.length > 0 && !ISSUE_738_PRICING_OWNED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)),
      );
      const liveNonPricingPaths = liveChangedPaths.filter(
        (path) => path.length > 0 && !ISSUE_738_PRICING_OWNED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)),
      );
      const ledgerPaths = ISSUE_738_NON_PRICING_SCOPE_LEDGER.map(({ path }) => path);
      const expectedLedgerPaths = [...new Set([...reviewedNonPricingPaths, ...liveNonPricingPaths])];
      const retainedLedgerPaths = ISSUE_738_NON_PRICING_SCOPE_LEDGER.filter(
        ({ disposition }) => disposition !== 'remove',
      ).map(({ path }) => path);
      const removedLedgerPaths = ISSUE_738_NON_PRICING_SCOPE_LEDGER.filter(
        ({ disposition }) => disposition === 'remove',
      ).map(({ path }) => path);

      expect(reviewedNonPricingPaths).toHaveLength(94);
      expect(new Set(ledgerPaths).size, 'the disposition map must not claim one path twice').toBe(ledgerPaths.length);
      expect(ledgerPaths.toSorted()).toEqual(expectedLedgerPaths.toSorted());
      expect(retainedLedgerPaths.toSorted()).toEqual(liveNonPricingPaths.toSorted());
      expect(removedLedgerPaths).toHaveLength(8);
      expect(
        liveNonPricingPaths.filter((path) =>
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
    }),
  );
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
