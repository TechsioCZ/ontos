import type { CommerceEnrollmentOwnerEffectIndeterminate } from './owner-effect-indeterminate.ts';
import type { CommerceEnrollmentOwnerEffectRejected } from './owner-effect-rejected.ts';
import type { CommerceEnrollmentOwnerEffectUnavailable } from './owner-effect-unavailable.ts';

export type CommerceEnrollmentOwnerEffectError =
  | InstanceType<typeof CommerceEnrollmentOwnerEffectRejected>
  | InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable>
  | InstanceType<typeof CommerceEnrollmentOwnerEffectIndeterminate>;
