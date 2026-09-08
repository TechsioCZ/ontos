import { Effect, Match, Schema, Predicate } from 'effect';

import { ActionCollectorError } from './errors.ts';
import {
  DataAccessEventSchema,
  DomainEventSchema,
  OutboxMessageSchema,
  createDomainEventReference,
} from './events.ts';
import type {
  ActionAccessEvidencePolicy,
  ActionEvidenceSnapshot,
  CollectedOutboxMessage,
  DataAccessEvent,
  DataAccessEventInput,
  DeclaredDomainEvent,
  DomainEvent,
  DomainEventContractMap,
  DomainEventReference,
  OutboxMessage,
} from './events.ts';

const withOptionalProperty = <
  Base extends object,
  Key extends PropertyKey,
  Value,
  Trailing extends object,
>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing
) =>
  condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing };

const invalidCollectorInput = (reason: string) =>
  new ActionCollectorError({
    code: 'action_collector_invalid',
    reason,
  });

const freezeJson = <Value>(value: Value): Value => {
  if (value !== null && Predicate.isObjectKeyword(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      freezeJson(child);
    }
  }
  return value;
};

const cloneAndFreeze = <Value>(value: Value): Value =>
  freezeJson(structuredClone(value));

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);
const JsonObjectJsonStringSchema = Schema.fromJsonString(JsonObjectSchema);
const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const RuntimeActionKeyEvidenceSchema = Schema.Struct({
  actionKey: Schema.Unknown,
});
const RuntimeResultHashEvidenceSchema = Schema.Struct({
  resultHash: Schema.Unknown,
});

const metadataOnlyPolicyFields = (
  policy: Extract<
    ActionAccessEvidencePolicy,
    { readonly captureMode: 'metadata_only' }
  >
) =>
  ({
    evidenceCaptureMode: policy.captureMode,
    evidencePolicyKey: policy.policyKey,
  }) as const;

const redactedPayloadPolicyFields = (
  policy: Extract<
    ActionAccessEvidencePolicy,
    { readonly captureMode: 'redacted_payload' }
  >
) =>
  ({
    evidenceCaptureMode: policy.captureMode,
    evidencePolicyKey: policy.policyKey,
    redactionProfile: policy.redactionProfile,
  }) as const;

const hasIncompleteRedactedEvidence = (event: DataAccessEvent): boolean =>
  event.evidenceCaptureMode === 'redacted_payload' &&
  (event.redactionProfile === undefined ||
    event.evidencePayloadJson === undefined);

const hasUnexpectedRedactionProfile = (event: DataAccessEvent): boolean =>
  event.evidenceCaptureMode !== 'redacted_payload' &&
  event.redactionProfile !== undefined;

const hasMetadataResultEvidence = (event: DataAccessEvent): boolean =>
  event.evidenceCaptureMode === 'metadata_only' &&
  (event.evidencePayloadJson !== undefined ||
    event.resultFingerprintHash !== undefined ||
    event.resultFingerprintSchema !== undefined);

const hasInvalidHashEvidence = (event: DataAccessEvent): boolean =>
  event.evidenceCaptureMode === 'hash_only' &&
  (event.evidencePayloadJson !== undefined ||
    (event.resultFingerprintHash === undefined) !==
      (event.resultFingerprintSchema === undefined));

const hasUnsupportedResultEvidence = (event: DataAccessEvent): boolean =>
  event.evidenceCaptureMode === 'stored_artifact' ||
  (event.evidenceCaptureMode === 'redacted_payload' &&
    (event.resultFingerprintHash !== undefined ||
      event.resultFingerprintSchema !== undefined));

const validateDataAccessInvariant = (
  event: DataAccessEvent
): Effect.Effect<DataAccessEvent, ActionCollectorError> => {
  if (hasIncompleteRedactedEvidence(event)) {
    return Effect.fail(
      invalidCollectorInput(
        'A redacted Data Access Event requires a redaction profile and evidence payload'
      )
    );
  }

  if (hasUnexpectedRedactionProfile(event)) {
    return Effect.fail(
      invalidCollectorInput(
        'A redaction profile is allowed only for redacted Data Access Events'
      )
    );
  }

  if (hasMetadataResultEvidence(event)) {
    return Effect.fail(
      invalidCollectorInput(
        'Metadata-only Data Access evidence cannot contain result evidence'
      )
    );
  }

  if (hasInvalidHashEvidence(event)) {
    return Effect.fail(
      invalidCollectorInput(
        'Hash-only Data Access evidence requires a paired result fingerprint and schema'
      )
    );
  }

  if (hasUnsupportedResultEvidence(event)) {
    return Effect.fail(
      invalidCollectorInput(
        'The Action runtime does not accept this result evidence shape'
      )
    );
  }

  const targetParts = [
    event.targetModuleKey,
    event.targetResourceType,
    event.targetResourceId,
  ].filter((part) => part !== undefined);

  if (targetParts.length !== 0 && targetParts.length !== 3) {
    return Effect.fail(
      invalidCollectorInput(
        'A Data Access Event target must be fully specified or absent'
      )
    );
  }

  return Effect.succeed(event);
};

export interface ActionCollector<DomainEvents extends DomainEventContractMap> {
  readonly addDomainEvent: (
    event: DeclaredDomainEvent<DomainEvents>
  ) => Effect.Effect<DomainEventReference, ActionCollectorError>;
  readonly addDomainEventInput: <Input>(
    event: Input
  ) => Effect.Effect<DomainEventReference, ActionCollectorError>;
  readonly addOutboxMessage: (
    domainEvent: DomainEventReference,
    message: OutboxMessage
  ) => Effect.Effect<void, ActionCollectorError>;
  readonly addOutboxMessageInput: <Reference, Message>(
    domainEvent: Reference,
    message: Message
  ) => Effect.Effect<void, ActionCollectorError>;
  readonly recordAuditEvidence: (
    evidence: Readonly<Record<string, Schema.Schema.Type<typeof Schema.Json>>>
  ) => Effect.Effect<void, ActionCollectorError>;
  readonly recordAuditEvidenceInput: <Input>(
    evidence: Input
  ) => Effect.Effect<void, ActionCollectorError>;
  readonly recordDataAccess: (
    event: DataAccessEventInput
  ) => Effect.Effect<void, ActionCollectorError>;
  readonly recordDataAccessInput: <Input>(
    event: Input
  ) => Effect.Effect<void, ActionCollectorError>;
  readonly snapshot: () => ActionEvidenceSnapshot;
}

export const createActionCollector = <
  DomainEvents extends DomainEventContractMap,
>(
  ...[
    domainEventContracts,
    owningModuleKey,
    accessEvidencePolicy,
    auditEvidenceSchema,
  ]: readonly [
    domainEventContracts: DomainEvents,
    owningModuleKey: string,
    accessEvidencePolicy: ActionAccessEvidencePolicy,
    auditEvidenceSchema?: Schema.ConstraintDecoder<unknown>,
  ]
): ActionCollector<DomainEvents> => {
  const dataAccessEvents: DataAccessEvent[] = [];
  let auditEvidence: Readonly<
    Record<string, Schema.Schema.Type<typeof Schema.Json>>
  > = {};
  let hasAuditEvidence = false;
  const domainEvents: DomainEvent[] = [];
  const outboxMessages: CollectedOutboxMessage[] = [];
  const references = new Map<DomainEventReference, number>();

  const recordAuditEvidenceInput = <Input>(
    evidence: Input
  ): Effect.Effect<void, ActionCollectorError> =>
    Schema.decodeUnknownEffect(UnknownRecordSchema)(evidence).pipe(
      Effect.catchTag('SchemaError', () =>
        Effect.fail(
          invalidCollectorInput('Action audit evidence must be a JSON object')
        )
      ),
      Effect.flatMap((evidenceRecord) => {
        if (hasAuditEvidence) {
          return Effect.fail(
            invalidCollectorInput(
              'Action audit evidence may be recorded only once'
            )
          );
        }
        if (
          Schema.is(RuntimeActionKeyEvidenceSchema)(evidenceRecord) ||
          Schema.is(RuntimeResultHashEvidenceSchema)(evidenceRecord)
        ) {
          return Effect.fail(
            invalidCollectorInput(
              'Action audit evidence cannot replace runtime-owned fields'
            )
          );
        }
        if (auditEvidenceSchema === undefined) {
          return Effect.fail(
            invalidCollectorInput(
              'This Action does not declare custom audit evidence'
            )
          );
        }
        const inputKeys = Object.keys(evidenceRecord).toSorted();
        return Schema.decodeUnknownEffect(auditEvidenceSchema)(evidence).pipe(
          Effect.catchTag('SchemaError', () =>
            Effect.fail(
              invalidCollectorInput(
                'The Action audit evidence does not match its declared schema'
              )
            )
          ),
          Effect.map((declared) => ({ declared, inputKeys }))
        );
      }),
      Effect.flatMap(({ declared, inputKeys }) =>
        Schema.decodeUnknownEffect(Schema.Json)(declared).pipe(
          Effect.map((decoded) => ({ decoded, inputKeys }))
        )
      ),
      Effect.catchTag('SchemaError', () =>
        Effect.fail(
          invalidCollectorInput('The Action audit evidence is not valid JSON')
        )
      ),
      Effect.flatMap(({ decoded, inputKeys }) => {
        if (!Schema.is(JsonObjectSchema)(decoded)) {
          return Effect.fail(
            invalidCollectorInput('Action audit evidence must be a JSON object')
          );
        }
        const decodedKeys = Object.keys(decoded).toSorted();
        if (
          inputKeys.length !== decodedKeys.length ||
          inputKeys.some((key, index) => key !== decodedKeys[index])
        ) {
          return Effect.fail(
            invalidCollectorInput(
              'Action audit evidence contains undeclared fields'
            )
          );
        }
        return Schema.encodeEffect(JsonObjectJsonStringSchema)(decoded).pipe(
          Effect.catchTag('SchemaError', () =>
            Effect.fail(
              invalidCollectorInput(
                'The Action audit evidence is not valid JSON'
              )
            )
          ),
          Effect.flatMap((encoded) => {
            if (Buffer.byteLength(encoded, 'utf-8') > 4096) {
              return Effect.fail(
                invalidCollectorInput(
                  'Action audit evidence exceeds its size limit'
                )
              );
            }
            return Effect.sync(() => {
              auditEvidence = cloneAndFreeze(decoded);
              hasAuditEvidence = true;
            });
          })
        );
      })
    );
  const recordAuditEvidence: ActionCollector<DomainEvents>['recordAuditEvidence'] =
    recordAuditEvidenceInput;

  const recordDataAccessInput = <Input>(
    event: Input
  ): Effect.Effect<void, ActionCollectorError> => {
    const eventRecord = Schema.is(UnknownRecordSchema)(event)
      ? event
      : undefined;
    const resultFingerprintHash = eventRecord?.['resultFingerprintHash'];
    const policyFields = Match.value(accessEvidencePolicy).pipe(
      Match.when({ captureMode: 'hash_only' }, (policy) =>
        withOptionalProperty(
          {
            evidenceCaptureMode: policy.captureMode,
            evidencePolicyKey: policy.policyKey,
          },
          resultFingerprintHash !== undefined,
          'resultFingerprintSchema',
          policy.resultFingerprintSchema,
          {}
        )
      ),
      Match.when({ captureMode: 'metadata_only' }, metadataOnlyPolicyFields),
      Match.when(
        { captureMode: 'redacted_payload' },
        redactedPayloadPolicyFields
      ),
      Match.exhaustive
    );
    const materializedEvent =
      eventRecord === undefined ? event : { ...eventRecord, ...policyFields };

    return Schema.decodeUnknownEffect(DataAccessEventSchema)(
      materializedEvent
    ).pipe(
      Effect.catchTag('SchemaError', () =>
        Effect.fail(
          invalidCollectorInput('The Data Access Event is structurally invalid')
        )
      ),
      Effect.flatMap(validateDataAccessInvariant),
      Effect.tap((decoded) =>
        Effect.sync(() => {
          dataAccessEvents.push(cloneAndFreeze(decoded));
        })
      ),
      Effect.asVoid
    );
  };
  const recordDataAccess: ActionCollector<DomainEvents>['recordDataAccess'] =
    recordDataAccessInput;

  const addDomainEventInput = <Input>(
    event: Input
  ): Effect.Effect<DomainEventReference, ActionCollectorError> =>
    Schema.decodeUnknownEffect(DomainEventSchema)(event).pipe(
      Effect.catchTag('SchemaError', () =>
        Effect.fail(
          invalidCollectorInput('The Domain Event is structurally invalid')
        )
      ),
      Effect.flatMap((decoded) => {
        if (decoded.producerModuleKey !== owningModuleKey) {
          return Effect.fail(
            invalidCollectorInput(
              'A Domain Event producer must match the owning Action module'
            )
          );
        }
        if (!Object.hasOwn(domainEventContracts, decoded.eventType)) {
          return Effect.fail(
            invalidCollectorInput(
              'The Domain Event is not declared by this Action'
            )
          );
        }
        const payloadSchema = domainEventContracts[decoded.eventType];
        if (payloadSchema === undefined) {
          return Effect.fail(
            invalidCollectorInput(
              'The Domain Event declaration has no payload schema'
            )
          );
        }
        return Schema.decodeEffect(payloadSchema)(decoded.payloadJson).pipe(
          Effect.catchTag('SchemaError', () =>
            Effect.fail(
              invalidCollectorInput(
                'The Domain Event payload violates its declared contract'
              )
            )
          ),
          Effect.flatMap((payload) =>
            Schema.decodeUnknownEffect(Schema.Json)(payload).pipe(
              Effect.catchTag('SchemaError', () =>
                Effect.fail(
                  invalidCollectorInput(
                    'The decoded Domain Event payload is not JSON'
                  )
                )
              )
            )
          ),
          Effect.map((payloadJson) => ({ ...decoded, payloadJson }))
        );
      }),
      Effect.map((decoded) => {
        const reference = createDomainEventReference();
        const index = domainEvents.length;
        domainEvents.push(cloneAndFreeze(decoded));
        references.set(reference, index);
        return reference;
      })
    );
  const addDomainEvent: ActionCollector<DomainEvents>['addDomainEvent'] =
    addDomainEventInput;

  const findReferenceIndex = <Reference>(
    candidate: Reference
  ): number | undefined => {
    for (const [reference, index] of references) {
      if (Object.is(reference, candidate)) {
        return index;
      }
    }
    return undefined;
  };
  const addOutboxMessageInput = <Reference, Message>(
    domainEvent: Reference,
    message: Message
  ): Effect.Effect<void, ActionCollectorError> => {
    const domainEventIndex = findReferenceIndex(domainEvent);

    if (domainEventIndex === undefined) {
      return Effect.fail(
        invalidCollectorInput(
          'An Outbox Message must reference a Domain Event from the same Action execution'
        )
      );
    }

    return Schema.decodeUnknownEffect(OutboxMessageSchema)(message).pipe(
      Effect.catchTag('SchemaError', () =>
        Effect.fail(
          invalidCollectorInput('The Outbox Message is structurally invalid')
        )
      ),
      Effect.flatMap((decoded) => {
        const registeredDomainEvent = domainEvents[domainEventIndex];
        if (
          registeredDomainEvent === undefined ||
          decoded.producerModuleKey !== owningModuleKey ||
          decoded.producerModuleKey !== registeredDomainEvent.producerModuleKey
        ) {
          return Effect.fail(
            invalidCollectorInput(
              'An Outbox Message producer must match its registered Domain Event producer'
            )
          );
        }
        return Effect.succeed(decoded);
      }),
      Effect.tap((decoded) =>
        Effect.sync(() => {
          outboxMessages.push(
            Object.freeze({
              domainEventIndex,
              message: cloneAndFreeze(decoded),
            })
          );
        })
      ),
      Effect.asVoid
    );
  };
  const addOutboxMessage: ActionCollector<DomainEvents>['addOutboxMessage'] =
    addOutboxMessageInput;

  const snapshot = (): ActionEvidenceSnapshot =>
    Object.freeze({
      auditEvidence,
      dataAccessEvents: Object.freeze([...dataAccessEvents]),
      domainEvents: Object.freeze([...domainEvents]),
      outboxMessages: Object.freeze([...outboxMessages]),
    });

  return Object.freeze({
    addDomainEvent,
    addDomainEventInput,
    addOutboxMessage,
    addOutboxMessageInput,
    recordAuditEvidence,
    recordAuditEvidenceInput,
    recordDataAccess,
    recordDataAccessInput,
    snapshot,
  });
};
