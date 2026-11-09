import { Schema } from 'effect';

// Placeholder public contract emitted by the foundation; the owning lane replaces both schemas.
export const IssuePaymentAuthorizationPayloadSchema = Schema.Struct({});
export type IssuePaymentAuthorizationPayload = typeof IssuePaymentAuthorizationPayloadSchema.Type;

export const IssuePaymentAuthorizationResultSchema = Schema.Struct({});
export type IssuePaymentAuthorizationResult = typeof IssuePaymentAuthorizationResultSchema.Type;
