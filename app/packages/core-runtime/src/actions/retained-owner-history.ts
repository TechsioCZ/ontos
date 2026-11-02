import { Schema } from 'effect';

import { ActionInvocationIdSchema, TenantIdSchema } from '../auth/external-identity-contracts.ts';
import { LegalEntityRefSchema } from '../resources/legal-entity.ts';

/** Native owner-definer capability, never a runtime-callable history browser. */
export const RETAINED_OWNER_HISTORY_CAPABILITY = Object.freeze({
  maximumEvents: 256,
  maximumSelectors: 8,
  name: 'read_committed_owner_change_history_v1',
  schema: 'core',
  schemaVersion: '1',
  signature: 'uuid,uuid,text,jsonb,jsonb,integer',
});

const boundedKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const moduleKey = Schema.toEncoded(
  boundedKey.check(Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u)).pipe(Schema.brand('ModuleKey')),
);
const resourceId = Schema.toEncoded(boundedKey.pipe(Schema.brand('ResourceId')));
const actionKey = Schema.toEncoded(boundedKey.pipe(Schema.brand('ActionKey')));
const domainEventId = Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('DomainEventId')));
const payloadKey = Schema.toEncoded(
  Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9]{0,99}$/u)).pipe(Schema.brand('PayloadResourceRefKey')),
);
const instant = Schema.DateTimeUtcFromString;

export const RetainedOwnerHistoryResourceRefSchema = Schema.Struct({
  moduleId: moduleKey,
  resourceId,
  resourceType: boundedKey,
  tenantId: Schema.toEncoded(TenantIdSchema),
});
export const RetainedOwnerHistorySelectorSchema = Schema.Struct({
  actionKey,
  binding: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('subject') }),
    Schema.Struct({
      aggregateRefKey: payloadKey,
      kind: Schema.Literal('payload_refs'),
      subjectRefKey: payloadKey,
      subjectResourceType: boundedKey,
    }),
  ]),
  eventType: boundedKey,
});
const selectors = Schema.Array(RetainedOwnerHistorySelectorSchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(RETAINED_OWNER_HISTORY_CAPABILITY.maximumSelectors),
  Schema.makeFilter((values) => new Set(values.map((value) => value.eventType)).size === values.length),
);
export const RetainedOwnerHistoryRequestSchema = Schema.Struct({
  legalEntityId: LegalEntityRefSchema.fields.resourceId,
  limit: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(RETAINED_OWNER_HISTORY_CAPABILITY.maximumEvents),
  ),
  ownerModuleKey: moduleKey,
  selectors,
  subjectRef: RetainedOwnerHistoryResourceRefSchema,
  tenantId: Schema.toEncoded(TenantIdSchema),
}).check(
  Schema.makeFilter(
    (value) => value.subjectRef.tenantId === value.tenantId && value.subjectRef.moduleId === value.ownerModuleKey,
  ),
);

export const RetainedOwnerHistoryEventSchema = Schema.Struct({
  actionInvocationId: Schema.toEncoded(ActionInvocationIdSchema),
  actionKey,
  completedAt: instant,
  domainEventId,
  eventType: boundedKey,
  occurredAt: instant,
  payloadJson: Schema.Json,
  producerModuleKey: moduleKey,
  subjectModuleKey: moduleKey,
  subjectResourceId: resourceId,
  subjectResourceType: boundedKey,
  tenantSequenceNo: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u)),
});

type HistoryResourceRef = typeof RetainedOwnerHistoryResourceRefSchema.Type;
type HistoryEvent = typeof RetainedOwnerHistoryEventSchema.Type;
type HistoryBinding = typeof RetainedOwnerHistorySelectorSchema.Type.binding;
const sameResourceRef = (left: HistoryResourceRef, right: HistoryResourceRef) =>
  left.tenantId === right.tenantId &&
  left.moduleId === right.moduleId &&
  left.resourceType === right.resourceType &&
  left.resourceId === right.resourceId;
const matchesEventBinding = (event: HistoryEvent, aggregate: HistoryResourceRef, binding: HistoryBinding): boolean => {
  if (binding.kind === 'subject') {
    return event.subjectResourceType === aggregate.resourceType && event.subjectResourceId === aggregate.resourceId;
  }
  const payload = event.payloadJson;
  // Core interprets only the declared ResourceRefs; the original owner payload remains opaque.
  if (!Schema.is(Schema.Record(Schema.String, Schema.Unknown))(payload)) {
    return false;
  }
  const retainedAggregate = payload[binding.aggregateRefKey];
  const retainedSubject = payload[binding.subjectRefKey];
  if (
    !Schema.is(RetainedOwnerHistoryResourceRefSchema)(retainedAggregate) ||
    !Schema.is(RetainedOwnerHistoryResourceRefSchema)(retainedSubject) ||
    Object.keys(retainedAggregate).length !== 4 ||
    Object.keys(retainedSubject).length !== 4
  ) {
    return false;
  }
  return (
    sameResourceRef(retainedAggregate, aggregate) &&
    event.subjectResourceType === binding.subjectResourceType &&
    sameResourceRef(retainedSubject, {
      moduleId: event.subjectModuleKey,
      resourceId: event.subjectResourceId,
      resourceType: binding.subjectResourceType,
      tenantId: aggregate.tenantId,
    })
  );
};

/** READ_COMPLETE describes the selected bounded read, not owner revision-chain completeness. */
export const RetainedOwnerHistoryEnvelopeSchema = Schema.Struct({
  events: Schema.Array(RetainedOwnerHistoryEventSchema).check(
    Schema.isMaxLength(RETAINED_OWNER_HISTORY_CAPABILITY.maximumEvents),
  ),
  legalEntityId: LegalEntityRefSchema.fields.resourceId,
  outcome: Schema.Literals(['READ_COMPLETE', 'TRUNCATED', 'UNUSABLE_BINDING']),
  schemaVersion: Schema.Literal('1'),
  selectors,
  subjectRef: RetainedOwnerHistoryResourceRefSchema,
}).check(
  Schema.makeFilter((value) => {
    if (value.outcome !== 'READ_COMPLETE') {
      return value.events.length === 0;
    }
    const { selectors: selected, subjectRef } = value;
    const ids = new Set<string>();
    let previous = 0n;
    for (const event of value.events) {
      const sequence = BigInt(event.tenantSequenceNo);
      if (
        ids.has(event.domainEventId) ||
        sequence <= previous ||
        event.producerModuleKey !== subjectRef.moduleId ||
        event.subjectModuleKey !== subjectRef.moduleId
      ) {
        return false;
      }
      const selector = selected.find(
        (candidate) => candidate.eventType === event.eventType && candidate.actionKey === event.actionKey,
      );
      if (selector === undefined || !matchesEventBinding(event, subjectRef, selector.binding)) {
        return false;
      }
      ids.add(event.domainEventId);
      previous = sequence;
    }
    return true;
  }),
);

export type RetainedOwnerHistoryEnvelope = typeof RetainedOwnerHistoryEnvelopeSchema.Type;
export type RetainedOwnerHistoryRequest = typeof RetainedOwnerHistoryRequestSchema.Type;
export type RetainedOwnerHistorySelector = typeof RetainedOwnerHistorySelectorSchema.Type;
