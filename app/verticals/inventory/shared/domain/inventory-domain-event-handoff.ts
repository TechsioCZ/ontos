import { Match, Schema } from 'effect';

const INVENTORY_MODULE_KEY = 'commerce.inventory';
const boundedText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const checkedModuleKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
  Schema.isMaxLength(200),
);
const moduleKey = checkedModuleKey.pipe(
  Schema.brand('InventoryDomainEventModuleKey'),
  Schema.decodeTo(checkedModuleKey),
);
const inventoryEventType = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isPattern(/^commerce\.inventory\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.v[1-9][0-9]*$/u),
  Schema.isMaxLength(200),
);
const checkedInventoryOwnerOperationKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isPattern(/^commerce\.inventory\.api\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  Schema.isMaxLength(200),
);
const inventoryOwnerOperationKey = checkedInventoryOwnerOperationKey.pipe(
  Schema.brand('InventoryOwnerReadOrProofKey'),
  Schema.decodeTo(checkedInventoryOwnerOperationKey),
);
const positiveRevision = Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 }));
const positiveTenantSequence = Schema.BigIntFromString.check(Schema.isGreaterThanBigInt(0n));
const checkedUuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());
const correlationId = boundedText.pipe(Schema.brand('InventoryDomainEventCorrelationId'), Schema.decodeTo(boundedText));
const domainEventId = checkedUuid.pipe(Schema.brand('InventoryDomainEventId'), Schema.decodeTo(checkedUuid));
const occurrenceId = boundedText.pipe(Schema.brand('InventoryDomainEventOccurrenceId'), Schema.decodeTo(boundedText));
const resourceId = checkedUuid.pipe(
  Schema.brand('InventoryDomainEventSubjectResourceId'),
  Schema.decodeTo(checkedUuid),
);
const tenantId = checkedUuid.pipe(Schema.brand('InventoryDomainEventTenantId'), Schema.decodeTo(checkedUuid));

export const InventoryDomainEventFamilyKeySchema = Schema.Literals([
  'RESERVATION_GUARANTEE_CHANGED',
  'COMMITMENT_PROTECTION_CHANGED',
  'STOCK_POSITION_EVIDENCE_CHANGED',
  'COMMITTED_OBLIGATION_CHANGED',
]);
export type InventoryDomainEventFamilyKey = typeof InventoryDomainEventFamilyKeySchema.Type;

export const InventoryDomainEventOrderingKindSchema = Schema.Literals([
  'IMMUTABLE_OCCURRENCE_IDENTITY',
  'OWNER_AGGREGATE_REVISION',
]);

/** A public family is canonical only when every routing and owner-proof field is exact. */
export const InventoryDomainEventFamilySchema = Schema.Struct({
  businessMeaning: boundedText,
  consumer: Schema.Struct({
    behavior: Schema.Literal('INVALIDATE_AND_REREAD_OWNER'),
    moduleKey,
    useCase: boundedText,
  }),
  currentTruthBoundary: Schema.Literal('OWNER_READ_OR_PROOF_REQUIRED'),
  deliveryFailureBoundary: Schema.Literal('RETRY_SEPARATELY_FROM_PRODUCER_COMMIT'),
  duplicateBoundary: Schema.Literal('ONE_CONSUMER_EFFECT_PER_EVENT_SEQUENCE_PAIR'),
  eventType: inventoryEventType,
  family: InventoryDomainEventFamilyKeySchema,
  ordering: InventoryDomainEventOrderingKindSchema,
  outOfOrderBoundary: Schema.Literal('TENANT_SEQUENCE_IS_TRANSPORT_ORDER_NOT_OWNER_TRUTH'),
  ownerReadOrProofKey: inventoryOwnerOperationKey,
  producer: Schema.Struct({
    moduleKey: Schema.Literal(INVENTORY_MODULE_KEY),
    revision: positiveRevision,
  }),
  retainedEventBoundary: Schema.Literal('HISTORICAL_FACT_NOT_CURRENT_GUARANTEE'),
  subjectResourceTypes: Schema.Array(
    Schema.String.check(
      Schema.isTrimmed(),
      Schema.isPattern(/^commerce\.inventory\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
      Schema.isMaxLength(200),
    ),
  ).check(Schema.isMinLength(1)),
}).check(
  Schema.makeFilter(({ eventType, producer }) =>
    eventType.endsWith(`.v${producer.revision}`)
      ? undefined
      : 'Inventory event type revision must equal the declared producer schema revision',
  ),
);
export type InventoryDomainEventFamily = typeof InventoryDomainEventFamilySchema.Type;

const familyBoundaries = {
  currentTruthBoundary: 'OWNER_READ_OR_PROOF_REQUIRED',
  deliveryFailureBoundary: 'RETRY_SEPARATELY_FROM_PRODUCER_COMMIT',
  duplicateBoundary: 'ONE_CONSUMER_EFFECT_PER_EVENT_SEQUENCE_PAIR',
  outOfOrderBoundary: 'TENANT_SEQUENCE_IS_TRANSPORT_ORDER_NOT_OWNER_TRUTH',
  producer: { moduleKey: INVENTORY_MODULE_KEY, revision: 1 },
  retainedEventBoundary: 'HISTORICAL_FACT_NOT_CURRENT_GUARANTEE',
} as const;

export const inventoryDomainEventFamilyByKey = Object.freeze({
  COMMITMENT_PROTECTION_CHANGED: InventoryDomainEventFamilySchema.make({
    ...familyBoundaries,
    businessMeaning: 'Commitment Protection was established or became materially impaired after commit.',
    consumer: {
      behavior: 'INVALIDATE_AND_REREAD_OWNER',
      moduleKey: moduleKey.make('commerce.order'),
      useCase: 'Refresh exact Attempt-bound protection evidence without treating delivery as the commit gate.',
    },
    eventType: 'commerce.inventory.commitment-protection-changed.v1',
    family: 'COMMITMENT_PROTECTION_CHANGED',
    ordering: 'OWNER_AGGREGATE_REVISION',
    ownerReadOrProofKey: inventoryOwnerOperationKey.make('commerce.inventory.api.commitment-protection-verification'),
    subjectResourceTypes: ['commerce.inventory.commitment-protection'],
  }),
  COMMITTED_OBLIGATION_CHANGED: InventoryDomainEventFamilySchema.make({
    ...familyBoundaries,
    businessMeaning: 'The continuing committed Inventory obligation changed after an owner-governed transition.',
    consumer: {
      behavior: 'INVALIDATE_AND_REREAD_OWNER',
      moduleKey: moduleKey.make('commerce.fulfillment'),
      useCase: 'Refresh committed-obligation evidence for recovery or operations without repeating physical effects.',
    },
    eventType: 'commerce.inventory.committed-obligation-changed.v1',
    family: 'COMMITTED_OBLIGATION_CHANGED',
    ordering: 'IMMUTABLE_OCCURRENCE_IDENTITY',
    ownerReadOrProofKey: inventoryOwnerOperationKey.make('commerce.inventory.api.inventory-reconciliation-evidence'),
    subjectResourceTypes: [
      'commerce.inventory.inventory-reservation',
      'commerce.inventory.imported-committed-obligation',
    ],
  }),
  RESERVATION_GUARANTEE_CHANGED: InventoryDomainEventFamilySchema.make({
    ...familyBoundaries,
    businessMeaning: 'A material Reservation lifecycle or guarantee fact changed after commit.',
    consumer: {
      behavior: 'INVALIDATE_AND_REREAD_OWNER',
      moduleKey: moduleKey.make('commerce.order'),
      useCase: 'Refresh the exact Reservation guarantee before an Order or Fulfillment decision.',
    },
    eventType: 'commerce.inventory.reservation-guarantee-changed.v1',
    family: 'RESERVATION_GUARANTEE_CHANGED',
    ordering: 'IMMUTABLE_OCCURRENCE_IDENTITY',
    ownerReadOrProofKey: inventoryOwnerOperationKey.make('commerce.inventory.api.inventory-reservation-detail'),
    subjectResourceTypes: ['commerce.inventory.inventory-reservation'],
  }),
  STOCK_POSITION_EVIDENCE_CHANGED: InventoryDomainEventFamilySchema.make({
    ...familyBoundaries,
    businessMeaning: 'Material owner evidence for one exact Stock Position changed after commit.',
    consumer: {
      behavior: 'INVALIDATE_AND_REREAD_OWNER',
      moduleKey: moduleKey.make('commerce.availability'),
      useCase: 'Invalidate cached stock inputs and refresh them before recomputing an Availability promise.',
    },
    eventType: 'commerce.inventory.stock-position-evidence-changed.v1',
    family: 'STOCK_POSITION_EVIDENCE_CHANGED',
    ordering: 'OWNER_AGGREGATE_REVISION',
    ownerReadOrProofKey: inventoryOwnerOperationKey.make(
      'commerce.inventory.api.current-stock-evidence-for-availability',
    ),
    subjectResourceTypes: ['commerce.inventory.stock-position'],
  }),
} satisfies Readonly<Record<InventoryDomainEventFamilyKey, InventoryDomainEventFamily>>);

export const inventoryDomainEventFamilies = Object.freeze([
  inventoryDomainEventFamilyByKey.RESERVATION_GUARANTEE_CHANGED,
  inventoryDomainEventFamilyByKey.COMMITMENT_PROTECTION_CHANGED,
  inventoryDomainEventFamilyByKey.STOCK_POSITION_EVIDENCE_CHANGED,
  inventoryDomainEventFamilyByKey.COMMITTED_OBLIGATION_CHANGED,
]);

export const InventoryCommittedEventSubjectRefSchema = Schema.Struct({
  moduleId: Schema.Literal(INVENTORY_MODULE_KEY),
  resourceId,
  resourceType: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isPattern(/^commerce\.inventory\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    Schema.isMaxLength(200),
  ),
  tenantId,
});
export type InventoryCommittedEventSubjectRef = typeof InventoryCommittedEventSubjectRefSchema.Type;

export const InventoryImmutableOccurrenceOrderingSchema = Schema.TaggedStruct('IMMUTABLE_OCCURRENCE_IDENTITY', {
  occurrenceId,
});
export const InventoryOwnerAggregateRevisionOrderingSchema = Schema.TaggedStruct('OWNER_AGGREGATE_REVISION', {
  revision: positiveRevision,
});
export const InventoryCommittedEventOrderingSchema = Schema.Union([
  InventoryImmutableOccurrenceOrderingSchema,
  InventoryOwnerAggregateRevisionOrderingSchema,
]);
export type InventoryCommittedEventOrdering = typeof InventoryCommittedEventOrderingSchema.Type;

/** Payload metadata stays minimal; owner truth remains behind the canonical governed read/proof. */
export const InventoryCommittedEventNoticeSchema = Schema.Struct({
  correlationId,
  domainEventId,
  eventType: inventoryEventType,
  occurredAt: Schema.toEncoded(Schema.DateTimeUtcFromString),
  ordering: InventoryCommittedEventOrderingSchema,
  producerModuleKey: Schema.Literal(INVENTORY_MODULE_KEY),
  producerRevision: positiveRevision,
  subjectRef: InventoryCommittedEventSubjectRefSchema,
  tenantSequenceNo: positiveTenantSequence,
});
export type InventoryCommittedEventNotice = typeof InventoryCommittedEventNoticeSchema.Type;

export const InventoryProcessedDomainEventSchema = Schema.Struct({
  domainEventId,
  ordering: InventoryCommittedEventOrderingSchema,
  tenantSequenceNo: Schema.BigInt.check(Schema.isGreaterThanBigInt(0n)),
});
export type InventoryProcessedDomainEvent = typeof InventoryProcessedDomainEventSchema.Type;

export const InventoryDomainEventConsumerStateSchema = Schema.Struct({
  consumerModuleKey: moduleKey,
  family: InventoryDomainEventFamilyKeySchema,
  highestTenantSequenceNo: Schema.BigInt.check(Schema.isGreaterThanBigInt(0n)),
  latestOwnerRevision: Schema.optionalKey(positiveRevision),
  processedEvents: Schema.Array(InventoryProcessedDomainEventSchema).check(Schema.isMinLength(1)),
  subjectRef: InventoryCommittedEventSubjectRefSchema,
});
export type InventoryDomainEventConsumerState = typeof InventoryDomainEventConsumerStateSchema.Type;

export interface InventoryDomainEventDeliveryInput {
  readonly consumerModuleKey: string;
  readonly event: InventoryCommittedEventNotice;
  readonly family: InventoryDomainEventFamilyKey;
  readonly state: InventoryDomainEventConsumerState | null;
}

export const InventoryDomainEventDeliveryRejectionReasonSchema = Schema.Literals([
  'CONSUMER_MISMATCH',
  'DOMAIN_EVENT_SEQUENCE_CONFLICT',
  'EVENT_CONTENT_CONFLICT',
  'EVENT_FAMILY_MISMATCH',
  'OCCURRENCE_IDENTITY_CONFLICT',
  'ORDERING_EVIDENCE_MISMATCH',
  'PRODUCER_MISMATCH',
  'REVISION_IDENTITY_CONFLICT',
  'STATE_CONSUMER_MISMATCH',
  'STATE_FAMILY_MISMATCH',
  'SUBJECT_IDENTITY_MISMATCH',
  'TENANT_SEQUENCE_IDENTITY_CONFLICT',
]);
export type InventoryDomainEventDeliveryRejectionReason = typeof InventoryDomainEventDeliveryRejectionReasonSchema.Type;

export const InventoryDomainEventDeliveryRejectedSchema = Schema.TaggedStruct('DELIVERY_REJECTED', {
  reason: InventoryDomainEventDeliveryRejectionReasonSchema,
});
export type InventoryDomainEventDeliveryRejected = typeof InventoryDomainEventDeliveryRejectedSchema.Type;

export const InventoryDomainEventDeliveryAcceptedSchema = Schema.TaggedStruct('DELIVERY_ACCEPTED', {
  consumerBusinessEffectAllowedFromEventAlone: Schema.Literal(false),
  disposition: Schema.Literals(['DUPLICATE_IGNORED', 'INVALIDATE_AND_REREAD_OWNER', 'OUT_OF_ORDER_IGNORED']),
  newerOwnerStateRolledBack: Schema.Literal(false),
  nextState: InventoryDomainEventConsumerStateSchema,
  ownerReadOrProofKey: inventoryOwnerOperationKey,
  ownerReadRequired: Schema.Boolean,
  producerFactMutationRequired: Schema.Literal(false),
  retainedEventIsCurrentGuarantee: Schema.Literal(false),
});
export type InventoryDomainEventDeliveryAccepted = typeof InventoryDomainEventDeliveryAcceptedSchema.Type;

export const InventoryDomainEventDeliveryResultSchema = Schema.Union([
  InventoryDomainEventDeliveryAcceptedSchema,
  InventoryDomainEventDeliveryRejectedSchema,
]);
export type InventoryDomainEventDeliveryResult = typeof InventoryDomainEventDeliveryResultSchema.Type;

const sameSubject = (left: InventoryCommittedEventSubjectRef, right: InventoryCommittedEventSubjectRef): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const sameOrdering = (left: InventoryCommittedEventOrdering, right: InventoryCommittedEventOrdering): boolean => {
  if (Schema.is(InventoryImmutableOccurrenceOrderingSchema)(left)) {
    return Schema.is(InventoryImmutableOccurrenceOrderingSchema)(right) && left.occurrenceId === right.occurrenceId;
  }
  return Schema.is(InventoryOwnerAggregateRevisionOrderingSchema)(right) && left.revision === right.revision;
};

const ownerRevision = (ordering: InventoryCommittedEventOrdering): number | null =>
  Match.value(ordering).pipe(
    Match.tag('IMMUTABLE_OCCURRENCE_IDENTITY', () => null),
    Match.tag('OWNER_AGGREGATE_REVISION', ({ revision }) => revision),
    Match.exhaustive,
  );

const rejected = (reason: InventoryDomainEventDeliveryRejectionReason): InventoryDomainEventDeliveryRejected => ({
  _tag: 'DELIVERY_REJECTED',
  reason,
});

const accepted = (
  disposition: InventoryDomainEventDeliveryAccepted['disposition'],
  nextState: InventoryDomainEventConsumerState,
  ownerReadOrProofKey: InventoryDomainEventFamily['ownerReadOrProofKey'],
  ownerReadRequired: boolean,
): InventoryDomainEventDeliveryAccepted => ({
  _tag: 'DELIVERY_ACCEPTED',
  consumerBusinessEffectAllowedFromEventAlone: false,
  disposition,
  newerOwnerStateRolledBack: false,
  nextState,
  ownerReadOrProofKey,
  ownerReadRequired,
  producerFactMutationRequired: false,
  retainedEventIsCurrentGuarantee: false,
});

const processedEvent = (event: InventoryCommittedEventNotice): InventoryProcessedDomainEvent => ({
  domainEventId: event.domainEventId,
  ordering: event.ordering,
  tenantSequenceNo: event.tenantSequenceNo,
});

const nextState = (
  current: InventoryDomainEventConsumerState | null,
  consumerModuleKey: InventoryDomainEventFamily['consumer']['moduleKey'],
  event: InventoryCommittedEventNotice,
  family: InventoryDomainEventFamily,
  advanceOwnerRevision: boolean,
): InventoryDomainEventConsumerState => {
  const revision = ownerRevision(event.ordering);
  const latestOwnerRevision = advanceOwnerRevision && revision !== null ? revision : current?.latestOwnerRevision;
  const baseState = {
    consumerModuleKey,
    family: family.family,
    highestTenantSequenceNo:
      current === null || event.tenantSequenceNo > current.highestTenantSequenceNo
        ? event.tenantSequenceNo
        : current.highestTenantSequenceNo,
    processedEvents: [...(current?.processedEvents ?? []), processedEvent(event)],
    subjectRef: event.subjectRef,
  };
  return latestOwnerRevision === undefined ? baseState : { ...baseState, latestOwnerRevision };
};

const orderingMatchesFamily = (
  ordering: InventoryCommittedEventOrdering,
  family: InventoryDomainEventFamily,
): boolean =>
  Match.value(family.ordering).pipe(
    Match.when('IMMUTABLE_OCCURRENCE_IDENTITY', () => Schema.is(InventoryImmutableOccurrenceOrderingSchema)(ordering)),
    Match.when('OWNER_AGGREGATE_REVISION', () => Schema.is(InventoryOwnerAggregateRevisionOrderingSchema)(ordering)),
    Match.exhaustive,
  );

const canonicalDeliveryRejection = (
  input: InventoryDomainEventDeliveryInput,
  family: InventoryDomainEventFamily,
): InventoryDomainEventDeliveryRejected | undefined => {
  const { consumerModuleKey, event, state } = input;
  if (consumerModuleKey !== family.consumer.moduleKey) {
    return rejected('CONSUMER_MISMATCH');
  }
  if (event.eventType !== family.eventType) {
    return rejected('EVENT_FAMILY_MISMATCH');
  }
  if (event.producerModuleKey !== family.producer.moduleKey || event.producerRevision !== family.producer.revision) {
    return rejected('PRODUCER_MISMATCH');
  }
  if (!family.subjectResourceTypes.includes(event.subjectRef.resourceType)) {
    return rejected('SUBJECT_IDENTITY_MISMATCH');
  }
  if (!orderingMatchesFamily(event.ordering, family)) {
    return rejected('ORDERING_EVIDENCE_MISMATCH');
  }
  if (state !== null && state.consumerModuleKey !== consumerModuleKey) {
    return rejected('STATE_CONSUMER_MISMATCH');
  }
  if (state !== null && state.family !== family.family) {
    return rejected('STATE_FAMILY_MISMATCH');
  }
  return state !== null && !sameSubject(state.subjectRef, event.subjectRef)
    ? rejected('SUBJECT_IDENTITY_MISMATCH')
    : undefined;
};

const replayIdentityDecision = (
  event: InventoryCommittedEventNotice,
  family: InventoryDomainEventFamily,
  state: InventoryDomainEventConsumerState,
): InventoryDomainEventDeliveryResult | undefined => {
  const sameId = state.processedEvents.find(({ domainEventId: candidate }) => candidate === event.domainEventId);
  if (sameId !== undefined) {
    if (sameId.tenantSequenceNo !== event.tenantSequenceNo) {
      return rejected('DOMAIN_EVENT_SEQUENCE_CONFLICT');
    }
    return sameOrdering(sameId.ordering, event.ordering)
      ? accepted('DUPLICATE_IGNORED', state, family.ownerReadOrProofKey, false)
      : rejected('EVENT_CONTENT_CONFLICT');
  }
  const sameSequence = state.processedEvents.find(
    ({ tenantSequenceNo: candidate }) => candidate === event.tenantSequenceNo,
  );
  if (sameSequence !== undefined || event.tenantSequenceNo === state.highestTenantSequenceNo) {
    return rejected('TENANT_SEQUENCE_IDENTITY_CONFLICT');
  }
  const sameBusinessIdentity = state.processedEvents.find(({ ordering }) => sameOrdering(ordering, event.ordering));
  if (sameBusinessIdentity === undefined) {
    return undefined;
  }
  return rejected(
    Schema.is(InventoryImmutableOccurrenceOrderingSchema)(event.ordering)
      ? 'OCCURRENCE_IDENTITY_CONFLICT'
      : 'REVISION_IDENTITY_CONFLICT',
  );
};

const outOfOrderDecision = (
  event: InventoryCommittedEventNotice,
  family: InventoryDomainEventFamily,
  state: InventoryDomainEventConsumerState,
): InventoryDomainEventDeliveryResult | undefined => {
  if (event.tenantSequenceNo < state.highestTenantSequenceNo) {
    return accepted(
      'OUT_OF_ORDER_IGNORED',
      nextState(state, family.consumer.moduleKey, event, family, false),
      family.ownerReadOrProofKey,
      false,
    );
  }
  const revision = ownerRevision(event.ordering);
  if (revision === null || state.latestOwnerRevision === undefined) {
    return undefined;
  }
  if (revision === state.latestOwnerRevision) {
    return rejected('REVISION_IDENTITY_CONFLICT');
  }
  return revision < state.latestOwnerRevision
    ? accepted(
        'OUT_OF_ORDER_IGNORED',
        nextState(state, family.consumer.moduleKey, event, family, false),
        family.ownerReadOrProofKey,
        false,
      )
    : undefined;
};

/**
 * Uses only the canonical family registry and Core's stable event/sequence pair. Transport order
 * dedupes delivery but never substitutes for owner revision or immutable occurrence identity.
 */
export const evaluateInventoryDomainEventDelivery = (
  input: InventoryDomainEventDeliveryInput,
): InventoryDomainEventDeliveryResult => {
  const { event, state } = input;
  const family = inventoryDomainEventFamilyByKey[input.family];
  const canonicalRejection = canonicalDeliveryRejection(input, family);
  if (canonicalRejection !== undefined) {
    return canonicalRejection;
  }
  if (state !== null) {
    const replayDecision = replayIdentityDecision(event, family, state);
    if (replayDecision !== undefined) {
      return replayDecision;
    }
    const orderingDecision = outOfOrderDecision(event, family, state);
    if (orderingDecision !== undefined) {
      return orderingDecision;
    }
  }
  return accepted(
    'INVALIDATE_AND_REREAD_OWNER',
    nextState(state, family.consumer.moduleKey, event, family, true),
    family.ownerReadOrProofKey,
    true,
  );
};

const inventoryCurrentTruthRequirement = Object.freeze({
  currentTruthSource: 'SUPPORTED_OWNER_READ_OR_PROOF' as const,
  eventSilenceIsCurrentProof: false as const,
  retainedEventIsCurrentGuarantee: false as const,
});

/** Event presence, absence, retention, and delivery timing never establish Current Inventory. */
export const currentInventoryTruthRequirement = () => inventoryCurrentTruthRequirement;

/** A committed producer fact is never rolled back because asynchronous delivery needs a retry. */
export const inventoryDomainEventDeliveryFailureBoundary = Object.freeze({
  producerTransactionRolledBack: false as const,
  retry: 'SEPARATE_DELIVERY_RETRY' as const,
});
