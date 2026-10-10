import { DateTime, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  TaxMigrationCompleteSchema,
  TaxMigrationConflictingSchema,
  TaxMigrationCutoverDeclaredSchema,
  TaxMigrationCutoverNotDeclaredSchema,
  TaxMigrationIncompleteSchema,
  TaxMigrationMappedAcceptedSchema,
  TaxMigrationNotCompleteSchema,
  TaxMigrationNotReadySchema,
  TaxMigrationReadySchema,
  TaxMigrationRejectedUnmappedSchema,
  TaxMigrationReviewRequiredSchema,
  TaxMigrationUnverifiableSchema,
  TaxShadowDifferentSchema,
  TaxShadowNotComparableSchema,
  TaxShadowSameSchema,
} from '../../shared/domain/tax-migration-contracts.ts';
import type {
  TaxMigrationCandidate,
  TaxMigrationFamily,
  TaxMigrationFamilyEvidence,
  TaxMigrationMapping,
  TaxMigrationOutcome,
  TaxMigrationProvenance,
} from '../../shared/domain/tax-migration-contracts.ts';
import {
  evaluateTaxMigrationCandidates,
  reconcileTaxMigrationTarget,
  taxMigrationFamilies,
  taxMigrationTargetMeaningKey,
  verifyTaxMigrationCompleteness,
} from '../../src/domain/tax-fact-migration.ts';
import {
  assessTaxMigrationReadiness,
  compareShadowSellerVatRegime,
  compareShadowTaxRule,
} from '../../src/domain/tax-migration-readiness.ts';
import type { SellerVatRegimeDeclarationRevision } from '../../src/domain/seller-vat-regime-timeline.ts';
import { TaxRelevantTimeSchema } from '../../shared/domain/tax-kernel/tax-time.ts';

/** Every fixture dataset is explicitly NON_PRODUCTION; no real legacy data is used (#960, #907 F271-F272). */
const prov = (
  sourceRecordRef: string,
  sourceSystemRef = 'fixture:legacy-vat',
  datasetRef = 'fixture:legacy-erp/2026-09',
): TaxMigrationProvenance => ({ datasetLabel: 'NON_PRODUCTION', datasetRef, sourceRecordRef, sourceSystemRef });
const src = (sourceRecordRef: string, sourceSystemRef = 'fixture:legacy-vat') => ({ sourceRecordRef, sourceSystemRef });

const candidate = (
  sourceRecordRef: string,
  mapping: TaxMigrationMapping,
  provenance: TaxMigrationProvenance = prov(sourceRecordRef),
): TaxMigrationCandidate => ({ mapping, provenance });

const standardRate = {
  compositionKind: 'EXCLUSIVE',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  jurisdiction: 'CZ_DOMESTIC',
  ratePercent: '21',
  taxClassificationCode: 'standard',
  treatmentCategory: 'TAXABLE',
};
const taxRule = (
  sourceRecordRef: string,
  overrides: Readonly<Record<string, string>> = {},
  provenance: TaxMigrationProvenance = prov(sourceRecordRef),
) =>
  candidate(
    sourceRecordRef,
    { _tag: 'TAX_OWNED', family: 'TAX_RULE', targetMeaning: { ...standardRate, ...overrides } },
    provenance,
  );

const keyOf = (overrides: Readonly<Record<string, string>> = {}) =>
  Result.getOrThrow(taxMigrationTargetMeaningKey('TAX_RULE', { ...standardRate, ...overrides }));

const at = (iso: string) => DateTime.makeUnsafe(iso);

const scope = { sellingLegalEntityRef: 'fixture:seller-a', tenantRef: 'fixture:tenant-a' };

const only = (outcomes: readonly TaxMigrationOutcome[]): TaxMigrationOutcome => {
  const [outcome] = outcomes;
  expect(outcomes).toHaveLength(1);
  return (
    outcome ??
    TaxMigrationReviewRequiredSchema.make({
      provenance: prov('none'),
      reason: 'MEANING_NOT_ESTABLISHED',
      sourceFamily: Option.none(),
    })
  );
};

const ruleClaim = (expectedRecordRefs: readonly string[]) => ({
  declaredBy: 'fixture:legacy-vat',
  expectedSourceRecords: expectedRecordRefs.map((ref) => src(ref)),
  family: 'TAX_RULE' as const,
});

describe('#960 Migration maps business meaning, not legacy storage shape', () => {
  it('BDD Legacy VAT field has unclear semantics: never promoted by name, review required (F1, F13, F34)', () => {
    const outcome = only(
      evaluateTaxMigrationCandidates([candidate('legacy-row-1', { _tag: 'UNESTABLISHED', legacyFieldNames: ['VAT'] })]),
    );
    expect(outcome).toEqual(
      TaxMigrationReviewRequiredSchema.make({
        provenance: prov('legacy-row-1'),
        reason: 'MEANING_NOT_ESTABLISHED',
        sourceFamily: Option.none(),
      }),
    );
  });

  it('BDD Legacy fact belongs to Party Registry: TAX creates no duplicate identity fact (F3, F5)', () => {
    const outcome = only(
      evaluateTaxMigrationCandidates([
        candidate('legacy-row-2', { _tag: 'FOREIGN_OWNER', targetOwner: 'commerce.party-registry' }),
      ]),
    );
    expect(outcome).toEqual(
      TaxMigrationRejectedUnmappedSchema.make({
        provenance: prov('legacy-row-2'),
        reason: 'FOREIGN_OWNER',
        sourceFamily: Option.none(),
        targetOwner: 'commerce.party-registry',
      }),
    );
  });
});

describe('#960 Only Launch-critical Current Tax meaning is promoted', () => {
  it('BDD Launch-critical Tax Rule is translated to its canonical meaning (F2, F8, F11)', () => {
    const outcome = only(evaluateTaxMigrationCandidates([taxRule('legacy-rate-21', { ratePercent: '21.00' })]));
    expect(outcome).toEqual(
      TaxMigrationMappedAcceptedSchema.make({
        family: 'TAX_RULE',
        provenance: prov('legacy-rate-21'),
        targetMeaningKey: keyOf({ ratePercent: '21.00' }),
      }),
    );
  });

  it('BDD Historical Order tax value is not Current Tax truth (F7, F10, F12)', () => {
    const outcome = only(
      evaluateTaxMigrationCandidates([
        candidate('order-77-line-1', { _tag: 'HISTORICAL_ACCEPTED_VALUE', historicalOwner: 'commerce.order' }),
      ]),
    );
    expect(outcome).toEqual(
      TaxMigrationRejectedUnmappedSchema.make({
        provenance: prov('order-77-line-1'),
        reason: 'HISTORICAL_ACCEPTED_VALUE',
        sourceFamily: Option.none(),
        targetOwner: 'commerce.order',
      }),
    );
  });

  it('BDD a historical zero-Tax Order/Billing value is never promoted as a Seller VAT Regime (#907 Unit 10 D2)', () => {
    const outcome = only(
      evaluateTaxMigrationCandidates([
        candidate('order-88-line-1', { _tag: 'HISTORICAL_ACCEPTED_VALUE', historicalOwner: 'commerce.order' }),
      ]),
    );
    expect(outcome).toEqual(
      TaxMigrationRejectedUnmappedSchema.make({
        provenance: prov('order-88-line-1'),
        reason: 'HISTORICAL_ACCEPTED_VALUE',
        sourceFamily: Option.none(),
        targetOwner: 'commerce.order',
      }),
    );
  });

  it('BDD Unsupported OSS rule exists in legacy: it does not activate OSS (F9)', () => {
    const outcome = only(evaluateTaxMigrationCandidates([taxRule('legacy-oss-1', { jurisdiction: 'EU_OSS' })]));
    expect(outcome).toEqual(
      TaxMigrationRejectedUnmappedSchema.make({
        provenance: prov('legacy-oss-1'),
        reason: 'UNSUPPORTED_BREADTH',
        sourceFamily: Option.some('TAX_RULE'),
        targetOwner: 'commerce.tax',
      }),
    );
  });

  it('keeps a record missing required meaning INCOMPLETE and an invalid meaning REVIEW_REQUIRED (F16)', () => {
    const outcomes = evaluateTaxMigrationCandidates([
      candidate('legacy-partial', {
        _tag: 'TAX_OWNED',
        family: 'TAX_RULE',
        targetMeaning: { compositionKind: 'EXCLUSIVE', jurisdiction: 'CZ_DOMESTIC', treatmentCategory: 'TAXABLE' },
      }),
      taxRule('legacy-negative', { ratePercent: '-21' }),
    ]);
    expect(outcomes).toEqual([
      TaxMigrationReviewRequiredSchema.make({
        provenance: prov('legacy-negative'),
        reason: 'TARGET_MEANING_INVALID',
        sourceFamily: Option.some('TAX_RULE'),
      }),
      TaxMigrationIncompleteSchema.make({
        missing: ['effectiveFrom', 'ratePercent', 'taxClassificationCode'],
        provenance: prov('legacy-partial'),
        sourceFamily: Option.some('TAX_RULE'),
      }),
    ]);
  });

  it('keeps one copy of an identical duplicate and never picks a winner among different meanings (G)', () => {
    const outcomes = evaluateTaxMigrationCandidates([
      taxRule('legacy-dup'),
      taxRule('legacy-dup'),
      taxRule('legacy-split', { ratePercent: '12' }),
      taxRule('legacy-split'),
    ]);
    expect(outcomes).toEqual([
      TaxMigrationMappedAcceptedSchema.make({
        family: 'TAX_RULE',
        provenance: prov('legacy-dup'),
        targetMeaningKey: keyOf(),
      }),
      TaxMigrationRejectedUnmappedSchema.make({
        provenance: prov('legacy-dup'),
        reason: 'DUPLICATE_SOURCE_RECORD',
        sourceFamily: Option.some('TAX_RULE'),
        targetOwner: 'commerce.tax',
      }),
      TaxMigrationConflictingSchema.make({
        counterparts: [prov('legacy-split')],
        provenance: prov('legacy-split'),
        sourceFamily: Option.some('TAX_RULE'),
      }),
      TaxMigrationConflictingSchema.make({
        counterparts: [prov('legacy-split')],
        provenance: prov('legacy-split'),
        sourceFamily: Option.some('TAX_RULE'),
      }),
    ]);
  });

  it('is deterministic under input order', () => {
    const dataset = [taxRule('b'), taxRule('a', { ratePercent: '12' }), taxRule('a'), taxRule('c')];
    expect(evaluateTaxMigrationCandidates(dataset.toReversed())).toEqual(evaluateTaxMigrationCandidates(dataset));
  });
});

describe('#960 Migration completeness requires business evidence', () => {
  it('BDD Launch-critical source set is incomplete: migration is not declared complete (F17-F18)', () => {
    const outcomes = evaluateTaxMigrationCandidates([taxRule('r1')]);
    expect(verifyTaxMigrationCompleteness('TAX_RULE', ruleClaim(['r1', 'r2']), outcomes)).toEqual(
      TaxMigrationNotCompleteSchema.make({
        family: 'TAX_RULE',
        missingSourceRecords: [src('r2')],
        openSourceRecords: [],
        rowCount: 1,
        unexpectedSourceRecords: [],
      }),
    );
    expect(verifyTaxMigrationCompleteness('TAX_RULE', undefined, outcomes)).toEqual(
      TaxMigrationUnverifiableSchema.make({ family: 'TAX_RULE', rowCount: 1 }),
    );
    expect(verifyTaxMigrationCompleteness('TAX_RULE', ruleClaim(['r1']), outcomes)).toEqual(
      TaxMigrationCompleteSchema.make({ family: 'TAX_RULE', rowCount: 1 }),
    );
  });

  it('keeps a family with an open outcome incomplete even when every declared record arrived (F16, F18)', () => {
    const outcomes = evaluateTaxMigrationCandidates([
      taxRule('r1'),
      candidate('r2', { _tag: 'UNESTABLISHED', legacyFieldNames: ['VAT'] }),
    ]);
    const completeness = verifyTaxMigrationCompleteness('TAX_RULE', ruleClaim(['r1', 'r2']), outcomes);
    expect(Schema.is(TaxMigrationNotCompleteSchema)(completeness)).toBe(true);
    expect(completeness).toEqual(expect.objectContaining({ missingSourceRecords: [], openSourceRecords: [src('r2')] }));
  });

  it('BDD Row counts match but semantics differ: Reconciliation does not pass (F14-F15)', () => {
    const outcomes = evaluateTaxMigrationCandidates([
      taxRule('r1'),
      taxRule('r2', { ratePercent: '12', taxClassificationCode: 'reduced' }),
    ]);
    const target = [
      { source: src('r1'), targetMeaningKey: keyOf() },
      { source: src('r2'), targetMeaningKey: keyOf({ ratePercent: '15', taxClassificationCode: 'reduced' }) },
    ];
    expect(target).toHaveLength(outcomes.length);
    expect(reconcileTaxMigrationTarget(outcomes, target)).toEqual([
      { difference: 'MEANING_DIFFERS', source: src('r2') },
    ]);
  });
});

describe('#960 Shadow evidence never becomes production authority', () => {
  it('BDD Shadow phase before cutover: a difference is evidence, OntOS does not become authority', () => {
    const difference = compareShadowTaxRule({
      candidateState: {
        predicateFingerprint: 'fixture-predicate',
        revisions: [
          {
            compositionKind: 'EXCLUSIVE',
            correctedBy: [],
            effectiveFrom: at('2026-01-01T00:00:00.000Z'),
            effectiveTo: Option.none(),
            endedEffectiveTo: Option.none(),
            ratePercent: '12',
            revisionId: 'candidate-r1',
            revisionNumber: 1,
            taxRuleId: 'candidate-rule',
            treatmentCategory: 'TAXABLE',
          },
        ],
      },
      legacyRatePercent: '21.0',
      probeRef: 'standard@2026-03-01',
      taxRelevantTime: TaxRelevantTimeSchema.make(at('2026-03-01T00:00:00.000Z')),
    });
    expect(difference).toEqual(
      TaxShadowDifferentSchema.make({ legacyValue: '21.0', ontosValue: '12', probeRef: 'standard@2026-03-01' }),
    );
  });
});

const regimeRevision = (
  revision: number,
  regime: 'NON_PAYER' | 'VAT_PAYER',
  effectiveFrom: string,
): SellerVatRegimeDeclarationRevision => ({
  effectiveFrom: at(effectiveFrom),
  provenance: 'MERCHANT_DECLARED',
  regime,
  revision,
});

describe('#907 Unit 10 D2 Seller VAT Regime shadow comparison and cutover declaration', () => {
  it('is SAME when the live declared regime agrees with the legacy shadow value', () => {
    const shadow = compareShadowSellerVatRegime({
      candidateRevisions: [regimeRevision(1, 'VAT_PAYER', '2026-01-01T00:00:00.000Z')],
      instant: at('2026-03-01T00:00:00.000Z'),
      legacyRegime: 'VAT_PAYER',
      probeRef: 'seller@2026-03-01',
    });
    expect(shadow).toEqual(TaxShadowSameSchema.make({ probeRef: 'seller@2026-03-01' }));
  });

  it('is DIFFERENT when the live declared regime disagrees with the legacy shadow value', () => {
    const shadow = compareShadowSellerVatRegime({
      candidateRevisions: [regimeRevision(1, 'NON_PAYER', '2026-01-01T00:00:00.000Z')],
      instant: at('2026-03-01T00:00:00.000Z'),
      legacyRegime: 'VAT_PAYER',
      probeRef: 'seller@2026-03-01',
    });
    expect(shadow).toEqual(
      TaxShadowDifferentSchema.make({
        legacyValue: 'VAT_PAYER',
        ontosValue: 'NON_PAYER',
        probeRef: 'seller@2026-03-01',
      }),
    );
  });

  it('is NOT_COMPARABLE when OntOS has NOT_DECLARED anything at the instant', () => {
    const shadow = compareShadowSellerVatRegime({
      candidateRevisions: [],
      instant: at('2026-03-01T00:00:00.000Z'),
      legacyRegime: 'VAT_PAYER',
      probeRef: 'seller@2026-03-01',
    });
    expect(shadow).toEqual(
      TaxShadowNotComparableSchema.make({
        probeRef: 'seller@2026-03-01',
        reason: 'SELLER_VAT_REGIME_NOT_DECLARED',
      }),
    );
  });

  it('is NOT_COMPARABLE when the legacy shadow side is UNKNOWN', () => {
    const shadow = compareShadowSellerVatRegime({
      candidateRevisions: [regimeRevision(1, 'VAT_PAYER', '2026-01-01T00:00:00.000Z')],
      instant: at('2026-03-01T00:00:00.000Z'),
      legacyRegime: 'UNKNOWN',
      probeRef: 'seller@2026-03-01',
    });
    expect(shadow).toEqual(
      TaxShadowNotComparableSchema.make({ probeRef: 'seller@2026-03-01', reason: 'LEGACY_UNKNOWN' }),
    );
  });
});

const readyEvidence = (family: TaxMigrationFamily): TaxMigrationFamilyEvidence => ({
  completeness: TaxMigrationCompleteSchema.make({ family, rowCount: 1 }),
  cutover: TaxMigrationCutoverDeclaredSchema.make({ at: at('2026-06-01T00:00:00.000Z') }),
  family,
  outcomes: [],
  shadowDifferences: [TaxShadowSameSchema.make({ probeRef: 'probe' })],
  targetDifferences: [],
});

describe('#960 Tax-specific readiness evidence for P6', () => {
  it('is READY only when every family is complete, reconciled, agreeing and its cutover is declared; never claims global cutover (F32)', () => {
    const evidence = assessTaxMigrationReadiness(scope, taxMigrationFamilies.map(readyEvidence));
    expect(evidence.verdict).toEqual(TaxMigrationReadySchema.make({}));
    expect(evidence.globalCutoverClaim).toBe('NONE');
    expect(evidence.datasetLabel).toBe('NON_PRODUCTION');
  });

  it('lists every blocker and treats a missing family as not verified (H)', () => {
    const shadow = compareShadowSellerVatRegime({
      candidateRevisions: [],
      instant: at('2026-03-01T00:00:00.000Z'),
      legacyRegime: 'VAT_PAYER',
      probeRef: 'seller@2026-03-01',
    });
    expect(shadow).toEqual(
      TaxShadowNotComparableSchema.make({
        probeRef: 'seller@2026-03-01',
        reason: 'SELLER_VAT_REGIME_NOT_DECLARED',
      }),
    );
    const evidence = assessTaxMigrationReadiness(scope, [
      {
        ...readyEvidence('TAX_RULE'),
        completeness: TaxMigrationUnverifiableSchema.make({ family: 'TAX_RULE', rowCount: 3 }),
        cutover: TaxMigrationCutoverNotDeclaredSchema.make({}),
        shadowDifferences: [shadow],
        targetDifferences: [{ difference: 'MEANING_DIFFERS', source: src('r2') }],
      },
    ]);
    expect(evidence.verdict).toEqual(
      TaxMigrationNotReadySchema.make({
        blockers: [
          { blocker: 'COMPLETENESS_NOT_VERIFIED', family: 'SELLER_VAT_REGIME_DECLARATION' },
          { blocker: 'COMPLETENESS_NOT_VERIFIED', family: 'TAX_RULE' },
          { blocker: 'TARGET_MEANING_DIFFERENCE', family: 'TAX_RULE' },
          { blocker: 'SHADOW_DIFFERENCE', family: 'TAX_RULE' },
          { blocker: 'CUTOVER_NOT_DECLARED', family: 'TAX_RULE' },
        ],
      }),
    );
  });
});

describe('#960 review round 1 regressions', () => {
  it('keeps two source systems with the same record ref as two records with their own provenance (F11, F17)', () => {
    const outcomes = evaluateTaxMigrationCandidates([
      taxRule('r1', {}, prov('r1', 'fixture:legacy-vat')),
      taxRule('r1', { ratePercent: '12' }, prov('r1', 'fixture:legacy-shop')),
    ]);
    expect(outcomes.map(({ provenance }) => provenance.sourceSystemRef)).toEqual([
      'fixture:legacy-shop',
      'fixture:legacy-vat',
    ]);
    const claim = { declaredBy: 'fixture:owner', expectedSourceRecords: [src('r1')], family: 'TAX_RULE' as const };
    expect(verifyTaxMigrationCompleteness('TAX_RULE', claim, outcomes)).toEqual(
      expect.objectContaining({ unexpectedSourceRecords: [src('r1', 'fixture:legacy-shop')] }),
    );
  });

  it('reports a target holding several meanings for one record as a conflict in any order (F15-F16)', () => {
    const outcomes = evaluateTaxMigrationCandidates([taxRule('r1')]);
    const target = [
      { source: src('r1'), targetMeaningKey: keyOf({ ratePercent: '12' }) },
      { source: src('r1'), targetMeaningKey: keyOf() },
    ];
    const conflict = [{ difference: 'TARGET_CONFLICT', source: src('r1') }];
    expect(reconcileTaxMigrationTarget(outcomes, target)).toEqual(conflict);
    expect(reconcileTaxMigrationTarget(outcomes, target.toReversed())).toEqual(conflict);
  });

  it('is never READY while a family still holds an open outcome, whatever completeness claims (F16-F18)', () => {
    const open = evaluateTaxMigrationCandidates([
      candidate('r9', { _tag: 'UNESTABLISHED', legacyFieldNames: ['VAT'] }),
    ]);
    const evidence = assessTaxMigrationReadiness(
      scope,
      taxMigrationFamilies.map((family) => ({ ...readyEvidence(family), outcomes: family === 'TAX_RULE' ? open : [] })),
    );
    expect(evidence.verdict).toEqual(
      TaxMigrationNotReadySchema.make({ blockers: [{ blocker: 'OPEN_OUTCOME', family: 'TAX_RULE' }] }),
    );
  });
});

const regimeMeaning = (
  effectiveFrom = '2026-01-01T00:00:00.000Z',
  overrides: Readonly<Record<string, string>> = {},
) => ({
  effectiveFrom,
  regime: 'VAT_PAYER',
  ...overrides,
});
const regimeCandidate = (
  sourceRecordRef: string,
  overrides: Readonly<Record<string, string>> = {},
  provenance: TaxMigrationProvenance = prov(sourceRecordRef),
) =>
  candidate(
    sourceRecordRef,
    { _tag: 'TAX_OWNED', family: 'SELLER_VAT_REGIME_DECLARATION', targetMeaning: regimeMeaning(undefined, overrides) },
    provenance,
  );

describe('#960 review round 1 regressions (Sol, Opus, Fable)', () => {
  it('never drops an unknown legacy key silently (F1, F9, F34)', () => {
    const outcome = only(evaluateTaxMigrationCandidates([taxRule('r-extra', { reverseCharge: 'true' })]));
    expect(outcome).toEqual(
      TaxMigrationReviewRequiredSchema.make({
        provenance: prov('r-extra'),
        reason: 'TARGET_MEANING_INVALID',
        sourceFamily: Option.some('TAX_RULE'),
      }),
    );
  });

  it('BDD a DIC-only legacy record never maps to a Seller VAT Regime Declaration (#907 Unit 10 D2)', () => {
    const outcome = only(
      evaluateTaxMigrationCandidates([regimeCandidate('dic-only', { dic: 'CZ00000000', regime: 'VAT_PAYER' })]),
    );
    expect(outcome).toEqual(
      TaxMigrationReviewRequiredSchema.make({
        provenance: prov('dic-only'),
        reason: 'TARGET_MEANING_INVALID',
        sourceFamily: Option.some('SELLER_VAT_REGIME_DECLARATION'),
      }),
    );
  });

  it('treats 21 and 21.00 as the same rate meaning (F15)', () => {
    expect(keyOf({ ratePercent: '21.00' })).toBe(keyOf());
  });

  it('marks two records for the same exact Tax Rule fact with different rates CONFLICTING (G, F16)', () => {
    const outcomes = evaluateTaxMigrationCandidates([taxRule('row-a'), taxRule('row-b', { ratePercent: '12' })]);
    expect(outcomes).toEqual([
      TaxMigrationConflictingSchema.make({
        counterparts: [prov('row-b')],
        provenance: prov('row-a'),
        sourceFamily: Option.some('TAX_RULE'),
      }),
      TaxMigrationConflictingSchema.make({
        counterparts: [prov('row-a')],
        provenance: prov('row-b'),
        sourceFamily: Option.some('TAX_RULE'),
      }),
    ]);
  });

  it('keeps different owners of one record CONFLICTING in any order (F3)', () => {
    const party = candidate('dup', { _tag: 'FOREIGN_OWNER', targetOwner: 'commerce.party-registry' });
    const order = candidate('dup', { _tag: 'HISTORICAL_ACCEPTED_VALUE', historicalOwner: 'commerce.order' });
    const forward = evaluateTaxMigrationCandidates([party, order]);
    expect(forward.every((outcome) => Schema.is(TaxMigrationConflictingSchema)(outcome))).toBe(true);
    expect(evaluateTaxMigrationCandidates([order, party])).toEqual(forward);
  });

  it('does not let a record mapped into another family satisfy a family claim (F17)', () => {
    const outcomes = evaluateTaxMigrationCandidates([regimeCandidate('v1')]);
    const claim = { declaredBy: 'fixture:owner', expectedSourceRecords: [src('v1')], family: 'TAX_RULE' as const };
    expect(verifyTaxMigrationCompleteness('TAX_RULE', claim, outcomes)).toEqual(
      expect.objectContaining({ missingSourceRecords: [src('v1')] }),
    );
  });

  it('reports records missing from and unexpected in the TAX target (F15)', () => {
    const outcomes = evaluateTaxMigrationCandidates([taxRule('r1')]);
    expect(reconcileTaxMigrationTarget(outcomes, [{ source: src('r9'), targetMeaningKey: keyOf() }])).toEqual([
      { difference: 'MISSING_IN_TARGET', source: src('r1') },
      { difference: 'UNEXPECTED_IN_TARGET', source: src('r9') },
    ]);
  });

  it('reports shadow agreement and an unselectable candidate rule as not comparable (F19-F20)', () => {
    const state = {
      predicateFingerprint: 'fixture-predicate',
      revisions: [
        {
          compositionKind: 'EXCLUSIVE' as const,
          correctedBy: [],
          effectiveFrom: at('2026-01-01T00:00:00.000Z'),
          effectiveTo: Option.none(),
          endedEffectiveTo: Option.none(),
          ratePercent: '21',
          revisionId: 'candidate-r1',
          revisionNumber: 1,
          taxRuleId: 'candidate-rule',
          treatmentCategory: 'TAXABLE' as const,
        },
      ],
    };
    const probe = (iso: string) => TaxRelevantTimeSchema.make(at(iso));
    expect(
      compareShadowTaxRule({
        candidateState: state,
        legacyRatePercent: '21.00',
        probeRef: 'p1',
        taxRelevantTime: probe('2026-03-01T00:00:00.000Z'),
      }),
    ).toEqual(TaxShadowSameSchema.make({ probeRef: 'p1' }));
    expect(
      compareShadowTaxRule({
        candidateState: state,
        legacyRatePercent: '21',
        probeRef: 'p0',
        taxRelevantTime: probe('2025-03-01T00:00:00.000Z'),
      }),
    ).toEqual(TaxShadowNotComparableSchema.make({ probeRef: 'p0', reason: 'TAX_RULE_MISSING' }));
  });

  it('never reports READY for an empty family list and names the evidence scope (C, F32)', () => {
    const evidence = assessTaxMigrationReadiness(scope, []);
    expect(Schema.is(TaxMigrationNotReadySchema)(evidence.verdict)).toBe(true);
    expect(evidence.scope).toEqual(scope);
  });
});

describe('#960 review round 2 regressions (Opus)', () => {
  it('never lets records of another Tax-owned family satisfy a family claim, mapped or not (F17-F18)', () => {
    const claim = { declaredBy: 'fixture:owner', expectedSourceRecords: [src('v1')], family: 'TAX_RULE' as const };
    const duplicated = evaluateTaxMigrationCandidates([regimeCandidate('v1'), regimeCandidate('v1')]);
    const outOfScope = evaluateTaxMigrationCandidates([regimeCandidate('v1', { regime: 'NON_PAYER' })]);
    const duplicateNotComplete = Schema.is(TaxMigrationNotCompleteSchema)(
      verifyTaxMigrationCompleteness('TAX_RULE', claim, duplicated),
    );
    expect(duplicateNotComplete).toBe(true);
    expect(
      Schema.is(TaxMigrationUnverifiableSchema)(verifyTaxMigrationCompleteness('TAX_RULE', claim, outOfScope)) ||
        Schema.is(TaxMigrationNotCompleteSchema)(verifyTaxMigrationCompleteness('TAX_RULE', claim, outOfScope)),
    ).toBe(true);
  });

  it('keeps a copy of a record of unknown meaning open instead of naming TAX its owner (F3, F34)', () => {
    const unknown = candidate('u1', { _tag: 'UNESTABLISHED', legacyFieldNames: ['VAT'] });
    const outcomes = evaluateTaxMigrationCandidates([unknown, unknown]);
    expect(outcomes.every((outcome) => Schema.is(TaxMigrationReviewRequiredSchema)(outcome))).toBe(true);
  });

  it('keeps a duplicate of a foreign-owned record with its foreign owner (F3)', () => {
    const party = candidate('p1', { _tag: 'FOREIGN_OWNER', targetOwner: 'commerce.party-registry' });
    const [, copy] = evaluateTaxMigrationCandidates([party, party]);
    expect(copy).toEqual(
      TaxMigrationRejectedUnmappedSchema.make({
        provenance: prov('p1'),
        reason: 'DUPLICATE_SOURCE_RECORD',
        sourceFamily: Option.none(),
        targetOwner: 'commerce.party-registry',
      }),
    );
  });

  it('treats differing copies of one unmapped Tax-owned record as CONFLICTING, not duplicates (G, F16)', () => {
    const outcomes = evaluateTaxMigrationCandidates([
      taxRule('o1', { jurisdiction: 'EU_OSS' }),
      taxRule('o1', { jurisdiction: 'DE_OSS' }),
    ]);
    expect(outcomes.every((outcome) => Schema.is(TaxMigrationConflictingSchema)(outcome))).toBe(true);
  });

  it('keeps two records with the identical meaning for one fact as one mapping and one duplicate (G)', () => {
    const outcomes = evaluateTaxMigrationCandidates([taxRule('same-a'), taxRule('same-b', { ratePercent: '21.0' })]);
    expect(outcomes).toEqual([
      TaxMigrationMappedAcceptedSchema.make({
        family: 'TAX_RULE',
        provenance: prov('same-a'),
        targetMeaningKey: keyOf(),
      }),
      TaxMigrationRejectedUnmappedSchema.make({
        provenance: prov('same-b'),
        reason: 'DUPLICATE_SOURCE_RECORD',
        sourceFamily: Option.some('TAX_RULE'),
        targetOwner: 'commerce.tax',
      }),
    ]);
  });

  it('never repairs a malformed rate into a valid one (F15)', () => {
    for (const ratePercent of ['21.', '21.5.0', '21.00.00']) {
      const outcome = only(evaluateTaxMigrationCandidates([taxRule('bad-rate', { ratePercent })]));
      expect(Schema.is(TaxMigrationReviewRequiredSchema)(outcome)).toBe(true);
    }
  });

  it('BDD a missing regime is INCOMPLETE, never defaulted (#907 Unit 10 D2, #960 F16)', () => {
    const outcome = only(
      evaluateTaxMigrationCandidates([
        candidate('no-regime', {
          _tag: 'TAX_OWNED',
          family: 'SELLER_VAT_REGIME_DECLARATION',
          targetMeaning: { effectiveFrom: '2026-01-01T00:00:00.000Z' },
        }),
      ]),
    );
    expect(outcome).toEqual(
      TaxMigrationIncompleteSchema.make({
        missing: ['regime'],
        provenance: prov('no-regime'),
        sourceFamily: Option.some('SELLER_VAT_REGIME_DECLARATION'),
      }),
    );
  });
});

describe('#960 review round 2 regressions (Sol, Astra)', () => {
  it('never merges two source identities whose parts only look alike when joined (F11, F17)', () => {
    const left = taxRule('c', { taxClassificationCode: 'left' }, prov('c', 'fixture:a b'));
    const right = taxRule('b c', { taxClassificationCode: 'right' }, prov('b c', 'fixture:a'));
    const outcomes = evaluateTaxMigrationCandidates([left]);
    const claim = {
      declaredBy: 'fixture:owner',
      expectedSourceRecords: [src('c', 'fixture:a b'), src('b c', 'fixture:a')],
      family: 'TAX_RULE' as const,
    };
    expect(verifyTaxMigrationCompleteness('TAX_RULE', claim, outcomes)).toEqual(
      expect.objectContaining({ missingSourceRecords: [src('b c', 'fixture:a')] }),
    );
    expect(
      evaluateTaxMigrationCandidates([left, right]).every((outcome) =>
        Schema.is(TaxMigrationMappedAcceptedSchema)(outcome),
      ),
    ).toBe(true);
  });
});

describe('#960 review round 3 regressions (Astra)', () => {
  it('never takes differing raw copies of one record for duplicates, whatever their characters (G, F16)', () => {
    const outcomes = evaluateTaxMigrationCandidates([
      // Under a `key=value&` join both serialize to `…zNote=x&zz=y`; the tuple encoding keeps them apart.
      taxRule('raw', { jurisdiction: 'EU_OSS', zNote: 'x&zz=y' }),
      taxRule('raw', { jurisdiction: 'EU_OSS', zNote: 'x', zz: 'y' }),
    ]);
    expect(outcomes.every((outcome) => Schema.is(TaxMigrationConflictingSchema)(outcome))).toBe(true);
  });
});

describe('#960 review round 3 regressions (Fable)', () => {
  it('lists an open record once in completeness, however many copies are open (F18)', () => {
    const outcomes = evaluateTaxMigrationCandidates([taxRule('split'), taxRule('split', { ratePercent: '12' })]);
    expect(verifyTaxMigrationCompleteness('TAX_RULE', ruleClaim(['split']), outcomes)).toEqual(
      expect.objectContaining({ openSourceRecords: [src('split')] }),
    );
  });
});

describe('#960 PR review regressions (Codex)', () => {
  it('excludes records resolved as owned elsewhere from a family claim, but keeps open unknown ones (F3, F17)', () => {
    const outcomes = evaluateTaxMigrationCandidates([
      taxRule('r1'),
      candidate('party-1', { _tag: 'FOREIGN_OWNER', targetOwner: 'commerce.party-registry' }),
    ]);
    expect(verifyTaxMigrationCompleteness('TAX_RULE', ruleClaim(['r1']), outcomes)).toEqual(
      TaxMigrationCompleteSchema.make({ family: 'TAX_RULE', rowCount: 2 }),
    );
    const withUnknown = [
      ...outcomes,
      ...evaluateTaxMigrationCandidates([candidate('u1', { _tag: 'UNESTABLISHED', legacyFieldNames: ['VAT'] })]),
    ];
    expect(
      Schema.is(TaxMigrationNotCompleteSchema)(
        verifyTaxMigrationCompleteness('TAX_RULE', ruleClaim(['r1']), withUnknown),
      ),
    ).toBe(true);
  });

  it('does not accept completeness evidence of another family (F17, H)', () => {
    const evidence = assessTaxMigrationReadiness(
      scope,
      taxMigrationFamilies.map((family) => ({
        ...readyEvidence(family),
        completeness: TaxMigrationCompleteSchema.make({ family: 'TAX_RULE', rowCount: 1 }),
      })),
    );
    expect(evidence.verdict).toEqual(
      TaxMigrationNotReadySchema.make({
        blockers: [{ blocker: 'COMPLETENESS_NOT_VERIFIED', family: 'SELLER_VAT_REGIME_DECLARATION' }],
      }),
    );
  });

  it('is independent of input order even for references that collate as equal (determinism)', () => {
    const composed = taxRule('café');
    const decomposed = taxRule('café');
    expect(evaluateTaxMigrationCandidates([decomposed, composed])).toEqual(
      evaluateTaxMigrationCandidates([composed, decomposed]),
    );
  });
});

describe('#960 PR review regressions (Codex, round 2)', () => {
  it('compares raw content independently of key insertion order, even for keys that collate as equal (G)', () => {
    const composedKey = 'café';
    const decomposedKey = 'café';
    const first = taxRule('raw-order', { [composedKey]: '1', [decomposedKey]: '2', jurisdiction: 'EU_OSS' });
    const second = candidate('raw-order', {
      _tag: 'TAX_OWNED',
      family: 'TAX_RULE',
      targetMeaning: { ...standardRate, [composedKey]: '1', [decomposedKey]: '2', jurisdiction: 'EU_OSS' },
    });
    const outcomes = evaluateTaxMigrationCandidates([first, second]);
    expect(outcomes.some((outcome) => Schema.is(TaxMigrationConflictingSchema)(outcome))).toBe(false);
  });

  it('lets the governed schema classify an invalid regime literal as REVIEW_REQUIRED (F16)', () => {
    const invalid = only(
      evaluateTaxMigrationCandidates([
        candidate('meaning', {
          _tag: 'TAX_OWNED',
          family: 'SELLER_VAT_REGIME_DECLARATION',
          targetMeaning: regimeMeaning(undefined, { regime: 'MAYBE' }),
        }),
      ]),
    );
    expect(invalid).toEqual(
      TaxMigrationReviewRequiredSchema.make({
        provenance: prov('meaning'),
        reason: 'TARGET_MEANING_INVALID',
        sourceFamily: Option.some('SELLER_VAT_REGIME_DECLARATION'),
      }),
    );
  });
});
