import { Context, Data, Effect, Layer } from 'effect';
import type { Duration } from 'effect';

import type { CommunicationDecisionRequest } from '../catalog/decision-request.ts';
import type {
  CommunicationPurposeKey,
  CommunicationResourceRef,
  MessageTypeId,
  RecipientRole,
} from '../catalog/vocabulary.ts';
import { RecipientAuthorityUnavailable } from './current-gate-errors.ts';
import type { OriginalContactBinding, ProtectedEndpoint, RecipientScope } from './original-binding.ts';
import type { GateUnusableReason } from './recipient-assessment.ts';

/**
 * Current gate of the original recipient (#1395, BR-03). Historical validity is not a current delivery permission:
 * before the last stoppable handoff the owners are asked again about the ORIGINAL recipient and endpoint only. The
 * query names the original contact and never offers a Current one, so the gate has no way to be asked about, or to
 * answer with, a replacement contact. Privacy Processing Eligibility is a separate fact (d21-04), not asked here.
 */
export interface RecipientGateQuery {
  readonly contact: OriginalContactBinding;
  readonly occurrence: CommunicationDecisionRequest['occurrence'];
  readonly purpose: CommunicationPurposeKey;
  readonly recipient: { readonly recipientRef: CommunicationResourceRef; readonly role: RecipientRole };
  readonly scope: RecipientScope;
  readonly sourceModule: CommunicationDecisionRequest['source']['moduleKey'];
  readonly typeId: MessageTypeId;
}

/**
 * What the owners reported about the original recipient now: usable with its protected endpoint, or unusable for one
 * current reason. There is no variant for "use another contact"; a corrected contact is a new owner request.
 */
export type RecipientGateVerdictCase = Data.TaggedEnum<{
  Unusable: { readonly reason: GateUnusableReason };
  Usable: { readonly endpoint: ProtectedEndpoint };
}>;
export const RecipientGateVerdict = Data.taggedEnum<RecipientGateVerdictCase>();

/**
 * What a gate adapter must supply besides its answers. The deadline is a deployment decision of the owner
 * composition, so the domain declares no default: a gate that cannot be bounded cannot be wired.
 */
export interface RecipientGateSettings {
  /** Longest one per-recipient check may take. A check past it fails closed as an unavailable source owner. */
  readonly checkTimeout: Duration.Input;
}

/**
 * TRUST BOUNDARY for the owner contract (d21-07): the domain only compares what the owner echoes. A real adapter
 * MUST echo and pin the contact reference and the revision (versioned snapshot) or snapshot reference (historical
 * snapshot) it actually resolved; an answer that omits it or names another is refused. An owner that invents them can
 * still pass the echo check without having resolved the original contact, so that echo is part of the owner contract,
 * not something Communications can verify alone.
 */
export interface RecipientCurrentGateService extends RecipientGateSettings {
  /** Re-check the original recipient and endpoint now; an unreachable authority fails closed, never as stale data. */
  readonly check: (query: RecipientGateQuery) => Effect.Effect<RecipientGateVerdictCase, RecipientAuthorityUnavailable>;
}

export class RecipientCurrentGate extends Context.Service<RecipientCurrentGate, RecipientCurrentGateService>()(
  '@app/communications/domain/recipient/current-gate/RecipientCurrentGate',
) {}

/**
 * The only production composition today: no owner publishes a recipient authority yet, so every check fails closed
 * with an unavailable source owner. It is explicit so nothing is ever allowed by default or by a missing adapter.
 */
export const unavailableRecipientCurrentGateLayer = (settings: RecipientGateSettings) =>
  Layer.succeed(RecipientCurrentGate, {
    ...settings,
    check: () => Effect.fail(new RecipientAuthorityUnavailable({ authority: 'SOURCE_OWNER' })),
  });
