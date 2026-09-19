import { Context, Effect, Layer } from 'effect';

import { retailPartyCandidateOwnerExecutors } from '../journeys/retail-self-enrollment-party-owner.ts';
import type { RetailPartyCandidateOwnerExecutors } from '../journeys/retail-self-enrollment-party-owner.ts';
import {
  CommerceActionCommitResolutionFailed,
  retailCustomerProfileActionExecutor,
  retailPortalBindingActionExecutor,
} from '../journeys/retail-self-enrollment-profile-owners.ts';
import type {
  RetailCustomerProfileOwnerExecutors,
  RetailPortalBindingOwnerExecutors,
} from '../journeys/retail-self-enrollment-profile-owners.ts';

/**
 * The far side of every owner dispatch seam the enrollment continuation drives, in one place.
 *
 * The continuation's registry never imports a transport directly: it asks for this set, so a
 * deployment installs the published Party Registry client and the vertical's typed Action clients
 * once, and an acceptance scenario installs scripted answers at exactly the same seam without
 * touching the driver, the Attempt routines or PostgreSQL.
 */
export interface CommerceEnrollmentOwnerEffectExecutorSet {
  readonly bindProfile: RetailPortalBindingOwnerExecutors['bindProfile'];
  /** Exact read of the binding Action invocation's committed result after a lost response. */
  readonly bindProfileCommitResolution: RetailPortalBindingOwnerExecutors['commitResolution'];
  readonly ensureProfile: RetailCustomerProfileOwnerExecutors['ensureProfile'];
  /** Exact read of the ensure Action invocation's committed result after a lost response. */
  readonly ensureProfileCommitResolution: RetailCustomerProfileOwnerExecutors['commitResolution'];
  readonly party: RetailPartyCandidateOwnerExecutors;
}

export class CommerceEnrollmentOwnerEffectExecutors extends Context.Service<
  CommerceEnrollmentOwnerEffectExecutors,
  CommerceEnrollmentOwnerEffectExecutorSet
>()(
  '@app/commerce-customer-context/enrollment/orchestration/owner-effect-executors/CommerceEnrollmentOwnerEffectExecutors',
) {}

/**
 * The governed Action runtime resolves whether one invocation committed, but it republishes no
 * Action result, and an owner verdict about a Retail Customer Profile or a Retail Portal Binding is
 * a reading of that exact result. Answering "unavailable" keeps the transition indeterminate — and
 * therefore retryable — rather than inventing a verdict from a commit flag.
 */
const actionResultNotRepublished = (): Effect.Effect<never, CommerceActionCommitResolutionFailed> =>
  Effect.fail(
    new CommerceActionCommitResolutionFailed({
      code: 'commit_resolution_unavailable',
      reason: 'The governed Action runtime republishes no Action result to reconcile this transition against',
    }),
  );

/** The deployed executors: the published Party Registry client and this vertical's Action clients. */
export const CommerceEnrollmentOwnerEffectExecutorsLive = Layer.succeed(CommerceEnrollmentOwnerEffectExecutors, {
  bindProfile: retailPortalBindingActionExecutor,
  bindProfileCommitResolution: actionResultNotRepublished,
  ensureProfile: retailCustomerProfileActionExecutor,
  ensureProfileCommitResolution: actionResultNotRepublished,
  party: retailPartyCandidateOwnerExecutors,
});
