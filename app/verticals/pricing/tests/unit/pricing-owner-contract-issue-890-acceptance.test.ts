import { fileURLToPath } from 'node:url';

import { NodeFileSystem } from '@effect/platform-node';
import { PricingCommercialTotalReadySchema } from '@app/pricing-contracts/domain/commercial-total';
import { PricingWholePurchaseContractualEligibleBasisSchema } from '@app/pricing-contracts/domain/discount';
import { Effect, FileSystem, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { makeIssue788CommercialTotal } from './support/issue-788-confirmation.fixture.ts';
import {
  ISSUE_890_OWNER_EVIDENCE_MAP,
  ISSUE_890_REQUIRED_INVARIANT_IDS,
} from './support/issue-890-owner-evidence-map.ts';

const decodeCommercialTotal = Schema.decodeUnknownSync(PricingCommercialTotalReadySchema, {
  onExcessProperty: 'error',
});
const decodeWholePurchaseBasis = Schema.decodeUnknownSync(PricingWholePurchaseContractualEligibleBasisSchema, {
  onExcessProperty: 'error',
});
const repositoryRoot = new URL('../../../../../', import.meta.url);

describe('issue #890 Pricing owner contract acceptance', () => {
  it('keeps one typed evidence row for every required invariant', () => {
    const evidenceIds = ISSUE_890_OWNER_EVIDENCE_MAP.map(({ id }) => id);

    expect(new Set(evidenceIds).size).toBe(evidenceIds.length);
    expect(evidenceIds.toSorted()).toEqual([...ISSUE_890_REQUIRED_INVARIANT_IDS].toSorted());

    for (const row of ISSUE_890_OWNER_EVIDENCE_MAP) {
      expect(row.owningNowIssue).toMatch(/^#\d+$/u);
      if (row.status === 'proved') {
        expect(row.productionRefs.length).toBeGreaterThan(0);
        expect(row.testRefs.length).toBeGreaterThan(0);
      } else {
        expect(row.proofKind).toBe('unresolved-gap');
        expect(row.reason.trim().length).toBeGreaterThan(0);
      }
    }

    const unpublishedConfirmationRows = ISSUE_890_OWNER_EVIDENCE_MAP.flatMap((row) =>
      'deferredProductionPublication' in row
        ? [
            {
              boundary: row.deferredProductionPublication,
              id: row.id,
              proofKind: row.proofKind,
              testRefs: row.testRefs,
            },
          ]
        : [],
    );
    expect(unpublishedConfirmationRows.map(({ id }) => id)).toEqual([
      'current-backed-confirmation-issuance',
      'quotation-backed-confirmation-issuance',
      'confirmation-renewal',
      'authorized-internal-evidence',
    ]);
    expect(
      unpublishedConfirmationRows.every(
        ({ boundary, proofKind, testRefs }) =>
          boundary.disposition === 'intentionally-unpublished' &&
          boundary.issue === '#902' &&
          boundary.status === 'park' &&
          proofKind === 'owner-service-contract' &&
          testRefs.includes('app/verticals/pricing/tests/unit/commitment-confirmation-publication-boundary.test.ts'),
      ),
    ).toBe(true);
  });

  it.layer(NodeFileSystem.layer)('repository file evidence', (suite) => {
    suite.effect('references only files that exist in the repository', () =>
      Effect.gen(function* referencedFilesExist() {
        const fileSystem = yield* FileSystem.FileSystem;
        const references = ISSUE_890_OWNER_EVIDENCE_MAP.flatMap((row) => [...row.productionRefs, ...row.testRefs]);
        const checkedRefs = yield* Effect.forEach(
          references,
          (reference) =>
            fileSystem
              .exists(fileURLToPath(new URL(reference, repositoryRoot)))
              .pipe(Effect.map((exists) => ({ exists, reference }))),
          { concurrency: 'unbounded' },
        );

        expect(checkedRefs.filter(({ exists }) => !exists).map(({ reference }) => reference)).toEqual([]);
      }),
    );
  });

  it.effect('rejects an extra split output line and preserves one result for each original occurrence', () =>
    Effect.gen(function* rejectsSplitOutputLine() {
      const ready = yield* makeIssue788CommercialTotal();
      expect(decodeCommercialTotal(ready)).toEqual(ready);

      const [publishedLine] = ready.publishedLines;
      if (publishedLine === undefined) {
        throw new Error('Issue #890 requires one published Pricing line');
      }

      expect(() =>
        decodeCommercialTotal({
          ...ready,
          publishedLines: [
            publishedLine,
            {
              ...publishedLine,
              occurrenceId: `${publishedLine.occurrenceId}-split`,
            },
          ],
        }),
      ).toThrow();
    }),
  );

  it('excludes negative, zero, and Shipping lines from the whole-purchase merchandise basis', () => {
    const validBasis = {
      currencyCode: 'CZK',
      eligibleAmount: '10',
      recipients: [
        {
          intermediateValue: { amount: '10', currencyCode: 'CZK' },
          occurrenceId: 'line-positive',
          recipientKind: 'MERCHANDISE',
        },
      ],
    } as const;
    expect(decodeWholePurchaseBasis(validBasis)).toEqual(validBasis);

    for (const excludedRecipient of [
      {
        intermediateValue: { amount: '-1', currencyCode: 'CZK' },
        occurrenceId: 'line-negative',
        recipientKind: 'MERCHANDISE',
      },
      {
        intermediateValue: { amount: '0', currencyCode: 'CZK' },
        occurrenceId: 'line-zero',
        recipientKind: 'MERCHANDISE',
      },
      {
        intermediateValue: { amount: '10', currencyCode: 'CZK' },
        occurrenceId: 'line-shipping',
        recipientKind: 'SHIPPING',
      },
    ] as const) {
      expect(() =>
        decodeWholePurchaseBasis({
          currencyCode: 'CZK',
          eligibleAmount: excludedRecipient.intermediateValue.amount,
          recipients: [excludedRecipient],
        }),
      ).toThrow();
    }
  });
});
