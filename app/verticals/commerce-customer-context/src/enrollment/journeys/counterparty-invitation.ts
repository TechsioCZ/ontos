import { Result, Schema } from 'effect';

import {
  PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  PORTAL_AUTH_OWNER_MODULE_KEY,
} from '../orchestration/prepared-owner-authority.ts';
import type { JourneyDefinition } from './journey-contracts.ts';
import { JourneyDefinitionSchema } from './journey-contracts.ts';

/**
 * Counterparty invitation enrollment journey: the portal account creation, the Tenant-scoped
 * Principal Auth Binding this recipient is then known by, and the existing
 * `claim-counterparty-access-invitation` Action.
 *
 * There is deliberately no fifth "grant" transition: the claim owner already stages the
 * invitation's intended Permission mutations inside its own transaction, so a journey-level grant
 * loop would either duplicate those mutations or invent authority the invitation never carried.
 */

/** Owner module that owns the Counterparty Access invitation claim and its staged grants. */
export const COUNTERPARTY_ACCESS_OWNER_MODULE_KEY = 'commerce.customer-context';
/** Stable transition identity of the existing claim-counterparty-access-invitation Action. */
export const CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY = 'counterparty-access-invitation.claim';
/** Owner module that owns the Tenant-scoped Principal Auth Binding. */
const CORE_IDENTITY_OWNER_MODULE_KEY = 'core.identity';
/** Byte-identical to the Existing-account keys, so one owner effect case serves both journeys. */
const CORE_PRINCIPAL_BINDING_RESERVATION_TRANSITION_KEY = 'core.principal-binding.reserve';
/** Enrollment may only establish a binding; disable/revoke stays with its own owner Action. */
const CORE_PRINCIPAL_BINDING_ACTIVATION_TRANSITION_KEY = 'core.principal-binding.activate';

/**
 * Dispatch order. The portal account must exist before a Principal can be bound to it, the binding
 * must be active before the recipient can authenticate as the Principal that claims, and the claim
 * is last because it is the only transition the recipient performs itself: the claim route records
 * it under the very Principal this journey bound.
 */
export const counterpartyInvitationJourneyDefinition: JourneyDefinition = Result.getOrThrow(
  Schema.decodeResult(JourneyDefinitionSchema)({
    kind: 'COUNTERPARTY_INVITATION',
    optionalTransitions: [],
    requiredTransitions: [
      {
        ownerModuleKey: PORTAL_AUTH_OWNER_MODULE_KEY,
        required: true,
        transitionKey: PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
      },
      {
        ownerModuleKey: CORE_IDENTITY_OWNER_MODULE_KEY,
        required: true,
        transitionKey: CORE_PRINCIPAL_BINDING_RESERVATION_TRANSITION_KEY,
      },
      {
        ownerModuleKey: CORE_IDENTITY_OWNER_MODULE_KEY,
        required: true,
        transitionKey: CORE_PRINCIPAL_BINDING_ACTIVATION_TRANSITION_KEY,
      },
      {
        ownerModuleKey: COUNTERPARTY_ACCESS_OWNER_MODULE_KEY,
        required: true,
        transitionKey: CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY,
      },
    ],
  }),
);
