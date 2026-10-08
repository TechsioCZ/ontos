import { DateTime, Schema } from 'effect';

import { TaxEvaluationRequestSchema } from '../../src/domain/tax-evaluation-request.ts';
import type { TaxEvaluationRequest } from '../../src/domain/tax-evaluation-request.ts';
import { evaluateProspectiveLaunchTax } from '../../src/domain/tax-evaluation.ts';
import type { TaxEvaluationOwnState, TaxRuleSetObservation } from '../../src/domain/tax-evaluation.ts';
import type { TaxOutcome } from '../../src/domain/tax-outcome.ts';
import { TaxEvaluationTimeSchema } from '../../src/domain/tax-time.ts';
import { taxMeaningFingerprint } from '../../src/services/tax-governance-fingerprint.ts';
import { exactDecimal, purchaseBindingInput } from './tax-domain-fixtures.ts';

export type TaxEvaluationRequestInput = typeof TaxEvaluationRequestSchema.Encoded;

export const decodeEvaluationRequest = Schema.decodeUnknownSync(TaxEvaluationRequestSchema);

export const PRICING_RESULT_REF = { pricingResultId: 'pricing-result-1', revision: 1 } as const;

export const STANDARD_CODE = 'cz-standard-goods';
export const REDUCED_CODE = 'cz-reduced-food';

type CatalogEntryInput = TaxEvaluationRequestInput['catalog'][number];
type CatalogSelectionInput = CatalogEntryInput['classificationInput']['catalogSelection'];

/** Catalog evidence of one occurrence: a single Current TAX_CATEGORY fact unless overridden. */
export const catalogEntry = (
  occurrenceId: string,
  code: string,
  options: Readonly<{ catalogSelection?: CatalogSelectionInput; factKind?: string; revision?: string }> = {},
): CatalogEntryInput => ({
  classificationInput: {
    catalogSelection: options.catalogSelection ?? { productRef: 'product-1', variantRef: 'variant-1' },
    evidencePurpose: 'TAX',
    materialCatalogEvidence: [
      {
        _tag: 'CURRENT',
        catalogFactRef: `${occurrenceId}:tax-category`,
        catalogFactRevisionRef: options.revision ?? 'r1',
        factKind: options.factKind ?? 'TAX_CATEGORY',
        factValue: code,
        ownerEvidenceRef: `catalog-evidence:${occurrenceId}:${options.revision ?? 'r1'}`,
      },
    ],
    materialEvidenceCompleteness: { _tag: 'OWNER_VERIFIED_COMPLETE', ownerEvidenceRef: 'catalog-completeness-1' },
  },
  occurrenceId,
});

type PublishedLineInput = TaxEvaluationRequestInput['pricing']['publishedLines'][number];

export const pricingLine = (occurrenceId: string, value: string, currency = 'CZK'): PublishedLineInput => ({
  breakdown: [],
  lineCommercialValue: { amount: exactDecimal(value), currency },
  occurrenceId,
  pricingLineRef: `pricing-line-${occurrenceId}`,
});

/** One CZ domestic purchase; occurrence `o1` is standard-rated at 1000 CZK, `o2` (when present) reduced at 500 CZK. */
export const evaluationRequestInput = (
  overrides: Partial<TaxEvaluationRequestInput> = {},
  occurrenceIds: readonly [string, ...string[]] = ['o1', 'o2'],
): TaxEvaluationRequestInput => ({
  catalog: [
    catalogEntry(occurrenceIds[0], STANDARD_CODE),
    ...occurrenceIds.slice(1).map((occurrenceId) => catalogEntry(occurrenceId, REDUCED_CODE)),
  ],
  decompositionNeed: 'PER_TAXABLE_SUPPLY_UNIT',
  places: {
    deliveryDestination: { _tag: 'OWNER_RESOLVED', countryCode: 'CZ', ownerEvidenceRef: 'delivery-evidence-1' },
    invoiceRecipient: { _tag: 'NOT_MATERIAL' },
    sellingLegalEntity: { _tag: 'OWNER_RESOLVED', countryCode: 'CZ', ownerEvidenceRef: 'seller-place-evidence-1' },
  },
  pricing: {
    pricingResultRef: PRICING_RESULT_REF,
    publishedLines: [
      pricingLine(occurrenceIds[0], '1000.00'),
      ...occurrenceIds.slice(1).map((occurrenceId) => pricingLine(occurrenceId, '500.00')),
    ],
  },
  purchase: purchaseBindingInput(occurrenceIds),
  taxRelevantTime: '2026-10-08T10:00:00.000Z',
  ...overrides,
});

export const evaluationRequest = (
  overrides: Partial<TaxEvaluationRequestInput> = {},
  occurrenceIds: readonly [string, ...string[]] = ['o1', 'o2'],
): TaxEvaluationRequest => decodeEvaluationRequest(evaluationRequestInput(overrides, occurrenceIds));

export const selected = (ratePercent: string, taxRuleId: string, revisionNumber = 1): TaxRuleSetObservation => ({
  applicable: [{ ratePercent, revisionNumber, taxRuleId, treatmentCategory: 'TAXABLE' }],
  outcome: 'SELECTED',
});

export const ownState = (overrides: Partial<TaxEvaluationOwnState> = {}): TaxEvaluationOwnState => ({
  ruleSets: new Map([
    [STANDARD_CODE, selected('21', 'rule-standard')],
    [REDUCED_CODE, selected('12', 'rule-reduced')],
  ]),
  sellerVatRegistration: 'CURRENT_POSITIVE',
  ...overrides,
});

export const evaluationTime = TaxEvaluationTimeSchema.make(DateTime.makeUnsafe('2026-10-08T10:00:02.000Z'));

export const evaluate = (
  request: TaxEvaluationRequest = evaluationRequest(),
  state: TaxEvaluationOwnState = ownState(),
  taxEvaluationTime = evaluationTime,
): TaxOutcome =>
  evaluateProspectiveLaunchTax(request, state, { fingerprint: taxMeaningFingerprint, taxEvaluationTime });
