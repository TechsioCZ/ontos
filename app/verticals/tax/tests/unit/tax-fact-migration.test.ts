import { DateTime, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  TaxAuthorityConflictSchema,
  TaxAuthorityGapSchema,
  TaxAuthorityHandoffIndeterminateSchema,
  TaxAuthorityHandoffValidSchema,
  TaxMigrationAuthorityContractIdSchema,
  TaxMigrationCompleteSchema,
  TaxMigrationConflictingSchema,
  TaxMigrationIncompleteSchema,
  TaxMigrationMappedAcceptedSchema,
  TaxMigrationNotCompleteSchema,
  TaxMigrationNotReadySchema,
  TaxMigrationReadySchema,
  TaxMigrationRejectedUnmappedSchema,
  TaxMigrationReviewRequiredSchema,
  TaxMigrationUnverifiableSchema,
  TaxShadowDifferentSchema,
  TaxShadowSameSchema,
} from '../../shared/domain/tax-migration-contracts.ts';
import type {
  TaxMigrationCandidate,
  TaxMigrationFamily,
  TaxMigrationFamilyEvidence,
  TaxMigrationMapping,
  TaxMigrationOutcome,
} from '../../shared/domain/tax-migration-contracts.ts';
import { evaluateTaxAuthorityHandoff, placeTaxMigrationAssertion } from '../../src/domain/tax-authority-handoff.ts';
import type { TaxAuthorityHandoffPeriod } from '../../src/domain/tax-authority-handoff.ts';
import {
  evaluateTaxMigrationCandidates,
  reconcileTaxMigrationTarget,
  taxMigrationFamilies,
  taxMigrationTargetMeaningKey,
  verifyTaxMigrationCompleteness,
} from '../../src/domain/tax-fact-migration.ts';
import {
  assessTaxMigrationReadiness,
  compareShadowTaxRule,
  compareShadowVatRegistration,
} from '../../src/domain/tax-migration-readiness.ts';
import { TaxRelevantTimeSchema } from '../../src/domain/tax-time.ts';

/** Every fixture dataset is explicitly NON_PRODUCTION; no real legacy data is used (#960, #907 F271-F272). */
const candidate = (sourceRecordRef: string, mapping: TaxMigrationMapping): TaxMigrationCandidate => ({
  mapping,
  provenance: {
    datasetLabel: 'NON_PRODUCTION',
    datasetRef: 'fixture:legacy-erp/2026-09',
    sourceRecordRef,
    sourceSystemRef: 'fixture:legacy-vat',
  },
});

const standardRate = {
  compositionKind: 'EXCLUSIVE',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  jurisdiction: 'CZ_DOMESTIC',
  ratePercent: '21',
  taxClassificationCode: 'standard',
  treatmentCategory: 'TAXABLE',
};
const taxRule = (sourceRecordRef: string, overrides: Readonly<Record<string, string>> = {}) =>
  candidate(sourceRecordRef, {
    _tag: 'TAX_OWNED',
    family: 'TAX_RULE',
    targetMeaning: { ...standardRate, ...overrides },
  });

const keyOf = (overrides: Readonly<Record<string, string>> = {}) =>
  Result.getOrThrow(taxMigrationTargetMeaningKey('TAX_RULE', { ...standardRate, ...overrides }));

const at = (iso: string) => DateTime.makeUnsafe(iso);

const only = (outcomes: readonly TaxMigrationOutcome[]): TaxMigrationOutcome => {
  const [outcome] = outcomes;
  expect(outcomes).toHaveLength(1);
  return (
    outcome ?? TaxMigrationReviewRequiredSchema.make({ reason: 'MEANING_NOT_ESTABLISHED', sourceRecordRef: 'none' })
  );
};

const ruleClaim = (expectedSourceRecordRefs: readonly string[]) => ({
  declaredBy: 'fixture:legacy-vat',
  expectedSourceRecordRefs,
  family: 'TAX_RULE' as const,
});

describe('#960 Migration maps business meaning, not legacy storage shape', () => {
  it('BDD Legacy VAT field has unclear semantics: never promoted by name, review required (F1, F13, F34)', () => {
    const outcome = only(
      evaluateTaxMigrationCandidates([candidate('legacy-row-1', { _tag: 'UNESTABLISHED', legacyFieldNames: ['VAT'] })]),
    );
    expect(outcome).toEqual(
      TaxMigrationReviewRequiredSchema.make({ reason: 'MEANING_NOT_ESTABLISHED', sourceRecordRef: 'legacy-row-1' }),
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
        reason: 'FOREIGN_OWNER',
        sourceRecordRef: 'legacy-row-2',
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
        sourceRecordRef: 'legacy-rate-21',
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
        reason: 'HISTORICAL_ACCEPTED_VALUE',
        sourceRecordRef: 'order-77-line-1',
        targetOwner: 'commerce.order',
      }),
    );
  });

  it('BDD Unsupported OSS rule exists in legacy: it does not activate OSS (F9)', () => {
    const outcome = only(evaluateTaxMigrationCandidates([taxRule('legacy-oss-1', { jurisdiction: 'EU_OSS' })]));
    expect(outcome).toEqual(
      TaxMigrationRejectedUnmappedSchema.make({
        reason: 'UNSUPPORTED_BREADTH',
        sourceRecordRef: 'legacy-oss-1',
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
      TaxMigrationReviewRequiredSchema.make({ reason: 'TARGET_MEANING_INVALID', sourceRecordRef: 'legacy-negative' }),
      TaxMigrationIncompleteSchema.make({
        missing: ['effectiveFrom', 'ratePercent', 'taxClassificationCode'],
        sourceRecordRef: 'legacy-partial',
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
        sourceRecordRef: 'legacy-dup',
        targetMeaningKey: keyOf(),
      }),
      TaxMigrationRejectedUnmappedSchema.make({
        reason: 'DUPLICATE_SOURCE_RECORD',
        sourceRecordRef: 'legacy-dup',
        targetOwner: 'commerce.tax',
      }),
      TaxMigrationConflictingSchema.make({ counterpartRecordRefs: ['legacy-split'], sourceRecordRef: 'legacy-split' }),
      TaxMigrationConflictingSchema.make({ counterpartRecordRefs: ['legacy-split'], sourceRecordRef: 'legacy-split' }),
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
        missingRecordRefs: ['r2'],
        openRecordRefs: [],
        rowCount: 1,
        unexpectedRecordRefs: [],
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
    expect(completeness).toEqual(expect.objectContaining({ missingRecordRefs: [], openRecordRefs: ['r2'] }));
  });

  it('BDD Row counts match but semantics differ: Reconciliation does not pass (F14-F15)', () => {
    const outcomes = evaluateTaxMigrationCandidates([taxRule('r1'), taxRule('r2', { ratePercent: '12' })]);
    const target = [
      { sourceRecordRef: 'r1', targetMeaningKey: keyOf() },
      { sourceRecordRef: 'r2', targetMeaningKey: keyOf({ ratePercent: '15' }) },
    ];
    expect(target).toHaveLength(outcomes.length);
    expect(reconcileTaxMigrationTarget(outcomes, target)).toEqual([
      { difference: 'MEANING_DIFFERS', sourceRecordRef: 'r2' },
    ]);
  });
});

const contract = (
  contractId: string,
  systemOfRecordRef: string,
  from: Option.Option<string>,
  to: Option.Option<string> = Option.none(),
): TaxAuthorityHandoffPeriod => ({
  authorityFrom: from.pipe(Option.map(at)),
  authorityTo: to.pipe(Option.map(at)),
  contractId,
  contractRevisionId: `${contractId}-r1`,
  evidenceSourceRefs: [],
  systemOfRecordRef,
});

const legacyAuthority = contract(
  'legacy',
  'fixture:legacy-vat',
  Option.some('2026-01-01T00:00:00.000Z'),
  Option.some('2026-06-01T00:00:00.000Z'),
);
const ontosAuthority = contract('ontos', 'commerce.tax', Option.some('2026-06-01T00:00:00.000Z'));

describe('#960 Migration allows dual running but never dual authority', () => {
  it('BDD Shadow phase before authority handoff: a difference is evidence, OntOS does not become authority', () => {
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

  it('BDD Tax authority is handed over: the explicit boundary moves Current authority (F23-F26)', () => {
    expect(evaluateTaxAuthorityHandoff([ontosAuthority, legacyAuthority])).toEqual(
      TaxAuthorityHandoffValidSchema.make({
        boundaries: [
          {
            at: at('2026-06-01T00:00:00.000Z'),
            fromSystemOfRecordRef: 'fixture:legacy-vat',
            toSystemOfRecordRef: 'commerce.tax',
          },
        ],
      }),
    );
  });

  it('BDD Authority windows accidentally overlap: a conflict, never chosen by order (F27)', () => {
    const overlapping = contract('ontos-early', 'commerce.tax', Option.some('2026-05-01T00:00:00.000Z'));
    const conflict = TaxAuthorityConflictSchema.make({
      contractIds: ['legacy', 'ontos-early'].map((contractId) =>
        TaxMigrationAuthorityContractIdSchema.make(contractId),
      ),
    });
    expect(evaluateTaxAuthorityHandoff([legacyAuthority, overlapping])).toEqual(conflict);
    expect(evaluateTaxAuthorityHandoff([overlapping, legacyAuthority])).toEqual(conflict);
  });

  it('BDD Authority gap exists: no authority is guessed (F28-F29)', () => {
    const late = contract('ontos-late', 'commerce.tax', Option.some('2026-07-01T00:00:00.000Z'));
    expect(evaluateTaxAuthorityHandoff([legacyAuthority, late])).toEqual(
      TaxAuthorityGapSchema.make({
        from: at('2026-06-01T00:00:00.000Z'),
        to: Option.some(at('2026-07-01T00:00:00.000Z')),
      }),
    );
    expect(evaluateTaxAuthorityHandoff([legacyAuthority])).toEqual(
      TaxAuthorityGapSchema.make({ from: at('2026-06-01T00:00:00.000Z'), to: Option.none() }),
    );
    expect(evaluateTaxAuthorityHandoff([legacyAuthority, contract('unknown', 'commerce.tax', Option.none())])).toEqual(
      TaxAuthorityHandoffIndeterminateSchema.make({ reason: 'AUTHORITY_BOUNDARY_UNKNOWN' }),
    );
  });

  it('BDD Pre-cutover assertion arrives after handoff: it keeps its provenance and stays historical (F30)', () => {
    const periods = [legacyAuthority, ontosAuthority].map((period) => ({
      ...period,
      authorityFrom: Option.getOrThrow(period.authorityFrom),
    }));
    expect(
      placeTaxMigrationAssertion({
        businessInstant: at('2026-03-01T00:00:00.000Z'),
        evaluationInstant: at('2026-07-01T00:00:00.000Z'),
        periods,
        sourceRef: 'fixture:legacy-vat',
      }),
    ).toEqual({ placement: 'HISTORICAL_OR_RECONCILIATION_ONLY', systemOfRecordRef: Option.some('fixture:legacy-vat') });
  });
});

const readyEvidence = (family: TaxMigrationFamily): TaxMigrationFamilyEvidence => ({
  completeness: TaxMigrationCompleteSchema.make({ family, rowCount: 1 }),
  family,
  handoff: TaxAuthorityHandoffValidSchema.make({ boundaries: [] }),
  outcomes: [],
  shadowDifferences: [TaxShadowSameSchema.make({ probeRef: 'probe' })],
  targetDifferences: [],
});

describe('#960 Tax-specific readiness evidence for P6', () => {
  it('is READY only when every family is complete, reconciled, agreeing and handed off; never claims cutover (F32)', () => {
    const evidence = assessTaxMigrationReadiness(taxMigrationFamilies.map(readyEvidence), taxMigrationFamilies);
    expect(evidence.verdict).toEqual(TaxMigrationReadySchema.make({}));
    expect(evidence.globalCutoverClaim).toBe('NONE');
    expect(evidence.datasetLabel).toBe('NON_PRODUCTION');
  });

  it('lists every blocker and treats a missing family as not verified (H)', () => {
    const shadow = compareShadowVatRegistration({
      candidateState: { authorities: [], eligibleAssertions: [] },
      evaluationTime: at('2026-03-01T00:00:00.000Z'),
      legacyState: 'CURRENT_POSITIVE',
      probeRef: 'seller@2026-03-01',
    });
    expect(shadow).toEqual(
      TaxShadowDifferentSchema.make({
        legacyValue: 'CURRENT_POSITIVE',
        ontosValue: 'UNKNOWN',
        probeRef: 'seller@2026-03-01',
      }),
    );
    const evidence = assessTaxMigrationReadiness(
      [
        {
          ...readyEvidence('TAX_RULE'),
          completeness: TaxMigrationUnverifiableSchema.make({ family: 'TAX_RULE', rowCount: 3 }),
          handoff: TaxAuthorityGapSchema.make({ from: at('2026-06-01T00:00:00.000Z'), to: Option.none() }),
          shadowDifferences: [shadow],
          targetDifferences: [{ difference: 'MEANING_DIFFERS', sourceRecordRef: 'r2' }],
        },
      ],
      taxMigrationFamilies,
    );
    expect(evidence.verdict).toEqual(
      TaxMigrationNotReadySchema.make({
        blockers: [
          { blocker: 'COMPLETENESS_NOT_VERIFIED', family: 'SELLING_LEGAL_ENTITY_VAT_REGISTRATION' },
          { blocker: 'COMPLETENESS_NOT_VERIFIED', family: 'TAX_RULE' },
          { blocker: 'TARGET_MEANING_DIFFERENCE', family: 'TAX_RULE' },
          { blocker: 'SHADOW_DIFFERENCE', family: 'TAX_RULE' },
          { blocker: 'AUTHORITY_GAP', family: 'TAX_RULE' },
        ],
      }),
    );
  });
});
