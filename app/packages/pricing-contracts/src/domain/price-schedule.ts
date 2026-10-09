import { Schema } from 'effect';

import { PricingInstantSchema } from '../apis/current-supported-currencies.ts';
import { PriceRefSchema } from '../resources/price.ts';
import {
  PriceDefinitionSchema,
  PriceNonNegativeDecimalSchema,
  PriceRevisionIdSchema,
  PriceRevisionNumberSchema,
} from './price-definition.ts';

export const PriceEffectivePeriodSchema = Schema.Struct({
  effectiveFrom: PricingInstantSchema,
  effectiveTo: Schema.NullOr(PricingInstantSchema),
}).check(
  Schema.makeFilter(({ effectiveFrom, effectiveTo }) =>
    effectiveTo === null || effectiveFrom < effectiveTo
      ? undefined
      : 'Price effective period must be a non-empty half-open interval',
  ),
);
export type PriceEffectivePeriod = typeof PriceEffectivePeriodSchema.Type;

export const PriceScheduleRevisionSchema = Schema.Int.check(Schema.isGreaterThan(0));
export const PriceScheduleFingerprintSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const checkedUuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());
export const PriceScheduleAcknowledgementPrincipalIdSchema = checkedUuid.pipe(
  Schema.brand('PricingPriceScheduleAcknowledgementPrincipalId'),
  Schema.decodeTo(checkedUuid),
);
export const PriceRevisionMonetaryAmountSchema = Schema.Struct({
  amount: PriceNonNegativeDecimalSchema,
  currencyCode: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u)),
});

export const PriceRevisionLineageSchema = Schema.Struct({
  correctedRevisionId: Schema.NullOr(PriceRevisionIdSchema),
  kind: Schema.Literals(['INITIAL', 'VALUE_ONLY_CURRENT', 'SCHEDULED', 'CORRECTION', 'RETIREMENT']),
  previousRevisionId: Schema.NullOr(PriceRevisionIdSchema),
}).check(
  Schema.makeFilter(({ correctedRevisionId, kind, previousRevisionId }) => {
    if (kind === 'INITIAL') {
      return correctedRevisionId === null && previousRevisionId === null
        ? undefined
        : 'An initial Price Revision cannot carry predecessor lineage';
    }
    if (previousRevisionId === null) {
      return 'A successor Price Revision must name its predecessor';
    }
    if (kind === 'CORRECTION') {
      return correctedRevisionId === null ? 'A correction must identify the corrected Price Revision' : undefined;
    }
    return correctedRevisionId === null ? undefined : 'Only a correction may identify a corrected Price Revision';
  }),
);
export type PriceRevisionLineage = typeof PriceRevisionLineageSchema.Type;

export const ScheduledPriceRevisionSchema = Schema.Struct({
  definition: PriceDefinitionSchema,
  effectivePeriod: PriceEffectivePeriodSchema,
  lineage: PriceRevisionLineageSchema,
}).check(
  Schema.makeFilter(({ definition, effectivePeriod }) =>
    definition.revision.effectiveFrom === effectivePeriod.effectiveFrom
      ? undefined
      : 'Price Revision effective start must match its scheduled period',
  ),
);
export type ScheduledPriceRevision = typeof ScheduledPriceRevisionSchema.Type;

export const ExpectedPriceCurrentSchema = Schema.Struct({
  effectivePeriod: PriceEffectivePeriodSchema,
  priceRef: PriceRefSchema,
  revision: PriceRevisionNumberSchema,
  revisionId: PriceRevisionIdSchema,
  scheduleRevision: PriceScheduleRevisionSchema,
});
export type ExpectedPriceCurrent = typeof ExpectedPriceCurrentSchema.Type;

export const PriceScheduleAcknowledgementSchema = Schema.Struct({
  actingPrincipalId: PriceScheduleAcknowledgementPrincipalIdSchema,
  fingerprint: PriceScheduleFingerprintSchema,
  intendedEffectivePeriod: PriceEffectivePeriodSchema,
  intendedMonetaryAmount: PriceRevisionMonetaryAmountSchema,
  intent: Schema.Literals(['RETIRE_CURRENT', 'VALUE_ONLY_CURRENT']),
  presentedFuture: Schema.Array(ScheduledPriceRevisionSchema),
  priceRef: PriceRefSchema,
  scheduleRevision: PriceScheduleRevisionSchema,
  targetRevisionId: PriceRevisionIdSchema,
});
export type PriceScheduleAcknowledgement = typeof PriceScheduleAcknowledgementSchema.Type;

export const PriceScheduleSnapshotSchema = Schema.Struct({
  current: Schema.optionalKey(ScheduledPriceRevisionSchema),
  future: Schema.Array(ScheduledPriceRevisionSchema),
  observedAt: PricingInstantSchema,
  priceRef: PriceRefSchema,
  revisions: Schema.Array(ScheduledPriceRevisionSchema).check(Schema.isMinLength(1)),
  scheduleRevision: PriceScheduleRevisionSchema,
}).check(
  Schema.makeFilter(({ current, future, observedAt, priceRef, revisions }) => {
    const ordered = revisions.toSorted((left, right) =>
      left.effectivePeriod.effectiveFrom.localeCompare(right.effectivePeriod.effectiveFrom),
    );
    const overlaps = ordered.some((revision, index) => {
      const previous = ordered[index - 1];
      return (
        previous !== undefined &&
        (previous.effectivePeriod.effectiveTo === null ||
          revision.effectivePeriod.effectiveFrom < previous.effectivePeriod.effectiveTo)
      );
    });
    if (overlaps) {
      return 'A Pricing Revision Schedule cannot overlap';
    }
    const selected = revisions.filter(
      ({ effectivePeriod }) =>
        effectivePeriod.effectiveFrom <= observedAt &&
        (effectivePeriod.effectiveTo === null || observedAt < effectivePeriod.effectiveTo),
    );
    if ((current === undefined && selected.length !== 0) || selected.length > 1) {
      return 'Schedule Current selection must use exact half-open effectivity';
    }
    if (
      current !== undefined &&
      (selected.length !== 1 || selected[0]?.definition.revision.revisionId !== current.definition.revision.revisionId)
    ) {
      return 'Schedule Current evidence must bind the exact effective Revision';
    }
    if (future.some(({ effectivePeriod }) => effectivePeriod.effectiveFrom <= observedAt)) {
      return 'Future Price Revisions must start after the trusted observation instant';
    }
    const expectedFuture: string[] = [];
    for (const revision of ordered) {
      if (revision.effectivePeriod.effectiveFrom > observedAt) {
        expectedFuture.push(revision.definition.revision.revisionId);
      }
    }
    if (
      future.length !== expectedFuture.length ||
      future.some(({ definition }, index) => definition.revision.revisionId !== expectedFuture[index])
    ) {
      return 'Future Price evidence must be the complete ordered future schedule';
    }
    return revisions.every(
      ({ definition }) =>
        definition.priceRef.moduleId === priceRef.moduleId &&
        definition.priceRef.resourceId === priceRef.resourceId &&
        definition.priceRef.resourceType === priceRef.resourceType &&
        definition.priceRef.tenantId === priceRef.tenantId,
    )
      ? undefined
      : 'All scheduled Revisions must belong to the exact Price';
  }),
);
export type PriceScheduleSnapshot = typeof PriceScheduleSnapshotSchema.Type;

export const PriceScheduleReadResultSchema = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal('PRICE_SCHEDULE_CURRENT'), schedule: PriceScheduleSnapshotSchema }),
  Schema.Struct({ outcome: Schema.Literal('PRICE_SCHEDULE_GAP'), schedule: PriceScheduleSnapshotSchema }),
  Schema.Struct({ outcome: Schema.Literal('PRICE_SCHEDULE_ABSENT'), priceRef: PriceRefSchema }),
  Schema.Struct({
    candidateRevisionIds: Schema.Array(PriceRevisionIdSchema).check(Schema.isMinLength(2)),
    outcome: Schema.Literal('PRICE_SCHEDULE_CONFLICT'),
    priceRef: PriceRefSchema,
  }),
]);
export type PriceScheduleReadResult = typeof PriceScheduleReadResultSchema.Type;
