import type { CommunicationRequest } from '@app/communications-contracts/communication-request';
import { Effect, Schema } from 'effect';

import { CommunicationDecisionRequestSchema } from '../catalog/decision-request.ts';
import type { CommunicationDecisionRequest } from '../catalog/decision-request.ts';
import { OriginalRecipientBindingSchema, RecipientScopeSchema } from '../recipient/original-binding.ts';
import type { OriginalRecipientBinding, RecipientScope } from '../recipient/original-binding.ts';
import { encodedRequestOf } from './identity.ts';

/**
 * Maps the PUBLISHED request (`@app/communications-contracts`) onto what the domain decides over. The contract and the
 * domain keep separate schemas, so the mapping does not trust that they agree: every part goes through the domain's own
 * schema, with unknown fields refused. A published request the domain's schemas do not accept is a contract defect, not
 * caller input, so it surfaces as a defect instead of being decided half understood.
 */
export interface IntakeInput {
  readonly bindings: readonly OriginalRecipientBinding[];
  readonly decisionRequest: CommunicationDecisionRequest;
  readonly request: CommunicationRequest;
  readonly scope: RecipientScope;
}

const strict = { onExcessProperty: 'error' } as const;
const IntakeParts = Schema.Struct({
  bindings: Schema.Array(OriginalRecipientBindingSchema),
  decisionRequest: CommunicationDecisionRequestSchema,
  scope: RecipientScopeSchema,
});

export const decodeIntakeInput = Effect.fn('Communications.decodeIntakeInput')(function* decodeInput(
  request: CommunicationRequest,
) {
  const encoded = yield* encodedRequestOf(request);
  const parts = yield* Schema.decodeUnknownEffect(
    IntakeParts,
    strict,
  )({
    bindings: encoded.originalRecipients,
    decisionRequest: {
      occurrence: encoded.occurrence,
      purpose: encoded.purpose,
      source: encoded.source,
      tenantId: encoded.scope.tenantId,
    },
    scope: encoded.scope,
  }).pipe(Effect.orDie);
  return { ...parts, request } satisfies IntakeInput;
});
