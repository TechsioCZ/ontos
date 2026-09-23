/* oxlint-disable effect-native/no-string-timestamp-schema -- The owner routine returns encoded PostgreSQL timestamps; this adapter decodes them into the public DateTime contract immediately; expires: 2027-03-31. */
/* oxlint-disable effect-native/no-nullable-schema-field -- The scoped-routine boundary receives PostgreSQL's raw nullable wire value under Schema.toType and converts it explicitly; expires: 2027-03-31. */
import type { OperationalScope, ReadServiceFactory, ScopedRoutineInvocationError } from '@app/core-runtime';
import { defineScopedRoutine } from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';

import type { EligibleMarketTuplesRequest } from '../../shared/apis/eligible-market-tuples.ts';
import { EligibleMarketTupleSchema, MarketLifecycleSchema } from '../../shared/market-contracts.ts';
import type { MarketEligibilityFact, MarketEligibilitySnapshot } from '../domain/market-resolution.ts';
import type { MarketSubjectRestrictionSnapshot } from '../integrations/market-subject-restrictions.ts';

const nonEmpty = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed());
const uuid = Schema.String.check(Schema.isUUID());
const AssociationIdSchema = uuid.pipe(Schema.brand('MarketResolutionAssociationId'), Schema.decodeTo(uuid));
const DefinitionRevisionIdSchema = uuid.pipe(
  Schema.brand('MarketResolutionDefinitionRevisionId'),
  Schema.decodeTo(uuid),
);
const MarketIdSchema = uuid.pipe(Schema.brand('MarketResolutionMarketId'), Schema.decodeTo(uuid));
const SellingLegalEntityIdSchema = uuid.pipe(
  Schema.brand('MarketResolutionSellingLegalEntityId'),
  Schema.decodeTo(uuid),
);
const StoredFactSchema = Schema.Struct({
  associationChannel: Schema.Literals(['B2C', 'B2B']),
  associationId: AssociationIdSchema,
  associationRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  lifecycle: MarketLifecycleSchema,
  marketDefinitionRevisionId: DefinitionRevisionIdSchema,
  marketId: MarketIdSchema,
  sellingLegalEntityId: SellingLegalEntityIdSchema,
});
const SnapshotPayloadSchema = Schema.Struct({
  facts: Schema.Array(StoredFactSchema),
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nextApplicabilityBoundary: Schema.NullOr(nonEmpty),
  observedAt: nonEmpty,
  predicateRevision: nonEmpty,
});
const SnapshotRowSchema = Schema.Struct({ payload: SnapshotPayloadSchema });

const readMarketEligibilitySnapshotRoutine = defineScopedRoutine({
  name: 'read_market_eligibility_snapshot',
  ownerModuleKey: 'commerce.market-catalog',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: SnapshotRowSchema,
  routineKey: 'market-resolution.read-eligibility-snapshot',
  schema: 'commerce_market_catalog',
});

export class MarketResolutionPersistenceUnavailable extends Schema.TaggedError<MarketResolutionPersistenceUnavailable>()(
  'MarketResolutionPersistenceUnavailable',
  {
    code: Schema.Literal('market_resolution_persistence_unavailable'),
    reason: Schema.String,
  },
) {}

export interface MarketResolutionPersistenceResult extends MarketEligibilitySnapshot {
  readonly generation: number;
}

export interface MarketResolutionPersistence {
  readonly load: (
    input: EligibleMarketTuplesRequest,
    subjectRestrictions?: MarketSubjectRestrictionSnapshot,
  ) => Effect.Effect<MarketResolutionPersistenceResult, MarketResolutionPersistenceUnavailable>;
}

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const unavailable = (cause: unknown): MarketResolutionPersistenceUnavailable => {
  const failure = new MarketResolutionPersistenceUnavailable({
    code: 'market_resolution_persistence_unavailable',
    reason: 'Current Commerce Market eligibility could not be established',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const ownerReference = <
  const ResourceType extends
    | 'commerce.market-catalog.market'
    | 'commerce.market-catalog.market-definition-revision'
    | 'commerce.market-catalog.storefront-association',
>(
  tenantId: string,
  resourceId: string,
  resourceType: ResourceType,
) => ({
  moduleId: 'commerce.market-catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});

const decodeFact = (
  tenantId: string,
  fact: typeof StoredFactSchema.Type,
): Effect.Effect<MarketEligibilityFact, MarketResolutionPersistenceUnavailable> =>
  Schema.decodeEffect(EligibleMarketTupleSchema)({
    associationRef: ownerReference(tenantId, fact.associationId, 'commerce.market-catalog.storefront-association'),
    associationRevision: fact.associationRevision,
    channel: fact.associationChannel,
    marketDefinitionRevisionRef: ownerReference(
      tenantId,
      fact.marketDefinitionRevisionId,
      'commerce.market-catalog.market-definition-revision',
    ),
    marketRef: ownerReference(tenantId, fact.marketId, 'commerce.market-catalog.market'),
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: fact.sellingLegalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
  }).pipe(
    Effect.map((tuple) => ({ lifecycle: fact.lifecycle, tuple })),
    Effect.mapError(unavailable),
  );

const decodeInstant = (value: string) =>
  Schema.decodeEffect(Schema.DateTimeUtcFromString)(value).pipe(Effect.mapError(unavailable));

interface MarketEligibilityRoutineInput {
  allowedChannels?: readonly ('B2B' | 'B2C')[];
  allowedMarketIds?: readonly string[];
  allowedSellerIds?: readonly string[];
  channel: EligibleMarketTuplesRequest['channel'];
  effectiveAt: string;
  sellingLegalEntityId?: string;
  storefrontAppId: string;
  subjectDecision?: 'ALLOWED' | 'DENIED';
  subjectIdentityRef?: string;
  subjectKind?: 'COUNTERPARTY' | 'RETAIL_PROFILE';
  subjectOwnerRevision?: string;
  subjectProfileState?: 'ACTIVE' | 'ARCHIVED' | 'SUSPENDED';
}

const routineInput = (
  input: EligibleMarketTuplesRequest,
  subjectRestrictions: MarketSubjectRestrictionSnapshot | undefined,
) => {
  const value: MarketEligibilityRoutineInput = {
    channel: input.channel,
    effectiveAt: DateTime.formatIso(input.effectiveAt),
    storefrontAppId: input.storefrontRef.appId,
  };
  if (input.sellingLegalEntityRestriction !== undefined) {
    value.sellingLegalEntityId = input.sellingLegalEntityRestriction.resourceId;
  }
  if (subjectRestrictions !== undefined) {
    value.allowedChannels = subjectRestrictions.allowedChannels;
    value.allowedSellerIds = subjectRestrictions.allowedSellerIds;
    value.subjectIdentityRef = subjectRestrictions.subjectIdentityRef;
    value.subjectKind = subjectRestrictions.subjectKind;
    value.subjectOwnerRevision = subjectRestrictions.ownerRevision;
    value.subjectDecision = subjectRestrictions.decision;
    value.subjectProfileState = subjectRestrictions.profileState;
    if (subjectRestrictions.allowedMarketIds !== undefined) {
      value.allowedMarketIds = subjectRestrictions.allowedMarketIds;
    }
  }
  return value;
};

const decodeSnapshotRow = Effect.fn('MarketResolutionPersistence.decodeSnapshotRow')(function* decodeSnapshot(
  input: EligibleMarketTuplesRequest,
  subjectRestrictions: MarketSubjectRestrictionSnapshot | undefined,
  tenantId: string,
  row: typeof SnapshotRowSchema.Type,
): Effect.fn.Return<MarketResolutionPersistenceResult, MarketResolutionPersistenceUnavailable> {
  const facts = yield* Effect.forEach(row.payload.facts, (fact) => decodeFact(tenantId, fact), {
    concurrency: 1,
  });
  const observedAt = yield* decodeInstant(row.payload.observedAt);
  const nextApplicabilityBoundary =
    row.payload.nextApplicabilityBoundary === null
      ? undefined
      : yield* decodeInstant(row.payload.nextApplicabilityBoundary);
  const evidenceBase = {
    observedAt,
    ownerRevision: `market-eligibility:v1:${row.payload.predicateRevision}`,
    scope: {
      kind: 'EXACT_PREDICATE' as const,
      predicateRef: [
        'market-eligibility:v1',
        tenantId,
        input.storefrontRef.appId,
        input.channel,
        input.sellingLegalEntityRestriction?.resourceId ?? 'all-sellers',
        subjectRestrictions?.subjectKind ?? 'guest-or-unrestricted',
        subjectRestrictions?.ownerRevision ?? 'none',
        subjectRestrictions?.profileState ?? 'none',
      ].join(':'),
    },
  };
  const completenessEvidence =
    nextApplicabilityBoundary === undefined ? evidenceBase : { ...evidenceBase, nextApplicabilityBoundary };
  const subjectRestrictionStatus: 'ALLOWED' | 'DENIED' =
    subjectRestrictions === undefined ||
    (subjectRestrictions.decision === 'ALLOWED' && subjectRestrictions.profileState === 'ACTIVE')
      ? 'ALLOWED'
      : 'DENIED';
  const result = {
    completenessEvidence: {
      ...completenessEvidence,
      observedAt: subjectRestrictions?.observedAt ?? observedAt,
      ownerRevision:
        subjectRestrictions === undefined
          ? evidenceBase.ownerRevision
          : `${evidenceBase.ownerRevision}:subject:${subjectRestrictions.ownerRevision}:${subjectRestrictions.profileState}`,
    },
    effectiveAt: input.effectiveAt,
    evaluatedAt: observedAt,
    facts,
    generation: row.payload.generation,
    subjectRestrictionStatus,
  };
  return nextApplicabilityBoundary === undefined ? result : { ...result, nextApplicabilityBoundary };
});

const marketResolutionPersistenceForTransaction = (
  transaction: ScopedTransaction,
  scope: Pick<OperationalScope, 'tenantId'>,
): MarketResolutionPersistence => ({
  load: (input, subjectRestrictions) =>
    transaction.invoke(readMarketEligibilitySnapshotRoutine, [routineInput(input, subjectRestrictions)]).pipe(
      Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
      Effect.flatMap(([row]) =>
        row === undefined
          ? Effect.fail(unavailable('The owner eligibility routine returned no snapshot'))
          : decodeSnapshotRow(input, subjectRestrictions, scope.tenantId, row),
      ),
    ),
});

export const marketResolutionPersistenceForScope: ReadServiceFactory<MarketResolutionPersistence> = (
  transaction,
  scope,
) => Effect.succeed(marketResolutionPersistenceForTransaction(transaction, scope));
