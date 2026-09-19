import { Result, Schema } from 'effect';

import {
  PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  PORTAL_AUTH_OWNER_MODULE_KEY,
} from '../orchestration/prepared-owner-authority.ts';
import type { JourneyDefinition } from './journey-contracts.ts';
import { JourneyDefinitionSchema } from './journey-contracts.ts';

/**
 * Counterparty invitation enrollment journey: the portal account creation, the existing
 * `claim-counterparty-access-invitation` Action, and the Core Principal Auth Binding activation.
 *
 * There is deliberately no fourth "grant" transition: the claim owner already stages the
 * invitation's intended Permission mutations inside its own transaction, so a journey-level grant
 * loop would either duplicate those mutations or invent authority the invitation never carried.
 *
 * All three transitions gate completion, and no deployment registers an owner effect for the claim
 * transition yet, so such an Attempt halts at the claim rather than projecting as COMPLETE.
 */

/** Owner module that owns the Counterparty Access invitation claim and its staged grants. */
const COUNTERPARTY_ACCESS_OWNER_MODULE_KEY = 'commerce.customer-context';
/** Stable transition identity of the existing claim-counterparty-access-invitation Action. */
const CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY = 'counterparty-access-invitation.claim';
/** Owner module that owns the Tenant-scoped Principal Auth Binding. */
const CORE_IDENTITY_OWNER_MODULE_KEY = 'core.identity';
/** Enrollment may only establish a binding; disable/revoke stays with its own owner Action. */
const CORE_PRINCIPAL_BINDING_ACTIVATION_TRANSITION_KEY = 'core.principal-binding.activate';

/**
 * Dispatch order. The portal account must exist before an invitation can be claimed by an
 * authenticated Principal, and the claim must have committed before the Core binding is activated
 * for the Tenant the invitation belongs to.
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
        ownerModuleKey: COUNTERPARTY_ACCESS_OWNER_MODULE_KEY,
        required: true,
        transitionKey: CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY,
      },
      {
        ownerModuleKey: CORE_IDENTITY_OWNER_MODULE_KEY,
        required: true,
        transitionKey: CORE_PRINCIPAL_BINDING_ACTIVATION_TRANSITION_KEY,
      },
    ],
  }),
);
