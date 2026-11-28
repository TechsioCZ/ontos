import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';

/** A native Privacy Action seals exactly this source-to-subject assertion. No source identifier leaves the owner. */
export const sourceChildBindingCommitment = (
  authorizationId: string,
  privacyInvocationId: string,
  key: string,
  subjectId: string,
) =>
  computeCanonicalValueHash([
    'privacy.core.source-child-binding.v1',
    authorizationId,
    privacyInvocationId,
    key,
    subjectId,
  ]);
