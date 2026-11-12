import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';

import {
  RequestPaymentOperationRecoveryPayloadSchema,
  RequestPaymentOperationRecoveryResultSchema,
} from './actions/request-payment-operation-recovery.ts';
import { PaymentTenantIdSchema } from './domain/payment-identifiers.ts';
import { ProviderBindingRouteKeySchema } from './apis/provider-binding-route.ts';

/**
 * Payment gateway relay contract (#1157, phase 2 D-P4/D-P5). Shell serves both relay groups; Payment owns
 * the wire shapes. Nothing here is a generic webhook: every endpoint has one exact family, path, body
 * media type and size limit, and nothing names a Legal Entity, binding, provider family of record or
 * account. Those come only from the provider binding route Read.
 *
 * - Notifications face the PSPs. A PSP cannot present an OntOS credential, so the path carries the Tenant
 *   (it selects the relay credential) and the opaque binding route key. The body is relayed as exact
 *   bytes; authenticity is the provider's signature, secret or status inquiry, decided by capture. Shell
 *   assembles that group itself because its raw-byte and text encodings are transport annotations.
 * - `paymentReconciliation` is called by the Payment reconciliation driver with its integration API key.
 */

/** Every path either relay group serves lies below this prefix; Shell answers the rest with a typed 404/405. */
export const PAYMENT_GATEWAY_RELAY_PATH_PREFIX = '/api/payment/v1';

/**
 * Largest notification body the relay accepts: exactly `CAPTURED_NOTIFICATION_MAXIMUM_BYTES` (64 KiB),
 * what capture stores. The cross-owner contract boundary admits no import of that action module, so the
 * value is restated here and a Shell relay test pins the two together.
 */
export const PAYMENT_NOTIFICATION_MAXIMUM_BYTES = 65_536;

/** `{tenantId}/{routeKey}` path of every notification endpoint. */
export const PaymentNotificationParamsSchema = Schema.Struct({
  routeKey: ProviderBindingRouteKeySchema,
  tenantId: PaymentTenantIdSchema,
});

const headerText = Schema.String.check(Schema.isMaxLength(2000));
const queryText = Schema.String.check(Schema.isMaxLength(200));

/** GoPay sends `id` and, for recurring payments, `parent_id`. Extra provider parameters are ignored, never refused. */
export const GopayNotificationQuerySchema = Schema.Struct({
  id: Schema.optionalKey(queryText),
  parent_id: Schema.optionalKey(queryText),
});
/** Only the headers capture keeps; every other provider header is ignored. */
export const StripeNotificationHeadersSchema = Schema.Struct({
  'content-type': Schema.optionalKey(headerText),
  'stripe-signature': Schema.optionalKey(headerText),
});
export const ComgateNotificationHeadersSchema = Schema.Struct({
  'content-type': Schema.optionalKey(headerText),
});

/** GoPay and Stripe require exactly 200; the `text/plain` body is informational. */
export const PAYMENT_NOTIFICATION_ACKNOWLEDGED = 'OK';
/** Comgate expects a 2xx carrying `code=0`; the form-encoded reply mirrors its documented example. */
export const COMGATE_NOTIFICATION_ACKNOWLEDGED = 'code=0&message=OK';

/** REJECTED capture and every request that does not match its endpoint contract. */
export const PaymentNotificationInvalidProblemSchema = makeProblemDetailsSchema(
  'PaymentNotificationInvalidProblem',
  400,
);
/** Unknown Tenant credential, unknown route, other family or other Tenant: indistinguishable by design. */
export const PaymentNotificationNotFoundProblemSchema = makeProblemDetailsSchema(
  'PaymentNotificationNotFoundProblem',
  404,
);
/** Anything OntOS did not durably record: the PSP retries and capture deduplicates. */
export const PaymentNotificationUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'PaymentNotificationUnavailableProblem',
  503,
);

/** Integration API key of the reconciliation principal; verified fresh on every request. */
export const PaymentReconciliationApiKeySchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2000),
).pipe(Schema.brand('PaymentReconciliationApiKey'));
/** Caller idempotency key: 1 to 200 printable ASCII characters without spaces. */
export const PaymentReconciliationIdempotencyKeySchema = Schema.String.check(Schema.isPattern(/^[!-~]{1,200}$/u)).pipe(
  Schema.brand('PaymentReconciliationIdempotencyKey'),
);

const PaymentReconciliationHeadersSchema = Schema.Struct({
  'idempotency-key': PaymentReconciliationIdempotencyKeySchema,
  'x-api-key': PaymentReconciliationApiKeySchema,
});

/** A10 payload without `requestedMode`: the driver never weakens or chooses a recovery mode. */
export const PaymentReconciliationRecoveryPayloadSchema = Schema.Struct({
  operationId: RequestPaymentOperationRecoveryPayloadSchema.fields.operationId,
  paymentId: RequestPaymentOperationRecoveryPayloadSchema.fields.paymentId,
  reason: RequestPaymentOperationRecoveryPayloadSchema.fields.reason,
  trigger: RequestPaymentOperationRecoveryPayloadSchema.fields.trigger,
});
export type PaymentReconciliationRecoveryPayload = typeof PaymentReconciliationRecoveryPayloadSchema.Type;

export const PaymentReconciliationAuthenticationProblemSchema = makeProblemDetailsSchema(
  'PaymentReconciliationAuthenticationProblem',
  401,
);
export const PaymentReconciliationForbiddenProblemSchema = makeProblemDetailsSchema(
  'PaymentReconciliationForbiddenProblem',
  403,
);
/** Unknown route key, or a route of another Tenant or binding: indistinguishable by design. */
export const PaymentReconciliationNotFoundProblemSchema = makeProblemDetailsSchema(
  'PaymentReconciliationNotFoundProblem',
  404,
);
/**
 * A10 refusal codes the relay passes through unchanged. The cross-owner contract boundary admits no import
 * of the generated A10 Action contract, so the codes are restated here and a Shell relay test pins them to
 * `RequestPaymentOperationRecoveryAction{Conflict,AlreadyCommitted,Ineligible}ProblemSchema`.
 */
export const PAYMENT_RECONCILIATION_CONFLICT_CODES = [
  'action_already_committed',
  'action_request_hash_conflict',
  'action_invocation_state_invalid',
  'payment_aggregate_version_conflict',
  'payment_collect_lineage_conflict',
  'payment_held_for_reconciliation',
  'payment_identity_conflict',
  'payment_intent_material_conflict',
  'payment_operation_material_conflict',
  'payment_refund_item_reserved',
  'payment_refundable_funds_exceeded',
  'payment_reconciliation_case_already_closed',
  'payment_reconciliation_case_revision_conflict',
  'payment_recovery_operation_already_resolved',
] as const;
export const PAYMENT_RECONCILIATION_INELIGIBLE_CODES = [
  'action_policy_denied',
  'payment_reconciliation_decision_not_applicable',
  'payment_reconciliation_evidence_not_qualified',
  'payment_reconciliation_obligation_unresolved',
  'payment_amount_invalid',
  'payment_currency_mismatch',
  'payment_method_binding_mismatch',
  'payment_no_established_collection',
  'payment_outcome_transition_illegal',
  'payment_refund_amount_mismatch',
  'payment_refund_basis_invalid',
  'payment_refund_item_fractioned',
] as const;

/** A10 conflict refusals (resolved, held, hash conflict, already committed, ...) with their A10 code. */
export const PaymentReconciliationConflictProblemSchema = makeProblemDetailsSchema(
  'PaymentReconciliationConflictProblem',
  409,
  { code: Schema.Literals(PAYMENT_RECONCILIATION_CONFLICT_CODES) },
);
/** A10 ineligibility refusals with their A10 code; a request outside this contract is `request_invalid`. */
export const PaymentReconciliationIneligibleProblemSchema = makeProblemDetailsSchema(
  'PaymentReconciliationIneligibleProblem',
  422,
  { code: Schema.Literals([...PAYMENT_RECONCILIATION_INELIGIBLE_CODES, 'request_invalid']) },
);
/** Everything else, including an indeterminate A10 commit: the driver retries in a later round only. */
export const PaymentReconciliationUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'PaymentReconciliationUnavailableProblem',
  503,
);

const recoveryEndpoint = HttpApiEndpoint.post(
  'requestRecovery',
  '/api/payment/v1/reconciliation/:routeKey/recoveries',
  {
    error: [
      PaymentReconciliationAuthenticationProblemSchema,
      PaymentReconciliationForbiddenProblemSchema,
      PaymentReconciliationNotFoundProblemSchema,
      PaymentReconciliationConflictProblemSchema,
      PaymentReconciliationIneligibleProblemSchema,
      PaymentReconciliationUnavailableProblemSchema,
    ],
    headers: PaymentReconciliationHeadersSchema,
    params: Schema.Struct({ routeKey: ProviderBindingRouteKeySchema }),
    payload: PaymentReconciliationRecoveryPayloadSchema,
    success: RequestPaymentOperationRecoveryResultSchema,
  },
);

/**
 * Reconciliation driver ingress: one route-scoped A10 call per request, never a provider call. Shell
 * attaches its boundary middleware, which maps schema failures to the 422 `request_invalid` and defects
 * to the 503.
 */
export const PaymentReconciliationGroup = HttpApiGroup.make('paymentReconciliation')
  .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: 'error' })
  .add(recoveryEndpoint);
