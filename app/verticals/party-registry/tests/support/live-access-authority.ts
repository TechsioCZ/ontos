import { OwnerAuthorizationOverlay, failClosedOwnerAuthorizationOverlay } from '@app/core-runtime';
import type { OwnerAuthorizationOverlayService } from '@app/core-runtime';
import { Effect, Layer } from 'effect';

/**
 * Authorization v2 decides a protected Action or Read at the one access gate, from the holder's
 * assignment (O62); the removed SpiceDB `action#executor` tuples and context permissions no longer
 * refuse anyone. `makeLiveOperationFixture` scripts its gate per capability key, so a suite that
 * proves *one principal* is refused — while the fixture's own manager keeps its allow — names that
 * principal here.
 *
 * The fixture asks its owner overlay once per request, inside the request transaction, with the
 * trusted scope and the entrypoint's capability key (O67-Q1). This test double answers exactly the
 * named principal+capability pairs and keeps the fixture's own fail-closed owner rule for every
 * other request, so an owner-held record stays unavailable rather than silently allowed.
 *
 * `deny` is a decided refusal (403). `unavailable` is an *indeterminate* answer: the owner-local
 * authority could not be read, so the read answers a retryable 503 (O48b) and is never turned into a
 * plain denial or an allow. A suite needs both controls, because the runtime must keep them apart.
 */
export interface PartyDeniedAccess {
  /** Stop refusing this principal (the negative control is lifted). */
  readonly allow: (principalId: string, capabilityKey?: string) => void;
  /**
   * Refuse this principal, as a live gate with no matching assignment would. Naming a capability
   * refuses only it; omitting it refuses every capability this principal asks about.
   */
  readonly deny: (principalId: string, capabilityKey?: string) => void;
  /**
   * Answer this principal with an indeterminate owner-authority answer, as an unreadable store would.
   * The read is neither allowed nor denied: it fails closed into a retryable unavailability (O48b).
   */
  readonly unavailable: (principalId: string, capabilityKey?: string) => void;
  readonly layer: Layer.Layer<OwnerAuthorizationOverlay>;
}

const pairKey = (principalId: string, capabilityKey: string): string => `${principalId}\u0000${capabilityKey}`;
const allKey = (principalId: string): string => `${principalId}\u0000*`;

const scopedKey = (principalId: string, capabilityKey: string | undefined): string =>
  capabilityKey === undefined ? allKey(principalId) : pairKey(principalId, capabilityKey);

export const makePartyDeniedAccess = (): PartyDeniedAccess => {
  const answers = new Map<string, 'denied' | 'unavailable'>();
  const answerOf = (principalId: string, capabilityKey: string): 'denied' | 'unavailable' | undefined =>
    answers.get(pairKey(principalId, capabilityKey)) ?? answers.get(allKey(principalId));
  const overlay: OwnerAuthorizationOverlayService = {
    authorize: (transaction, input) => {
      const answer = answerOf(input.scope.principalId, input.capabilityKey);
      return answer === undefined
        ? failClosedOwnerAuthorizationOverlay.authorize(transaction, input)
        : Effect.succeed(answer);
    },
  };
  return {
    allow: (principalId, capabilityKey) => {
      answers.delete(scopedKey(principalId, capabilityKey));
    },
    deny: (principalId, capabilityKey) => {
      answers.set(scopedKey(principalId, capabilityKey), 'denied');
    },
    unavailable: (principalId, capabilityKey) => {
      answers.set(scopedKey(principalId, capabilityKey), 'unavailable');
    },
    layer: Layer.succeed(OwnerAuthorizationOverlay, overlay),
  };
};
