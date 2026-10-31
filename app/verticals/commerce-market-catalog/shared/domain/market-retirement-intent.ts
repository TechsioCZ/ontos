import { Schema } from 'effect';

import { MarketRefSchema } from '../resources/market.ts';
import { MarketDefinitionRevisionRefSchema } from '../resources/market-definition-revision.ts';

const checkedUuid = Schema.String.check(Schema.isUUID());
const positiveRevision = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));

/** Opaque identity of one durable Market retirement intent. */
export const MarketRetirementIntentIdSchema = checkedUuid.pipe(
  Schema.brand('CommerceMarketRetirementIntentId'),
  Schema.decodeTo(checkedUuid),
);

/** The selling Legal Entity whose verified worker scope completes the intent. */
export const MarketRetirementLegalEntityIdSchema = checkedUuid.pipe(
  Schema.brand('CommerceMarketRetirementLegalEntityId'),
  Schema.decodeTo(checkedUuid),
);

/** Remote Customer Context operations, each with one stable idempotency key per intent. */
export const MarketRetirementRemoteOperationSchema = Schema.Literals(['commit', 'release', 'reserve']);
export type MarketRetirementRemoteOperation = typeof MarketRetirementRemoteOperationSchema.Type;

/** Stages in which the retirement is still being completed by the Market owner worker. */
export const MarketRetirementPendingStageSchema = Schema.Literals([
  'REQUESTED',
  'RESERVATION_REQUESTED',
  'RESERVED',
  'COMMIT_PENDING',
  'RELEASE_PENDING',
]);
export type MarketRetirementPendingStage = typeof MarketRetirementPendingStageSchema.Type;

export const MarketRetirementStageSchema = Schema.Literals([
  ...MarketRetirementPendingStageSchema.literals,
  'COMPLETED',
  'FAILED',
]);
export type MarketRetirementStage = typeof MarketRetirementStageSchema.Type;

/** Typed terminal reasons a requested retirement did not happen. */
export const MarketRetirementFailureReasonSchema = Schema.Literals([
  'replacement_impact_unresolved',
  'impact_assessment_stale',
  'impact_assessment_rejected',
  'impact_assessment_unavailable',
  'revision_conflict',
  'invalid_lifecycle_transition',
]);
export type MarketRetirementFailureReason = typeof MarketRetirementFailureReasonSchema.Type;

export const MarketRetirementPendingSchema = Schema.Struct({
  marketRef: MarketRefSchema,
  outcome: Schema.Literal('pending'),
  retirementIntentId: MarketRetirementIntentIdSchema,
  stage: MarketRetirementPendingStageSchema,
});

export const MarketRetirementCompletedSchema = Schema.Struct({
  changed: Schema.Boolean,
  definitionRevisionRef: MarketDefinitionRevisionRefSchema,
  lifecycle: Schema.Literal('RETIRED'),
  marketRef: MarketRefSchema,
  outcome: Schema.Literal('completed'),
  /** Absent only when the Market was already retired and no intent was created. */
  retirementIntentId: Schema.optionalKey(MarketRetirementIntentIdSchema),
  revision: positiveRevision,
}).check(
  Schema.makeFilter(({ definitionRevisionRef, marketRef }) =>
    definitionRevisionRef.tenantId === marketRef.tenantId
      ? undefined
      : 'Market and definition revision must belong to the same Tenant',
  ),
);

export const MarketRetirementFailedSchema = Schema.Struct({
  marketRef: MarketRefSchema,
  outcome: Schema.Literal('failed'),
  reason: MarketRetirementFailureReasonSchema,
  retirementIntentId: MarketRetirementIntentIdSchema,
});

/** Result of `retire-market` and of the `market-retirement-status` read. */
export const MarketRetirementOutcomeSchema = Schema.Union([
  MarketRetirementPendingSchema,
  MarketRetirementCompletedSchema,
  MarketRetirementFailedSchema,
]);
export type MarketRetirementOutcome = typeof MarketRetirementOutcomeSchema.Type;
