// Canonical schema-only contract extracted from the generated claim-counterparty-access-invitation Action.
import { Schema } from 'effect';
import {
  CounterpartyPermissionScopeSchema,
  CounterpartyRefSchema,
  PrincipalRefSchema,
} from '../domain/access-contract.ts';
import {
  CounterpartyAccessInvitationSchema,
  InvitationClaimProofReferenceSchema,
  VerifiedInvitationClaimAttestationSchema,
} from '../domain/invitation-contract.ts';
import { CounterpartyAccessInvitationRefSchema } from '../resources/counterparty-access-invitation.ts';
import { InvitationClaimAuthorizationMutationEvidenceSchema } from '../domain/access-authorization-mutation.ts';

export const ClaimCounterpartyAccessInvitationPayloadSchema = Schema.Struct({
  claimant: PrincipalRefSchema,
  claimProofReference: InvitationClaimProofReferenceSchema,
  counterpartyRef: CounterpartyRefSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  invitationRef: CounterpartyAccessInvitationRefSchema,
  scope: CounterpartyPermissionScopeSchema,
});
export type ClaimCounterpartyAccessInvitationPayload = typeof ClaimCounterpartyAccessInvitationPayloadSchema.Type;

export const ClaimCounterpartyAccessInvitationResultSchema = Schema.Union([
  Schema.Struct({
    attestation: VerifiedInvitationClaimAttestationSchema,
    invitation: CounterpartyAccessInvitationSchema,
    outcome: Schema.Literal('CLAIMED'),
  }),
  Schema.Struct({
    attestation: VerifiedInvitationClaimAttestationSchema,
    invitation: CounterpartyAccessInvitationSchema,
    outcome: Schema.Literal('RECONCILIATION_REQUIRED'),
    reconciliation: InvitationClaimAuthorizationMutationEvidenceSchema,
  }),
  Schema.Struct({
    invitation: CounterpartyAccessInvitationSchema,
    outcome: Schema.Literal('ALREADY_CLAIMED'),
  }),
]);
