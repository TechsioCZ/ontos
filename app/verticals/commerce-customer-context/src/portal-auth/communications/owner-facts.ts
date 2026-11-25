import { Effect, Match, Option, Redacted } from 'effect';

import type { PortalAuthIssuanceSourceResponse } from '../../../shared/apis/portal-auth-issuance-source.ts';
import {
  PORTAL_AUTH_ISSUANCE_REVISION,
  PORTAL_AUTH_ISSUANCE_STATE,
} from '../../../shared/portal-auth-communications.ts';
import type { PortalAuthIssuanceRef, PortalAuthIssuanceState } from '../../../shared/portal-auth-communications.ts';
import type { PortalAuthIssuanceStateUnavailable } from './issuance-state-unavailable.ts';
import type { IssuanceCurrentness } from './issuance.ts';
import type { ProtectedHandoffService } from './protected-handoff.ts';

/**
 * The facts Auth, as the sole source owner, answers when Communications asks again at the decision and at the last
 * stoppable handoff (AUTH-COM-02/04/07). They are Auth's own CURRENT lifecycle and original binding, never a language,
 * revision or recipient-profile fact, so no localisation choice can extend, shorten or redirect an issuance.
 *
 * Both answers are pure reads of the protected handoff. They reach Communications through the published owner Read
 * `commerce.customer-context.api.portal-auth-issuance-source` (`issuanceSourceAnswerOf` below), which answers state and
 * binding facts only and never the address, token, one-time code or link.
 */

/** The source state Auth reports for an issuance. Only `current` lets an approved type proceed; every other state stops it. */
export const issuanceSourceStateOf = (currentness: IssuanceCurrentness): PortalAuthIssuanceState =>
  Match.value(currentness).pipe(
    Match.when('CURRENT', () => PORTAL_AUTH_ISSUANCE_STATE.current),
    Match.when('EXPIRED', () => PORTAL_AUTH_ISSUANCE_STATE.expired),
    Match.when('CONSUMED', () => PORTAL_AUTH_ISSUANCE_STATE.consumed),
    Match.when('REVOKED', () => PORTAL_AUTH_ISSUANCE_STATE.revoked),
    Match.when('SUPERSEDED', () => PORTAL_AUTH_ISSUANCE_STATE.superseded),
    Match.when('NOT_RESUMABLE', () => PORTAL_AUTH_ISSUANCE_STATE.notResumable),
    Match.exhaustive,
  );

/**
 * The ORIGINAL address Auth bound to the issuance, only for the account the message is addressed to and only while the
 * issuance is Current. An issuance of another account answers nothing: the same address on two accounts never merges them,
 * and a profile edit never redirects a message (the address is the one held at issuance, never a Current profile).
 */
export const originalEndpointOf = Effect.fn('PortalAuthOwnerFacts.originalEndpoint')(function* endpoint(
  handoff: Pick<ProtectedHandoffService, 'endpointOf' | 'issuanceOf'>,
  input: { readonly issuanceRef: PortalAuthIssuanceRef; readonly recipientSubjectId: string },
): Effect.fn.Return<Option.Option<Redacted.Redacted>, PortalAuthIssuanceStateUnavailable> {
  const issuance = yield* handoff.issuanceOf(input.issuanceRef);
  if (!Option.exists(issuance, ({ providerSubjectId }) => providerSubjectId === input.recipientSubjectId)) {
    return Option.none();
  }
  return yield* handoff.endpointOf(input.issuanceRef);
});

const MASK_PREFIX_LENGTH = 1;
const MASK_HIDDEN = '***';

/**
 * A mask that hides the address: one visible character, three hidden ones and the domain of the original address. It is the only
 * form of the address that may be stored; it is never the whole address.
 */
export const maskedAddressOf = (address: Redacted.Redacted): string => {
  const value = Redacted.value(address);
  const at = value.lastIndexOf('@');
  const domain = at === -1 ? '' : value.slice(at);
  return `${value.slice(0, MASK_PREFIX_LENGTH)}${MASK_HIDDEN}${domain}`;
};

/**
 * What the published owner Read answers for ONE issuance (never a secret, an address or a provider reference):
 * - an issuance that exists but belongs to ANOTHER account answers `NO_FACTS` when an account is named, so the same address on two
 *   accounts never merges and nothing about the other account's issuance is disclosed;
 * - otherwise the source state of the issuance (a row Auth no longer holds is its `not-resumable` state, never a guess);
 * - when the account is named, whether the ORIGINAL endpoint is still Current for it, with only the mask of the address.
 * A store that cannot answer is `PortalAuthIssuanceStateUnavailable`, never a state.
 */
export const issuanceSourceAnswerOf = Effect.fn('PortalAuthOwnerFacts.issuanceSourceAnswer')(function* answer(
  handoff: Pick<ProtectedHandoffService, 'currentness' | 'endpointOf' | 'issuanceOf'>,
  input: { readonly issuanceRef: PortalAuthIssuanceRef; readonly recipientSubjectId?: string | undefined },
): Effect.fn.Return<PortalAuthIssuanceSourceResponse, PortalAuthIssuanceStateUnavailable> {
  const { issuanceRef, recipientSubjectId } = input;
  if (recipientSubjectId !== undefined) {
    const issuance = yield* handoff.issuanceOf(issuanceRef);
    if (Option.exists(issuance, ({ providerSubjectId }) => providerSubjectId !== recipientSubjectId)) {
      return { kind: 'NO_FACTS' };
    }
  }
  const state = issuanceSourceStateOf(yield* handoff.currentness(issuanceRef));
  if (recipientSubjectId === undefined) {
    return { issuanceRef, kind: 'FACTS', latestRevision: PORTAL_AUTH_ISSUANCE_REVISION, state };
  }
  const address = yield* originalEndpointOf(handoff, { issuanceRef, recipientSubjectId });
  return {
    issuanceRef,
    kind: 'FACTS',
    latestRevision: PORTAL_AUTH_ISSUANCE_REVISION,
    originalEndpoint: Option.match(address, {
      onNone: () => ({ kind: 'NOT_CURRENT' as const }),
      onSome: (value) => ({ kind: 'CURRENT' as const, mask: maskedAddressOf(value) }),
    }),
    state,
  };
});
