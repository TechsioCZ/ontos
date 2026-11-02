import { QuotationExpiredResponseSchema } from '@app/pricing-contracts/quotation-verification';
import { ConfigProvider, Layer, Schema } from 'effect';
import type { Effect, Option } from 'effect';

import { OrderCommitmentRejected } from '../../shared/domain/order-commitment.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/commerce-order-finalization-work.ts';
import { ApprovalOwnerGateway } from '../../src/services/approval-owner-gateway.ts';
import { OrderFinalSourceVerification } from '../../src/services/order-final-source-verification.service.ts';
import { OrderFinalizationWorkerLive } from '../../src/services/order-finalization-worker.service.ts';
import { orderLegalEntityId, orderTenantId } from './order-revalidation-work.ts';

const quotationRef = 'quotation:expired';

export const orderPreparationPayload = Schema.decodeUnknownSync(OutboxPayloadSchema)({
  intentRef: {
    moduleId: 'commerce.order',
    resourceId: 'preparation:original',
    resourceType: 'commerce.order.finalization-intent',
    tenantId: orderTenantId,
  },
  legalEntityId: orderLegalEntityId,
  stage: 'PREPARE',
});

/** The owner work read for a still-pending preparation; only the selectors the worker inspects. */
export const pendingOrderPreparationWork = {
  evidence: { operation: 'LOAD_PROPOSAL' },
  input: { quotationRef },
  intentRef: orderPreparationPayload.intentRef,
  stage: 'PREPARE',
  status: 'PENDING',
  work: {
    buyerPrincipalId: '20000000-0000-4000-8000-000000000001',
    correlationId: 'commitment-correlation',
    legalEntityId: orderLegalEntityId,
    tenantId: orderTenantId,
  },
} as const;
export const failedOrderPreparationWork = {
  intentRef: orderPreparationPayload.intentRef,
  stage: 'PREPARE',
  status: 'FAILED',
} as const;
/** What the worker's owner read observes after a completion attempt. */
export type OrderPreparationWorkObservation = typeof failedOrderPreparationWork | typeof pendingOrderPreparationWork;

/** Pricing's authenticated expiry of the exact retained Quotation, as decoded from its public read. */
export const expiredOrderQuotation = Schema.decodeUnknownSync(QuotationExpiredResponseSchema)({
  authenticityEvidence: {
    authenticityRef: 'pricing:quotation-proof:unit',
    authority: 'EVIDENCE_ONLY',
    issuerRef: 'commerce.pricing',
    keyRef: 'pricing-key',
    keyStatus: 'ACTIVE',
    keyVersion: '1',
    lineageRef: 'pricing-lineage',
    payloadDigest: 'b'.repeat(64),
    proofVersion: '1',
    quotationRef,
    verifiedAt: '2026-10-29T12:00:01.000Z',
  },
  expired: {
    _tag: 'EXPIRED',
    evaluatedAt: '2026-10-29T12:00:01.000Z',
    quotationRef,
    validity: {
      policyEvidence: { maximumValidityDurationMilliseconds: 3_600_000, policyRef: 'policy', policyVersion: '1' },
      validFrom: '2026-10-29T11:00:00.000Z',
      validUntil: '2026-10-29T12:00:00.000Z',
    },
  },
  outcome: 'QUOTATION_EXPIRED',
});

export const pricingTransportFailure = () =>
  new OrderCommitmentRejected({ code: 'order_commitment_unavailable', reason: 'Pricing transport failed' });

/**
 * The registered Order worker with only its foreign source verification replaced. Preparation
 * never reaches the approval owner, so that mock has no members.
 */
export const orderPreparationWorkerLayer = (
  prepare: () => Effect.Effect<typeof expiredOrderQuotation, OrderCommitmentRejected>,
) =>
  OrderFinalizationWorkerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ApprovalOwnerGateway, {}),
        Layer.mock(OrderFinalSourceVerification, { prepare }),
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ONTOS_ORDER_API_BASE_URL: 'https://order.unit.invalid',
            ONTOS_ORDER_FINALIZATION_GATEWAY_API_KEY: 'unit-api-key',
            ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.unit.invalid',
          }),
        ),
      ),
    ),
  );

export const orderProofPayload = Schema.decodeUnknownSync(OutboxPayloadSchema)({
  intentRef: {
    moduleId: 'commerce.order',
    resourceId: 'proof:original',
    resourceType: 'commerce.order.proof-request',
    tenantId: orderTenantId,
  },
  legalEntityId: orderLegalEntityId,
  stage: 'PROOF',
});
/** Pending proof work whose Bundle retained the Quotation interval of `expiredOrderQuotation`. */
export const pendingOrderProofWork = {
  approvalIdempotencyKey: 'approval:original',
  intentRef: orderProofPayload.intentRef,
  pricingIdempotencyKey: 'pricing:proof:original',
  stage: 'PROOF',
  state: { bundle: { finalization: { pricing: { quotation: { validity: expiredOrderQuotation.expired.validity } } } } },
  status: 'PENDING',
  work: pendingOrderPreparationWork.work,
} as const;
export const failedOrderProofWork = {
  intentRef: orderProofPayload.intentRef,
  stage: 'PROOF',
  status: 'FAILED',
} as const;

/** The registered worker for proof work; only the Quotation expiry read and approval owner are replaced. */
export const orderProofWorkerLayer = (
  readRetainedQuotationExpiry: () => Effect.Effect<
    Option.Option<typeof expiredOrderQuotation>,
    OrderCommitmentRejected
  >,
  revalidateOutcome: () => Effect.Effect<never, OrderCommitmentRejected>,
) =>
  OrderFinalizationWorkerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ApprovalOwnerGateway, { revalidateOutcome }),
        Layer.mock(OrderFinalSourceVerification, { readRetainedQuotationExpiry }),
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ONTOS_ORDER_API_BASE_URL: 'https://order.unit.invalid',
            ONTOS_ORDER_FINALIZATION_GATEWAY_API_KEY: 'unit-api-key',
            ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.unit.invalid',
          }),
        ),
      ),
    ),
  );
