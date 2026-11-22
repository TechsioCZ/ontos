import { Schema } from 'effect';
import type { PrivacyDispatchOperation } from '@app/core-runtime/auth/system-principal-context-provenance';

/**
 * The consumer's own carrier of an outcome a human records LATER, after its dispatch delivery is settled: the consumer
 * Action the human runs, the consumer's own message of that Action and the consumer's own worker that reports it. A
 * continuation reports exactly one Privacy outcome and nothing else; Privacy then reads the receipt itself.
 */
export interface PrivacyDispatchContinuation {
  /** The consumer Action whose succeeded human invocation alone may write the continuation message. */
  readonly actionKey: string;
  /** The consumer's operation requirement that lets the continuation worker report to Privacy. */
  readonly requirementKey: string;
  readonly topic: string;
  readonly workerKey: string;
}

/**
 * One approved consumer of the finite Privacy dispatch (`privacy.measure.dispatched`). The graph is closed: a consumer is
 * named here, with its own worker, its own deployment, its own receipt operation and the one requirement that lets
 * Privacy read that receipt. A consumer module that is not listed here has no finite dispatch authority at all.
 */
export interface PrivacyDispatchConsumer {
  readonly appId: string;
  /** Only a consumer whose outcome a human records after the dispatch: its own continuation carrier. */
  readonly continuation?: PrivacyDispatchContinuation;
  /** The consumer's own execution operation, only for a consumer that executes the measure itself. */
  readonly executionOperation?: PrivacyDispatchOperation;
  readonly moduleKey: string;
  /** The consumer's published Read of its own owner receipt for one dispatched measure. */
  readonly receiptOperation: PrivacyDispatchOperation;
  /** The Privacy-side operation requirement that authorizes Privacy to read that receipt. */
  readonly receiptRequirementKey: string;
  readonly workerKey: string;
}

const symmy: PrivacyDispatchConsumer = Object.freeze({
  appId: 'symmy-integration',
  executionOperation: 'SymmyRetention',
  moduleKey: 'integration.symmy',
  receiptOperation: 'SymmyReceipt',
  receiptRequirementKey: 'privacy.core.requirement.symmy-owner-execution-outcome',
  workerKey: 'integration.symmy.symmy-job-privacy-dispatch',
});

/**
 * Communications never executes a measure itself: a human-confirmed owner Action is a separate, separately approved
 * operation, so this consumer has a receipt Read and no execution operation.
 */
const communications: PrivacyDispatchConsumer = Object.freeze({
  appId: 'communications',
  continuation: Object.freeze({
    actionKey: 'communications.core.record-owner-execution-evidence',
    requirementKey: 'communications.core.requirement.privacy-report-recorded-owner-outcome',
    topic: 'communications.core.owner-execution-evidence-recorded.v1',
    workerKey: 'communications.core.report-privacy-owner-outcome',
  }),
  moduleKey: 'communications.core',
  receiptOperation: 'CommunicationsReceipt',
  receiptRequirementKey: 'privacy.core.requirement.communications-owner-execution-outcome',
  workerKey: 'communications.core.receive-privacy-measure',
});

/** Keyed by consumer module id. */
export const privacyDispatchConsumers: Readonly<Record<string, PrivacyDispatchConsumer>> = Object.freeze({
  [communications.moduleKey]: communications,
  [symmy.moduleKey]: symmy,
});

const consumers = Object.values(privacyDispatchConsumers);

export const privacyDispatchConsumerOfWorker = (workerKey: string | undefined): PrivacyDispatchConsumer | undefined =>
  workerKey === undefined ? undefined : consumers.find((consumer) => consumer.workerKey === workerKey);

/** The consumer whose own continuation worker this is. Symmy has none, so no Symmy worker is ever a continuation. */
export const privacyDispatchConsumerOfContinuationWorker = (
  workerKey: string | undefined,
): PrivacyDispatchConsumer | undefined =>
  workerKey === undefined ? undefined : consumers.find((consumer) => consumer.continuation?.workerKey === workerKey);

/** The only operation a continuation carries: the consumer's own outcome report to Privacy. */
export const privacyDispatchContinuationOperation = 'PrivacyOutcome' satisfies PrivacyDispatchOperation;

const continuationAttempt = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(2));
/**
 * The payload of a consumer's continuation message. It names the original dispatch and the one attempt to report, and
 * never an outcome: Privacy reads the result from the consumer's own receipt. The take-over report is attempt 1, so a
 * continuation attempt is at least 2.
 */
export const PrivacyDispatchContinuationPayloadSchema = Schema.Struct({
  attempt: continuationAttempt,
  dispatchInvocationId: Schema.String.check(Schema.isUUID()).pipe(
    Schema.brand('PrivacyDispatchContinuationDispatchInvocationId'),
  ),
  measureId: Schema.NonEmptyString.pipe(Schema.brand('PrivacyDispatchContinuationMeasureId')),
  taskId: Schema.NonEmptyString.pipe(Schema.brand('PrivacyDispatchContinuationTaskId')),
});
export type PrivacyDispatchContinuationPayload = typeof PrivacyDispatchContinuationPayloadSchema.Type;

/** The consumer that owns an operation: its receipt or its own execution. The Privacy-side operations belong to none. */
export const privacyDispatchConsumerOfOperation = (
  operation: PrivacyDispatchOperation,
): PrivacyDispatchConsumer | undefined =>
  consumers.find(
    ({ executionOperation, receiptOperation }) => operation === receiptOperation || operation === executionOperation,
  );

/** An operation fits a consumer when the consumer owns it or no consumer does (the shared Privacy-side operations). */
export const privacyDispatchOperationFitsConsumer = (
  consumer: PrivacyDispatchConsumer,
  operation: PrivacyDispatchOperation,
): boolean => {
  const owner = privacyDispatchConsumerOfOperation(operation);
  return owner === undefined || owner.moduleKey === consumer.moduleKey;
};

/**
 * Who a dispatch belongs to: the consumer of its worker when it carries one, otherwise the consumer whose receipt it
 * reads. A worker never carries another consumer's operation, and a durable receipt read names exactly one receipt.
 */
export const privacyDispatchConsumerOf = (dispatch: {
  readonly operation: PrivacyDispatchOperation;
  readonly sourceMode?: 'continuation' | 'dispatch' | 'worker' | undefined;
  readonly workerKey?: string | undefined;
}): PrivacyDispatchConsumer | undefined => {
  if (dispatch.sourceMode === 'continuation') {
    return dispatch.operation === privacyDispatchContinuationOperation
      ? privacyDispatchConsumerOfContinuationWorker(dispatch.workerKey)
      : undefined;
  }
  if (dispatch.workerKey !== undefined) {
    const consumer = privacyDispatchConsumerOfWorker(dispatch.workerKey);
    return consumer !== undefined && privacyDispatchOperationFitsConsumer(consumer, dispatch.operation)
      ? consumer
      : undefined;
  }
  const owner = privacyDispatchConsumerOfOperation(dispatch.operation);
  return owner?.receiptOperation === dispatch.operation ? owner : undefined;
};

/**
 * What a durable receipt read (a Privacy request with no worker) may ask for: exactly one consumer's own receipt, under
 * exactly that consumer's receipt requirement.
 */
const PrivacyDispatchReceiptVerdictSchema = Schema.Literals(['ALLOWED', 'NOT_A_RECEIPT', 'WRONG_REQUIREMENT']);
export type PrivacyDispatchReceiptVerdict = typeof PrivacyDispatchReceiptVerdictSchema.Type;
export const privacyDispatchReceiptVerdict = (
  operation: PrivacyDispatchOperation,
  requirementKey: string | undefined,
): PrivacyDispatchReceiptVerdict => {
  const consumer = privacyDispatchConsumerOfOperation(operation);
  if (consumer?.receiptOperation !== operation) {
    return 'NOT_A_RECEIPT';
  }
  return requirementKey === consumer.receiptRequirementKey ? 'ALLOWED' : 'WRONG_REQUIREMENT';
};
