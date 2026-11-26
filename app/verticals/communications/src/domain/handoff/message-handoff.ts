import type { MessageHandoffOutcomeSchema } from '@app/communications-contracts/message-handoff';
import { Context, Effect, Layer } from 'effect';

import type { DeliveryAttemptIdSchema, MessageIntentIdSchema } from '../../../shared/communication-intake.ts';
import type { TemplatePin } from '../../../shared/template-revision.ts';
import type { CommunicationResourceRef } from '../catalog/vocabulary.ts';
import type { PinnedDocument } from '../documents/document-pin.ts';
import type { SupportedLanguage } from '../language/vocabulary.ts';
import type { ProtectedEndpoint } from '../recipient/original-binding.ts';

/**
 * The handoff port toward the Messaging Adapter (step 22, D-E). It receives ONLY a pinned intent that has just passed
 * every Current gate, and returns provider evidence bound to exactly that tenant, intent and attempt. Step 22 owns the
 * provider, the rendering, the callbacks and the reconciliation transport; it never creates a business intent.
 *
 * Nothing here claims inbox delivery: `ACCEPTED` means the provider accepted the submission and nothing more.
 */

/** What step 22 is given. Every field is a pin the decision stored or a fact the gates just proved; nothing is looked up. */
export interface PinnedHandoff {
  /** Identity of THIS single attempt; the provider idempotency key derives from it, never from the intent alone. */
  readonly attemptId: typeof DeliveryAttemptIdSchema.Type;
  /**
   * The documents the message carries, each as its form and the EXACT pinned Core Media Asset (#1409): references only, never a
   * URL or bytes. Absent for a message without documents. The adapter asks the owner for the content at its own time.
   */
  readonly documents?: readonly PinnedDocument[];
  /** The ORIGINAL endpoint as its owner just handed it over for this call: protected, never stored, never logged. */
  readonly endpoint: ProtectedEndpoint;
  readonly intentId: typeof MessageIntentIdSchema.Type;
  readonly language: SupportedLanguage;
  readonly purpose: string;
  readonly recipientRef: CommunicationResourceRef;
  /** The exact template revision pinned at the decision. The adapter renders this revision and no other. */
  readonly template: TemplatePin;
  readonly tenantId: string;
}

/**
 * The provider's answer, as the PUBLISHED handoff contract (`@app/communications-contracts/message-handoff`) defines it: the
 * reasons are the closed literals of `@app/email-delivery` (a unit test keeps the two from drifting), plus two cases the provider
 * never produces: `NOT_ATTEMPTED`, for a deployment that has no adapter wired, and `MESSAGE_INVALID`, which the adapter may state
 * only with the proof that it never asked the provider. The meaning of each case is documented on the contract.
 */
export type ProviderEvidenceCase = typeof MessageHandoffOutcomeSchema.Encoded;

/** The evidence of one attempt, bound to the identities it was asked for so a mixed-up answer is recognized. */
export interface ProviderEvidence {
  readonly attemptId: typeof DeliveryAttemptIdSchema.Type;
  readonly intentId: typeof MessageIntentIdSchema.Type;
  readonly outcome: ProviderEvidenceCase;
  readonly tenantId: string;
}

/**
 * A single submission attempt; it never fails with an expected error, because every provider answer is data. A defect
 * or a missing answer after the call began is treated by the caller as INDETERMINATE: an effect may exist.
 */
export interface MessageHandoffService {
  readonly handoff: (message: PinnedHandoff) => Effect.Effect<ProviderEvidence>;
}

export class MessageHandoff extends Context.Service<MessageHandoff, MessageHandoffService>()(
  '@app/communications/domain/handoff/message-handoff/MessageHandoff',
) {}

/**
 * The only production composition today. Step 22 provides the Messaging Adapter; until it does, every handoff fails
 * closed with honest evidence that nothing was submitted. There is deliberately no Resend or EmailDeliveryService
 * adapter here: that is step 22's decision and its provider, not a convenience of this owner.
 */
export const unavailableMessageHandoffLayer = Layer.succeed(MessageHandoff, {
  handoff: (message) =>
    Effect.succeed({
      attemptId: message.attemptId,
      intentId: message.intentId,
      outcome: { kind: 'NOT_ATTEMPTED', reason: 'NO_ADAPTER_CONFIGURED' },
      tenantId: message.tenantId,
    }),
});
