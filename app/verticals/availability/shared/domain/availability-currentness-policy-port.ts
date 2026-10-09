import { Context } from 'effect';
import type { Effect } from 'effect';
import type { AvailabilityOwnerFailure } from './availability-owner-ports.ts';
import type { AvailabilitySubject, AvailabilityUseBoundary } from './availability-subject.ts';
import type { AvailabilityLaunchPromisePolicy } from './availability-promise-policy.ts';

/** Availability owns promise policy; resolving it cannot mutate another owner's source facts. */
export interface AvailabilityPolicyPort<Policy> {
  readonly resolveCurrent: (input: {
    readonly subject: AvailabilitySubject;
    readonly useBoundary: AvailabilityUseBoundary;
  }) => Effect.Effect<Policy, AvailabilityOwnerFailure>;
}

export class AvailabilityCurrentnessPolicy extends Context.Service<
  AvailabilityCurrentnessPolicy,
  AvailabilityPolicyPort<AvailabilityLaunchPromisePolicy>
>()('@app/availability/shared/domain/availability-currentness-policy-port/AvailabilityCurrentnessPolicy') {}
