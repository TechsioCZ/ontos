import { Effect } from 'effect';

import type {
  AccessInstant,
  CounterpartyPermissionScope,
  CounterpartyRef,
  PrincipalRef,
} from '../../../shared/domain/access-contract.ts';
import type { CounterpartyAccessDomainError } from '../../../shared/domain/access-error.ts';
import { CounterpartyAccessUnavailable } from '../../../shared/domain/access-error.ts';
import type {
  CounterpartyAccessInvitation,
  InvitationGrantProgress,
} from '../../../shared/domain/invitation-contract.ts';
import { invitationCanBeginClaim } from '../../../shared/domain/invitation-contract.ts';
import type { CounterpartyPermissionCode } from '../../../shared/domain/permission-catalog.ts';
import type { CounterpartyAccessInvitationRef } from '../../../shared/resources/counterparty-access-invitation.ts';
import { validateInvitationIntent } from '../../actions/invitation-action-support.ts';
import type { CounterpartyInvitationClaimRejected } from './counterparty-invitation-claim-rejection.ts';
import { rejectCounterpartyInvitationClaim } from './counterparty-invitation-claim-rejection.ts';
import { CounterpartyInvitationReads } from './counterparty-invitation-reads.ts';

/**
 * Invitation re-check performed immediately before the claim owner transition is dispatched.
 *
 * The invitation read when the Enrollment Attempt was planned is not evidence at claim time: it
 * may have expired, been revoked, already have been claimed by somebody else, or its grantor may
 * have lost the authority to delegate one of its intended Permissions.  Each of those is a typed
 * rejection here, so the claim Action is never invoked on stale authority, and the invitation is
 * never mistaken for a Permission in its own right.
 *
 * The re-check only reads.  It stages nothing, grants nothing and repairs nothing; when a read is
 * unavailable it fails retryable rather than assuming the invitation is still valid.
 */

/** The Permission an inviter must still hold, in the invitation's scope, to delegate at all. */
export const COUNTERPARTY_INVITATION_GRANTOR_PERMISSION = 'counterparty.access.manage' as const;

export interface CounterpartyInvitationClaimPreflightRequest {
  readonly claimant: PrincipalRef;
  readonly counterpartyRef: CounterpartyRef;
  readonly invitationRef: CounterpartyAccessInvitationRef;
  readonly legalEntityId: string;
  /** The instant the claim is attempted at; expiry is judged against it, never against "now". */
  readonly observedAt: AccessInstant;
  readonly scope: CounterpartyPermissionScope;
  readonly tenantId: string;
}

export type CounterpartyInvitationClaimPreflight =
  | {
      readonly decision: 'CLAIMABLE';
      /** The exact invitation revision the claim must be dispatched against. */
      readonly expectedRevision: number;
      /** Exactly the invitation's own intended Permissions; never a superset of them. */
      readonly grantablePermissions: readonly CounterpartyPermissionCode[];
      readonly invitation: CounterpartyAccessInvitation;
    }
  | {
      readonly decision: 'ALREADY_CLAIMED';
      readonly invitation: CounterpartyAccessInvitation;
      /** Progress the winning claim already staged; it is reported, never re-staged or undone. */
      readonly retainedGrantProgress: readonly InvitationGrantProgress[];
    };

type LifecycleVerdict =
  | { readonly kind: 'converge'; readonly preflight: CounterpartyInvitationClaimPreflight }
  | { readonly kind: 'proceed' }
  | { readonly kind: 'reject'; readonly rejection: CounterpartyInvitationClaimRejected };

const sameScope = (left: CounterpartyPermissionScope, right: CounterpartyPermissionScope): boolean =>
  left.kind === 'storefront'
    ? right.kind === 'storefront' && left.storefrontKey === right.storefrontKey
    : right.kind === 'counterparty';

const samePrincipal = (left: PrincipalRef, right: PrincipalRef): boolean =>
  left.principalId === right.principalId && left.tenantId === right.tenantId;

const tenantBindingIssue = (request: CounterpartyInvitationClaimPreflightRequest): string | undefined => {
  if (request.invitationRef.tenantId !== request.tenantId) {
    return 'The invitation belongs to a different Tenant than the claim request';
  }
  if (request.counterpartyRef.tenantId !== request.tenantId) {
    return 'The Counterparty belongs to a different Tenant than the claim request';
  }
  return request.claimant.tenantId === request.tenantId
    ? undefined
    : 'The claimant belongs to a different Tenant than the claim request';
};

const readIdentityIssue = (
  request: CounterpartyInvitationClaimPreflightRequest,
  invitation: CounterpartyAccessInvitation,
): CounterpartyInvitationClaimRejected | undefined => {
  if (
    invitation.invitationRef.tenantId !== request.tenantId ||
    invitation.counterpartyRef.tenantId !== request.tenantId
  ) {
    return rejectCounterpartyInvitationClaim(
      'invitation_tenant_mismatch',
      'The invitation read returned a different Tenant than the claim request',
    );
  }
  if (
    invitation.invitationRef.resourceId !== request.invitationRef.resourceId ||
    invitation.counterpartyRef.resourceId !== request.counterpartyRef.resourceId
  ) {
    return rejectCounterpartyInvitationClaim(
      'invitation_not_claimable',
      'The invitation read returned a different invitation or Counterparty',
    );
  }
  return sameScope(invitation.scope, request.scope)
    ? undefined
    : rejectCounterpartyInvitationClaim(
        'invitation_scope_mismatch',
        'The invitation no longer covers the requested Permission scope',
      );
};

/**
 * A claimed, claiming or reconciling invitation held by this very claimant is the convergence
 * case: a concurrent claim already won, and the loser must observe the winner's exact result
 * instead of dispatching a second claim that would duplicate an account, a binding or a grant.
 */
const claimedStateVerdict = (
  request: CounterpartyInvitationClaimPreflightRequest,
  invitation: CounterpartyAccessInvitation,
): LifecycleVerdict => {
  const { claimant } = invitation;
  if (claimant === undefined || !samePrincipal(claimant, request.claimant)) {
    return {
      kind: 'reject',
      rejection: rejectCounterpartyInvitationClaim(
        'invitation_recipient_mismatch',
        'The invitation has already been claimed by a different Principal',
      ),
    };
  }
  return {
    kind: 'converge',
    preflight: {
      decision: 'ALREADY_CLAIMED',
      invitation,
      retainedGrantProgress: invitation.grantProgress,
    },
  };
};

const lifecycleVerdict = (
  request: CounterpartyInvitationClaimPreflightRequest,
  invitation: CounterpartyAccessInvitation,
): LifecycleVerdict => {
  if (invitation.state === 'EXPIRED' || request.observedAt >= invitation.expiresAt) {
    return {
      kind: 'reject',
      rejection: rejectCounterpartyInvitationClaim(
        'invitation_expired',
        'The invitation expired before the claim was dispatched',
      ),
    };
  }
  if (invitation.state === 'REVOKED') {
    return {
      kind: 'reject',
      rejection:
        invitation.grantProgress.length === 0
          ? rejectCounterpartyInvitationClaim(
              'invitation_not_claimable',
              'The invitation was revoked before the claim was dispatched',
            )
          : rejectCounterpartyInvitationClaim(
              'invitation_replayed',
              'The invitation proof was already consumed by an earlier claim',
            ),
    };
  }
  if (invitation.state !== 'PENDING') {
    return claimedStateVerdict(request, invitation);
  }
  return invitationCanBeginClaim(invitation, request.observedAt)
    ? { kind: 'proceed' }
    : {
        kind: 'reject',
        rejection: rejectCounterpartyInvitationClaim(
          'invitation_not_claimable',
          'The invitation is not in a state a claim may begin from',
        ),
      };
};

const grantorAuthorityPermissions = (
  invitation: CounterpartyAccessInvitation,
): readonly CounterpartyPermissionCode[] =>
  invitation.intendedPermissions.some((permission) => permission === COUNTERPARTY_INVITATION_GRANTOR_PERMISSION)
    ? invitation.intendedPermissions
    : [COUNTERPARTY_INVITATION_GRANTOR_PERMISSION, ...invitation.intendedPermissions];

/**
 * The inviter must still hold, right now, the authority to delegate every Permission the
 * invitation names.  A single lost Permission fails the whole claim closed: the claim owner stages
 * the invitation's intended set atomically, so a narrowed claim would silently change what the
 * recipient was invited to, and a partial one would grant that Permission on nothing but the
 * original invitation intent.
 */
const verifyGrantorAuthority = Effect.fn('CounterpartyInvitationPreflight.verifyGrantorAuthority')(
  function* verifyGrantorAuthorityEffect(
    request: CounterpartyInvitationClaimPreflightRequest,
    invitation: CounterpartyAccessInvitation,
  ): Effect.fn.Return<
    readonly CounterpartyPermissionCode[],
    CounterpartyInvitationClaimRejected | CounterpartyAccessUnavailable,
    CounterpartyInvitationReads
  > {
    const reads = yield* CounterpartyInvitationReads;
    const decisions = yield* Effect.forEach(
      grantorAuthorityPermissions(invitation),
      (permission) =>
        reads.check({
          counterpartyRef: invitation.counterpartyRef,
          permission,
          principal: invitation.invitedBy,
          scope: request.scope,
        }),
      { concurrency: 1 },
    );
    if (decisions.some((decision) => decision === 'UNAVAILABLE')) {
      return yield* new CounterpartyAccessUnavailable({
        code: 'counterparty_access_unavailable',
        reason: 'Current grantor authority for the invited Permissions could not be established',
      });
    }
    if (decisions.some((decision) => decision !== 'ALLOWED')) {
      return yield* rejectCounterpartyInvitationClaim(
        'invitation_grantor_authority_lost',
        'The inviter no longer holds Current authority to delegate every invited Permission',
      );
    }
    return invitation.intendedPermissions;
  },
);

/**
 * Re-read the invitation and decide whether the claim owner transition may be dispatched.  A
 * `CLAIMABLE` result reports exactly the invitation's own intended Permissions, so no caller can
 * widen a claim beyond what the invitation carried; an `ALREADY_CLAIMED` result lets the losing
 * side of a concurrent claim converge on the winner's result without dispatching a second claim.
 */
export const preflightCounterpartyInvitationClaim = Effect.fn('CounterpartyInvitationPreflight.claim')(
  function* preflightCounterpartyInvitationClaimEffect(
    request: CounterpartyInvitationClaimPreflightRequest,
  ): Effect.fn.Return<
    CounterpartyInvitationClaimPreflight,
    CounterpartyInvitationClaimRejected | CounterpartyAccessDomainError,
    CounterpartyInvitationReads
  > {
    const tenantIssue = tenantBindingIssue(request);
    if (tenantIssue !== undefined) {
      return yield* rejectCounterpartyInvitationClaim('invitation_tenant_mismatch', tenantIssue);
    }
    const reads = yield* CounterpartyInvitationReads;
    const invitation = yield* reads.getInvitation({
      actor: request.claimant,
      counterpartyRef: request.counterpartyRef,
      invitationRef: request.invitationRef,
      legalEntityId: request.legalEntityId,
      scope: request.scope,
    });
    const identityIssue = readIdentityIssue(request, invitation);
    if (identityIssue !== undefined) {
      return yield* identityIssue;
    }
    const verdict = lifecycleVerdict(request, invitation);
    if (verdict.kind === 'reject') {
      return yield* verdict.rejection;
    }
    if (verdict.kind === 'converge') {
      return verdict.preflight;
    }
    yield* validateInvitationIntent(invitation).pipe(
      Effect.mapError((cause) =>
        rejectCounterpartyInvitationClaim(
          'invitation_catalog_revision_changed',
          `An invited Permission is no longer delegable in the invitation scope under the Current catalog: ${cause.code}`,
        ),
      ),
    );
    const grantablePermissions = yield* verifyGrantorAuthority(request, invitation);
    return {
      decision: 'CLAIMABLE',
      expectedRevision: invitation.revision,
      grantablePermissions,
      invitation,
    };
  },
);
