import { Schema } from 'effect';

const MarketLifecycleStateSchema = Schema.Literals(['ACTIVE', 'RETIRED', 'SUSPENDED']);
export type MarketLifecycleState = typeof MarketLifecycleStateSchema.Type;

const DomainIdentifierSchema = Schema.String.pipe(
  Schema.brand('CommerceMarketAdministrationIdentifier'),
  Schema.decodeTo(Schema.String),
);
const RevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const HalfOpenPeriodSchema = Schema.Struct({
  endsAt: Schema.optional(Schema.DateTimeUtcFromString),
  startsAt: Schema.DateTimeUtcFromString,
});
export type HalfOpenPeriod = typeof HalfOpenPeriodSchema.Encoded;

const MarketAdministrationSnapshotSchema = Schema.Struct({
  aggregateRevision: RevisionSchema,
  businessCode: Schema.String,
  currentDefinitionRevision: RevisionSchema,
  lifecycle: MarketLifecycleStateSchema,
  marketId: DomainIdentifierSchema,
  sellingLegalEntityId: DomainIdentifierSchema,
});
export type MarketAdministrationSnapshot = typeof MarketAdministrationSnapshotSchema.Type;

const StorefrontAssociationSnapshotSchema = Schema.Struct({
  associationId: DomainIdentifierSchema,
  channel: Schema.Literals(['B2B', 'B2C']),
  effectivePeriod: HalfOpenPeriodSchema,
  marketId: DomainIdentifierSchema,
  removedAt: Schema.optional(Schema.DateTimeUtcFromString),
  revision: RevisionSchema,
  sellingLegalEntityId: DomainIdentifierSchema,
  storefrontAppId: DomainIdentifierSchema,
});
export type StorefrontAssociationSnapshot = typeof StorefrontAssociationSnapshotSchema.Encoded;

export const halfOpenPeriodsOverlap = (left: HalfOpenPeriod, right: HalfOpenPeriod): boolean =>
  (left.endsAt === undefined || right.startsAt < left.endsAt) &&
  (right.endsAt === undefined || left.startsAt < right.endsAt);

const MarketCreateDecisionSchema = Schema.Union([
  Schema.TaggedStruct('created', {}),
  Schema.TaggedStruct('reused', { market: MarketAdministrationSnapshotSchema }),
  Schema.TaggedStruct('market_code_conflict', {}),
  Schema.TaggedStruct('seller_identity_immutable', {}),
]);
export type MarketCreateDecision = typeof MarketCreateDecisionSchema.Type;

export const decideMarketCreate = (
  existingById: MarketAdministrationSnapshot | undefined,
  existingByCode: MarketAdministrationSnapshot | undefined,
  proposed: Readonly<{
    readonly businessCode: string;
    readonly marketId: string;
    readonly sellingLegalEntityId: string;
  }>,
): MarketCreateDecision => {
  if (existingById !== undefined) {
    if (existingById.sellingLegalEntityId !== proposed.sellingLegalEntityId) {
      return { _tag: 'seller_identity_immutable' };
    }
    return existingById.businessCode === proposed.businessCode
      ? { _tag: 'reused', market: existingById }
      : { _tag: 'market_code_conflict' };
  }
  return existingByCode === undefined ? { _tag: 'created' } : { _tag: 'market_code_conflict' };
};

const RevisionDecisionSchema = Schema.Union([
  Schema.TaggedStruct('revision_conflict', { actualRevision: RevisionSchema }),
  Schema.TaggedStruct('revised', {
    nextAggregateRevision: RevisionSchema,
    nextDefinitionRevision: RevisionSchema,
  }),
]);
export type RevisionDecision = typeof RevisionDecisionSchema.Type;

export const decideDefinitionRevision = (
  current: MarketAdministrationSnapshot,
  expectedRevision: number,
): RevisionDecision =>
  current.currentDefinitionRevision === expectedRevision
    ? {
        _tag: 'revised',
        nextAggregateRevision: current.aggregateRevision + 1,
        nextDefinitionRevision: current.currentDefinitionRevision + 1,
      }
    : { _tag: 'revision_conflict', actualRevision: current.currentDefinitionRevision };

const LifecycleDecisionSchema = Schema.Union([
  Schema.TaggedStruct('invalid_lifecycle_transition', {}),
  Schema.TaggedStruct('revision_conflict', { actualRevision: RevisionSchema }),
  Schema.TaggedStruct('transitioned', {
    changed: Schema.Boolean,
    nextAggregateRevision: RevisionSchema,
    target: MarketLifecycleStateSchema,
  }),
]);
export type LifecycleDecision = typeof LifecycleDecisionSchema.Type;

export const decideLifecycleTransition = (
  current: MarketAdministrationSnapshot,
  expectedAggregateRevision: number,
  target: MarketLifecycleState,
): LifecycleDecision => {
  if (current.aggregateRevision !== expectedAggregateRevision) {
    return { _tag: 'revision_conflict', actualRevision: current.aggregateRevision };
  }
  if (current.lifecycle === target) {
    return {
      _tag: 'transitioned',
      changed: false,
      nextAggregateRevision: current.aggregateRevision,
      target,
    };
  }
  if (current.lifecycle === 'RETIRED') {
    return { _tag: 'invalid_lifecycle_transition' };
  }
  return {
    _tag: 'transitioned',
    changed: true,
    nextAggregateRevision: current.aggregateRevision + 1,
    target,
  };
};

const AssociationDecisionSchema = Schema.Union([
  Schema.TaggedStruct('already_applied', { association: StorefrontAssociationSnapshotSchema }),
  Schema.TaggedStruct('inconsistent_seller_or_channel', {}),
  Schema.TaggedStruct('overlapping_association', { conflictingAssociationId: DomainIdentifierSchema }),
  Schema.TaggedStruct('revision_conflict', { actualRevision: RevisionSchema }),
  Schema.TaggedStruct('write', { nextRevision: RevisionSchema }),
]);
export type AssociationDecision = typeof AssociationDecisionSchema.Encoded;

const sameAssociationMeaning = (
  current: StorefrontAssociationSnapshot,
  proposed: Omit<StorefrontAssociationSnapshot, 'revision'>,
): boolean =>
  current.marketId === proposed.marketId &&
  current.sellingLegalEntityId === proposed.sellingLegalEntityId &&
  current.storefrontAppId === proposed.storefrontAppId &&
  current.channel === proposed.channel &&
  current.effectivePeriod.startsAt === proposed.effectivePeriod.startsAt &&
  current.effectivePeriod.endsAt === proposed.effectivePeriod.endsAt &&
  current.removedAt === proposed.removedAt;

export const decideAssociationWrite = (
  current: StorefrontAssociationSnapshot | undefined,
  activeAssociations: readonly StorefrontAssociationSnapshot[],
  proposed: Omit<StorefrontAssociationSnapshot, 'revision'>,
  expectedRevision?: number,
): AssociationDecision => {
  if (current !== undefined && current.sellingLegalEntityId !== proposed.sellingLegalEntityId) {
    return { _tag: 'inconsistent_seller_or_channel' };
  }
  if (current !== undefined && expectedRevision !== undefined && current.revision !== expectedRevision) {
    return { _tag: 'revision_conflict', actualRevision: current.revision };
  }
  if (current !== undefined && sameAssociationMeaning(current, proposed)) {
    return { _tag: 'already_applied', association: current };
  }
  const conflict = activeAssociations.find(
    (candidate) =>
      candidate.associationId !== proposed.associationId &&
      candidate.removedAt === undefined &&
      candidate.marketId === proposed.marketId &&
      candidate.storefrontAppId === proposed.storefrontAppId &&
      candidate.channel === proposed.channel &&
      halfOpenPeriodsOverlap(candidate.effectivePeriod, proposed.effectivePeriod),
  );
  return conflict === undefined
    ? { _tag: 'write', nextRevision: (current?.revision ?? 0) + 1 }
    : { _tag: 'overlapping_association', conflictingAssociationId: conflict.associationId };
};

export const decideAssociationRemoval = (
  current: StorefrontAssociationSnapshot,
  expectedRevision: number,
  effectiveAt: string,
): AssociationDecision => {
  if (current.revision !== expectedRevision) {
    return { _tag: 'revision_conflict', actualRevision: current.revision };
  }
  if (current.removedAt === effectiveAt) {
    return { _tag: 'already_applied', association: current };
  }
  if (current.removedAt !== undefined || effectiveAt < current.effectivePeriod.startsAt) {
    return { _tag: 'inconsistent_seller_or_channel' };
  }
  return { _tag: 'write', nextRevision: current.revision + 1 };
};
