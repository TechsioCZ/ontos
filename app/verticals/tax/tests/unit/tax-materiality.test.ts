import { ReadHandlerNotFound } from '@app/core-runtime';
import { Array as Arr, DateTime, Effect, Option, Schema, pipe } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { readTaxMaterialityComparison } from '../../src/api/tax-materiality-comparison.read.ts';
import { TaxDecisionIdSchema } from '../../shared/domain/tax-kernel/tax-decision.ts';
import { NonNegativeTaxExactRationalSchema } from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import { TaxOutcomeSuccessSchema as BoundTaxOutcomeSuccessSchema } from '../../shared/domain/tax-kernel/tax-outcome.ts';
import {
  TaxMaterialChangeConclusionSchema,
  TaxMaterialityUnverifiableSchema,
  TaxNonMaterialAttestationSchema,
  compareTaxMateriality,
  isSamePurchaseIdentity,
  taxOutcomeVisibleInScope,
} from '../../src/domain/tax-materiality.ts';
import type { TaxMaterialityConclusion } from '../../src/domain/tax-materiality.ts';
import { TaxRuleMissingSchema } from '../../src/domain/tax-non-success-outcome.ts';
import { TaxOutcomeSuccessSchema } from '../../src/domain/tax-outcome.ts';
import type { TaxOutcome, TaxOutcomeSuccess } from '../../src/domain/tax-outcome.ts';
import { TaxEvaluationTimeSchema } from '../../shared/domain/tax-kernel/tax-time.ts';
import { taxMeaningFingerprint } from '../../src/services/tax-governance-fingerprint.ts';
import { decodePurchaseBinding, exactDecimal, occurrenceInput, purchaseBindingInput } from './tax-domain-fixtures.ts';
import {
  PRICING_RESULT_REF,
  REDUCED_CODE,
  STANDARD_CODE,
  catalogEntry,
  evaluate,
  evaluationRequest,
  ownState,
  pricingLine,
  selected,
} from './tax-evaluation-fixtures.ts';
import type { TaxEvaluationRequestInput } from './tax-evaluation-fixtures.ts';

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
  evaluationRequest({ pricing: { pricingResultRef: PRICING_RESULT_REF, publishedLines: [pricingLine('o1', value)] } }, [
    'o1',
  ]);

const withWeights = (o1Weight: string) =>
  evaluate(
    evaluationRequest({
      purchase: purchaseBindingInput(['o1', 'o2'], {
        shippingSourceRef: { revision: 1, shippingAmountId: 'shipping-1' },
      }),
      shipping: {
        affectedOccurrenceIds: ['o1', 'o2'],
        allocationWeights: {
          approvalEvidenceRef: 'weights-approval-1',
          weights: [
            { occurrenceId: 'o1', weight: exactDecimal(o1Weight) },
            { occurrenceId: 'o2', weight: exactDecimal('1') },
          ],
        },
        source: {
          _tag: 'CURRENT',
          amount: { amount: exactDecimal('100.00'), currency: 'CZK' },
          shippingSourceRef: { revision: 1, shippingAmountId: 'shipping-1' },
        },
      },
    }),
  );

const catalogWith = (catalogFactRef: string, completeness: string): TaxEvaluationRequestInput['catalog'][number] => {
  const base = catalogEntry('o1', STANDARD_CODE);
  return {
    ...base,
    classificationInput: {
      ...base.classificationInput,
      materialCatalogEvidence: [
        {
          _tag: 'CURRENT' as const,
          catalogFactRef,
          catalogFactRevisionRef: 'r1',
          factKind: 'TAX_CATEGORY',
          factValue: STANDARD_CODE,
          ownerEvidenceRef: 'owner-1',
        },
      ],
      materialEvidenceCompleteness: { _tag: 'OWNER_VERIFIED_COMPLETE' as const, ownerEvidenceRef: completeness },
    },
  };
};

/** Catalog evidence with the category fact plus a non-category fact of the given value under fixed references. */
const withAncestry = (factValue: string): TaxEvaluationRequestInput['catalog'][number] => {
  const entry = catalogWith('o1:tax-category', 'x');
  const [category] = entry.classificationInput.materialCatalogEvidence;
  return {
    ...entry,
    classificationInput: {
      ...entry.classificationInput,
      materialCatalogEvidence: [
        category,
        {
          _tag: 'CURRENT',
          catalogFactRef: 'o1:ancestry',
          catalogFactRevisionRef: 'r1',
          factKind: 'CATEGORY_ANCESTRY',
          factValue,
          ownerEvidenceRef: 'owner-2',
        },
      ],
    },
  };
};

/**
 * A bound outcome whose first unit is internally consistent (published = HALF_UP of its exact contribution) but whose
 * amounts no longer follow from the Decision: the published schema accepts it, only TAX's own check rejects it.
 */
/** The same successful outcome with every unit's material Catalog facts in reverse array order. */
const withReversedCatalogFacts = (genuine: TaxOutcomeSuccess): TaxOutcomeSuccess => ({
  ...genuine,
  decision: {
    ...genuine.decision,
    units: pipe(
      genuine.decision.units,
      Arr.map((unit) =>
        'taxClassification' in unit
          ? {
              ...unit,
              taxClassification: {
                ...unit.taxClassification,
                materialCatalogEvidence: Arr.reverse(unit.taxClassification.materialCatalogEvidence),
              },
            }
          : unit,
      ),
    ),
  },
});

const withUnfollowingAmounts = (genuine: TaxOutcomeSuccess): TaxOutcome => {
  const [first, ...rest] = genuine.result.units;
  return {
    ...genuine,
    result: {
      ...genuine.result,
      purchaseTaxTotal: { amount: '271.00', currency: 'CZK' },
      units: [
        {
          ...first,
          exactTaxContribution: NonNegativeTaxExactRationalSchema.make({ denominator: '1', numerator: '211' }),
          publishedTaxAmount: { amount: '211.00', currency: 'CZK' },
          taxRoundingAdjustment: { denominator: '1', numerator: '0' },
        },
        ...rest,
      ],
    },
  };
};

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

  it('#943 F7 evidence identifiers containing separators are compared structurally, never by joined text', () => {
    // Joined with '|', completeness `x` + fact `a|b` and completeness `x|a` + fact `b` would look identical.
    const previous = evaluate(evaluationRequest({ catalog: [catalogWith('a|b', 'x')] }, ['o1']));
    const current = evaluate(evaluationRequest({ catalog: [catalogWith('b', 'x|a')] }, ['o1']));

    expect(attestedDifferences(compare(previous, current))).toEqual(Option.some(['CATALOG_EVIDENCE']));
  });

  it('#943 F7 identifiers with lone surrogates are compared without failing', () => {
    const previous = evaluate(evaluationRequest({ catalog: [catalogWith('fact-\uD800', 'x')] }, ['o1']));
    const current = evaluate(evaluationRequest({ catalog: [catalogWith('fact-\uDC00', 'x')] }, ['o1']));

    expect(attestedDifferences(compare(previous, current))).toEqual(Option.some(['CATALOG_EVIDENCE']));
  });

  it('#943 F7 a changed fact kind or value under the same references is an evidence difference', () => {
    const previous = evaluate(evaluationRequest({ catalog: [withAncestry('food')] }, ['o1']));
    const current = evaluate(evaluationRequest({ catalog: [withAncestry('drinks')] }, ['o1']));

    expect(attestedDifferences(compare(previous, current))).toEqual(Option.some(['CATALOG_EVIDENCE']));
  });

  it('#937 F7 the same Catalog facts in another order keep the Decision identity and differ in no evidence', () => {
    const previous = success(evaluate(evaluationRequest({ catalog: [withAncestry('food')] }, ['o1'])));
    const reordered = withReversedCatalogFacts(previous);

    expect(reordered.decision.decisionId).toBe(previous.decision.decisionId);
    expect(attestedDifferences(compare(previous, reordered))).toEqual(Option.some([]));
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

  it('#936 F32 a bound outcome whose amounts do not follow from its Decision is never attested', () => {
    const tampered = withUnfollowingAmounts(success(approved));

    expect(compare(approved, tampered)).toEqual(TaxMaterialityUnverifiableSchema.make({ reason: 'NOT_DETERMINED' }));
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

  it('#943 F3 a changed Shipping allocation is material', () => {
    expect(materialReasons(compare(withWeights('3'), withWeights('1')))).toEqual(
      Option.some(['SHIPPING_ALLOCATION', 'PUBLISHED_TAX_AMOUNT', 'PURCHASE_TAX_TOTAL']),
    );
  });

  it('#950 F21-F25 a compared outcome is visible only to its own Tenant and Selling Legal Entity', () => {
    const binding = success(approved).decision.purchaseBinding;
    const own = { legalEntityId: binding.sellingLegalEntityRef, tenantId: binding.tenantId };

    expect(taxOutcomeVisibleInScope(approved, own)).toBe(true);
    expect(taxOutcomeVisibleInScope(approved, { ...own, tenantId: 'tenant-2' })).toBe(false);
    expect(taxOutcomeVisibleInScope(approved, { ...own, legalEntityId: 'selling-legal-entity-2' })).toBe(false);
    expect(taxOutcomeVisibleInScope(TaxRuleMissingSchema.make({}), { ...own, tenantId: 'tenant-2' })).toBe(true);
    // Scope is checked on the published shape, so inconsistent amounts never bypass it.
    const tampered = withUnfollowingAmounts(success(approved));
    expect(Schema.is(BoundTaxOutcomeSuccessSchema)(tampered)).toBe(true);
    expect(taxOutcomeVisibleInScope(tampered, { ...own, tenantId: 'tenant-2' })).toBe(false);
  });
});

const handlerContextFor = (tenantId: string) => ({
  readKey: 'commerce.tax.api.tax-materiality-comparison',
  scope: {
    authContextRef: 'better-auth-session:test',
    authMethod: 'session' as const,
    correlationId: 'correlation-1',
    legalEntityId: 'selling-legal-entity-1',
    principalId: 'principal-1',
    tenantId,
  },
  services: {},
});
const materialityInput = () => ({ current: evaluate(), declaredUse: 'LAUNCH_PURCHASE' as const, previous: evaluate() });

describe('Tax materiality comparison read handler', () => {
  it.effect('#950 F21-F25 outcomes of another Tenant are not found in the trusted scope', () =>
    Effect.gen(function* foreignTenant() {
      const failure = yield* Effect.flip(
        readTaxMaterialityComparison(materialityInput(), handlerContextFor('tenant-2')),
      );

      expect(failure).toBeInstanceOf(ReadHandlerNotFound);
    }),
  );

  it.effect('outcomes of the trusted scope are compared', () =>
    Effect.gen(function* ownTenant() {
      const { result } = yield* readTaxMaterialityComparison(materialityInput(), handlerContextFor('tenant-1'));

      expect(attestedDifferences(result)).toEqual(Option.some([]));
    }),
  );
});

describe('Same purchase/use for materiality (#943 F1, F9, F11-F12)', () => {
  it('survives a new candidate, Pricing Result and Shipping source revision', () => {
    const approved = decodePurchaseBinding(purchaseBindingInput(['o-1']));
    const finalCandidate = decodePurchaseBinding(
      purchaseBindingInput(['o-1'], {
        pricingResultRef: { pricingResultId: 'pricing-result-2', revision: 3 },
        purchaseCandidateRef: 'purchase-final',
        shippingSourceRef: { revision: 2, shippingAmountId: 'shipping-1' },
      }),
    );

    expect(isSamePurchaseIdentity(approved, finalCandidate)).toBe(true);
    expect(isSamePurchaseIdentity(finalCandidate, approved)).toBe(true);
  });

  it('#937 F12-F20 changed quantity, subject or seller is not the same purchase/use', () => {
    const original = decodePurchaseBinding(purchaseBindingInput(['o-1']));
    const changedQuantity = decodePurchaseBinding(
      purchaseBindingInput(['o-1'], {
        purchaseDemandOccurrences: [{ ...occurrenceInput('o-1'), quantity: { amount: '2', unitRef: 'piece' } }],
      }),
    );
    const otherSubject = decodePurchaseBinding(
      purchaseBindingInput(['o-1'], { purchasingSubject: { _tag: 'COUNTERPARTY', counterpartyRef: 'counterparty-1' } }),
    );
    const otherSeller = decodePurchaseBinding(purchaseBindingInput(['o-1'], { sellingLegalEntityRef: 'seller-2' }));

    expect(isSamePurchaseIdentity(original, changedQuantity)).toBe(false);
    expect(isSamePurchaseIdentity(original, otherSubject)).toBe(false);
    expect(isSamePurchaseIdentity(original, otherSeller)).toBe(false);
  });
});
