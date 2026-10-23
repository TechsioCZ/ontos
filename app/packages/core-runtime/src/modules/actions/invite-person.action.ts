import { Effect } from 'effect';

import type { ActionHandlerContext } from '../../actions/context.ts';
import { defineAction } from '../../actions/definition.ts';
import { PersonInvitationIdentityProvider } from '../../auth/person-invitation-identity-provider.ts';
import type { PersonInvitationIdentityWriter } from '../../auth/person-invitation-identity-provider.ts';
import { personInvitationManagementFromTransaction } from '../../auth/person-invitation-management.ts';
import {
  InvitePersonAuditEvidenceSchema,
  InvitePersonPayloadSchema,
  InvitePersonResultSchema,
} from '../../auth/person-invitation.ts';
import type { InvitePersonPayload } from '../../auth/person-invitation.ts';
import { PrincipalManagementErrorSchema } from '../../auth/principal-management-errors.ts';
import { defineSystemModuleEntrypoint } from '../module-entrypoint.ts';
import { principalLifecycleDomainEvents, recordPrincipalLifecycleChange } from './principal-lifecycle-event.ts';

interface InvitationServices {
  readonly core: ReturnType<typeof personInvitationManagementFromTransaction>;
  readonly identity: PersonInvitationIdentityWriter;
}

const handle = Effect.fn('InvitePersonAction.handle')(function* invitePerson(
  payload: InvitePersonPayload,
  context: ActionHandlerContext<typeof principalLifecycleDomainEvents, InvitationServices>,
) {
  const invitation = yield* context.services.core.create(payload, context.actionInvocationId);
  // Both owner writers use the very same transaction. A provider failure rolls back
  // principal, binding, membership, invitation and all standard Action evidence.
  yield* context.services.identity.provision(invitation.identity);
  const { result } = invitation;
  yield* context.recordAuditEvidence({
    affiliation: payload.affiliation,
    displayName: payload.displayName,
    email: invitation.identity.email,
    invitationId: result.invitationId,
    legalEntityId: result.membership.legalEntityId,
    membershipRevision: 1,
    membershipStatus: 'invited',
    principalRef: result.principalRef,
  });
  // The invitation is an explicit administrator choice, not an invitation inferred
  // from a login or role. Its invited membership projects no company access.
  yield* recordPrincipalLifecycleChange(context, result.principalRef.principalId);
  return result;
});

export const invitePersonAction = defineAction(
  {
    accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'core.identity.invite-person.access.v1' },
    actionKey: 'core.identity.invite-person',
    auditEvidenceSchema: InvitePersonAuditEvidenceSchema,
    auditProfile: 'sensitive',
    domainErrorSchema: PrincipalManagementErrorSchema,
    domainEvents: principalLifecycleDomainEvents,
    entrypoint: defineSystemModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'action_execution', provisioning: 'explicit' },
      entrypointKey: 'core.identity.invite-person',
      moduleKey: 'core.identity',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'required',
    owningModuleKey: 'core.identity',
    payloadSchema: InvitePersonPayloadSchema,
    policies: [],
    resultSchema: InvitePersonResultSchema,
    schemaVersion: '1',
  },
  handle,
  Effect.fn('InvitePersonAction.makeServices')(function* makeInvitationServices(transaction) {
    const provider = yield* PersonInvitationIdentityProvider;
    return {
      core: personInvitationManagementFromTransaction(transaction),
      identity: provider.fromTransaction(transaction),
    };
  }),
);
