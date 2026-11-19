import type { CommunicationRequest } from '@app/communications-contracts/communication-request';
import type { Option } from 'effect';

import type {
  CommunicationDecisionIdSchema,
  CommunicationRequestIdSchema,
  MessageIntentIdSchema,
  MessageIntentStatus,
} from '../../../shared/communication-intake.ts';

import type { CommunicationDecision, MessageIntentIdentity } from '../catalog/decision.ts';
import { resourceRefKey } from '../catalog/vocabulary.ts';
import type { CommunicationResourceRef, RecipientRole } from '../catalog/vocabulary.ts';
import type { LanguageDecision, LanguagePolicySnapshot } from '../language/vocabulary.ts';
import type { ProcessingScope } from '../privacy/processing-scope.ts';
import type { OriginalRecipientBinding } from '../recipient/original-binding.ts';
import type { HandoffPin } from '../recipient/recheck-before-handoff.ts';

/**
 * The durable shape of one decided request, before it is written. Everything here is a PIN: what the decision saw and
 * chose at its own time. Nothing in it is looked up again by a retry, so a later catalog revision, tenant default,
 * template activation or contact change cannot reinterpret it (I-05, I-06).
 */

/**
 * The minimum of the original endpoint that may be stored: its channel, the owner's contact reference and revision,
 * and the owner's already-safe mask. The address itself is NEVER stored. The owner holds it, the last stoppable
 * handoff asks the owner again for exactly this contact (`recheckBeforeHandoff`) and receives the usable address only
 * as a `Redacted` value held in memory for that one call. So no copy of an address can age, leak into history or be
 * mistaken for the Current contact, and the pinned contact reference proves WHICH endpoint was meant.
 */
export interface EndpointPin {
  readonly channel: string;
  readonly contactRef: CommunicationResourceRef;
  readonly contactRevision?: number;
  readonly mask: string;
}

export type IntentStatus = MessageIntentStatus;

export interface IntentPlan {
  readonly binding: OriginalRecipientBinding;
  readonly endpoint: Option.Option<EndpointPin>;
  readonly handoffPin: HandoffPin;
  readonly identity: MessageIntentIdentity;
  readonly intentId: typeof MessageIntentIdSchema.Type;
  readonly intentKey: string;
  readonly language: Option.Option<LanguageDecision>;
  readonly purpose: string;
  readonly reason: Option.Option<string>;
  readonly role: RecipientRole;
  readonly scope: Option.Option<ProcessingScope>;
  readonly status: IntentStatus;
}

export interface DecisionPlan {
  readonly decision: CommunicationDecision;
  readonly decisionId: typeof CommunicationDecisionIdSchema.Type;
  readonly intents: readonly IntentPlan[];
  /** The Tenant language mode the decision used, read once for every intent of the request; none when no intent needed it. */
  readonly languagePolicy: Option.Option<LanguagePolicySnapshot>;
  readonly request: CommunicationRequest;
  readonly requestId: typeof CommunicationRequestIdSchema.Type;
}

const lengthPrefixed = (parts: readonly string[]) => parts.map((part) => `${String(part.length)}:${part}`).join('|');

/** The identity text of one Message Intent: exactly the catalog's candidate identity, with the full recipient reference. */
export const intentKeyOf = (identity: MessageIntentIdentity) =>
  lengthPrefixed([
    identity.tenantId,
    identity.sourceModule,
    identity.occurrenceId,
    String(identity.revision),
    identity.typeId,
    identity.slotKey,
    resourceRefKey(identity.recipient),
  ]);
