import { OwnerAuthorizationOverlay } from '@app/core-runtime';
import type { OwnerAuthorizationOverlayService } from '@app/core-runtime';
import { Effect, Layer } from 'effect';

/**
 * Authorization v2 decides a protected Action or Read at the one access gate, from the holder's
 * assignment (O62); the removed SpiceDB `action#executor` tuples and context permissions no longer
 * refuse anyone. `makeLiveOperationFixture` scripts its gate as one answer (or one per capability
 * key), so a native Commerce Customer Context suite that must prove *one principal* is refused —
 * while the fixture's own manager keeps its allow — names that principal here.
 *
 * The fixture asks its owner overlay once per request, inside the request transaction, with the
 * trusted scope and the entrypoint's capability key (O67-Q1, O70). This test double refuses exactly
 * the named principal+capability pairs and delegates every other request to the owner's real rule,
 * so the manager's genuine counterparty grants keep deciding (never a blanket allow).
 *
 * `deny` is a decided refusal (403, `ActionPermissionDenied`/`ReadPermissionDenied`). `unavailable`
 * is an *indeterminate* answer: the owner-local authority could not be read, so the request answers
 * a retryable 503 (O48b) and is never turned into a plain denial or an allow. A suite needs both
 * controls, because the runtime must keep them apart.
 */
export interface CommerceCustomerContextDeniedAccess {
  /** Stop refusing this principal on this capability (the negative control is lifted). */
  readonly allow: (principalId: string, capabilityKey: string) => void;
  /** Refuse this principal on this capability, as a live gate with no matching assignment would. */
  readonly deny: (principalId: string, capabilityKey: string) => void;
  readonly layer: Layer.Layer<OwnerAuthorizationOverlay>;
  /** Answer this principal with an indeterminate owner-authority answer, as an unreadable store would. */
  readonly unavailable: (principalId: string, capabilityKey: string) => void;
}

const pairKey = (principalId: string, capabilityKey: string): string => `${principalId}\u0000${capabilityKey}`;

export const makeCommerceCustomerContextDeniedAccess = (
  /** The owner's own rule, consulted for every principal+capability this double does not name. */
  delegate: OwnerAuthorizationOverlayService,
): CommerceCustomerContextDeniedAccess => {
  const answers = new Map<string, 'denied' | 'unavailable'>();
  const overlay: OwnerAuthorizationOverlayService = {
    authorize: (transaction, input) => {
      const answer = answers.get(pairKey(input.scope.principalId, input.capabilityKey));
      return answer === undefined ? delegate.authorize(transaction, input) : Effect.succeed(answer);
    },
  };
  return {
    allow: (principalId, capabilityKey) => {
      answers.delete(pairKey(principalId, capabilityKey));
    },
    deny: (principalId, capabilityKey) => {
      answers.set(pairKey(principalId, capabilityKey), 'denied');
    },
    layer: Layer.succeed(OwnerAuthorizationOverlay, overlay),
    unavailable: (principalId, capabilityKey) => {
      answers.set(pairKey(principalId, capabilityKey), 'unavailable');
    },
  };
};
