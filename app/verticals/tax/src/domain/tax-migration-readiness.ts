import { Match, Option } from 'effect';
import type { DateTime } from 'effect';

import {
  TaxMigrationNotReadySchema,
  TaxMigrationReadySchema,
  TaxShadowDifferentSchema,
  TaxShadowNotComparableSchema,
  TaxShadowSameSchema,
} from '../../shared/domain/tax-migration-contracts.ts';
import type {
  TaxMigrationCutover,
  TaxMigrationFamilyEvidence,
  TaxMigrationReadinessBlocker,
  TaxMigrationReadinessEvidence,
  TaxMigrationScope,
  TaxShadowDifference,
} from '../../shared/domain/tax-migration-contracts.ts';
import { sellerVatRegimeAt } from './seller-vat-regime-timeline.ts';
import type { SellerVatRegimeDeclarationRevision } from './seller-vat-regime-timeline.ts';
import { isOpenTaxMigrationOutcome, taxMigrationFamilies } from './tax-fact-migration.ts';
import { selectApplicableTaxRuleRevision } from './tax-rule-selection.ts';
import type { CompleteTaxRuleState } from './tax-rule-selection.ts';
import {
  taxExactRationalFromDecimal,
  taxExactRationalsEqual,
} from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import type { SellerVatRegime } from '../../shared/domain/tax-kernel/seller-vat-regime.ts';
import type { TaxRelevantTime } from '../../shared/domain/tax-kernel/tax-time.ts';

/**
 * Shadow comparison of the applicable VAT rate for one Tax Classification at a Tax-Relevant Time: the declared
 * pre-cutover System of Record value against the OntOS TAX candidate state, compared exactly (#929, #938). A
 * difference is Reconciliation evidence only; the shadow side never becomes production authority (#960 F19-F20).
 */
export const compareShadowTaxRule = (input: {
  readonly candidateState: CompleteTaxRuleState;
  readonly legacyRatePercent: string;
  readonly probeRef: string;
  readonly taxRelevantTime: TaxRelevantTime;
}): TaxShadowDifference => {
  const { probeRef } = input;
  const selection = selectApplicableTaxRuleRevision({
    completeState: input.candidateState,
    taxRelevantTime: input.taxRelevantTime,
  });
  if (selection.kind === 'NOT_SELECTED') {
    return TaxShadowNotComparableSchema.make({ probeRef, reason: selection.outcome._tag });
  }
  const legacy = taxExactRationalFromDecimal(input.legacyRatePercent);
  const ontos = taxExactRationalFromDecimal(selection.ratePercent);
  if (Option.isNone(legacy) || Option.isNone(ontos)) {
    return TaxShadowNotComparableSchema.make({ probeRef, reason: 'RATE_NOT_EXACT' });
  }
  return taxExactRationalsEqual(legacy.value, ontos.value)
    ? TaxShadowSameSchema.make({ probeRef })
    : TaxShadowDifferentSchema.make({
        legacyValue: input.legacyRatePercent,
        ontosValue: selection.ratePercent,
        probeRef,
      });
};

/** Legacy shadow regime, including the unresolved value when legacy has no comparable VAT regime of its own. */
export type LegacySellerVatRegime = SellerVatRegime | 'UNKNOWN';

/**
 * Shadow comparison of the Seller VAT Regime at an instant, against the live declaration timeline (#907 Unit 10
 * D2, #960 F19). NOT_DECLARED on the OntOS side or UNKNOWN on the legacy side is not a business value, so equality
 * would prove nothing; both are NOT_COMPARABLE.
 */
export const compareShadowSellerVatRegime = (input: {
  readonly candidateRevisions: readonly SellerVatRegimeDeclarationRevision[];
  readonly instant: DateTime.Utc;
  readonly legacyRegime: LegacySellerVatRegime;
  readonly probeRef: string;
}): TaxShadowDifference => {
  const { instant, legacyRegime, probeRef } = input;
  if (legacyRegime === 'UNKNOWN') {
    return TaxShadowNotComparableSchema.make({ probeRef, reason: 'LEGACY_UNKNOWN' });
  }
  const selection = sellerVatRegimeAt(input.candidateRevisions, instant);
  return Match.value(selection).pipe(
    Match.tag('NOT_DECLARED', () =>
      TaxShadowNotComparableSchema.make({ probeRef, reason: 'SELLER_VAT_REGIME_NOT_DECLARED' }),
    ),
    Match.tag('DECLARED', ({ regime }) =>
      regime === legacyRegime
        ? TaxShadowSameSchema.make({ probeRef })
        : TaxShadowDifferentSchema.make({ legacyValue: legacyRegime, ontosValue: regime, probeRef }),
    ),
    Match.exhaustive,
  );
};

type Blocker = TaxMigrationReadinessBlocker['blocker'];

const cutoverBlockers = (cutover: TaxMigrationCutover): readonly Blocker[] =>
  Match.value(cutover).pipe(
    Match.tag('CUTOVER_DECLARED', () => []),
    Match.tag('CUTOVER_NOT_DECLARED', () => ['CUTOVER_NOT_DECLARED' as const]),
    Match.exhaustive,
  );

const completenessBlockers = (evidence: TaxMigrationFamilyEvidence): readonly Blocker[] =>
  Match.value(evidence.completeness).pipe(
    // Completeness evidence counts only for the family it encloses.
    Match.tag('COMPLETE', ({ family }) => (family === evidence.family ? [] : ['COMPLETENESS_NOT_VERIFIED' as const])),
    Match.orElse(() => ['COMPLETENESS_NOT_VERIFIED' as const]),
  );

const isSame = (difference: TaxShadowDifference): boolean =>
  Match.value(difference).pipe(
    Match.tag('SAME', () => true),
    Match.orElse(() => false),
  );

const familyBlockers = (evidence: TaxMigrationFamilyEvidence): readonly TaxMigrationReadinessBlocker[] => {
  const blockers: readonly Blocker[] = [
    ...completenessBlockers(evidence),
    ...(evidence.outcomes.some(isOpenTaxMigrationOutcome) ? ['OPEN_OUTCOME' as const] : []),
    ...(evidence.targetDifferences.length === 0 ? [] : ['TARGET_MEANING_DIFFERENCE' as const]),
    ...(evidence.shadowDifferences.every(isSame) ? [] : ['SHADOW_DIFFERENCE' as const]),
    ...cutoverBlockers(evidence.cutover),
  ];
  return blockers.map((blocker) => ({ blocker, family: evidence.family }));
};

/**
 * Shadow evidence is optional (#960 F19 "may"), but any difference it does report blocks. READY only when every
 * Launch-critical family is owner-verifiably complete with no open outcome, its target meaning
 * reconciles, its shadow evaluation agrees and its cutover is declared (#960 H). A missing family is never ready. The evidence
 * is Tax-specific, NON_PRODUCTION, and never claims the global cutover complete (#960 F32).
 */
export const assessTaxMigrationReadiness = (
  scope: TaxMigrationScope,
  families: readonly TaxMigrationFamilyEvidence[],
): TaxMigrationReadinessEvidence => {
  // TAX owns which families are Launch-critical (#960 C); the caller cannot narrow the set.
  const missing = taxMigrationFamilies.flatMap((family) =>
    families.some((evidence) => evidence.family === family)
      ? []
      : [{ blocker: 'COMPLETENESS_NOT_VERIFIED' as const, family }],
  );
  const blockers = [...missing, ...families.flatMap(familyBlockers)];
  return {
    datasetLabel: 'NON_PRODUCTION',
    families,
    globalCutoverClaim: 'NONE',
    scope,
    verdict: blockers.length === 0 ? TaxMigrationReadySchema.make({}) : TaxMigrationNotReadySchema.make({ blockers }),
  };
};
