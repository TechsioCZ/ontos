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
  TaxAuthorityHandoffEvaluation,
  TaxMigrationFamilyEvidence,
  TaxMigrationReadinessBlocker,
  TaxMigrationReadinessEvidence,
  TaxMigrationScope,
  TaxShadowDifference,
} from '../../shared/domain/tax-migration-contracts.ts';
import { resolveSellingLegalEntityVatRegistration } from './selling-legal-entity-vat-registration-resolution.ts';
import type { CompleteSellingLegalEntityVatRegistrationState } from './selling-legal-entity-vat-registration-resolution.ts';
import type { SellingLegalEntityVatRegistrationState } from './selling-legal-entity-vat-registration.ts';
import { taxExactRationalFromDecimal, taxExactRationalsEqual } from './tax-exact-rational.ts';
import { isOpenTaxMigrationOutcome, taxMigrationFamilies } from './tax-fact-migration.ts';
import { selectApplicableTaxRuleRevision } from './tax-rule-selection.ts';
import type { CompleteTaxRuleState } from './tax-rule-selection.ts';
import type { TaxRelevantTime } from './tax-time.ts';

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

const unresolvedStates: ReadonlySet<SellingLegalEntityVatRegistrationState> = new Set([
  'STALE',
  'UNAVAILABLE',
  'UNKNOWN',
  'UNRESOLVED',
]);

/** Shadow comparison of the Selling Legal Entity VAT Registration state at an evaluation time (#925, #959, #960 F19). */
export const compareShadowVatRegistration = (input: {
  readonly candidateState: CompleteSellingLegalEntityVatRegistrationState;
  readonly evaluationTime: DateTime.Utc;
  readonly legacyState: SellingLegalEntityVatRegistrationState;
  readonly probeRef: string;
}): TaxShadowDifference => {
  const { reason, state } = resolveSellingLegalEntityVatRegistration({
    completeState: input.candidateState,
    evaluationTime: input.evaluationTime,
  });
  // An unresolved state on either side is not a business value, so equality would prove nothing (#960 F28-F29, F34).
  if (unresolvedStates.has(input.legacyState)) {
    return TaxShadowNotComparableSchema.make({ probeRef: input.probeRef, reason: `LEGACY_${input.legacyState}` });
  }
  if (unresolvedStates.has(state)) {
    return TaxShadowNotComparableSchema.make({ probeRef: input.probeRef, reason });
  }
  return state === input.legacyState
    ? TaxShadowSameSchema.make({ probeRef: input.probeRef })
    : TaxShadowDifferentSchema.make({ legacyValue: input.legacyState, ontosValue: state, probeRef: input.probeRef });
};

type Blocker = TaxMigrationReadinessBlocker['blocker'];

const handoffBlockers = (handoff: TaxAuthorityHandoffEvaluation): readonly Blocker[] =>
  Match.value(handoff).pipe(
    Match.tag('HANDOFF_VALID', () => []),
    Match.tag('AUTHORITY_CONFLICT', () => ['AUTHORITY_CONFLICT' as const]),
    Match.tag('AUTHORITY_GAP', () => ['AUTHORITY_GAP' as const]),
    Match.tag('INDETERMINATE', () => ['AUTHORITY_INDETERMINATE' as const]),
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
    ...handoffBlockers(evidence.handoff),
  ];
  return blockers.map((blocker) => ({ blocker, family: evidence.family }));
};

/**
 * Shadow evidence is optional (#960 F19 "may"), but any difference it does report blocks. READY only when every
 * Launch-critical family is owner-verifiably complete with no open outcome, its target meaning
 * reconciles, its shadow evaluation agrees and its authority handoff is valid (#960 H). A missing family is never ready. The evidence
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
