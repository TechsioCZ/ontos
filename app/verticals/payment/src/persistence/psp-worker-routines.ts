import { defineScopedRoutine, ScopedRoutineInvocationError } from '@app/core-runtime';
import type { ScopedRoutineInvoker } from '@app/core-runtime';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime/outbox/worker';
import { DateTime, Effect, Option, Schema } from 'effect';

import { PaymentExecutionBindingSchema } from '../../shared/domain/payment-execution-binding.ts';
import {
  PaymentActionInvocationIdSchema,
  PaymentCustomerConfigurationIdSchema,
  PaymentEconomicEffectKeySchema,
  PaymentIdSchema,
  PaymentMaterialHashSchema,
  PaymentObservationIdSchema,
  PaymentOperationIdSchema,
  PaymentSourceOccurrenceIdSchema,
} from '../../shared/domain/payment-identifiers.ts';
import { PAYMENT_LAUNCH_CURRENCY } from '../../shared/domain/payment-money.ts';
import {
  PaymentGatewayProviderFamilySchema,
  PaymentObservationFactKindSchema,
  PaymentOperationKindSchema,
  PaymentOperationOutcomeSchema,
  PaymentSourceFactFamilySchema,
} from '../../shared/domain/payment-vocabulary.ts';
import type { PaymentObservationFactKind, PaymentSourceFactFamily } from '../../shared/domain/payment-vocabulary.ts';
import {
  GatewayCredentialSecretRefSchema,
  GatewayHttpsUrlSchema,
  GatewayMerchantIdentitySchema,
  GatewayProviderAccountBindingIdSchema,
  GatewayProviderAccountRefSchema,
  GatewayReturnTokenSchema,
} from '../../shared/domain/psp-configuration.ts';
import type {
  GatewayHttpsUrl,
  GatewayProviderAccountBindingId,
  GatewayProviderAccountRef,
  GatewayReturnToken,
} from '../../shared/domain/psp-configuration.ts';
import {
  GatewayBindingStatusSchema,
  GatewayCredentialStatusSchema,
  GatewayEnvironmentSchema,
  ProviderDispatchStateSchema,
  ProviderEvidenceOriginSchema,
  ProviderEvidenceSubmissionStateSchema,
  ProviderNotificationAuthenticitySchema,
  ProviderNotificationStateSchema,
  ProviderNotSentReasonSchema,
} from '../../shared/domain/psp-vocabulary.ts';
import type {
  GatewayEnvironment,
  ProviderEvidenceOrigin,
  ProviderEvidenceSubmissionState,
  ProviderNotificationState,
  ProviderNotSentReason,
} from '../../shared/domain/psp-vocabulary.ts';

/*
 * Frozen worker-side database surface of the C17 gateway adapter (#1155-#1158, plan §3.4). Workers get no
 * database executor; every read and write of the dispatch ledger, the evidence store and notification
 * processing goes through one of these SECURITY DEFINER routines (migration `c17-psp-guards`). Each routine
 * returns one `result` jsonb document per row; its exact encoded shape is the routine's result Schema and
 * the wrapper decodes it into the typed record.
 */

const OWNER_MODULE_KEY = 'payment.core';
const ROUTINE_SCHEMA = 'payment';

const uuidText = Schema.String.check(Schema.isUUID());
const revisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const nonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const sha256Hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const boundedText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200), Schema.isTrimmed());

/** Identity of one provider dispatch ledger row. */
const PspDispatchIdSchema = uuidText.pipe(Schema.brand('PspDispatchId'));
/** Identity of one provider evidence row. */
const PspEvidenceIdSchema = uuidText.pipe(Schema.brand('PspEvidenceId'));
export type PspEvidenceId = typeof PspEvidenceIdSchema.Type;
/** Identity of one captured provider notification. */
export const PspNotificationIdSchema = uuidText.pipe(Schema.brand('PspNotificationId'));
export type PspNotificationId = typeof PspNotificationIdSchema.Type;
/** The Core outbox delivery that wrote a worker row. */
const PspOutboxDeliveryIdSchema = uuidText.pipe(Schema.brand('PspOutboxDeliveryId'));
/** The registered worker key that wrote a worker row. */
const PspWorkerKeySchema = boundedText.pipe(Schema.brand('PspWorkerKey'));
/** Deterministic dispatch correlation reference: the operation UUID as 32 lowercase hex characters. */
const PspOrderReferenceSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));
const PspProviderObjectRefTextSchema = boundedText;
/** The provider's own event or notification identity, when it has one. */
const PspProviderOccurrenceIdSchema = boundedText.pipe(Schema.brand('PspProviderOccurrenceId'));
const PspCurrencySchema = Schema.Literal(PAYMENT_LAUNCH_CURRENCY);

/** Every reason a routine refuses a worker request; nothing is written for a refusal. */
const PSP_ROUTINE_CONFLICT_REASONS = [
  'operation_unknown',
  'binding_unknown',
  'binding_mismatch',
  'material_mismatch',
  'request_mismatch',
  'request_body_invalid',
  'credential_not_active',
  'target_not_acknowledged',
  'provider_target_not_applicable',
  'cancel_not_registered',
  'illegal_transition',
  'correlation_mismatch',
  'occurrence_mismatch',
] as const;
const PspRoutineConflictReasonSchema = Schema.Literals(PSP_ROUTINE_CONFLICT_REASONS);

/** The C16 operation and Payment facts the executor needs before any provider call. */
const PspOperationForExecutionSchema = Schema.Struct({
  amountMinor: nonNegativeIntSchema,
  binding: PaymentExecutionBindingSchema,
  /** A CANCEL ledger row targets this operation (prepare of a COLLECT is then WITHHELD). */
  cancelDispatchExists: Schema.Boolean,
  /** A C16 CANCEL_OR_VOID operation targets this operation. */
  cancelOperationExists: Schema.Boolean,
  currency: PspCurrencySchema,
  customerConfigurationId: PaymentCustomerConfigurationIdSchema,
  kind: PaymentOperationKindSchema,
  materialHash: PaymentMaterialHashSchema,
  operationId: PaymentOperationIdSchema,
  outcome: PaymentOperationOutcomeSchema,
  paymentId: PaymentIdSchema,
  targetOperationId: Schema.optionalKey(PaymentOperationIdSchema),
});
export type PspOperationForExecution = typeof PspOperationForExecutionSchema.Type;

/** A resolved binding with the credential revision to execute with. The secret itself is never here. */
const PspExecutionTargetSchema = Schema.Struct({
  bindingId: GatewayProviderAccountBindingIdSchema,
  credentialRevision: revisionSchema,
  credentialSecretRef: GatewayCredentialSecretRefSchema,
  credentialStatus: GatewayCredentialStatusSchema,
  environment: GatewayEnvironmentSchema,
  merchantIdentity: GatewayMerchantIdentitySchema,
  notificationUrl: GatewayHttpsUrlSchema,
  providerAccountRef: GatewayProviderAccountRefSchema,
  providerFamily: PaymentGatewayProviderFamilySchema,
  returnUrl: Schema.optionalKey(GatewayHttpsUrlSchema),
  status: GatewayBindingStatusSchema,
});
export type PspExecutionTarget = typeof PspExecutionTargetSchema.Type;

/** One provider dispatch ledger row. */
const PspDispatchRecordSchema = Schema.Struct({
  bindingId: GatewayProviderAccountBindingIdSchema,
  credentialRevision: Schema.optionalKey(revisionSchema),
  customerRedirectUrl: Schema.optionalKey(GatewayHttpsUrlSchema),
  deliveryId: PspOutboxDeliveryIdSchema,
  dispatchId: PspDispatchIdSchema,
  endpointRef: Schema.optionalKey(boundedText),
  environment: GatewayEnvironmentSchema,
  idempotencyKeyHash: Schema.optionalKey(sha256Hex),
  materialHash: PaymentMaterialHashSchema,
  notSentReason: Schema.optionalKey(ProviderNotSentReasonSchema),
  operationId: PaymentOperationIdSchema,
  operationKind: PaymentOperationKindSchema,
  orderReference: PspOrderReferenceSchema,
  originActionInvocationId: PaymentActionInvocationIdSchema,
  paymentId: PaymentIdSchema,
  preparedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  providerAccountRef: GatewayProviderAccountRefSchema,
  providerFamily: PaymentGatewayProviderFamilySchema,
  providerPaymentRef: Schema.optionalKey(PspProviderObjectRefTextSchema),
  providerRefundRef: Schema.optionalKey(PspProviderObjectRefTextSchema),
  recordedAt: Schema.DateTimeUtcFromString,
  replayExpiresAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  replayStartsAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  /** Exact request bytes for a Stripe replay. Contains no secret. */
  requestBody: Schema.optionalKey(Schema.Uint8ArrayFromBase64),
  requestHash: Schema.optionalKey(sha256Hex),
  respondedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  returnToken: Schema.optionalKey(GatewayReturnTokenSchema),
  state: ProviderDispatchStateSchema,
  targetOperationId: Schema.optionalKey(PaymentOperationIdSchema),
  workerKey: PspWorkerKeySchema,
});
export type PspDispatchRecord = typeof PspDispatchRecordSchema.Type;

/** One provider evidence row. `providerRefs` and `discrepancy` are the adapter's encoded documents. */
const PspEvidenceRecordSchema = Schema.Struct({
  bindingId: GatewayProviderAccountBindingIdSchema,
  deliveryId: PspOutboxDeliveryIdSchema,
  discrepancy: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  economicEffectKey: Schema.optionalKey(PaymentEconomicEffectKeySchema),
  environment: GatewayEnvironmentSchema,
  evidenceId: PspEvidenceIdSchema,
  evidenceOrigin: ProviderEvidenceOriginSchema,
  factFamily: PaymentSourceFactFamilySchema,
  factKind: PaymentObservationFactKindSchema,
  notificationId: Schema.optionalKey(PspNotificationIdSchema),
  observationId: Schema.optionalKey(PaymentObservationIdSchema),
  observedAmountMinor: Schema.optionalKey(nonNegativeIntSchema),
  operationId: PaymentOperationIdSchema,
  paymentId: PaymentIdSchema,
  providerAccountRef: GatewayProviderAccountRefSchema,
  providerFamily: PaymentGatewayProviderFamilySchema,
  providerOccurredAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  providerRefs: Schema.Array(Schema.Json),
  reason: Schema.optionalKey(boundedText),
  recordedAt: Schema.DateTimeUtcFromString,
  sourceOccurrenceId: PaymentSourceOccurrenceIdSchema,
  sourceRevision: nonNegativeIntSchema,
  submissionState: ProviderEvidenceSubmissionStateSchema,
  submittedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  submittedDeliveryId: Schema.optionalKey(PspOutboxDeliveryIdSchema),
});
export type PspEvidenceRecord = typeof PspEvidenceRecordSchema.Type;

/** One captured provider notification, including its exact raw body for re-verification. */
const PspNotificationRecordSchema = Schema.Struct({
  authenticity: ProviderNotificationAuthenticitySchema,
  bindingId: GatewayProviderAccountBindingIdSchema,
  claimedStatus: Schema.optionalKey(boundedText),
  correlatedOperationId: Schema.optionalKey(PaymentOperationIdSchema),
  deliveryIdentity: boundedText,
  environment: GatewayEnvironmentSchema,
  headers: Schema.Record(Schema.String, Schema.String),
  notificationId: PspNotificationIdSchema,
  processedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  processedDeliveryId: Schema.optionalKey(PspOutboxDeliveryIdSchema),
  providerAccountRef: GatewayProviderAccountRefSchema,
  providerEventAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  providerFamily: PaymentGatewayProviderFamilySchema,
  providerOccurrenceId: Schema.optionalKey(PspProviderOccurrenceIdSchema),
  providerRefs: Schema.Array(Schema.Json),
  query: Schema.Record(Schema.String, Schema.String),
  rawBody: Schema.Uint8ArrayFromBase64,
  receivedAt: Schema.DateTimeUtcFromString,
  state: ProviderNotificationStateSchema,
  transportDeliveryRef: boundedText,
  verifiedAt: Schema.DateTimeUtcFromString,
});
export type PspNotificationRecord = typeof PspNotificationRecordSchema.Type;

const conflict = <RecordSchema extends Schema.Top>(record: RecordSchema) =>
  Schema.TaggedStruct('CONFLICT', { reason: PspRoutineConflictReasonSchema, record: Schema.optionalKey(record) });

const PspRegisterCancelResultSchema = Schema.Union([
  Schema.TaggedStruct('REGISTERED', {
    cancel: PspDispatchRecordSchema,
    target: Schema.optionalKey(PspDispatchRecordSchema),
  }),
  Schema.TaggedStruct('EXISTING', {
    cancel: PspDispatchRecordSchema,
    target: Schema.optionalKey(PspDispatchRecordSchema),
  }),
  Schema.TaggedStruct('CONFLICT', { reason: PspRoutineConflictReasonSchema }),
]);
export type PspRegisterCancelResult = typeof PspRegisterCancelResultSchema.Type;

const PspPrepareDispatchResultSchema = Schema.Union([
  Schema.TaggedStruct('PREPARED', { record: PspDispatchRecordSchema }),
  Schema.TaggedStruct('EXISTING', { record: PspDispatchRecordSchema }),
  Schema.TaggedStruct('WITHHELD', { record: PspDispatchRecordSchema }),
  conflict(PspDispatchRecordSchema),
]);
export type PspPrepareDispatchResult = typeof PspPrepareDispatchResultSchema.Type;

const PspDispatchChangeResultSchema = Schema.Union([
  Schema.TaggedStruct('RECORDED', { record: PspDispatchRecordSchema }),
  Schema.TaggedStruct('UNCHANGED', { record: PspDispatchRecordSchema }),
  Schema.TaggedStruct('NOT_FOUND', {}),
  conflict(PspDispatchRecordSchema),
]);
export type PspDispatchChangeResult = typeof PspDispatchChangeResultSchema.Type;

const PspCorrelateResultSchema = Schema.Union([
  Schema.TaggedStruct('CORRELATED', { record: PspDispatchRecordSchema }),
  Schema.TaggedStruct('ALREADY_CORRELATED', { record: PspDispatchRecordSchema }),
  Schema.TaggedStruct('NOT_FOUND', {}),
  conflict(PspDispatchRecordSchema),
]);
export type PspCorrelateResult = typeof PspCorrelateResultSchema.Type;

const PspUnresolvedRefundsSchema = Schema.Struct({
  operationIds: Schema.Array(PaymentOperationIdSchema),
  unresolved: Schema.Boolean,
});
export type PspUnresolvedRefunds = typeof PspUnresolvedRefundsSchema.Type;

const PspAppendEvidenceResultSchema = Schema.Union([
  Schema.TaggedStruct('APPENDED', { record: PspEvidenceRecordSchema }),
  Schema.TaggedStruct('EXISTING', { record: PspEvidenceRecordSchema }),
  conflict(PspEvidenceRecordSchema),
]);
export type PspAppendEvidenceResult = typeof PspAppendEvidenceResultSchema.Type;

const PspMarkEvidenceResultSchema = Schema.Union([
  Schema.TaggedStruct('MARKED', { record: PspEvidenceRecordSchema }),
  Schema.TaggedStruct('UNCHANGED', { record: PspEvidenceRecordSchema }),
  Schema.TaggedStruct('NOT_FOUND', {}),
  conflict(PspEvidenceRecordSchema),
]);
export type PspMarkEvidenceResult = typeof PspMarkEvidenceResultSchema.Type;

const PspTransitionNotificationResultSchema = Schema.Union([
  Schema.TaggedStruct('TRANSITIONED', { record: PspNotificationRecordSchema }),
  Schema.TaggedStruct('UNCHANGED', { record: PspNotificationRecordSchema }),
  Schema.TaggedStruct('NOT_FOUND', {}),
  conflict(PspNotificationRecordSchema),
]);
export type PspTransitionNotificationResult = typeof PspTransitionNotificationResultSchema.Type;

/** The admitting invocation and the delivery of a worker write. Never a human actor (plan §3.4). */
export interface PspWorkerOrigin {
  readonly compositionRevision: string;
  readonly deliveryId: string;
  readonly originActionInvocationId: string;
  readonly workerKey: string;
}

/** The origin of a write from a verified worker context; none when the delivery has no originating invocation. */
export const pspWorkerOriginOf = (context: OutboxWorkerHandlerContext): Option.Option<PspWorkerOrigin> =>
  Option.map(Option.fromUndefinedOr(context.originatorInvocationId), (originActionInvocationId) => ({
    compositionRevision: context.compositionRevision,
    deliveryId: context.deliveryId,
    originActionInvocationId,
    workerKey: context.workerKey,
  }));

const scope = [
  { source: 'tenantId', type: 'uuid' },
  { source: 'legalEntityId', type: 'uuid' },
] as const;
const origin = [
  { source: 'input', type: 'uuid' },
  { source: 'input', type: 'text' },
  { source: 'input', type: 'text' },
  { source: 'input', type: 'uuid' },
] as const;
const originValues = (value: PspWorkerOrigin) =>
  [value.originActionInvocationId, value.compositionRevision, value.workerKey, value.deliveryId] as const;

const resultRow = <Result extends Schema.Top>(result: Result) => Schema.Struct({ result: Schema.toEncoded(result) });

const readOperationForExecutionRoutine = defineScopedRoutine({
  name: 'psp_read_operation_for_execution',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [...scope, { source: 'input', type: 'uuid' }] as const,
  resultSchema: resultRow(PspOperationForExecutionSchema),
  routineKey: 'psp.read-operation-for-execution',
  schema: ROUTINE_SCHEMA,
});
const resolveExecutionTargetRoutine = defineScopedRoutine({
  name: 'psp_resolve_execution_target',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    ...scope,
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'integer' },
  ] as const,
  resultSchema: resultRow(PspExecutionTargetSchema),
  routineKey: 'psp.resolve-execution-target',
  schema: ROUTINE_SCHEMA,
});
const resolveNotificationBindingRoutine = defineScopedRoutine({
  name: 'psp_resolve_notification_binding',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [...scope, { source: 'input', type: 'text' }, { source: 'input', type: 'text' }] as const,
  resultSchema: resultRow(PspExecutionTargetSchema),
  routineKey: 'psp.resolve-notification-binding',
  schema: ROUTINE_SCHEMA,
});
const registerCancelRoutine = defineScopedRoutine({
  name: 'psp_register_cancel',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    ...scope,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    ...origin,
  ] as const,
  resultSchema: resultRow(PspRegisterCancelResultSchema),
  routineKey: 'psp.register-cancel',
  schema: ROUTINE_SCHEMA,
});
const prepareDispatchRoutine = defineScopedRoutine({
  name: 'psp_prepare_dispatch',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    ...scope,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'integer' },
    { nullable: true, source: 'input', type: 'text' },
    ...origin,
  ] as const,
  resultSchema: resultRow(PspPrepareDispatchResultSchema),
  routineKey: 'psp.prepare-dispatch',
  schema: ROUTINE_SCHEMA,
});
const recordDispatchOutcomeRoutine = defineScopedRoutine({
  name: 'psp_record_dispatch_outcome',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    ...scope,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: resultRow(PspDispatchChangeResultSchema),
  routineKey: 'psp.record-dispatch-outcome',
  schema: ROUTINE_SCHEMA,
});
const recordNotSentRoutine = defineScopedRoutine({
  name: 'psp_record_not_sent',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    ...scope,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    ...origin,
  ] as const,
  resultSchema: resultRow(PspDispatchChangeResultSchema),
  routineKey: 'psp.record-not-sent',
  schema: ROUTINE_SCHEMA,
});
const recordUnsupportedRoutine = defineScopedRoutine({
  name: 'psp_record_unsupported',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    ...scope,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    ...origin,
  ] as const,
  resultSchema: resultRow(PspDispatchChangeResultSchema),
  routineKey: 'psp.record-unsupported',
  schema: ROUTINE_SCHEMA,
});
const correlateUnknownDispatchRoutine = defineScopedRoutine({
  name: 'psp_correlate_unknown_dispatch',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    ...scope,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: resultRow(PspCorrelateResultSchema),
  routineKey: 'psp.correlate-unknown-dispatch',
  schema: ROUTINE_SCHEMA,
});
const readDispatchRoutine = defineScopedRoutine({
  name: 'psp_read_dispatch',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [...scope, { source: 'input', type: 'uuid' }] as const,
  resultSchema: resultRow(PspDispatchRecordSchema),
  routineKey: 'psp.read-dispatch',
  schema: ROUTINE_SCHEMA,
});
const readDispatchByProviderRefRoutine = defineScopedRoutine({
  name: 'psp_read_dispatch_by_provider_ref',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [...scope, { source: 'input', type: 'uuid' }, { source: 'input', type: 'text' }] as const,
  resultSchema: resultRow(PspDispatchRecordSchema),
  routineKey: 'psp.read-dispatch-by-provider-ref',
  schema: ROUTINE_SCHEMA,
});
const readDispatchByOrderReferenceRoutine = defineScopedRoutine({
  name: 'psp_read_dispatch_by_order_reference',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [...scope, { source: 'input', type: 'uuid' }, { source: 'input', type: 'text' }] as const,
  resultSchema: resultRow(PspDispatchRecordSchema),
  routineKey: 'psp.read-dispatch-by-order-reference',
  schema: ROUTINE_SCHEMA,
});
const hasUnresolvedRefundRoutine = defineScopedRoutine({
  name: 'psp_has_unresolved_refund',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    ...scope,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: resultRow(PspUnresolvedRefundsSchema),
  routineKey: 'psp.has-unresolved-refund',
  schema: ROUTINE_SCHEMA,
});
const appendEvidenceRoutine = defineScopedRoutine({
  name: 'psp_append_evidence',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    ...scope,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'jsonb' },
    { nullable: true, source: 'input', type: 'bigint' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'bigint' },
    { nullable: true, source: 'input', type: 'timestamptz' },
    { nullable: true, source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'jsonb' },
    { nullable: true, source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'uuid' },
    ...origin,
  ] as const,
  resultSchema: resultRow(PspAppendEvidenceResultSchema),
  routineKey: 'psp.append-evidence',
  schema: ROUTINE_SCHEMA,
});
const listPendingEvidenceRoutine = defineScopedRoutine({
  name: 'psp_list_pending_evidence',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [...scope, { source: 'input', type: 'uuid' }] as const,
  resultSchema: resultRow(PspEvidenceRecordSchema),
  routineKey: 'psp.list-pending-evidence',
  schema: ROUTINE_SCHEMA,
});
const markEvidenceSubmissionRoutine = defineScopedRoutine({
  name: 'psp_mark_evidence_submission',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    ...scope,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: resultRow(PspMarkEvidenceResultSchema),
  routineKey: 'psp.mark-evidence-submission',
  schema: ROUTINE_SCHEMA,
});
const readNotificationRoutine = defineScopedRoutine({
  name: 'psp_read_notification',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [...scope, { source: 'input', type: 'uuid' }] as const,
  resultSchema: resultRow(PspNotificationRecordSchema),
  routineKey: 'psp.read-notification',
  schema: ROUTINE_SCHEMA,
});
const transitionNotificationRoutine = defineScopedRoutine({
  name: 'psp_transition_notification',
  ownerModuleKey: OWNER_MODULE_KEY,
  parameters: [
    ...scope,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: resultRow(PspTransitionNotificationResultSchema),
  routineKey: 'psp.transition-notification',
  schema: ROUTINE_SCHEMA,
});

/** Every C17 worker routine; `verify-db-schema.mts` proves exactly these are executable by the runtime role. */
export const PSP_WORKER_ROUTINES = [
  readOperationForExecutionRoutine,
  resolveExecutionTargetRoutine,
  resolveNotificationBindingRoutine,
  registerCancelRoutine,
  prepareDispatchRoutine,
  recordDispatchOutcomeRoutine,
  recordNotSentRoutine,
  recordUnsupportedRoutine,
  correlateUnknownDispatchRoutine,
  readDispatchRoutine,
  readDispatchByProviderRefRoutine,
  readDispatchByOrderReferenceRoutine,
  hasUnresolvedRefundRoutine,
  appendEvidenceRoutine,
  listPendingEvidenceRoutine,
  markEvidenceSubmissionRoutine,
  readNotificationRoutine,
  transitionNotificationRoutine,
] as const;

const withCause = (failure: ScopedRoutineInvocationError, cause: Schema.SchemaError) =>
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });

const resultInvalid = (routineKey: string) =>
  new ScopedRoutineInvocationError({
    code: 'scoped_routine_result_invalid',
    constraint: Option.none(),
    ownerModuleKey: OWNER_MODULE_KEY,
    postgresCode: Option.none(),
    reason: 'The scoped database routine returned an invalid result',
    routineKey,
  });

const decodeAll =
  <Result extends Schema.Top>(routineKey: string, schema: Result) =>
  (rows: readonly { readonly result: unknown }[]) =>
    Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(schema)(row.result), { concurrency: 1 }).pipe(
      Effect.mapError((cause) => withCause(resultInvalid(routineKey), cause)),
    );

const decodeOptional =
  <Result extends Schema.Top>(routineKey: string, schema: Result) =>
  (rows: readonly { readonly result: unknown }[]) =>
    rows.length > 1
      ? Effect.fail(resultInvalid(routineKey))
      : decodeAll(routineKey, schema)(rows).pipe(Effect.map((decoded) => Option.fromUndefinedOr(decoded[0])));

const decodeOne =
  <Result extends Schema.Top>(routineKey: string, schema: Result) =>
  (rows: readonly { readonly result: unknown }[]) =>
    decodeOptional(
      routineKey,
      schema,
    )(rows).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(resultInvalid(routineKey)), onSome: Effect.succeed })),
    );

const encodeBody = (
  body: Option.Option<Uint8Array>,
  routineKey: string,
): Effect.Effect<Option.Option<string>, ScopedRoutineInvocationError> =>
  Option.match(body, {
    onNone: () => Effect.succeedNone,
    onSome: (bytes) =>
      Schema.encodeEffect(Schema.Uint8ArrayFromBase64)(bytes).pipe(
        Effect.map(Option.some),
        Effect.mapError((cause) =>
          withCause(
            new ScopedRoutineInvocationError({
              code: 'scoped_routine_arguments_invalid',
              constraint: Option.none(),
              ownerModuleKey: OWNER_MODULE_KEY,
              postgresCode: Option.none(),
              reason: 'The request body could not be encoded',
              routineKey,
            }),
            cause,
          ),
        ),
      ),
  });

/** The C16 operation to execute, if it exists in the worker's scope. */
export const pspReadOperationForExecution = (invoker: ScopedRoutineInvoker, operationId: string) =>
  invoker
    .invoke(readOperationForExecutionRoutine, [operationId])
    .pipe(Effect.flatMap(decodeOptional(readOperationForExecutionRoutine.routineKey, PspOperationForExecutionSchema)));

export interface PspResolveExecutionTargetInput {
  /** The credential revision recorded on an existing dispatch; none selects the binding's current revision. */
  readonly credentialRevision: Option.Option<number>;
  readonly customerConfigurationId: Option.Option<string>;
  readonly environment: GatewayEnvironment;
  readonly providerAccountRef: GatewayProviderAccountRef;
}

/** The exact (possibly retired) binding of an operation. Unknown ref or another environment is none. */
export const pspResolveExecutionTarget = (invoker: ScopedRoutineInvoker, input: PspResolveExecutionTargetInput) =>
  invoker
    .invoke(resolveExecutionTargetRoutine, [
      input.providerAccountRef,
      input.environment,
      Option.getOrNull(input.customerConfigurationId),
      Option.getOrNull(input.credentialRevision),
    ])
    .pipe(Effect.flatMap(decodeOptional(resolveExecutionTargetRoutine.routineKey, PspExecutionTargetSchema)));

/** The binding a captured notification was addressed to, with its current credential revision. */
export const pspResolveNotificationBinding = (
  invoker: ScopedRoutineInvoker,
  input: { readonly environment: GatewayEnvironment; readonly providerAccountRef: GatewayProviderAccountRef },
) =>
  invoker
    .invoke(resolveNotificationBindingRoutine, [input.providerAccountRef, input.environment])
    .pipe(Effect.flatMap(decodeOptional(resolveNotificationBindingRoutine.routineKey, PspExecutionTargetSchema)));

/** The ledger identity of one operation: its exact binding and its C16 materialHash. */
export interface PspDispatchIdentity {
  readonly bindingId: GatewayProviderAccountBindingId;
  readonly materialHash: string;
  readonly operationId: string;
}

/** Registers a CANCEL under the target's advisory lock and returns the target's row read under that lock. */
export const pspRegisterCancel = (
  invoker: ScopedRoutineInvoker,
  input: PspDispatchIdentity & { readonly origin: PspWorkerOrigin },
) =>
  invoker
    .invoke(registerCancelRoutine, [
      input.operationId,
      input.bindingId,
      input.materialHash,
      ...originValues(input.origin),
    ])
    .pipe(Effect.flatMap(decodeOne(registerCancelRoutine.routineKey, PspRegisterCancelResultSchema)));

export interface PspPrepareDispatchInput extends PspDispatchIdentity {
  readonly credentialRevision: number;
  readonly endpointRef: string;
  /** SHA-256 hex of the idempotency key sent to the provider (Stripe); the key itself is derived, never stored. */
  readonly idempotencyKeyHash: Option.Option<string>;
  readonly origin: PspWorkerOrigin;
  /** The acknowledged provider payment the CANCEL or REFUND acts on; none for a COLLECT. */
  readonly providerPaymentRef: Option.Option<string>;
  /** Exact request bytes, persisted only when a replay window exists. */
  readonly replayBody: Option.Option<{ readonly body: Uint8Array; readonly windowMs: number }>;
  readonly requestHash: string;
  readonly returnToken: Option.Option<GatewayReturnToken>;
}

/** Persists the prepared request before the first send (#1158). */
export const pspPrepareDispatch = (invoker: ScopedRoutineInvoker, input: PspPrepareDispatchInput) =>
  encodeBody(input.replayBody.pipe(Option.map(({ body }) => body)), prepareDispatchRoutine.routineKey).pipe(
    Effect.flatMap((body) =>
      invoker.invoke(prepareDispatchRoutine, [
        input.operationId,
        input.bindingId,
        input.materialHash,
        input.credentialRevision,
        input.endpointRef,
        input.requestHash,
        Option.getOrNull(input.idempotencyKeyHash),
        Option.getOrNull(input.returnToken),
        Option.getOrNull(body),
        Option.getOrNull(input.replayBody.pipe(Option.map(({ windowMs }) => windowMs))),
        Option.getOrNull(input.providerPaymentRef),
        ...originValues(input.origin),
      ]),
    ),
    Effect.flatMap(decodeOne(prepareDispatchRoutine.routineKey, PspPrepareDispatchResultSchema)),
  );

export interface PspRecordDispatchOutcomeInput {
  readonly customerRedirectUrl: Option.Option<GatewayHttpsUrl>;
  readonly deliveryId: string;
  readonly operationId: string;
  readonly providerPaymentRef: Option.Option<string>;
  readonly providerRefundRef: Option.Option<string>;
  readonly to: 'ACKNOWLEDGED' | 'OUTCOME_UNKNOWN' | 'REJECTED_BEFORE_EFFECT' | 'TARGET_UNRESOLVED';
}

/** Records a provider response, a lost response, or an unresolved cancel target. */
export const pspRecordDispatchOutcome = (invoker: ScopedRoutineInvoker, input: PspRecordDispatchOutcomeInput) =>
  invoker
    .invoke(recordDispatchOutcomeRoutine, [
      input.operationId,
      input.to,
      Option.getOrNull(input.providerPaymentRef),
      Option.getOrNull(input.providerRefundRef),
      Option.getOrNull(input.customerRedirectUrl),
      input.deliveryId,
    ])
    .pipe(Effect.flatMap(decodeOne(recordDispatchOutcomeRoutine.routineKey, PspDispatchChangeResultSchema)));

/** Records that an operation was never sent. */
export const pspRecordNotSent = (
  invoker: ScopedRoutineInvoker,
  input: PspDispatchIdentity & { readonly origin: PspWorkerOrigin; readonly reason: ProviderNotSentReason },
) =>
  invoker
    .invoke(recordNotSentRoutine, [
      input.operationId,
      input.bindingId,
      input.materialHash,
      input.reason,
      ...originValues(input.origin),
    ])
    .pipe(Effect.flatMap(decodeOne(recordNotSentRoutine.routineKey, PspDispatchChangeResultSchema)));

/** Records that the provider family cannot perform the operation. There is no fallback. */
export const pspRecordUnsupported = (
  invoker: ScopedRoutineInvoker,
  input: PspDispatchIdentity & { readonly origin: PspWorkerOrigin },
) =>
  invoker
    .invoke(recordUnsupportedRoutine, [
      input.operationId,
      input.bindingId,
      input.materialHash,
      ...originValues(input.origin),
    ])
    .pipe(Effect.flatMap(decodeOne(recordUnsupportedRoutine.routineKey, PspDispatchChangeResultSchema)));

/** Correlates a dispatch with a lost response by its lookup-verified order reference inside one binding. */
export const pspCorrelateUnknownDispatch = (
  invoker: ScopedRoutineInvoker,
  input: {
    readonly bindingId: GatewayProviderAccountBindingId;
    readonly deliveryId: string;
    readonly orderReference: string;
    readonly providerPaymentRef: Option.Option<string>;
    readonly providerRefundRef: Option.Option<string>;
  },
) =>
  invoker
    .invoke(correlateUnknownDispatchRoutine, [
      input.bindingId,
      input.orderReference,
      Option.getOrNull(input.providerPaymentRef),
      Option.getOrNull(input.providerRefundRef),
      input.deliveryId,
    ])
    .pipe(Effect.flatMap(decodeOne(correlateUnknownDispatchRoutine.routineKey, PspCorrelateResultSchema)));

export const pspReadDispatch = (invoker: ScopedRoutineInvoker, operationId: string) =>
  invoker
    .invoke(readDispatchRoutine, [operationId])
    .pipe(Effect.flatMap(decodeOptional(readDispatchRoutine.routineKey, PspDispatchRecordSchema)));

/** Every dispatch of the binding naming this provider payment or refund object (collection first). */
export const pspReadDispatchByProviderRef = (
  invoker: ScopedRoutineInvoker,
  input: { readonly bindingId: GatewayProviderAccountBindingId; readonly providerRef: string },
) =>
  invoker
    .invoke(readDispatchByProviderRefRoutine, [input.bindingId, input.providerRef])
    .pipe(Effect.flatMap(decodeAll(readDispatchByProviderRefRoutine.routineKey, PspDispatchRecordSchema)));

export const pspReadDispatchByOrderReference = (
  invoker: ScopedRoutineInvoker,
  input: { readonly bindingId: GatewayProviderAccountBindingId; readonly orderReference: string },
) =>
  invoker
    .invoke(readDispatchByOrderReferenceRoutine, [input.bindingId, input.orderReference])
    .pipe(Effect.flatMap(decodeOptional(readDispatchByOrderReferenceRoutine.routineKey, PspDispatchRecordSchema)));

/** Unresolved refunds of one provider payment, other than the asking operation. */
export const pspHasUnresolvedRefund = (
  invoker: ScopedRoutineInvoker,
  input: {
    readonly bindingId: GatewayProviderAccountBindingId;
    readonly excludingOperationId: Option.Option<string>;
    readonly providerPaymentRef: string;
  },
) =>
  invoker
    .invoke(hasUnresolvedRefundRoutine, [
      input.bindingId,
      input.providerPaymentRef,
      Option.getOrNull(input.excludingOperationId),
    ])
    .pipe(Effect.flatMap(decodeOne(hasUnresolvedRefundRoutine.routineKey, PspUnresolvedRefundsSchema)));

export interface PspAppendEvidenceInput {
  readonly bindingId: GatewayProviderAccountBindingId;
  readonly discrepancy: Option.Option<Readonly<Record<string, Schema.Json>>>;
  readonly economicEffectKey: Option.Option<string>;
  readonly evidenceOrigin: ProviderEvidenceOrigin;
  readonly factFamily: Extract<PaymentSourceFactFamily, 'GATEWAY_OUTCOME' | 'REFUND_EXECUTION'>;
  readonly factKind: Exclude<PaymentObservationFactKind, 'UNRECOGNIZED'>;
  readonly notificationId: Option.Option<PspNotificationId>;
  readonly observedAmountMinor: Option.Option<number>;
  readonly operationId: string;
  readonly origin: PspWorkerOrigin;
  readonly providerOccurredAt: Option.Option<DateTime.Utc>;
  readonly providerRefs: readonly Schema.Json[];
  readonly reason: Option.Option<string>;
  readonly sourceOccurrenceId: string;
  readonly sourceRevision: number;
}

/** Appends evidence idempotently on (binding, source occurrence, revision); a different statement conflicts. */
export const pspAppendEvidence = (invoker: ScopedRoutineInvoker, input: PspAppendEvidenceInput) =>
  invoker
    .invoke(appendEvidenceRoutine, [
      input.operationId,
      input.bindingId,
      input.evidenceOrigin,
      input.factKind,
      input.factFamily,
      input.providerRefs,
      Option.getOrNull(input.observedAmountMinor.pipe(Option.map(String))),
      input.sourceOccurrenceId,
      String(input.sourceRevision),
      Option.getOrNull(input.providerOccurredAt.pipe(Option.map((instant) => DateTime.toDateUtc(instant)))),
      Option.getOrNull(input.economicEffectKey),
      Option.getOrNull(input.discrepancy),
      Option.getOrNull(input.reason),
      Option.getOrNull(input.notificationId),
      ...originValues(input.origin),
    ])
    .pipe(Effect.flatMap(decodeOne(appendEvidenceRoutine.routineKey, PspAppendEvidenceResultSchema)));

export const pspListPendingEvidence = (invoker: ScopedRoutineInvoker, operationId: string) =>
  invoker
    .invoke(listPendingEvidenceRoutine, [operationId])
    .pipe(Effect.flatMap(decodeAll(listPendingEvidenceRoutine.routineKey, PspEvidenceRecordSchema)));

/** Records the one governed submission outcome of a pending evidence row. */
export const pspMarkEvidenceSubmission = (
  invoker: ScopedRoutineInvoker,
  input: {
    readonly deliveryId: string;
    readonly evidenceId: PspEvidenceId;
    readonly observationId: Option.Option<string>;
    readonly state: Exclude<ProviderEvidenceSubmissionState, 'PENDING_SUBMISSION'>;
  },
) =>
  invoker
    .invoke(markEvidenceSubmissionRoutine, [
      input.evidenceId,
      input.state,
      Option.getOrNull(input.observationId),
      input.deliveryId,
    ])
    .pipe(Effect.flatMap(decodeOne(markEvidenceSubmissionRoutine.routineKey, PspMarkEvidenceResultSchema)));

export const pspReadNotification = (invoker: ScopedRoutineInvoker, notificationId: PspNotificationId) =>
  invoker
    .invoke(readNotificationRoutine, [notificationId])
    .pipe(Effect.flatMap(decodeOptional(readNotificationRoutine.routineKey, PspNotificationRecordSchema)));

/** Advances a captured notification's processing state. */
export const pspTransitionNotification = (
  invoker: ScopedRoutineInvoker,
  input: {
    readonly correlatedOperationId: Option.Option<string>;
    readonly deliveryId: string;
    readonly notificationId: PspNotificationId;
    readonly to: Exclude<ProviderNotificationState, 'CAPTURED' | 'IGNORED'>;
  },
) =>
  invoker
    .invoke(transitionNotificationRoutine, [
      input.notificationId,
      input.to,
      Option.getOrNull(input.correlatedOperationId),
      input.deliveryId,
    ])
    .pipe(Effect.flatMap(decodeOne(transitionNotificationRoutine.routineKey, PspTransitionNotificationResultSchema)));
