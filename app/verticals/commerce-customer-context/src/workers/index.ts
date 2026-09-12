import type { AnyOutboxWorkerRegistration } from '@app/core-runtime';

// <generated-outbox-worker-imports>
import { reconcileCounterpartyAccessAdministratorBootstrapAuthorizationMutationWorker } from './reconcile-counterparty-access-administrator-bootstrap-authorization-mutation.worker.ts';
import { reconcileCounterpartyAccessGrantAuthorizationMutationWorker } from './reconcile-counterparty-access-grant-authorization-mutation.worker.ts';
import { reconcileCounterpartyAccessInvitationClaimAuthorizationMutationWorker } from './reconcile-counterparty-access-invitation-claim-authorization-mutation.worker.ts';
import { reconcileCounterpartyAccessRevokeAuthorizationMutationWorker } from './reconcile-counterparty-access-revoke-authorization-mutation.worker.ts';
import { reconcilePartyMergeWorker } from './reconcile-party-merge.worker.ts';
import { reconcileRetailPortalProfileBindingActivationAuthorizationMutationWorker } from './reconcile-retail-portal-profile-binding-activation-authorization-mutation.worker.ts';
import { reconcileRetailPortalProfileBindingRecoveryAuthorizationMutationWorker } from './reconcile-retail-portal-profile-binding-recovery-authorization-mutation.worker.ts';
import { reconcileRetailPortalProfileBindingRevocationAuthorizationMutationWorker } from './reconcile-retail-portal-profile-binding-revocation-authorization-mutation.worker.ts';
// </generated-outbox-worker-imports>

export const outboxWorkers = Object.freeze([
  // <generated-outbox-worker-registrations>
  reconcileCounterpartyAccessAdministratorBootstrapAuthorizationMutationWorker,
  reconcileCounterpartyAccessGrantAuthorizationMutationWorker,
  reconcileCounterpartyAccessInvitationClaimAuthorizationMutationWorker,
  reconcileCounterpartyAccessRevokeAuthorizationMutationWorker,
  reconcilePartyMergeWorker,
  reconcileRetailPortalProfileBindingActivationAuthorizationMutationWorker,
  reconcileRetailPortalProfileBindingRecoveryAuthorizationMutationWorker,
  reconcileRetailPortalProfileBindingRevocationAuthorizationMutationWorker,
  // </generated-outbox-worker-registrations>
]) satisfies readonly AnyOutboxWorkerRegistration[];
