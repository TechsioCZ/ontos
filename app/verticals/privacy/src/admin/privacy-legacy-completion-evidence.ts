import type {
  LegacyCompletionMessageEvidence,
  LegacyCompletionOwnerResult,
} from '@app/core-runtime/legacy-completion-publication';
import { Effect, Result, Schema } from 'effect';

import {
  OwnerExecutionOutcomeSchema,
  OwnerExecutionStatusSchema,
  PrivacyMeasureHandoffSchema,
  reconcilePrivacyMeasure,
} from '../../shared/domain/privacy-measure-handoff.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/privacy-measure-dispatched.ts';

const LegalEntityIdSchema = Schema.String.pipe(Schema.brand('PrivacyLegacyLegalEntityId'));
const DispatchSchema = Schema.Struct({
  handoffRecord: PrivacyMeasureHandoffSchema,
  idempotencyKey: PrivacyMeasureHandoffSchema.fields.idempotencyKey,
  legalEntityId: LegalEntityIdSchema,
  measureId: PrivacyMeasureHandoffSchema.fields.measureId,
  status: OwnerExecutionStatusSchema,
  tenantId: PrivacyMeasureHandoffSchema.fields.tenantId,
});
const OutcomeSchema = Schema.Struct({
  attempt: Schema.Int,
  legalEntityId: LegalEntityIdSchema,
  measureId: OwnerExecutionOutcomeSchema.fields.measureId,
  outcomeId: OwnerExecutionOutcomeSchema.fields.outcomeId,
  outcomeRecord: OwnerExecutionOutcomeSchema,
  status: OwnerExecutionStatusSchema,
  tenantId: PrivacyMeasureHandoffSchema.fields.tenantId,
});
type CompletionStatus = LegacyCompletionOwnerResult['status'];
type Dispatch = typeof DispatchSchema.Type;
type Outcome = typeof OutcomeSchema.Type;
type MessageIndex = ReadonlyMap<string, typeof OutboxPayloadSchema.Type>;
const sameHandoff = Schema.toEquivalence(PrivacyMeasureHandoffSchema);
const messageIdentity = (tenantId: string, measureId: string) => `${tenantId.length}:${tenantId}${measureId}`;
const scopeIdentity = (row: {
  readonly legalEntityId: string;
  readonly measureId: string;
  readonly tenantId: string;
}) => `${row.tenantId.length}:${row.tenantId}${row.legalEntityId.length}:${row.legalEntityId}${row.measureId}`;

const indexOwnerOutcomes = (dispatches: readonly Dispatch[], outcomes: readonly Outcome[]) => {
  const ownerScopes = new Set(dispatches.map(scopeIdentity));
  const indexed = new Map<string, Outcome[]>();
  for (const outcome of outcomes) {
    const scope = scopeIdentity(outcome);
    if (
      !ownerScopes.has(scope) ||
      outcome.outcomeRecord.outcomeId !== outcome.outcomeId ||
      outcome.outcomeRecord.attempt !== outcome.attempt ||
      outcome.outcomeRecord.status !== outcome.status
    ) {
      return null;
    }
    const previous = indexed.get(scope) ?? [];
    previous.push(outcome);
    indexed.set(scope, previous);
  }
  return indexed;
};

const indexDecodedMessages = (
  messages: readonly LegacyCompletionMessageEvidence[],
  payloads: readonly (typeof OutboxPayloadSchema.Type)[],
) => {
  const indexed = new Map<string, typeof OutboxPayloadSchema.Type>();
  let unresolved = false;
  for (const [index, payload] of payloads.entries()) {
    const message = messages.at(index);
    if (message === undefined || payload.handoff.tenantId !== message.tenantId) {
      return null;
    }
    const { handoff } = payload;
    const identity = messageIdentity(message.tenantId, handoff.measureId);
    if (indexed.has(identity)) {
      return null;
    }
    indexed.set(identity, payload);
    if (message.completionConsumerModuleKey === null && message.completionOriginalRevision === null) {
      unresolved = true;
    } else if (
      message.completionConsumerModuleKey !== handoff.owningCapability ||
      message.completionOriginalRevision === null ||
      message.completionOriginalRevision.trim().length === 0
    ) {
      return null;
    }
    const ownerDeliveries = message.deliveries.filter(
      (delivery) => delivery.consumerModuleKey === handoff.owningCapability,
    );
    if (ownerDeliveries.length === 0 || ownerDeliveries.some((delivery) => delivery.status !== 'done')) {
      unresolved = true;
    }
  }
  return { indexed, unresolved };
};

const indexCoreMessages = Effect.fn('PrivacyLegacyCompletion.indexMessages')(function* indexCoreMessages(
  messages: readonly LegacyCompletionMessageEvidence[],
) {
  const decoded = yield* Effect.result(
    Schema.decodeUnknownEffect(Schema.Array(OutboxPayloadSchema))(messages.map((message) => message.payloadJson)),
  );
  return Result.isFailure(decoded) ? null : indexDecodedMessages(messages, decoded.success);
});

const assessDispatch = Effect.fn('PrivacyLegacyCompletion.assessDispatch')(function* assessDispatch(
  dispatch: Dispatch,
  outcomes: readonly Outcome[],
  messages: MessageIndex,
): Effect.fn.Return<CompletionStatus> {
  const handoff = dispatch.handoffRecord;
  const message = messages.get(messageIdentity(dispatch.tenantId, dispatch.measureId));
  if (
    handoff.tenantId !== dispatch.tenantId ||
    handoff.measureId !== dispatch.measureId ||
    handoff.idempotencyKey !== dispatch.idempotencyKey ||
    message === undefined ||
    !sameHandoff(handoff, message.handoff)
  ) {
    return 'UNKNOWN';
  }
  if (dispatch.status !== 'SUCCEEDED') {
    return 'UNRESOLVED';
  }
  // Validate immutable success evidence serially to bound decoding/validation memory.
  const validations = yield* Effect.forEach(
    outcomes.filter((outcome) => outcome.status === 'SUCCEEDED'),
    (outcome) =>
      Effect.result(
        reconcilePrivacyMeasure(
          { attempts: [], createdAt: handoff.requestedAt, handoff, status: 'RECEIVED' },
          outcome.outcomeRecord,
          outcome.outcomeRecord.recordedAt,
        ),
      ),
    { concurrency: 1 },
  );
  if (validations.some(Result.isFailure)) {
    return 'UNKNOWN';
  }
  return validations.length === 0 ? 'UNRESOLVED' : 'VERIFIED_ABSENT';
});

/** Pure evidence interpretation; it neither mints a publication binding nor adopts legacy work. */
export const assessPrivacyLegacyCompletionEvidence = Effect.fn('PrivacyLegacyCompletion.assess')(
  function* assessPrivacyLegacyCompletionEvidence(
    messages: readonly LegacyCompletionMessageEvidence[],
    dispatchRows: readonly unknown[],
    outcomeRows: readonly unknown[],
  ): Effect.fn.Return<CompletionStatus> {
    const [decodedDispatches, decodedOutcomes] = yield* Effect.all(
      [
        Effect.result(Schema.decodeUnknownEffect(Schema.Array(DispatchSchema))(dispatchRows)),
        Effect.result(Schema.decodeUnknownEffect(Schema.Array(OutcomeSchema))(outcomeRows)),
      ],
      { concurrency: 1 },
    );
    if (Result.isFailure(decodedDispatches) || Result.isFailure(decodedOutcomes)) {
      return 'UNKNOWN';
    }
    const dispatches = decodedDispatches.success;
    const outcomes = indexOwnerOutcomes(dispatches, decodedOutcomes.success);
    const messagesObserved = yield* indexCoreMessages(messages);
    if (outcomes === null || messagesObserved === null) {
      return 'UNKNOWN';
    }
    const identities = new Set(dispatches.map((dispatch) => messageIdentity(dispatch.tenantId, dispatch.measureId)));
    if (identities.size !== dispatches.length || identities.size !== messagesObserved.indexed.size) {
      return 'UNKNOWN';
    }
    const statuses = yield* Effect.forEach(
      dispatches,
      (dispatch) => assessDispatch(dispatch, outcomes.get(scopeIdentity(dispatch)) ?? [], messagesObserved.indexed),
      { concurrency: 1 },
    );
    if (statuses.includes('UNKNOWN')) {
      return 'UNKNOWN';
    }
    return messagesObserved.unresolved || statuses.includes('UNRESOLVED') ? 'UNRESOLVED' : 'VERIFIED_ABSENT';
  },
);
