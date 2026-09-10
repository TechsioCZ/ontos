import { Schema } from 'effect';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';
import { RetailCustomerProfileRefSchema } from '../resources/retail-customer-profile.ts';
import { CounterpartyRefSchema } from './access-contract.ts';
import {
  CustomerHistorySubjectSchema,
  CustomerRecordVisibilityGrantSchema,
  HistoryInstantJsonSchema,
  HistoricalRecordRefSchema,
} from './record-visibility-contracts.ts';

const NonEmptyTextSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
export const HistoryOwnerModuleIdSchema = Schema.toEncoded(
  NonEmptyTextSchema.pipe(Schema.brand('HistoryOwnerModuleId')),
);
const HistoryPrincipalIdSchema = Schema.toEncoded(
  NonEmptyTextSchema.pipe(Schema.brand('HistoryPrincipalId')),
);
const QuantitySchema = Schema.String.check(
  Schema.isPattern(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u),
  Schema.isMaxLength(80),
);

export const CurrentGateStateSchema = Schema.Literals(['CURRENT', 'ABSENT', 'INDETERMINATE']);
export type CurrentGateState = typeof CurrentGateStateSchema.Type;
export const BusinessPolicyStateSchema = Schema.Literals(['ALLOWED', 'DENIED', 'INDETERMINATE']);
export type BusinessPolicyState = typeof BusinessPolicyStateSchema.Type;

export const HistoryFreshnessSchema = Schema.Struct({
  observedAt: HistoryInstantJsonSchema,
  sourceRevision: NonEmptyTextSchema,
  status: Schema.Literals(['CURRENT', 'STALE']),
});
export type HistoryFreshness = typeof HistoryFreshnessSchema.Type;

export const HistoryDegradationSchema = Schema.Struct({
  code: Schema.Literals([
    'ONBOARDING_UNAVAILABLE',
    'SOURCE_STALE',
    'SOURCE_UNAVAILABLE',
    'VISIBILITY_UNAVAILABLE',
  ]),
  ownerModuleId: HistoryOwnerModuleIdSchema,
  retryable: Schema.Boolean,
});
export type HistoryDegradation = typeof HistoryDegradationSchema.Type;

export const CustomerOrderHistoryItemSchema = Schema.Struct({
  acceptedAt: HistoryInstantJsonSchema,
  displayLabel: NonEmptyTextSchema,
  freshness: HistoryFreshnessSchema,
  orderRef: HistoricalRecordRefSchema,
  visibility: CustomerRecordVisibilityGrantSchema,
});
export type CustomerOrderHistoryItem = typeof CustomerOrderHistoryItemSchema.Type;

export const CustomerFacingHistoricalFieldValueSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('BOOLEAN'), value: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal('DECIMAL'), value: NonEmptyTextSchema }),
  Schema.Struct({ kind: Schema.Literal('INSTANT'), value: HistoryInstantJsonSchema }),
  Schema.Struct({ kind: Schema.Literal('REFERENCE'), value: HistoricalRecordRefSchema }),
  Schema.Struct({ kind: Schema.Literal('TEXT'), value: Schema.String }),
]);
export type CustomerFacingHistoricalFieldValue =
  typeof CustomerFacingHistoricalFieldValueSchema.Type;

export const CustomerFacingHistoricalFieldSchema = Schema.Struct({
  fieldName: NonEmptyTextSchema,
  ownerModuleId: HistoryOwnerModuleIdSchema,
  sourceRevision: NonEmptyTextSchema,
  value: CustomerFacingHistoricalFieldValueSchema,
  visibility: CustomerRecordVisibilityGrantSchema,
});
export type CustomerFacingHistoricalField = typeof CustomerFacingHistoricalFieldSchema.Type;

export const CustomerOrderHistoryDetailSchema = Schema.Struct({
  acceptedAt: HistoryInstantJsonSchema,
  fields: Schema.Array(CustomerFacingHistoricalFieldSchema),
  freshness: HistoryFreshnessSchema,
  orderRef: HistoricalRecordRefSchema,
  visibility: CustomerRecordVisibilityGrantSchema,
});
export type CustomerOrderHistoryDetail = typeof CustomerOrderHistoryDetailSchema.Type;

export const RetailOrderHistoryDetailInputSchema = Schema.Struct({
  now: HistoryInstantJsonSchema,
  orderRef: HistoricalRecordRefSchema,
  principalId: HistoryPrincipalIdSchema,
  profileRef: RetailCustomerProfileRefSchema,
});
export type RetailOrderHistoryDetailInput = typeof RetailOrderHistoryDetailInputSchema.Type;

export const CounterpartyOrderHistoryDetailInputSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  now: HistoryInstantJsonSchema,
  orderRef: HistoricalRecordRefSchema,
  principalId: HistoryPrincipalIdSchema,
  profileRef: CounterpartyPurchasingProfileRefSchema,
});
export type CounterpartyOrderHistoryDetailInput =
  typeof CounterpartyOrderHistoryDetailInputSchema.Type;

export const RetailOrderHistoryInputSchema = Schema.Struct({
  now: HistoryInstantJsonSchema,
  principalId: HistoryPrincipalIdSchema,
  profileRef: RetailCustomerProfileRefSchema,
});
export type RetailOrderHistoryInput = typeof RetailOrderHistoryInputSchema.Type;

export const RetailOrderHistoryResultSchema = Schema.Struct({
  degradations: Schema.Array(HistoryDegradationSchema),
  items: Schema.Array(CustomerOrderHistoryItemSchema),
  profileRef: RetailCustomerProfileRefSchema,
});
export type RetailOrderHistoryResult = typeof RetailOrderHistoryResultSchema.Type;

export const CounterpartyHistoryScopeSchema = Schema.Literals([
  'OWN_ORDERS',
  'ALL_COUNTERPARTY_ORDERS',
]);
export type CounterpartyHistoryScope = typeof CounterpartyHistoryScopeSchema.Type;

export const CounterpartyOrderHistoryInputSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  now: HistoryInstantJsonSchema,
  principalId: HistoryPrincipalIdSchema,
  profileRef: CounterpartyPurchasingProfileRefSchema,
});
export type CounterpartyOrderHistoryInput = typeof CounterpartyOrderHistoryInputSchema.Type;

export const CounterpartyOrderHistoryResultSchema = Schema.Struct({
  degradations: Schema.Array(HistoryDegradationSchema),
  items: Schema.Array(CustomerOrderHistoryItemSchema),
  profileRef: CounterpartyPurchasingProfileRefSchema,
  scope: CounterpartyHistoryScopeSchema,
});
export type CounterpartyOrderHistoryResult = typeof CounterpartyOrderHistoryResultSchema.Type;

export const CustomerArchiveRecordKindSchema = Schema.Literals([
  'ORDER',
  'BILLING_DOCUMENT',
  'CLAIM',
]);
export type CustomerArchiveRecordKind = typeof CustomerArchiveRecordKindSchema.Type;

export const CustomerArchiveItemSchema = Schema.Struct({
  displayLabel: NonEmptyTextSchema,
  freshness: HistoryFreshnessSchema,
  occurredAt: HistoryInstantJsonSchema,
  recordKind: CustomerArchiveRecordKindSchema,
  recordRef: HistoricalRecordRefSchema,
  visibility: CustomerRecordVisibilityGrantSchema,
});
export type CustomerArchiveItem = typeof CustomerArchiveItemSchema.Type;

export const CustomerArchiveInputSchema = Schema.Struct({
  now: HistoryInstantJsonSchema,
  principalId: HistoryPrincipalIdSchema,
  subject: CustomerHistorySubjectSchema,
});
export type CustomerArchiveInput = typeof CustomerArchiveInputSchema.Type;

export const CustomerArchiveResultSchema = Schema.Struct({
  degradations: Schema.Array(HistoryDegradationSchema),
  items: Schema.Array(CustomerArchiveItemSchema),
  subject: CustomerHistorySubjectSchema,
});
export type CustomerArchiveResult = typeof CustomerArchiveResultSchema.Type;

export const HistoricalOrderLineIntentSchema = Schema.Struct({
  configurationRef: Schema.optionalKey(NonEmptyTextSchema),
  productRef: NonEmptyTextSchema,
  requestedQuantity: QuantitySchema,
  sourceLineRef: NonEmptyTextSchema,
});
export type HistoricalOrderLineIntent = typeof HistoricalOrderLineIntentSchema.Type;

export const RepeatOrderLineResultSchema = Schema.Union([
  Schema.Struct({
    currentProductRef: NonEmptyTextSchema,
    requestedQuantity: QuantitySchema,
    sourceLineRef: NonEmptyTextSchema,
    status: Schema.Literal('REPEATABLE'),
  }),
  Schema.Struct({
    reason: Schema.Literals([
      'CONFIGURATION_CHANGED',
      'QUANTITY_RULE_CONFLICT',
      'CURRENT_SELECTION_REQUIRED',
    ]),
    requestedQuantity: QuantitySchema,
    sourceLineRef: NonEmptyTextSchema,
    status: Schema.Literal('REQUIRES_EXPLICIT_CHANGE'),
  }),
  Schema.Struct({
    reason: Schema.Literals([
      'ASSORTMENT_NOT_ALLOWED',
      'CURRENT_RULE_UNAVAILABLE',
      'PRODUCT_NOT_FOUND',
      'PRODUCT_NOT_SELLABLE',
    ]),
    requestedQuantity: QuantitySchema,
    sourceLineRef: NonEmptyTextSchema,
    status: Schema.Literal('SKIPPED'),
  }),
]);
export type RepeatOrderLineResult = typeof RepeatOrderLineResultSchema.Type;

export const RepeatOrderPreparationInputSchema = Schema.Struct({
  now: HistoryInstantJsonSchema,
  orderRef: HistoricalRecordRefSchema,
  principalId: HistoryPrincipalIdSchema,
  subject: CustomerHistorySubjectSchema,
});
export type RepeatOrderPreparationInput = typeof RepeatOrderPreparationInputSchema.Type;

export const RepeatOrderPreparationResultSchema = Schema.Struct({
  lines: Schema.Array(RepeatOrderLineResultSchema),
  outcome: Schema.Literals(['PREPARED', 'NO_REPEATABLE_LINES']),
  sourceOrderRef: HistoricalRecordRefSchema,
});
export type RepeatOrderPreparationResult = typeof RepeatOrderPreparationResultSchema.Type;
