import { DateTime, Option } from 'effect';

import { TaxRuleRevisionRefSchema, TaxRuleIdSchema } from '../../shared/domain/tax-kernel/tax-decision.ts';
import { taxExactFractionOfPercent } from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import {
  TaxRuleConflictSchema,
  TaxRuleMissingSchema,
  TaxRuleOverlapSchema,
  TaxStateIndeterminateSchema,
} from './tax-non-success-outcome.ts';
import type {
  TaxRuleConflict,
  TaxRuleMissing,
  TaxRuleOverlap,
  TaxStateIndeterminate,
} from './tax-non-success-outcome.ts';
import { isWithinEffectivePeriod } from './tax-time.ts';
import type { TaxRelevantTime } from '../../shared/domain/tax-kernel/tax-time.ts';

type TaxRuleRevisionRef = typeof TaxRuleRevisionRefSchema.Type;

/** One immutable Tax Rule Revision of the complete owner state for a decisive predicate (#929 F17, #942 F13). */
export interface TaxRuleRevisionState {
  readonly compositionKind: 'EXCLUSIVE';
  /** Confirmed corrections naming this revision as wrong; the revision itself stays addressable (#930 F8). */
  readonly correctedBy: readonly string[];
  readonly effectiveFrom: DateTime.Utc;
  readonly effectiveTo: Option.Option<DateTime.Utc>;
  /** Separate end fact; ending never mutates the revision (#929 F2). */
  readonly endedEffectiveTo: Option.Option<DateTime.Utc>;
  readonly ratePercent: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly taxRuleId: string;
  readonly treatmentCategory: 'TAXABLE';
}

/** Complete authoritative state for one predicate; a partial observation is never represented as complete. */
export interface CompleteTaxRuleState {
  readonly predicateFingerprint: string;
  readonly revisions: readonly TaxRuleRevisionState[];
}

export interface TaxRuleCorrectionProvenance {
  readonly correctingRevisionId: string;
  readonly wrongRevisionId: string;
}

export type TaxRuleSelection =
  | Readonly<{
      excludedByCorrection: readonly TaxRuleCorrectionProvenance[];
      kind: 'SELECTED';
      predicateFingerprint: string;
      ratePercent: string;
      ref: TaxRuleRevisionRef;
      revision: TaxRuleRevisionState;
      treatmentCategory: 'TAXABLE';
    }>
  | Readonly<{
      applicable: readonly TaxRuleRevisionState[];
      excludedByCorrection: readonly TaxRuleCorrectionProvenance[];
      kind: 'NOT_SELECTED';
      outcome: TaxRuleConflict | TaxRuleMissing | TaxRuleOverlap | TaxStateIndeterminate;
    }>;

/** The earlier of the declared end and the separate end fact; ending only ever shortens (#929 F2, F10). */
const effectiveEnd = (revision: TaxRuleRevisionState): Option.Option<DateTime.Utc> =>
  Option.match(revision.endedEffectiveTo, {
    onNone: () => revision.effectiveTo,
    onSome: (ended) =>
      Option.some(Option.match(revision.effectiveTo, { onNone: () => ended, onSome: (to) => DateTime.min(to, ended) })),
  });

/** Half-open membership `[effective_from, effective_to)` with the end fact applied (#929 F4-F10). */
export const isTaxRuleRevisionEffectiveAt = (revision: TaxRuleRevisionState, taxRelevantTime: TaxRelevantTime) =>
  isWithinEffectivePeriod(
    Option.match(effectiveEnd(revision), {
      onNone: () => ({ effectiveFrom: revision.effectiveFrom }),
      onSome: (effectiveTo) => ({ effectiveFrom: revision.effectiveFrom, effectiveTo }),
    }),
    taxRelevantTime,
  );

/** Presentation order only; it never chooses a winner (#929 F13, #907 F59). */
const byIdentity = (left: TaxRuleRevisionState, right: TaxRuleRevisionState) =>
  left.taxRuleId === right.taxRuleId
    ? left.revisionNumber - right.revisionNumber
    : left.taxRuleId.localeCompare(right.taxRuleId, 'en');

const rateMeaning = (revision: TaxRuleRevisionState) => {
  const rate = taxExactFractionOfPercent(revision.ratePercent);
  return `${revision.treatmentCategory}:${rate.numerator}/${rate.denominator}`;
};

/**
 * Simultaneously applicable revisions of one Tax Rule, or of different EXCLUSIVE rules with the same meaning, are an
 * overlap (#930 F2); different rules with incompatible meanings and no governing composition are a conflict (F3).
 */
const hasIncompatibleRules = (applicable: readonly TaxRuleRevisionState[]): boolean =>
  applicable.some((left) =>
    applicable.some((right) => left.taxRuleId !== right.taxRuleId && rateMeaning(left) !== rateMeaning(right)),
  );

/**
 * Selects the applicable Tax Rule Revision for a Tax-Relevant Time from the complete owner state (#929 F11-F18,
 * #930 F1-F8, #942 F11-F15). It uses only Effective Periods, end facts and confirmed correction provenance; never
 * created_at, updated_at, insertion order or the highest revision number.
 */
export const selectApplicableTaxRuleRevision = (input: {
  readonly completeState: CompleteTaxRuleState | undefined;
  readonly taxRelevantTime: TaxRelevantTime;
}): TaxRuleSelection => {
  const { completeState, taxRelevantTime } = input;
  if (completeState === undefined) {
    return {
      applicable: [],
      excludedByCorrection: [],
      kind: 'NOT_SELECTED',
      outcome: TaxStateIndeterminateSchema.make({}),
    };
  }
  const effective = completeState.revisions.filter((revision) =>
    isTaxRuleRevisionEffectiveAt(revision, taxRelevantTime),
  );
  // A confirmed-wrong revision is never applicable again, whatever later happens to its correcting revision
  // (#930 F8-F9, #949 F16); its provenance is returned instead.
  const excludedByCorrection = effective
    .flatMap((revision) =>
      revision.correctedBy.map((correctingRevisionId) => ({
        correctingRevisionId,
        wrongRevisionId: revision.revisionId,
      })),
    )
    .toSorted(
      (left, right) =>
        left.wrongRevisionId.localeCompare(right.wrongRevisionId, 'en') ||
        left.correctingRevisionId.localeCompare(right.correctingRevisionId, 'en'),
    );
  const applicable = effective.filter((revision) => revision.correctedBy.length === 0).toSorted(byIdentity);
  const [only] = applicable;
  if (only === undefined) {
    return { applicable, excludedByCorrection, kind: 'NOT_SELECTED', outcome: TaxRuleMissingSchema.make({}) };
  }
  if (applicable.length === 1) {
    return {
      excludedByCorrection,
      kind: 'SELECTED',
      predicateFingerprint: completeState.predicateFingerprint,
      ratePercent: only.ratePercent,
      ref: TaxRuleRevisionRefSchema.make({
        revision: only.revisionNumber,
        taxRuleId: TaxRuleIdSchema.make(only.taxRuleId),
      }),
      revision: only,
      treatmentCategory: only.treatmentCategory,
    };
  }
  return {
    applicable,
    excludedByCorrection,
    kind: 'NOT_SELECTED',
    outcome: hasIncompatibleRules(applicable) ? TaxRuleConflictSchema.make({}) : TaxRuleOverlapSchema.make({}),
  };
};
