import type { CommunicationRequest } from '@app/communications-contracts/communication-request';
import { Effect, Schema } from 'effect';

import { CommunicationDecisionRequestSchema } from '../catalog/decision-request.ts';
import { DocumentReferenceSchema, orderedReferences } from '../documents/document-reference.ts';
import type { DocumentReference } from '../documents/document-reference.ts';
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
  /** The documents the source named, as safe references in their canonical order; none for a request that names none. */
  readonly documents: readonly DocumentReference[];
  readonly request: CommunicationRequest;
  readonly scope: RecipientScope;
}

const strict = { onExcessProperty: 'error' } as const;
const IntakeParts = Schema.Struct({
  bindings: Schema.Array(OriginalRecipientBindingSchema),
  decisionRequest: CommunicationDecisionRequestSchema,
  documents: Schema.Array(DocumentReferenceSchema),
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
      // `validUntil` is the source's stated expiry: it lives on the stored request and the handoff gate, not in the decision's identity
      occurrence: { occurrenceId: encoded.occurrence.occurrenceId, revision: encoded.occurrence.revision },
      purpose: encoded.purpose,
      source: encoded.source,
      tenantId: encoded.scope.tenantId,
    },
    documents: encoded.documents ?? [],
    scope: encoded.scope,
  }).pipe(Effect.orDie);
  return { ...parts, documents: orderedReferences(parts.documents), request } satisfies IntakeInput;
});
