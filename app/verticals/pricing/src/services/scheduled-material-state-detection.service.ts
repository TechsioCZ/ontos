import type { PricingInstantSchema } from '@app/pricing-contracts/domain/currency-support';
import type { PricingMaterialChangeReason } from '@app/pricing-contracts/domain/material-change';
import type { PriceEffectivePeriod } from '@app/pricing-contracts/domain/price-schedule';
import { Schema } from 'effect';

type PricingInstant = typeof PricingInstantSchema.Type;

export const PricingMaterialSetFamilySchema = Schema.Literals([
  'PRICE',
  'QUANTITY_TIER',
  'DISCOUNT',
  'COMMERCIAL_FEE',
  'ZERO_FLOOR',
  'PROMOTION',
]);
export type PricingMaterialSetFamily = typeof PricingMaterialSetFamilySchema.Type;

export interface PricingScheduledMaterialRevision {
  readonly effectivePeriod: PriceEffectivePeriod;
  readonly revisionRef: string;
}

export interface PricingScheduledMaterialState {
  readonly exactKeyRef: string;
  readonly revisions: readonly PricingScheduledMaterialRevision[];
}

export type PricingScheduledSelection =
  | {
      readonly exactKeyRef: string;
      readonly outcome: 'ABSENT';
    }
  | {
      readonly current: PricingScheduledMaterialRevision;
      readonly exactKeyRef: string;
      readonly outcome: 'CURRENT';
    }
  | {
      readonly exactKeyRef: string;
      readonly outcome: 'CONFLICT';
      readonly revisionRefs: readonly string[];
    };

export type PricingMaterialOwnerSetState =
  | {
      readonly currentRevisionRefs: readonly string[];
      readonly family: PricingMaterialSetFamily;
      readonly ownerSetRevisionRef: string;
      readonly predicateRef: string;
      readonly status: 'PRESENT';
    }
  | {
      readonly family: PricingMaterialSetFamily;
      readonly ownerSetRevisionRef: string;
      readonly predicateRef: string;
      readonly status: 'ABSENT';
    }
  | {
      readonly currentRevisionRefs: readonly string[];
      readonly family: PricingMaterialSetFamily;
      readonly ownerSetRevisionRef: string;
      readonly predicateRef: string;
      readonly status: 'CONFLICT';
    }
  | {
      readonly family: PricingMaterialSetFamily;
      readonly predicateRef: string;
      readonly status: 'UNVERIFIABLE';
    };

export interface PricingMaterialStateSnapshot {
  readonly exactKeySchedules: readonly PricingScheduledMaterialState[];
  readonly observedAt: PricingInstant;
  readonly ownerSets: readonly PricingMaterialOwnerSetState[];
}

export const PricingScheduledMaterialChangeDetailSchema = Schema.Literals([
  'EXACT_KEY_STATE_CHANGED',
  'EXACT_KEY_COLLISION',
  'GROUP_PRICE_INSERTED_AFTER_PROVEN_ABSENCE',
  'MATERIAL_SET_CHANGED',
  'MATERIAL_SET_CONFLICT',
]);
export type PricingScheduledMaterialChangeDetail = typeof PricingScheduledMaterialChangeDetailSchema.Type;

export type PricingMaterialStateChangeDetection =
  | {
      readonly outcome: 'UNCHANGED';
    }
  | {
      readonly detail: PricingScheduledMaterialChangeDetail;
      readonly exactKeyRef?: string;
      readonly family?: PricingMaterialSetFamily;
      readonly outcome: 'MATERIAL_CHANGE';
      readonly predicateRef?: string;
      readonly reason: PricingMaterialChangeReason;
    }
  | {
      readonly outcome: 'INDETERMINATE';
      readonly predicateRef: string;
      readonly reason: 'OWNER_STATE_UNVERIFIABLE';
    };

export interface PricingScheduleAcknowledgementEvidence {
  readonly exactKeyRef: string;
  readonly intendedPayloadFingerprint: string;
  readonly presentedFuture: readonly PricingScheduledMaterialRevision[];
  readonly presentedScheduleRevisionRef: string;
  readonly targetEffectivePeriod: PriceEffectivePeriod;
  readonly targetRevisionRef: string;
}

export interface PricingPresentedScheduleState {
  readonly current: PricingScheduledMaterialRevision | undefined;
  readonly exactKeyRef: string;
  readonly future: readonly PricingScheduledMaterialRevision[];
  readonly scheduleRevisionRef: string;
}

export type PricingScheduleAcknowledgementAssessment =
  | { readonly outcome: 'ACKNOWLEDGEMENT_CURRENT' }
  | {
      readonly outcome: 'ACKNOWLEDGEMENT_STALE';
      readonly reason:
        | 'PRESENTED_SCHEDULE_CHANGED'
        | 'TARGET_REVISION_CHANGED'
        | 'TARGET_INTERVAL_CHANGED'
        | 'INTENDED_PAYLOAD_CHANGED';
    };

const covers = ({ effectiveFrom, effectiveTo }: PriceEffectivePeriod, at: PricingInstant): boolean =>
  effectiveFrom <= at && (effectiveTo === null || at < effectiveTo);

const samePeriod = (left: PriceEffectivePeriod, right: PriceEffectivePeriod): boolean =>
  left.effectiveFrom === right.effectiveFrom && left.effectiveTo === right.effectiveTo;

const stableRefs = (refs: readonly string[]): readonly string[] => [...refs].toSorted();

const sameRefs = (left: readonly string[], right: readonly string[]): boolean => {
  const stableLeft = stableRefs(left);
  const stableRight = stableRefs(right);
  return stableLeft.length === stableRight.length && stableLeft.every((ref, index) => ref === stableRight[index]);
};

const sameScheduledRevision = (
  left: PricingScheduledMaterialRevision,
  right: PricingScheduledMaterialRevision,
): boolean => left.revisionRef === right.revisionRef && samePeriod(left.effectivePeriod, right.effectivePeriod);

const samePresentedFuture = (
  left: readonly PricingScheduledMaterialRevision[],
  right: readonly PricingScheduledMaterialRevision[],
): boolean =>
  left.length === right.length &&
  left.every((revision, index) => {
    const observed = right[index];
    return observed !== undefined && sameScheduledRevision(revision, observed);
  });

const ownerSetIdentity = ({ family, predicateRef }: PricingMaterialOwnerSetState): string =>
  `${family}\u0000${predicateRef}`;

const materialReasonByFamily = {
  COMMERCIAL_FEE: 'COMMERCIAL_FEE_SET_CHANGED',
  DISCOUNT: 'DISCOUNT_SET_CHANGED',
  PRICE: 'EXACT_PRICE_KEY_OR_SET_CHANGED',
  PROMOTION: 'PROMOTION_OR_ALLOCATION_CHANGED',
  QUANTITY_TIER: 'QUANTITY_TIER_SET_CHANGED',
  ZERO_FLOOR: 'ZERO_FLOOR_SCOPE_OR_COVERAGE_CHANGED',
} as const satisfies Readonly<Record<PricingMaterialSetFamily, PricingMaterialChangeReason>>;

const reasonForFamily = (family: PricingMaterialSetFamily): PricingMaterialChangeReason =>
  materialReasonByFamily[family];

/** Selects the exact Current revision using half-open `[from,to)` effectivity. Gaps stay absent. */
export const selectScheduledMaterialStateAt = (
  schedule: PricingScheduledMaterialState,
  at: PricingInstant,
): PricingScheduledSelection => {
  const current = schedule.revisions.filter(({ effectivePeriod }) => covers(effectivePeriod, at));
  if (current.length === 0) {
    return { exactKeyRef: schedule.exactKeyRef, outcome: 'ABSENT' };
  }
  if (current.length === 1) {
    const [selected] = current;
    if (selected !== undefined) {
      return { current: selected, exactKeyRef: schedule.exactKeyRef, outcome: 'CURRENT' };
    }
  }
  return {
    exactKeyRef: schedule.exactKeyRef,
    outcome: 'CONFLICT',
    revisionRefs: stableRefs(current.map(({ revisionRef }) => revisionRef)),
  };
};

const schedulesByKey = (
  schedules: readonly PricingScheduledMaterialState[],
): ReadonlyMap<string, PricingScheduledMaterialState> | undefined => {
  const byKey = new Map<string, PricingScheduledMaterialState>();
  for (const schedule of schedules) {
    if (byKey.has(schedule.exactKeyRef)) {
      return undefined;
    }
    byKey.set(schedule.exactKeyRef, schedule);
  }
  return byKey;
};

const ownerSetsByIdentity = (
  ownerSets: readonly PricingMaterialOwnerSetState[],
): ReadonlyMap<string, PricingMaterialOwnerSetState> | undefined => {
  const byIdentity = new Map<string, PricingMaterialOwnerSetState>();
  for (const ownerSet of ownerSets) {
    const identity = ownerSetIdentity(ownerSet);
    if (byIdentity.has(identity)) {
      return undefined;
    }
    byIdentity.set(identity, ownerSet);
  }
  return byIdentity;
};

const compareScheduledSelections = (
  previous: PricingScheduledSelection,
  observed: PricingScheduledSelection,
  crossedTime: boolean,
): PricingMaterialStateChangeDetection | undefined => {
  if (observed.outcome === 'CONFLICT') {
    return {
      detail: 'EXACT_KEY_COLLISION',
      exactKeyRef: observed.exactKeyRef,
      outcome: 'MATERIAL_CHANGE',
      reason: 'EXACT_PRICE_KEY_OR_SET_CHANGED',
    };
  }
  if (previous.outcome === 'ABSENT' && observed.outcome === 'CURRENT') {
    const detail = observed.exactKeyRef.startsWith('GROUP_PRICE:')
      ? 'GROUP_PRICE_INSERTED_AFTER_PROVEN_ABSENCE'
      : 'EXACT_KEY_STATE_CHANGED';
    return {
      detail,
      exactKeyRef: observed.exactKeyRef,
      outcome: 'MATERIAL_CHANGE',
      reason: crossedTime ? 'PRICE_SCHEDULE_BOUNDARY_CROSSED' : 'EXACT_PRICE_KEY_OR_SET_CHANGED',
    };
  }
  if (previous.outcome !== observed.outcome) {
    return {
      detail: 'EXACT_KEY_STATE_CHANGED',
      exactKeyRef: observed.exactKeyRef,
      outcome: 'MATERIAL_CHANGE',
      reason: crossedTime ? 'PRICE_SCHEDULE_BOUNDARY_CROSSED' : 'EXACT_PRICE_KEY_OR_SET_CHANGED',
    };
  }
  if (
    previous.outcome === 'CURRENT' &&
    observed.outcome === 'CURRENT' &&
    (previous.current.revisionRef !== observed.current.revisionRef ||
      !samePeriod(previous.current.effectivePeriod, observed.current.effectivePeriod))
  ) {
    return {
      detail: 'EXACT_KEY_STATE_CHANGED',
      exactKeyRef: observed.exactKeyRef,
      outcome: 'MATERIAL_CHANGE',
      reason: crossedTime ? 'PRICE_SCHEDULE_BOUNDARY_CROSSED' : 'EXACT_PRICE_KEY_OR_SET_CHANGED',
    };
  }
  return undefined;
};

const compareOwnerSets = (
  previous: PricingMaterialOwnerSetState,
  observed: PricingMaterialOwnerSetState,
): PricingMaterialStateChangeDetection | undefined => {
  if (observed.status === 'UNVERIFIABLE') {
    return {
      outcome: 'INDETERMINATE',
      predicateRef: observed.predicateRef,
      reason: 'OWNER_STATE_UNVERIFIABLE',
    };
  }
  if (observed.status === 'CONFLICT') {
    return {
      detail: 'MATERIAL_SET_CONFLICT',
      family: observed.family,
      outcome: 'MATERIAL_CHANGE',
      predicateRef: observed.predicateRef,
      reason: reasonForFamily(observed.family),
    };
  }
  if (previous.status === 'UNVERIFIABLE' || previous.status === 'CONFLICT') {
    return {
      outcome: 'INDETERMINATE',
      predicateRef: previous.predicateRef,
      reason: 'OWNER_STATE_UNVERIFIABLE',
    };
  }
  const revisionsMatch =
    previous.status === 'PRESENT' && observed.status === 'PRESENT'
      ? sameRefs(previous.currentRevisionRefs, observed.currentRevisionRefs)
      : previous.status === observed.status;
  return previous.ownerSetRevisionRef === observed.ownerSetRevisionRef && revisionsMatch
    ? undefined
    : {
        detail: 'MATERIAL_SET_CHANGED',
        family: observed.family,
        outcome: 'MATERIAL_CHANGE',
        predicateRef: observed.predicateRef,
        reason: reasonForFamily(observed.family),
      };
};

/**
 * Compares two owner snapshots without merging them. The first material/conflict/indeterminate
 * result invalidates the retained evaluation; callers must discard the whole attempt.
 */
export const detectPricingMaterialStateChange = (
  previous: PricingMaterialStateSnapshot,
  observed: PricingMaterialStateSnapshot,
): PricingMaterialStateChangeDetection => {
  const previousSchedules = schedulesByKey(previous.exactKeySchedules);
  const observedSchedules = schedulesByKey(observed.exactKeySchedules);
  if (previousSchedules === undefined || observedSchedules === undefined) {
    return { outcome: 'INDETERMINATE', predicateRef: 'exact-key-schedules', reason: 'OWNER_STATE_UNVERIFIABLE' };
  }
  const exactKeys = new Set([...previousSchedules.keys(), ...observedSchedules.keys()]);
  for (const exactKeyRef of [...exactKeys].toSorted()) {
    const previousSchedule = previousSchedules.get(exactKeyRef);
    const observedSchedule = observedSchedules.get(exactKeyRef);
    if (previousSchedule === undefined || observedSchedule === undefined) {
      return {
        detail: 'EXACT_KEY_STATE_CHANGED',
        exactKeyRef,
        outcome: 'MATERIAL_CHANGE',
        reason: 'EXACT_PRICE_KEY_OR_SET_CHANGED',
      };
    }
    const change = compareScheduledSelections(
      selectScheduledMaterialStateAt(previousSchedule, previous.observedAt),
      selectScheduledMaterialStateAt(observedSchedule, observed.observedAt),
      previous.observedAt !== observed.observedAt,
    );
    if (change !== undefined) {
      return change;
    }
  }

  const previousOwnerSets = ownerSetsByIdentity(previous.ownerSets);
  const observedOwnerSets = ownerSetsByIdentity(observed.ownerSets);
  if (previousOwnerSets === undefined || observedOwnerSets === undefined) {
    return { outcome: 'INDETERMINATE', predicateRef: 'material-owner-sets', reason: 'OWNER_STATE_UNVERIFIABLE' };
  }
  const identities = new Set([...previousOwnerSets.keys(), ...observedOwnerSets.keys()]);
  for (const identity of [...identities].toSorted()) {
    const previousSet = previousOwnerSets.get(identity);
    const observedSet = observedOwnerSets.get(identity);
    if (previousSet === undefined || observedSet === undefined) {
      const source = observedSet ?? previousSet;
      if (source === undefined) {
        continue;
      }
      return {
        detail: 'MATERIAL_SET_CHANGED',
        family: source.family,
        outcome: 'MATERIAL_CHANGE',
        predicateRef: source.predicateRef,
        reason: reasonForFamily(source.family),
      };
    }
    const change = compareOwnerSets(previousSet, observedSet);
    if (change !== undefined) {
      return change;
    }
  }
  return { outcome: 'UNCHANGED' };
};

/** A schedule acknowledgement is valid only for the exact state and intent that was presented. */
export const assessPricingScheduleAcknowledgement = (
  acknowledgement: PricingScheduleAcknowledgementEvidence,
  presented: PricingPresentedScheduleState,
  intendedPayloadFingerprint: string,
): PricingScheduleAcknowledgementAssessment => {
  if (acknowledgement.intendedPayloadFingerprint !== intendedPayloadFingerprint) {
    return { outcome: 'ACKNOWLEDGEMENT_STALE', reason: 'INTENDED_PAYLOAD_CHANGED' };
  }
  if (presented.current?.revisionRef !== acknowledgement.targetRevisionRef) {
    return { outcome: 'ACKNOWLEDGEMENT_STALE', reason: 'TARGET_REVISION_CHANGED' };
  }
  if (
    acknowledgement.exactKeyRef !== presented.exactKeyRef ||
    acknowledgement.presentedScheduleRevisionRef !== presented.scheduleRevisionRef ||
    !samePresentedFuture(acknowledgement.presentedFuture, presented.future)
  ) {
    return { outcome: 'ACKNOWLEDGEMENT_STALE', reason: 'PRESENTED_SCHEDULE_CHANGED' };
  }
  return samePeriod(presented.current.effectivePeriod, acknowledgement.targetEffectivePeriod)
    ? { outcome: 'ACKNOWLEDGEMENT_CURRENT' }
    : { outcome: 'ACKNOWLEDGEMENT_STALE', reason: 'TARGET_INTERVAL_CHANGED' };
};
