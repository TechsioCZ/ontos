import { defineScopedRoutine } from '@app/core-runtime';
import { Schema } from 'effect';

/** The governed service reader injects the admitted Order principal and verifies Cart authority. */
export const readOrderServiceApprovalProofRoutine = defineScopedRoutine({
  name: 'read_order_service_approval_proof',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({ result: Schema.Json }),
  routineKey: 'purchasing-approval.read-order-service-proof',
  schema: 'commerce_customer_context',
});
