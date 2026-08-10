import { Schema } from 'effect';

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));
const nonNegativeInteger = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

export type DomainEventContractMap = Readonly<
  Record<string, Schema.ConstraintDecoder<unknown, never>>
>;

export type ActionAccessEvidencePolicy =
  | {
      readonly captureMode: 'hash_only';
      readonly policyKey: string;
      readonly resultFingerprintSchema: string;
    }
  | {
      readonly captureMode: 'metadata_only';
      readonly policyKey: string;
    }
  | {
      readonly captureMode: 'redacted_payload';
      readonly policyKey: string;
      readonly redactionProfile: string;
    };

export const DataAccessEventSchema = Schema.Struct({
  accessKind: Schema.Literals(['read', 'list', 'search', 'export', 'download']),
  evidenceCaptureMode: Schema.Literals([
    'metadata_only',
    'hash_only',
    'redacted_payload',
    'stored_artifact',
  ]),
  evidencePayloadJson: Schema.optionalKey(Schema.Json),
  evidencePolicyKey: nonEmptyString,
  occurredAt: Schema.optionalKey(Schema.Date),
  queryHash: nonEmptyString,
  redactionProfile: Schema.optionalKey(nonEmptyString),
  resultCount: nonNegativeInteger,
  resultFingerprintHash: Schema.optionalKey(nonEmptyString),
  resultFingerprintSchema: Schema.optionalKey(nonEmptyString),
  servingModuleKey: nonEmptyString,
  targetModuleKey: Schema.optionalKey(nonEmptyString),
  targetResourceId: Schema.optionalKey(nonEmptyString),
  targetResourceType: Schema.optionalKey(nonEmptyString),
});

export type DataAccessEvent = Schema.Schema.Type<typeof DataAccessEventSchema>;

/** Handler-supplied read facts. Core applies the descriptor-owned evidence policy. */
export type DataAccessEventInput = Omit<
  DataAccessEvent,
  'evidenceCaptureMode' | 'evidencePolicyKey' | 'redactionProfile' | 'resultFingerprintSchema'
>;

export const DomainEventSchema = Schema.Struct({
  eventType: nonEmptyString,
  occurredAt: Schema.optionalKey(Schema.Date),
  payloadJson: Schema.Json,
  producerModuleKey: nonEmptyString,
  subjectModuleKey: nonEmptyString,
  subjectResourceId: nonEmptyString,
  subjectResourceType: nonEmptyString,
});

export type DomainEvent = Schema.Schema.Type<typeof DomainEventSchema>;

export type DeclaredDomainEvent<Contracts extends DomainEventContractMap> = {
  readonly [EventType in keyof Contracts & string]: Omit<
    DomainEvent,
    'eventType' | 'payloadJson'
  > & {
    readonly eventType: EventType;
    readonly payloadJson: Contracts[EventType]['Type'];
  };
}[keyof Contracts & string];

export const OutboxMessageSchema = Schema.Struct({
  payloadJson: Schema.Json,
  producerModuleKey: nonEmptyString,
  topic: nonEmptyString,
});

export type OutboxMessage = Schema.Schema.Type<typeof OutboxMessageSchema>;

declare const domainEventReferenceBrand: unique symbol;

/** Opaque reference produced only by one execution's Domain Event collector. */
export interface DomainEventReference {
  readonly [domainEventReferenceBrand]: true;
}

export interface CollectedOutboxMessage {
  readonly domainEventIndex: number;
  readonly message: OutboxMessage;
}

export interface ActionEvidenceSnapshot {
  readonly auditEvidence: Readonly<Record<string, Schema.Schema.Type<typeof Schema.Json>>>;
  readonly dataAccessEvents: readonly DataAccessEvent[];
  readonly domainEvents: readonly DomainEvent[];
  readonly outboxMessages: readonly CollectedOutboxMessage[];
}
