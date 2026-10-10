import { randomUUID } from 'node:crypto';

import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ApplicableTaxRuleSetRequestSchema } from '../../shared/apis/applicable-tax-rule-set.ts';
import { SellerVatRegimeAtInstantRequestSchema } from '../../shared/apis/seller-vat-regime-at-instant.ts';
import { TaxCorrectionPreviewRequestSchema } from '../../shared/apis/tax-correction-preview.ts';
import { TaxEvaluationRequestSchema, TaxEvaluationResponseSchema } from '../../shared/apis/tax-evaluation.ts';
import { TaxMaterialityComparisonRequestSchema } from '../../shared/apis/tax-materiality-comparison.ts';
import { TaxRuleHistoryRequestSchema } from '../../shared/apis/tax-rule-history.ts';
import { applicableTaxRuleSetRead } from '../../src/api/applicable-tax-rule-set.read.ts';
import { sellerVatRegimeAtInstantRead } from '../../src/api/seller-vat-regime-at-instant.read.ts';
import { taxCorrectionPreviewRead } from '../../src/api/tax-correction-preview.read.ts';
import { taxEvaluationRead } from '../../src/api/tax-evaluation.read.ts';
import { taxMaterialityComparisonRead } from '../../src/api/tax-materiality-comparison.read.ts';
import { taxRuleHistoryRead } from '../../src/api/tax-rule-history.read.ts';
import { projectCustomerSafeTax } from '../../src/domain/customer-safe-tax-projection.ts';
import { acceptedTaxTermsInput } from './tax-correction-fixtures.ts';
import { evaluate, evaluationRequest, evaluationRequestInput, evaluationTime } from './tax-evaluation-fixtures.ts';

/**
 * `HttpApiBuilder` decodes each read's HTTP payload with the endpoint schema (`<Stem>RequestSchema`) before the
 * governed-read handler hands it to Read Runtime, which decodes it again with the read's own `inputSchema`, the same
 * schema. Every request instant is therefore idempotent (`UtcInstantSchema`): an ISO string on the wire, or the
 * already-decoded `DateTime.Utc` on the second pass. The wire contract stays as strict as the plain contract.
 */
const readRuntimeAccepts = <Value>(inputSchema: Schema.Decoder<Value>, httpDecoded: Value) =>
  Schema.decodeUnknownResult(inputSchema, { onExcessProperty: 'error' })(httpDecoded);

describe('TAX governed reads decode their HTTP payload exactly once', () => {
  it('applicable Tax Rule Set: the decoded Tax-Relevant Time passes Read Runtime unchanged', () => {
    const httpDecoded = Schema.decodeSync(ApplicableTaxRuleSetRequestSchema)({
      jurisdiction: 'CZ_DOMESTIC',
      taxClassificationCode: 'cz-standard-goods',
      taxRelevantTime: '2026-06-01T00:00:00.000Z',
    });
    const accepted = readRuntimeAccepts(applicableTaxRuleSetRead.descriptor.inputSchema, httpDecoded);
    expect(Result.getOrThrow(accepted)).toEqual(httpDecoded);
  });

  it('Seller VAT Regime at an instant: the decoded instant passes Read Runtime unchanged', () => {
    const httpDecoded = Schema.decodeSync(SellerVatRegimeAtInstantRequestSchema)({
      instant: '2026-06-01T00:00:00.000Z',
    });
    const accepted = readRuntimeAccepts(sellerVatRegimeAtInstantRead.descriptor.inputSchema, httpDecoded);
    expect(Result.getOrThrow(accepted)).toEqual(httpDecoded);
  });

  it('Tax Rule history: the decoded Tax Rule reference passes Read Runtime unchanged', () => {
    const httpDecoded = Schema.decodeSync(TaxRuleHistoryRequestSchema)({
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
    const httpDecoded = Schema.decodeSync(TaxEvaluationRequestSchema)(evaluationRequestInput());
    const accepted = readRuntimeAccepts(taxEvaluationRead.descriptor.inputSchema, httpDecoded);
    expect(Result.getOrThrow(accepted)).toEqual(httpDecoded);
  });

  it('Tax materiality comparison: the decoded Tax Outcomes pass Read Runtime unchanged', () => {
    const wire = Schema.encodeSync(TaxMaterialityComparisonRequestSchema)({
      current: evaluate(),
      declaredUse: 'LAUNCH_PURCHASE',
      previous: evaluate(),
    });
    const httpDecoded = Schema.decodeSync(TaxMaterialityComparisonRequestSchema)(wire);
    const accepted = readRuntimeAccepts(taxMaterialityComparisonRead.descriptor.inputSchema, httpDecoded);
    expect(Result.getOrThrow(accepted)).toEqual(httpDecoded);
  });

  it('Tax correction preview: decoded Accepted Tax Terms pass Read Runtime unchanged', () => {
    const httpDecoded = Schema.decodeSync(TaxCorrectionPreviewRequestSchema)({
      acceptedTaxTerms: acceptedTaxTermsInput([{ lineValue: '999.90', occurrenceId: 'o-1', quantity: '10' }]),
      declaredPurpose: { _tag: 'HISTORICAL_READ' },
    });
    const accepted = readRuntimeAccepts(taxCorrectionPreviewRead.descriptor.inputSchema, httpDecoded);
    expect(Result.getOrThrow(accepted)).toEqual(httpDecoded);
  });
});

const strictDecode = <Value>(schema: Schema.Decoder<Value>) =>
  Schema.decodeUnknownResult(schema, { onExcessProperty: 'error' });

const validTaxRuleRef = {
  moduleId: 'commerce.tax',
  resourceId: randomUUID(),
  resourceType: 'commerce.tax.tax-rule',
  tenantId: randomUUID(),
} as const;

describe('TAX read request schemas keep the strict wire contract', () => {
  it('Tax Rule history: the endpoint payload schema rejects a malformed Tax Rule reference', () => {
    for (const schema of [TaxRuleHistoryRequestSchema, taxRuleHistoryRead.descriptor.inputSchema]) {
      const decode = strictDecode(schema);
      expect(Result.isFailure(decode({ taxRuleRef: { ...validTaxRuleRef, tenantId: 'not-a-uuid' } }))).toBe(true);
      expect(Result.isFailure(decode({ taxRuleRef: { ...validTaxRuleRef, resourceId: '' } }))).toBe(true);
      expect(Result.isSuccess(decode({ taxRuleRef: validTaxRuleRef }))).toBe(true);
    }
  });

  it('an instant that is not an ISO string is rejected on the wire', () => {
    const atInstant = strictDecode(SellerVatRegimeAtInstantRequestSchema);
    const ruleSet = strictDecode(ApplicableTaxRuleSetRequestSchema);
    const evaluation = strictDecode(TaxEvaluationRequestSchema);
    for (const instant of [Date.parse('2026-06-01T00:00:00.000Z'), {}, 'not-an-instant']) {
      expect(Result.isFailure(atInstant({ instant }))).toBe(true);
      expect(
        Result.isFailure(
          ruleSet({
            jurisdiction: 'CZ_DOMESTIC',
            taxClassificationCode: 'cz-standard-goods',
            taxRelevantTime: instant,
          }),
        ),
      ).toBe(true);
      expect(Result.isFailure(evaluation({ ...evaluationRequestInput(), taxRelevantTime: instant }))).toBe(true);
    }
  });

  it('a response still encodes its instants as the same ISO strings', () => {
    const request = evaluationRequest();
    const outcome = evaluate(request);
    const wire = Schema.encodeSync(TaxEvaluationResponseSchema)({
      _tag: 'EVALUATED',
      customerSafe: projectCustomerSafeTax(outcome, request.decompositionNeed),
      evidence: {
        attempts: 1,
        discarded: [],
        foreignEvidenceOrigin: 'CALLER_SUPPLIED_UNVERIFIED',
        ruleSets: [],
        sellerVatRegime: {
          headRevision: 0,
          selectedFor: request.taxRelevantTime,
          selection: { _tag: 'NOT_DECLARED' },
          setFingerprint: '0'.repeat(64),
        },
        taxEvaluationTime: evaluationTime,
        taxRelevantTime: request.taxRelevantTime,
      },
      outcome,
    });
    expect(wire).toMatchObject({
      evidence: {
        sellerVatRegime: { selectedFor: '2026-10-08T10:00:00.000Z' },
        taxEvaluationTime: '2026-10-08T10:00:02.000Z',
        taxRelevantTime: '2026-10-08T10:00:00.000Z',
      },
    });
  });
});
