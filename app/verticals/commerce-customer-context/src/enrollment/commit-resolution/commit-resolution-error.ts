import type { CommerceEnrollmentCommitResolutionRejected } from './commit-resolution-rejected.ts';
import type { CommerceEnrollmentCommitResolutionRevoked } from './commit-resolution-revoked.ts';
import type { CommerceEnrollmentCommitResolutionUnavailable } from './commit-resolution-unavailable.ts';

export type CommerceEnrollmentCommitResolutionError =
  | InstanceType<typeof CommerceEnrollmentCommitResolutionRejected>
  | InstanceType<typeof CommerceEnrollmentCommitResolutionRevoked>
  | InstanceType<typeof CommerceEnrollmentCommitResolutionUnavailable>;
