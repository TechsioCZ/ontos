import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
import { Crypto, Effect } from 'effect';

import type { CustomerPartyProfileScope } from '../profile/party-profile.ts';

/** What a governed portal read or Action knows when its owner routine runs. */
export interface OwnPortalOperation {
  /** The Core-admitted composition revision, when the runtime handed one over. */
  readonly compositionRevision?: string | undefined;
  readonly legalEntityId: string | undefined;
  /** The Party of the admitted session's own account (the overlay proved it inside the operation). */
  readonly partyId: string;
  readonly tenantId: string;
}

/**
 * The owner routines' scope for the session's own Party, built exactly as the portal routes built it: the active
 * composition revision, the selling company, the Party and a fresh request correlation. A missing company or an
 * unreadable composition is the caller's `unavailable`.
 */
export const ownPortalScope = Effect.fn('CustomerOwnPortal.scope')(function* ownPortalScope<Failure>(
  operation: OwnPortalOperation,
  unavailable: () => Failure,
) {
  const { legalEntityId } = operation;
  if (legalEntityId === undefined) {
    return yield* Effect.fail(unavailable());
  }
  let { compositionRevision } = operation;
  if (compositionRevision === undefined) {
    const compositions = yield* ActiveApplicationCompositionService;
    const active = yield* compositions.load.pipe(
      Effect.flatMap(validateActiveApplicationCompositionSnapshot),
      Effect.mapError(unavailable),
    );
    compositionRevision = active.composition.revision;
  }
  const crypto = yield* Crypto.Crypto;
  const requestCorrelation = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
  const scope: CustomerPartyProfileScope = {
    compositionRevision,
    legalEntityId,
    partyId: operation.partyId,
    requestCorrelation,
    tenantId: operation.tenantId,
  };
  return scope;
});
