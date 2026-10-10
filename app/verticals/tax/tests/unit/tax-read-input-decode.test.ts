import { randomUUID } from 'node:crypto';

import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ApplicableTaxRuleSetRequestSchema } from '../../shared/apis/applicable-tax-rule-set.ts';
import { SellerVatRegimeAtInstantRequestSchema } from '../../shared/apis/seller-vat-regime-at-instant.ts';
import { TaxCorrectionPreviewRequestSchema } from '../../shared/apis/tax-correction-preview.ts';
import { TaxEvaluationRequestSchema } from '../../shared/apis/tax-evaluation.ts';
import { TaxMaterialityComparisonRequestSchema } from '../../shared/apis/tax-materiality-comparison.ts';
import { TaxRuleHistoryRequestSchema } from '../../shared/apis/tax-rule-history.ts';
import { applicableTaxRuleSetRead } from '../../src/api/applicable-tax-rule-set.read.ts';
import { sellerVatRegimeAtInstantRead } from '../../src/api/seller-vat-regime-at-instant.read.ts';
import { taxCorrectionPreviewRead } from '../../src/api/tax-correction-preview.read.ts';
import { taxEvaluationRead } from '../../src/api/tax-evaluation.read.ts';
import { taxMaterialityComparisonRead } from '../../src/api/tax-materiality-comparison.read.ts';
import { taxRuleHistoryRead } from '../../src/api/tax-rule-history.read.ts';
import { acceptedTaxTermsInput } from './tax-correction-fixtures.ts';
import { evaluate, evaluationRequestInput } from './tax-evaluation-fixtures.ts';

/**
 * `HttpApiBuilder` decodes each read's HTTP payload with the endpoint schema before the governed-read handler hands it
 * to Read Runtime, which decodes it again with the read's own `inputSchema`. A request schema with an encoding (the
 * `DateTimeUtcFromString` times) must therefore be transformed exactly once: the second step only validates the
 * already-decoded value, never re-decodes it from a wire string.
 */
const readRuntimeAccepts = <Value>(inputSchema: Schema.Decoder<Value>, httpDecoded: Value) =>
  Schema.decodeUnknownResult(inputSchema, { onExcessProperty: 'error' })(httpDecoded);

describe('TAX governed reads decode their HTTP payload exactly once', () => {
  it('applicable Tax Rule Set: the decoded Tax-Relevant Time passes Read Runtime unchanged', () => {
    const httpDecoded = Schema.decodeUnknownSync(ApplicableTaxRuleSetRequestSchema)({
      jurisdiction: 'CZ_DOMESTIC',
      taxClassificationCode: 'cz-standard-goods',
      taxRelevantTime: '2026-06-01T00:00:00.000Z',
    });
    const accepted = readRuntimeAccepts(applicableTaxRuleSetRead.descriptor.inputSchema, httpDecoded);
    expect(Result.getOrThrow(accepted)).toEqual(httpDecoded);
  });

  it('Seller VAT Regime at an instant: the decoded instant passes Read Runtime unchanged', () => {
    const httpDecoded = Schema.decodeUnknownSync(SellerVatRegimeAtInstantRequestSchema)({
      instant: '2026-06-01T00:00:00.000Z',
    });
    const accepted = readRuntimeAccepts(sellerVatRegimeAtInstantRead.descriptor.inputSchema, httpDecoded);
    expect(Result.getOrThrow(accepted)).toEqual(httpDecoded);
  });

  it('Tax Rule history: the decoded Tax Rule reference passes Read Runtime unchanged', () => {
    const httpDecoded = Schema.decodeUnknownSync(TaxRuleHistoryRequestSchema)({
      taxRuleRef: {
        moduleId: 'commerce.tax',
        resourceId: randomUUID(),
        resourceType: 'commerce.tax.tax-rule',
        tenantId: randomUUID(),
      },
    });
    const accepted = readRuntimeAccepts(taxRuleHistoryRead.descriptor.inputSchema, httpDecoded);
    expect(Result.getOrThrow(accepted)).toEqual(httpDecoded);
  });

  it('prospective Tax Evaluation: the decoded request passes Read Runtime unchanged', () => {
    const httpDecoded = Schema.decodeUnknownSync(TaxEvaluationRequestSchema)(evaluationRequestInput());
    const accepted = readRuntimeAccepts(taxEvaluationRead.descriptor.inputSchema, httpDecoded);
    expect(Result.getOrThrow(accepted)).toEqual(httpDecoded);
  });

  it('Tax materiality comparison: the decoded Tax Outcomes pass Read Runtime unchanged', () => {
    const wire = Schema.encodeSync(TaxMaterialityComparisonRequestSchema)({
      current: evaluate(),
      declaredUse: 'LAUNCH_PURCHASE',
      previous: evaluate(),
    });
    const httpDecoded = Schema.decodeUnknownSync(TaxMaterialityComparisonRequestSchema)(wire);
    const accepted = readRuntimeAccepts(taxMaterialityComparisonRead.descriptor.inputSchema, httpDecoded);
    expect(Result.getOrThrow(accepted)).toEqual(httpDecoded);
  });

  it('Tax correction preview: decoded Accepted Tax Terms pass Read Runtime unchanged', () => {
    const httpDecoded = Schema.decodeUnknownSync(TaxCorrectionPreviewRequestSchema)({
      acceptedTaxTerms: acceptedTaxTermsInput([{ lineValue: '999.90', occurrenceId: 'o-1', quantity: '10' }]),
      declaredPurpose: { _tag: 'HISTORICAL_READ' },
    });
    const accepted = readRuntimeAccepts(taxCorrectionPreviewRead.descriptor.inputSchema, httpDecoded);
    expect(Result.getOrThrow(accepted)).toEqual(httpDecoded);
  });
});
