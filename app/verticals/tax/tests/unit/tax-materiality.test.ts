import { DateTime, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { TaxDecisionIdSchema } from '../../src/domain/tax-decision.ts';
import {
  TaxMaterialChangeConclusionSchema,
  TaxMaterialityUnverifiableSchema,
  TaxNonMaterialAttestationSchema,
  compareTaxMateriality,
} from '../../src/domain/tax-materiality.ts';
import type { TaxMaterialityConclusion } from '../../src/domain/tax-materiality.ts';
import { TaxRuleMissingSchema } from '../../src/domain/tax-non-success-outcome.ts';
import { TaxOutcomeSuccessSchema } from '../../src/domain/tax-outcome.ts';
import type { TaxOutcome, TaxOutcomeSuccess } from '../../src/domain/tax-outcome.ts';
import { TaxEvaluationTimeSchema } from '../../src/domain/tax-time.ts';
import { taxMeaningFingerprint } from '../../src/services/tax-governance-fingerprint.ts';
import { purchaseBindingInput } from './tax-domain-fixtures.ts';
import {
  REDUCED_CODE,
  STANDARD_CODE,
  catalogEntry,
  evaluate,
  evaluationRequest,
  ownState,
  pricingLine,
  selected,
} from './tax-evaluation-fixtures.ts';

const isSuccess = Schema.is(TaxOutcomeSuccessSchema);
const isMaterial = Schema.is(TaxMaterialChangeConclusionSchema);
const isAttested = Schema.is(TaxNonMaterialAttestationSchema);

const success = (outcome: TaxOutcome): TaxOutcomeSuccess => {
  if (!isSuccess(outcome)) {
    throw new Error('Expected a successful Tax Outcome');
  }
  return outcome;
};

const compare = (previous: TaxOutcome, current: TaxOutcome) =>
  compareTaxMateriality({ current, previous }, taxMeaningFingerprint);

/** Reported material changes, none when the conclusion is not MATERIAL. */
const materialReasons = (conclusion: TaxMaterialityConclusion) =>
  isMaterial(conclusion) ? Option.some(conclusion.reasons) : Option.none();

/** Named evidence differences, none when the conclusion is not an attestation. */
const attestedDifferences = (conclusion: TaxMaterialityConclusion) =>
  isAttested(conclusion) ? Option.some(conclusion.evidenceDifferences) : Option.none();

const withStandardRule = (standard: ReturnType<typeof selected>) =>
  ownState({
    ruleSets: new Map([
      [STANDARD_CODE, standard],
      [REDUCED_CODE, selected('12', 'rule-reduced')],
    ]),
  });

const singleLine = (value: string) =>
  evaluationRequest({ pricing: { publishedLines: [pricingLine('o1', value)] } }, ['o1']);

describe('TAX-owned materiality of exact old/new Tax meanings (#943)', () => {
  const approved = evaluate();

  it('#943 G Tax 210 -> 211 CZK is material', () => {
    const conclusion = compare(evaluate(singleLine('1000.00')), evaluate(singleLine('1004.77')));

    expect(materialReasons(conclusion)).toEqual(
      Option.some(['TAXABLE_BASIS', 'PUBLISHED_TAX_AMOUNT', 'PURCHASE_TAX_TOTAL']),
    );
  });

  it('#943 BDD changed rate meaning with identical rounded total is material', () => {
    // 0.10 CZK at 21 % and at 20 % both publish 0.02 CZK.
    const previous = success(evaluate(singleLine('0.10'), withStandardRule(selected('21', 'rule-standard'))));
    const current = success(evaluate(singleLine('0.10'), withStandardRule(selected('20', 'rule-standard'))));

    expect(previous.result.purchaseTaxTotal.amount).toBe('0.02');
    expect(current.result.purchaseTaxTotal.amount).toBe('0.02');
    expect(materialReasons(compare(previous, current))).toEqual(Option.some(['TREATMENT']));
  });

  it('#943 BDD R2 replacing R1 with preserved meaning may be attested non-material, naming the change', () => {
    const current = evaluate(evaluationRequest(), withStandardRule(selected('21', 'rule-standard', 2)));

    expect(attestedDifferences(compare(approved, current))).toEqual(Option.some(['GOVERNING_TAX_RULE_REVISION']));
  });

  it('#943 F9 a new Tax-Relevant Time with equivalent meaning is attested, not hidden', () => {
    const later = TaxEvaluationTimeSchema.make(DateTime.makeUnsafe('2026-10-08T12:00:05.000Z'));
    const current = evaluate(evaluationRequest({ taxRelevantTime: '2026-10-08T12:00:00.000Z' }), ownState(), later);
    const conclusion = compare(approved, current);

    expect(attestedDifferences(conclusion)).toEqual(Option.some(['TAX_RELEVANT_TIME', 'TAX_EVALUATION_TIME']));
    expect(success(current).decision.decisionId).not.toBe(success(approved).decision.decisionId);
  });

  it('#943 F9 F12 a final candidate with a new Pricing Result but equal amounts keeps its meaning', () => {
    const current = evaluate(
      evaluationRequest({
        purchase: purchaseBindingInput(['o1', 'o2'], {
          pricingResultRef: { pricingResultId: 'pricing-result-2', revision: 1 },
          purchaseCandidateRef: 'purchase-final',
        }),
      }),
    );

    expect(attestedDifferences(compare(approved, current))).toEqual(
      Option.some(['PRICING_SOURCE', 'PURCHASE_CANDIDATE']),
    );
  });

  it('#943 F10 the same old/new states give the same conclusion', () => {
    const current = evaluate(evaluationRequest(), withStandardRule(selected('21', 'rule-standard', 2)));

    expect(compare(approved, current)).toEqual(compare(approved, current));
  });

  it('#943 F1 #937 F1-F6 another purchase is unverifiable, never compared by visible values', () => {
    const otherSeller = evaluate(
      evaluationRequest({
        purchase: purchaseBindingInput(['o1', 'o2'], { sellingLegalEntityRef: 'selling-legal-entity-2' }),
      }),
    );

    expect(compare(approved, otherSeller)).toEqual(
      TaxMaterialityUnverifiableSchema.make({ reason: 'DIFFERENT_PURCHASE' }),
    );
  });

  it('#943 F8 a non-success outcome is unverifiable, not an implicit attestation', () => {
    expect(compare(approved, TaxRuleMissingSchema.make({}))).toEqual(
      TaxMaterialityUnverifiableSchema.make({ reason: 'NOT_DETERMINED' }),
    );
  });

  it('#943 F7 a forged Decision identity is unverifiable', () => {
    const genuine = success(approved);
    const forgedId = TaxDecisionIdSchema.make('tax-decision:forged');
    const forged: TaxOutcome = {
      ...genuine,
      decision: { ...genuine.decision, decisionId: forgedId },
      result: { ...genuine.result, taxDecisionId: forgedId },
    };

    expect(compare(approved, forged)).toEqual(
      TaxMaterialityUnverifiableSchema.make({ reason: 'DECISION_IDENTITY_MISMATCH' }),
    );
  });

  it('#943 F2 changed classification with the same rate is material', () => {
    const reclassified = evaluate(
      evaluationRequest({ catalog: [catalogEntry('o1', STANDARD_CODE), catalogEntry('o2', 'cz-reduced-books')] }),
      ownState({
        ruleSets: new Map([
          [STANDARD_CODE, selected('21', 'rule-standard')],
          ['cz-reduced-books', selected('12', 'rule-reduced-books')],
        ]),
      }),
    );

    expect(materialReasons(compare(approved, reclassified))).toEqual(Option.some(['CLASSIFICATION']));
  });
});
