import { Schema } from 'effect';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';
import { RetailCustomerProfileRefSchema } from '../resources/retail-customer-profile.ts';
import { CounterpartyRefSchema } from './access-contract.ts';
import { HistoricalRecordRefSchema } from './record-visibility-contracts.ts';

const NonEmptyTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const ProofIdSchema = NonEmptyTextSchema.pipe(
  Schema.brand('GuestOrderClaimProofId'),
  Schema.decodeTo(Schema.String),
);
const SourceOwnerModuleIdSchema = NonEmptyTextSchema.pipe(
  Schema.brand('HistoryActionSourceOwnerModuleId'),
  Schema.decodeTo(Schema.String),
);
const StorefrontIdSchema = NonEmptyTextSchema.pipe(
  Schema.brand('HistoryActionStorefrontId'),
  Schema.decodeTo(Schema.String),
);
const TargetResourceIdSchema = NonEmptyTextSchema.pipe(
  Schema.brand('HistoryActionTargetResourceId'),
  Schema.decodeTo(Schema.String),
);

export const RepeatRetailOrderPayloadSchema = Schema.Struct({
  profileRef: RetailCustomerProfileRefSchema,
  sourceOrderRef: HistoricalRecordRefSchema,
});
export type RepeatRetailOrderPayload = typeof RepeatRetailOrderPayloadSchema.Type;

export const RepeatCounterpartyOrderPayloadSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  profileRef: CounterpartyPurchasingProfileRefSchema,
  sourceOrderRef: HistoricalRecordRefSchema,
  storefrontId: StorefrontIdSchema,
});
export type RepeatCounterpartyOrderPayload = typeof RepeatCounterpartyOrderPayloadSchema.Type;

export const RepeatOrderActionResultSchema = Schema.Struct({
  cartRef: HistoricalRecordRefSchema,
  lines: Schema.Array(
    Schema.Union([
      Schema.Struct({
        cartLineRef: NonEmptyTextSchema,
        outcome: Schema.Literal('ADDED'),
        sourceLineRef: NonEmptyTextSchema,
      }),
      Schema.Struct({
        cartLineRef: NonEmptyTextSchema,
        changeReason: NonEmptyTextSchema,
        outcome: Schema.Literal('CHANGED'),
        sourceLineRef: NonEmptyTextSchema,
      }),
      Schema.Struct({
        outcome: Schema.Literal('SKIPPED'),
        reason: NonEmptyTextSchema,
        sourceLineRef: NonEmptyTextSchema,
      }),
    ]),
  ),
  outcome: Schema.Literals(['CART_CREATED', 'CART_ALREADY_CREATED']),
  sourceOrderRef: HistoricalRecordRefSchema,
});
export type RepeatOrderActionResult = typeof RepeatOrderActionResultSchema.Type;
export type RepeatOrderCartLineResult = RepeatOrderActionResult['lines'][number];

export const GuestOrderClaimProofSchema = Schema.Struct({
  assurance: Schema.Literal('HIGH'),
  proofId: ProofIdSchema,
});
export type GuestOrderClaimProof = typeof GuestOrderClaimProofSchema.Type;

export const ClaimGuestOrderPayloadSchema = Schema.Struct({
  orderRef: HistoricalRecordRefSchema,
  profileRef: RetailCustomerProfileRefSchema,
  proof: GuestOrderClaimProofSchema,
});
export type ClaimGuestOrderPayload = typeof ClaimGuestOrderPayloadSchema.Type;

export const ClaimGuestOrderResultSchema = Schema.Struct({
  orderRef: HistoricalRecordRefSchema,
  outcome: Schema.Literals(['CLAIMED', 'ALREADY_CLAIMED_EQUIVALENT']),
  profileRef: RetailCustomerProfileRefSchema,
});
export type ClaimGuestOrderResult = typeof ClaimGuestOrderResultSchema.Type;

export const HistoryActionAuditEvidenceSchema = Schema.Struct({
  actionKind: Schema.Literals([
    'CLAIM_GUEST_ORDER',
    'REPEAT_COUNTERPARTY_ORDER',
    'REPEAT_RETAIL_ORDER',
  ]),
  lineCount: Schema.optionalKey(Schema.Int),
  outcome: NonEmptyTextSchema,
  sourceOwnerModuleId: SourceOwnerModuleIdSchema,
  targetResourceId: TargetResourceIdSchema,
});
