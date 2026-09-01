import { Effect, Schema, Predicate } from 'effect';
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
import { ActionCollectorError } from './errors.ts';

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
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

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

const cloneAndFreeze = <Value>(value: Value): Value => freezeJson(structuredClone(value));

type JsonValue = Schema.Schema.Type<typeof Schema.Json>;
type JsonObject = Readonly<Record<string, JsonValue>>;
const isJsonObject = (value: JsonValue): value is JsonObject =>
  value !== null && Predicate.isObjectKeyword(value) && !Array.isArray(value);
const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);

const validateDataAccessInvariant = (
  event: DataAccessEvent,
): Effect.Effect<DataAccessEvent, ActionCollectorError> => {
  if (
    event.evidenceCaptureMode === 'redacted_payload' &&
    (event.redactionProfile === undefined || event.evidencePayloadJson === undefined)
  ) {
    return Effect.fail(
      invalidCollectorInput(
        'A redacted Data Access Event requires a redaction profile and evidence payload',
      ),
    );
  }

  if (event.evidenceCaptureMode !== 'redacted_payload' && event.redactionProfile !== undefined) {
    return Effect.fail(
      invalidCollectorInput('A redaction profile is allowed only for redacted Data Access Events'),
    );
  }

  if (
    event.evidenceCaptureMode === 'metadata_only' &&
    (event.evidencePayloadJson !== undefined ||
      event.resultFingerprintHash !== undefined ||
      event.resultFingerprintSchema !== undefined)
  ) {
    return Effect.fail(
      invalidCollectorInput('Metadata-only Data Access evidence cannot contain result evidence'),
    );
  }

  if (
    event.evidenceCaptureMode === 'hash_only' &&
    (event.evidencePayloadJson !== undefined ||
      (event.resultFingerprintHash === undefined) !== (event.resultFingerprintSchema === undefined))
  ) {
    return Effect.fail(
      invalidCollectorInput(
        'Hash-only Data Access evidence requires a paired result fingerprint and schema',
      ),
    );
  }

  if (
    event.evidenceCaptureMode === 'stored_artifact' ||
    (event.evidenceCaptureMode === 'redacted_payload' &&
      (event.resultFingerprintHash !== undefined || event.resultFingerprintSchema !== undefined))
  ) {
    return Effect.fail(
      invalidCollectorInput('The Action runtime does not accept this result evidence shape'),
    );
  }

  const targetParts = [
    event.targetModuleKey,
    event.targetResourceType,
    event.targetResourceId,
  ].filter((part) => part !== undefined);

  if (targetParts.length !== 0 && targetParts.length !== 3) {
    return Effect.fail(
      invalidCollectorInput('A Data Access Event target must be fully specified or absent'),
    );
  }

  return Effect.succeed(event);
};

export interface ActionCollector<DomainEvents extends DomainEventContractMap> {
  readonly addDomainEvent: (
    event: DeclaredDomainEvent<DomainEvents>,
  ) => Effect.Effect<DomainEventReference, ActionCollectorError>;
  readonly addDomainEventInput: <Input>(
    event: Input,
  ) => Effect.Effect<DomainEventReference, ActionCollectorError>;
  readonly addOutboxMessage: (
    domainEvent: DomainEventReference,
    message: OutboxMessage,
  ) => Effect.Effect<void, ActionCollectorError>;
  readonly addOutboxMessageInput: <Reference, Message>(
    domainEvent: Reference,
    message: Message,
  ) => Effect.Effect<void, ActionCollectorError>;
  readonly recordDataAccess: (
    event: DataAccessEventInput,
  ) => Effect.Effect<void, ActionCollectorError>;
  readonly recordDataAccessInput: <Input>(
    event: Input,
  ) => Effect.Effect<void, ActionCollectorError>;
  readonly recordAuditEvidence: (
    evidence: Readonly<Record<string, Schema.Schema.Type<typeof Schema.Json>>>,
  ) => Effect.Effect<void, ActionCollectorError>;
  readonly recordAuditEvidenceInput: <Input>(
    evidence: Input,
  ) => Effect.Effect<void, ActionCollectorError>;
  readonly snapshot: () => ActionEvidenceSnapshot;
}

export const createActionCollector = <DomainEvents extends DomainEventContractMap>(
  domainEventContracts: DomainEvents,
  owningModuleKey: string,
  accessEvidencePolicy: ActionAccessEvidencePolicy,
  auditEvidenceSchema?: Schema.ConstraintDecoder<unknown, never>,
): ActionCollector<DomainEvents> => {
  const dataAccessEvents: DataAccessEvent[] = [];
  let auditEvidence: Readonly<Record<string, Schema.Schema.Type<typeof Schema.Json>>> = {};
  let hasAuditEvidence = false;
  const domainEvents: DomainEvent[] = [];
  const outboxMessages: CollectedOutboxMessage[] = [];
  const references = new Map<DomainEventReference, number>();

  const recordAuditEvidenceInput = <Input>(
    evidence: Input,
  ): Effect.Effect<void, ActionCollectorError> => {
    if (evidence === null || !Predicate.isObjectKeyword(evidence) || Array.isArray(evidence)) {
      return Effect.fail(invalidCollectorInput('Action audit evidence must be a JSON object'));
    }
    if (hasAuditEvidence) {
      return Effect.fail(invalidCollectorInput('Action audit evidence may be recorded only once'));
    }
    if (Object.hasOwn(evidence, 'actionKey') || Object.hasOwn(evidence, 'resultHash')) {
      return Effect.fail(
        invalidCollectorInput('Action audit evidence cannot replace runtime-owned fields'),
      );
    }
    if (auditEvidenceSchema === undefined) {
      return Effect.fail(
        invalidCollectorInput('This Action does not declare custom audit evidence'),
      );
    }
    return Schema.decodeUnknownEffect(auditEvidenceSchema)(evidence).pipe(
      Effect.mapError(() =>
        invalidCollectorInput('The Action audit evidence does not match its declared schema'),
      ),
      Effect.flatMap((declared) => Schema.decodeUnknownEffect(Schema.Json)(declared)),
      Effect.mapError(() => invalidCollectorInput('The Action audit evidence is not valid JSON')),
      Effect.flatMap((decoded) => {
        if (!isJsonObject(decoded)) {
          return Effect.fail(invalidCollectorInput('Action audit evidence must be a JSON object'));
        }
        const inputKeys = Object.keys(evidence).toSorted();
        const decodedKeys = Object.keys(decoded).toSorted();
        if (
          inputKeys.length !== decodedKeys.length ||
          inputKeys.some((key, index) => key !== decodedKeys[index])
        ) {
          return Effect.fail(
            invalidCollectorInput('Action audit evidence contains undeclared fields'),
          );
        }
        if (Buffer.byteLength(JSON.stringify(decoded), 'utf-8') > 4096) {
          return Effect.fail(invalidCollectorInput('Action audit evidence exceeds its size limit'));
        }
        return Effect.sync(() => {
          auditEvidence = cloneAndFreeze(decoded);
          hasAuditEvidence = true;
        });
      }),
    );
  };
  const recordAuditEvidence: ActionCollector<DomainEvents>['recordAuditEvidence'] =
    recordAuditEvidenceInput;

  const recordDataAccessInput = <Input>(
    event: Input,
  ): Effect.Effect<void, ActionCollectorError> => {
    const eventRecord = Schema.is(UnknownRecordSchema)(event) ? event : undefined;
    const resultFingerprintHash = eventRecord?.['resultFingerprintHash'];
    const policyFields = (() => {
      switch (accessEvidencePolicy.captureMode) {
        case 'hash_only': {
          return withOptionalProperty(
            {
              evidenceCaptureMode: accessEvidencePolicy.captureMode,
              evidencePolicyKey: accessEvidencePolicy.policyKey,
            },
            resultFingerprintHash !== undefined,
            'resultFingerprintSchema',
            accessEvidencePolicy.resultFingerprintSchema,
            {},
          );
        }
        case 'metadata_only': {
          return {
            evidenceCaptureMode: accessEvidencePolicy.captureMode,
            evidencePolicyKey: accessEvidencePolicy.policyKey,
          } as const;
        }
        case 'redacted_payload': {
          return {
            evidenceCaptureMode: accessEvidencePolicy.captureMode,
            evidencePolicyKey: accessEvidencePolicy.policyKey,
            redactionProfile: accessEvidencePolicy.redactionProfile,
          } as const;
        }
        default: {
          const unhandledPolicy: never = accessEvidencePolicy;
          return unhandledPolicy;
        }
      }
    })();
    const materializedEvent =
      eventRecord === undefined ? event : { ...eventRecord, ...policyFields };

    return Schema.decodeUnknownEffect(DataAccessEventSchema)(materializedEvent).pipe(
      Effect.mapError(() => invalidCollectorInput('The Data Access Event is structurally invalid')),
      Effect.flatMap(validateDataAccessInvariant),
      Effect.tap((decoded) =>
        Effect.sync(() => {
          dataAccessEvents.push(cloneAndFreeze(decoded));
        }),
      ),
      Effect.asVoid,
    );
  };
  const recordDataAccess: ActionCollector<DomainEvents>['recordDataAccess'] = recordDataAccessInput;

  const addDomainEventInput = <Input>(
    event: Input,
  ): Effect.Effect<DomainEventReference, ActionCollectorError> =>
    Schema.decodeUnknownEffect(DomainEventSchema)(event).pipe(
      Effect.mapError(() => invalidCollectorInput('The Domain Event is structurally invalid')),
      Effect.flatMap((decoded) => {
        if (decoded.producerModuleKey !== owningModuleKey) {
          return Effect.fail(
            invalidCollectorInput('A Domain Event producer must match the owning Action module'),
          );
        }
        if (!Object.hasOwn(domainEventContracts, decoded.eventType)) {
          return Effect.fail(
            invalidCollectorInput('The Domain Event is not declared by this Action'),
          );
        }
        const payloadSchema = domainEventContracts[decoded.eventType];
        if (payloadSchema === undefined) {
          return Effect.fail(
            invalidCollectorInput('The Domain Event declaration has no payload schema'),
          );
        }
        return Schema.decodeUnknownEffect(payloadSchema)(decoded.payloadJson).pipe(
          Effect.mapError(() =>
            invalidCollectorInput('The Domain Event payload violates its declared contract'),
          ),
          Effect.flatMap((payload) =>
            Schema.decodeUnknownEffect(Schema.Json)(payload).pipe(
              Effect.mapError(() =>
                invalidCollectorInput('The decoded Domain Event payload is not JSON'),
              ),
            ),
          ),
          Effect.map((payloadJson) => ({ ...decoded, payloadJson })),
        );
      }),
      Effect.map((decoded) => {
        const reference = createDomainEventReference();
        const index = domainEvents.length;
        domainEvents.push(cloneAndFreeze(decoded));
        references.set(reference, index);
        return reference;
      }),
    );
  const addDomainEvent: ActionCollector<DomainEvents>['addDomainEvent'] = addDomainEventInput;

  const findReferenceIndex = <Reference>(candidate: Reference): number | undefined => {
    for (const [reference, index] of references) {
      if (Object.is(reference, candidate)) {
        return index;
      }
    }
    return undefined;
  };
  const addOutboxMessageInput = <Reference, Message>(
    domainEvent: Reference,
    message: Message,
  ): Effect.Effect<void, ActionCollectorError> => {
    const domainEventIndex = findReferenceIndex(domainEvent);

    if (domainEventIndex === undefined) {
      return Effect.fail(
        invalidCollectorInput(
          'An Outbox Message must reference a Domain Event from the same Action execution',
        ),
      );
    }

    return Schema.decodeUnknownEffect(OutboxMessageSchema)(message).pipe(
      Effect.mapError(() => invalidCollectorInput('The Outbox Message is structurally invalid')),
      Effect.flatMap((decoded) => {
        const registeredDomainEvent = domainEvents[domainEventIndex];
        if (
          registeredDomainEvent === undefined ||
          decoded.producerModuleKey !== owningModuleKey ||
          decoded.producerModuleKey !== registeredDomainEvent.producerModuleKey
        ) {
          return Effect.fail(
            invalidCollectorInput(
              'An Outbox Message producer must match its registered Domain Event producer',
            ),
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
            }),
          );
        }),
      ),
      Effect.asVoid,
    );
  };
  const addOutboxMessage: ActionCollector<DomainEvents>['addOutboxMessage'] = addOutboxMessageInput;

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
