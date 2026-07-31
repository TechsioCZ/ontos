import { Effect, Schema } from 'effect';
import { DataAccessEventSchema, DomainEventSchema, OutboxMessageSchema } from './events.ts';
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

const invalidCollectorInput = (reason: string) =>
  new ActionCollectorError({
    code: 'action_collector_invalid',
    reason,
  });

const freezeJson = <Value>(value: Value): Value => {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      freezeJson(child);
    }
  }
  return value;
};

const cloneAndFreeze = <Value>(value: Value): Value => freezeJson(structuredClone(value));

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
  readonly addOutboxMessage: (
    domainEvent: DomainEventReference,
    message: OutboxMessage,
  ) => Effect.Effect<void, ActionCollectorError>;
  readonly recordDataAccess: (
    event: DataAccessEventInput,
  ) => Effect.Effect<void, ActionCollectorError>;
  readonly snapshot: () => ActionEvidenceSnapshot;
}

export const makeActionCollector = <DomainEvents extends DomainEventContractMap>(
  domainEventContracts: DomainEvents,
  owningModuleKey: string,
  accessEvidencePolicy: ActionAccessEvidencePolicy,
): ActionCollector<DomainEvents> => {
  const dataAccessEvents: DataAccessEvent[] = [];
  const domainEvents: DomainEvent[] = [];
  const outboxMessages: CollectedOutboxMessage[] = [];
  const references = new Map<DomainEventReference, number>();

  const recordDataAccess = (
    event: DataAccessEventInput,
  ): Effect.Effect<void, ActionCollectorError> => {
    const policyFields = (() => {
      switch (accessEvidencePolicy.captureMode) {
        case 'hash_only': {
          return {
            evidenceCaptureMode: accessEvidencePolicy.captureMode,
            evidencePolicyKey: accessEvidencePolicy.policyKey,
            ...(event.resultFingerprintHash === undefined
              ? {}
              : { resultFingerprintSchema: accessEvidencePolicy.resultFingerprintSchema }),
          } as const;
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
    const materializedEvent: DataAccessEvent = {
      ...event,
      ...policyFields,
    };

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

  const addDomainEvent = (
    event: DeclaredDomainEvent<DomainEvents>,
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
        const reference = Object.freeze({}) as DomainEventReference;
        const index = domainEvents.length;
        domainEvents.push(cloneAndFreeze(decoded));
        references.set(reference, index);
        return reference;
      }),
    );

  const addOutboxMessage = (
    domainEvent: DomainEventReference,
    message: OutboxMessage,
  ): Effect.Effect<void, ActionCollectorError> => {
    const domainEventIndex = references.get(domainEvent);

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

  const snapshot = (): ActionEvidenceSnapshot =>
    Object.freeze({
      dataAccessEvents: Object.freeze([...dataAccessEvents]),
      domainEvents: Object.freeze([...domainEvents]),
      outboxMessages: Object.freeze([...outboxMessages]),
    });

  return Object.freeze({
    addDomainEvent,
    addOutboxMessage,
    recordDataAccess,
    snapshot,
  });
};
