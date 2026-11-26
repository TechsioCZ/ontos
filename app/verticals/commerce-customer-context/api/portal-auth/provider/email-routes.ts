import { Effect, Layer } from 'effect';

import { PortalAuthIssuanceStateUnavailable } from '../../../src/portal-auth/communications/issuance-state-unavailable.ts';
import { CommercePortalAuthIssuedFacts } from '../../../src/portal-auth/communications/issued-facts.ts';
import { ownerSlotCompletionLayer } from '../../../src/portal-auth/communications/owner-completion.ts';
import {
  CommercePortalAuthProtectedHandoff,
  protectedHandoffLayerOverProbe,
} from '../../../src/portal-auth/communications/protected-handoff.ts';
import {
  directVerificationReplayLayer,
  verificationReplayLayer,
} from '../../../src/portal-auth/communications/verification-replay.ts';
import { CommercePortalAuthCommunicationsEmailLive } from './communications-email-delivery.ts';
import { ledgerProbeOver } from './communications-ledger-probe.ts';
import { CommercePortalAuthRecoveryStoreService } from './recovery/store-service.ts';
import { CommercePortalAuthTransactionalEmailLive } from './transactional-email.ts';

/**
 * The two compositions of the Portal Auth e-mail (#1406, R-D13), each a complete, EXPLICIT set of the services the realm needs
 * of its e-mail route: the raw delivery behind the ledger registration and the replay rule of an enrollment, plus the issuance
 * state the issuance-source Read answers from. Every requirement stays visible: the composition root (`api/index.ts`) selects ONE
 * route from `portalAuthEmailRoute` and supplies them once; a composition that installs neither route does not build, so no
 * deployment falls open by omission (#1282).
 *
 * - `commercePortalAuthDirectEmailRouteLive` (the default): the unchanged English direct sender and a replay that re-issues the
 *   link exactly as before. Its issuance state is the explicit unavailable form (a direct deployment holds no issuance, so the
 *   Read answers typed unavailable and discloses nothing);
 * - `commercePortalAuthCommunicationsEmailRouteLive`: the Communications-routed delivery, the Communications replay rule, and the
 *   owner-slot completion, over Auth's own protected handoff (the sealed store of D2 and the ledger probe over Auth's own recovery
 *   ledger), the outcome reader, the trusted Tenant of the realm and the one-time-code challenge key reader.
 */

const unavailable = () => Effect.fail(new PortalAuthIssuanceStateUnavailable({ flow: 'verify-email' }));

/** A direct deployment holds no issuance: every question about one is the typed unavailable, never an invented fact. */
export const commercePortalAuthDirectIssuanceStateLive = Layer.succeed(CommercePortalAuthProtectedHandoff, {
  currentness: unavailable,
  endpointOf: unavailable,
  forget: unavailable,
  hold: () => Effect.die('A direct deployment holds no Portal Auth issuance'),
  issuanceOf: unavailable,
  reserve: () => Effect.void,
  revealSecret: unavailable,
  settle: unavailable,
  takeReservation: () => Effect.succeedNone,
});

export const commercePortalAuthDirectEmailRouteLive = Layer.mergeAll(
  CommercePortalAuthTransactionalEmailLive,
  directVerificationReplayLayer,
);

/** What Auth itself STORED about an issuance, read from its own recovery ledger. */
export const commercePortalAuthIssuedFactsLive = Layer.effect(
  CommercePortalAuthIssuedFacts,
  Effect.gen(function* makeIssuedFacts() {
    const store = yield* CommercePortalAuthRecoveryStoreService;
    return {
      locateOtpChallenge: store.locateOtpChallenge,
      peekEmailVerificationLedger: store.peekEmailVerificationLedger,
      peekPasswordResetLedger: store.peekPasswordResetLedger,
    };
  }),
);

/**
 * The protected handoff of a Communications-routed deployment: what the issuance-source Read and the delivery both answer from.
 * Sealed under the realm secret in Auth's own store, its Current state read from Auth's own recovery ledger.
 */
export const commercePortalAuthCommunicationsIssuanceStateLive = protectedHandoffLayerOverProbe(
  CommercePortalAuthRecoveryStoreService.pipe(Effect.map(ledgerProbeOver)),
);

export const commercePortalAuthCommunicationsEmailRouteLive = Layer.mergeAll(
  CommercePortalAuthCommunicationsEmailLive,
  verificationReplayLayer,
  ownerSlotCompletionLayer,
);
