// Canonical schema-only contract for the claim-guest-order Action.
import {
  ClaimGuestOrderPayloadSchema as HistoryClaimGuestOrderPayloadSchema,
  ClaimGuestOrderResultSchema as HistoryClaimGuestOrderResultSchema,
} from '../domain/history-action-contracts.ts';

export const ClaimGuestOrderPayloadSchema = HistoryClaimGuestOrderPayloadSchema;
export type ClaimGuestOrderPayload = typeof ClaimGuestOrderPayloadSchema.Type;

export const ClaimGuestOrderResultSchema = HistoryClaimGuestOrderResultSchema;
export type ClaimGuestOrderResult = typeof ClaimGuestOrderResultSchema.Type;
