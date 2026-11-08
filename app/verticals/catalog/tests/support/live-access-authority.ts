import { OwnerAuthorizationOverlay, failClosedOwnerAuthorizationOverlay } from '@app/core-runtime';
import type { OwnerAuthorizationOverlayService } from '@app/core-runtime';
import { Effect, Layer } from 'effect';

/**
 * Authorization v2 decides a protected Action or Read at the one access gate, from the holder's
 * assignment (O62); the removed SpiceDB `action#executor` tuples and context permissions no longer
 * refuse anyone. `makeLiveOperationFixture` scripts its gate as one answer (or one per capability
 * key), so a native Catalog suite that proves *one principal* is refused — while the fixture's own
 * manager keeps its allow — names that principal here.
 *
 * The fixture asks its owner overlay once per request, inside the request transaction, with the
 * trusted scope and the entrypoint's capability key (O67-Q1). This test double denies exactly the
 * named principal+capability pairs and keeps the fixture's own fail-closed owner rule for every
 * other request, so an owner-held record stays unavailable rather than silently allowed.
 */
export interface CatalogDeniedAccess {
  /** Stop refusing this principal on this capability (the negative control is lifted). */
  readonly allow: (principalId: string, capabilityKey: string) => void;
  /** Refuse this principal on this capability, as a live gate with no matching assignment would. */
  readonly deny: (principalId: string, capabilityKey: string) => void;
  readonly layer: Layer.Layer<OwnerAuthorizationOverlay>;
}

const pairKey = (principalId: string, capabilityKey: string): string => `${principalId}\u0000${capabilityKey}`;

export const createCatalogDeniedAccess = (): CatalogDeniedAccess => {
  const denied = new Set<string>();
  const overlay: OwnerAuthorizationOverlayService = {
    authorize: (transaction, input) =>
      denied.has(pairKey(input.scope.principalId, input.capabilityKey))
        ? Effect.succeed('denied' as const)
        : failClosedOwnerAuthorizationOverlay.authorize(transaction, input),
  };
  return {
    allow: (principalId, capabilityKey) => {
      denied.delete(pairKey(principalId, capabilityKey));
    },
    deny: (principalId, capabilityKey) => {
      denied.add(pairKey(principalId, capabilityKey));
    },
    layer: Layer.succeed(OwnerAuthorizationOverlay, overlay),
  };
};
