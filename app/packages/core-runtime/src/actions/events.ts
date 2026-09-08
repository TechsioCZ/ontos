import { Schema } from 'effect';

import {
  decodedStringBrand,
  nonEmptyString,
  TargetModuleKeySchema,
  TargetResourceIdSchema,
} from './string-schemas.ts';

const nonNegativeInteger = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
);
const EvidencePolicyKeySchema = decodedStringBrand(
  nonEmptyString,
  'EvidencePolicyKey'
);
const ProducerModuleKeySchema = decodedStringBrand(
  nonEmptyString,
  'ProducerModuleKey'
);
const ServingModuleKeySchema = decodedStringBrand(
  nonEmptyString,
  'ServingModuleKey'
);
const SubjectModuleKeySchema = decodedStringBrand(
  nonEmptyString,
  'SubjectModuleKey'
);
const SubjectResourceIdSchema = decodedStringBrand(
  nonEmptyString,
  'SubjectResourceId'
);

export type DomainEventContractMap = Readonly<
  Record<string, Schema.ConstraintDecoder<unknown>>
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
  evidencePolicyKey: EvidencePolicyKeySchema,
  occurredAt: Schema.optionalKey(Schema.Date),
  queryHash: nonEmptyString,
  redactionProfile: Schema.optionalKey(nonEmptyString),
  resultCount: nonNegativeInteger,
  resultFingerprintHash: Schema.optionalKey(nonEmptyString),
  resultFingerprintSchema: Schema.optionalKey(nonEmptyString),
  servingModuleKey: ServingModuleKeySchema,
  targetModuleKey: Schema.optionalKey(TargetModuleKeySchema),
  targetResourceId: Schema.optionalKey(TargetResourceIdSchema),
  targetResourceType: Schema.optionalKey(nonEmptyString),
});

export type DataAccessEvent = Schema.Schema.Type<typeof DataAccessEventSchema>;

/** Handler-supplied read facts. Core applies the descriptor-owned evidence policy. */
export type DataAccessEventInput = Omit<
  DataAccessEvent,
  | 'evidenceCaptureMode'
  | 'evidencePolicyKey'
  | 'redactionProfile'
  | 'resultFingerprintSchema'
>;

export const DomainEventSchema = Schema.Struct({
  eventType: nonEmptyString,
  occurredAt: Schema.optionalKey(Schema.Date),
  payloadJson: Schema.Json,
  producerModuleKey: ProducerModuleKeySchema,
  subjectModuleKey: SubjectModuleKeySchema,
  subjectResourceId: SubjectResourceIdSchema,
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
  producerModuleKey: ProducerModuleKeySchema,
  topic: nonEmptyString,
});

export type OutboxMessage = Schema.Schema.Type<typeof OutboxMessageSchema>;

const domainEventReferenceBrand: unique symbol = Symbol(
  '@app/core-runtime/actions/events/DomainEventReference'
);

/** Opaque reference produced only by one execution's Domain Event collector. */
export interface DomainEventReference {
  readonly [domainEventReferenceBrand]: true;
}

/** Internal owner factory; references remain valid only in their creating collector. */
export const createDomainEventReference = (): DomainEventReference =>
  Object.freeze({ [domainEventReferenceBrand]: true as const });

export interface CollectedOutboxMessage {
  readonly domainEventIndex: number;
  readonly message: OutboxMessage;
}

export interface ActionEvidenceSnapshot {
  readonly auditEvidence: Readonly<
    Record<string, Schema.Schema.Type<typeof Schema.Json>>
  >;
  readonly dataAccessEvents: readonly DataAccessEvent[];
  readonly domainEvents: readonly DomainEvent[];
  readonly outboxMessages: readonly CollectedOutboxMessage[];
}
