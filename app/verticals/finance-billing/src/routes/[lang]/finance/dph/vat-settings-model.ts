// What the VAT settings page shows and plans, computed from Tax's own reads; no request and no React here.
import type { CzVatClassificationCode } from '@app/shared-contracts/cz-vat-classifications';
import type { TaxRuleRevisionRef } from '@app/tax/resources/tax-rule-revision';
import type { TaxRuleRef } from '@app/tax/resources/tax-rule';
import { DateTime, Option, Order, Schema } from 'effect';

/** One rate revision as it applies: its rate and the half-open period `[from, to)`, open-ended without `to`. */
export interface RateRevision {
  readonly from: DateTime.Utc;
  readonly ratePercent: string;
  readonly revisionRef: TaxRuleRevisionRef;
  readonly to: DateTime.Utc | undefined;
}

/** A Tax rule history entry, reduced to what decides when it applies. */
export interface RuleHistoryRevision {
  readonly effectiveFrom: DateTime.Utc;
  readonly effectiveTo: Option.Option<DateTime.Utc>;
  readonly endFact: Option.Option<{ readonly endedEffectiveTo: DateTime.Utc }>;
  readonly ratePercent: string;
  readonly taxRuleRevisionRef: TaxRuleRevisionRef;
}

export interface RuleHistory {
  readonly basisFingerprint: string;
  readonly corrections: readonly { readonly wrongRevisionRef: TaxRuleRevisionRef }[];
  readonly revisions: readonly RuleHistoryRevision[];
  readonly taxRuleRef: TaxRuleRef;
}

/** One classification's rate over time: what applies now, what is planned, and what applied before. */
export type ClassificationView =
  | { readonly code: CzVatClassificationCode; readonly state: 'missing' }
  | {
      readonly basisFingerprint: string;
      readonly code: CzVatClassificationCode;
      readonly current: RateRevision | undefined;
      readonly past: readonly RateRevision[];
      readonly revisions: readonly RateRevision[];
      readonly scheduled: readonly RateRevision[];
      readonly state: 'ready';
      readonly taxRuleRef: TaxRuleRef;
      /** Tax found more than one rate (or none it could decide) for today: the company must fix its plan. */
      readonly undecided: boolean;
    };

const sameRevision = (left: TaxRuleRevisionRef, right: TaxRuleRevisionRef) =>
  left.resourceId === right.resourceId && left.tenantId === right.tenantId;

const byFrom = Order.mapInput(DateTime.Order, (revision: RateRevision) => revision.from);

/** The effective end of a revision: the earlier of its declared end and the end Tax recorded later. */
const effectiveEnd = (revision: RuleHistoryRevision): DateTime.Utc | undefined => {
  const declared = Option.getOrUndefined(revision.effectiveTo);
  const ended = revision.endFact.pipe(
    Option.map((fact) => fact.endedEffectiveTo),
    Option.getOrUndefined,
  );
  if (declared === undefined) {
    return ended;
  }
  return ended === undefined ? declared : DateTime.min(declared, ended);
};

/**
 * The revisions that still apply somewhere: a corrected (wrong) revision and a withdrawn plan (ended at its own start)
 * apply nowhere, so the page never shows them as rates.
 */
export const applyingRevisions = (history: RuleHistory): readonly RateRevision[] =>
  history.revisions
    .flatMap((revision) => {
      const to = effectiveEnd(revision);
      const withdrawn = to !== undefined && !DateTime.isGreaterThan(to, revision.effectiveFrom);
      const corrected = history.corrections.some((correction) =>
        sameRevision(correction.wrongRevisionRef, revision.taxRuleRevisionRef),
      );
      return withdrawn || corrected
        ? []
        : [
            {
              from: revision.effectiveFrom,
              ratePercent: revision.ratePercent,
              revisionRef: revision.taxRuleRevisionRef,
              to,
            },
          ];
    })
    .toSorted(byFrom);

const appliesAt = (revision: RateRevision, instant: DateTime.Utc) =>
  !DateTime.isGreaterThan(revision.from, instant) &&
  (revision.to === undefined || DateTime.isLessThan(instant, revision.to));

/** Splits a classification's history at `now` into the current rate, planned rates and earlier rates. */
export const classificationView = (
  code: CzVatClassificationCode,
  history: RuleHistory,
  now: DateTime.Utc,
  undecided: boolean,
): ClassificationView => {
  const revisions = applyingRevisions(history);
  return {
    basisFingerprint: history.basisFingerprint,
    code,
    current: revisions.find((revision) => appliesAt(revision, now)),
    past: revisions
      .filter((revision) => revision.to !== undefined && !DateTime.isGreaterThan(revision.to, now))
      .toReversed(),
    revisions,
    scheduled: revisions.filter((revision) => DateTime.isGreaterThan(revision.from, now)),
    state: 'ready',
    taxRuleRef: history.taxRuleRef,
    undecided,
  };
};

/** The Tax steps of one planned rate change: end the rate that covers its start, then add the new rate. */
export interface RateChangePlan {
  readonly create: { readonly effectiveFrom: DateTime.Utc; readonly effectiveTo: DateTime.Utc | undefined };
  readonly end: RateRevision | undefined;
}

/** How one VAT change ended, as the page explains it. */
export const VatChangeOutcomeSchema = Schema.Literals([
  'alreadyPlanned',
  'approvalRequired',
  'confirmReplace',
  'conflict',
  'done',
  'forbidden',
  'invalid',
  'notInFuture',
  'reasonRequired',
  'unavailable',
]);
export type VatChangeOutcome = typeof VatChangeOutcomeSchema.Type;

/**
 * Plans a new rate from `from` (a Prague midnight in the future). The rate covering that day is ended there, and the
 * new rate lasts until the next planned rate starts (or open-ended), so periods never overlap. A day that already
 * starts a planned rate is refused: that plan is withdrawn first.
 */
export const planRateChange = (
  view: Extract<ClassificationView, { readonly state: 'ready' }>,
  from: DateTime.Utc,
  now: DateTime.Utc,
): RateChangePlan | Extract<VatChangeOutcome, 'alreadyPlanned' | 'notInFuture'> => {
  if (!DateTime.isGreaterThan(from, now)) {
    return 'notInFuture';
  }
  if (view.revisions.some((revision) => DateTime.Equivalence(revision.from, from))) {
    return 'alreadyPlanned';
  }
  const next = view.revisions.find((revision) => DateTime.isGreaterThan(revision.from, from));
  return {
    create: { effectiveFrom: from, effectiveTo: next?.from },
    end: view.revisions.find((revision) => appliesAt(revision, from)),
  };
};

/** The Tax steps of withdrawing a planned rate: withdraw it, then let the rate before it continue over its period. */
export interface WithdrawPlan {
  /** The earlier rate ended exactly where the plan starts: it is carried on over the withdrawn plan's period. */
  readonly continueWith: { readonly effectiveTo: DateTime.Utc | undefined; readonly ratePercent: string } | undefined;
  readonly withdraw: RateRevision;
}

export const planWithdraw = (
  view: Extract<ClassificationView, { readonly state: 'ready' }>,
  planned: RateRevision,
): WithdrawPlan => {
  const before = view.revisions.find(
    (revision) => revision.to !== undefined && DateTime.Equivalence(revision.to, planned.from),
  );
  return {
    continueWith: before === undefined ? undefined : { effectiveTo: planned.to, ratePercent: before.ratePercent },
    withdraw: planned,
  };
};

/** One declared VAT regime revision as the timeline applies it. */
export interface RegimeRevision {
  readonly effectiveFrom: DateTime.Utc;
  readonly regime: 'NON_PAYER' | 'VAT_PAYER';
  readonly revision: number;
}

export interface RegimePeriod {
  readonly from: DateTime.Utc;
  readonly regime: 'NON_PAYER' | 'VAT_PAYER';
  readonly state: 'current' | 'past' | 'scheduled';
  readonly to: DateTime.Utc | undefined;
}

/**
 * The company's regime periods. Tax applies the highest-numbered revision already in effect, so a revision that a
 * later declaration with an earlier-or-equal start replaced never applies; the rest follow one another by start.
 */
export const regimeTimeline = (revisions: readonly RegimeRevision[], now: DateTime.Utc): readonly RegimePeriod[] => {
  const live = revisions
    .filter(
      (candidate) =>
        !revisions.some(
          (other) =>
            other.revision > candidate.revision &&
            !DateTime.isGreaterThan(other.effectiveFrom, candidate.effectiveFrom),
        ),
    )
    .toSorted(Order.mapInput(DateTime.Order, (revision: RegimeRevision) => revision.effectiveFrom));
  return live.map((revision, index) => {
    const to = live[index + 1]?.effectiveFrom;
    const started = !DateTime.isGreaterThan(revision.effectiveFrom, now);
    const ended = to !== undefined && !DateTime.isGreaterThan(to, now);
    let state: RegimePeriod['state'] = 'scheduled';
    if (started) {
      state = ended ? 'past' : 'current';
    }
    return { from: revision.effectiveFrom, regime: revision.regime, state, to };
  });
};

/** A whole percent between 1 and 100 typed with a comma or a dot; undefined otherwise. */
export const parseRatePercent = (text: string): number | undefined => {
  const value = Number(text.trim().replace(',', '.'));
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : undefined;
};
