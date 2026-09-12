export type ProfileLifecycleDomainProblemIdentity =
  | {
      readonly code:
        | 'CURRENT_STATE_CONFLICT'
        | 'INVALID_LIFECYCLE_TRANSITION'
        | 'PROFILE_RECONCILIATION_REQUIRED'
        | 'REACTIVATION_RECONFIRMATION_REQUIRED';
      readonly kind: 'conflict';
    }
  | { readonly code: 'PROFILE_NOT_FOUND'; readonly kind: 'notFound' }
  | {
      readonly code: 'OUTCOME_INDETERMINATE' | 'PERSISTENCE_UNAVAILABLE';
      readonly kind: 'unavailable';
    };

export const profileLifecycleActionRejectedProblemByCode = {
  CURRENT_STATE_CONFLICT: { code: 'CURRENT_STATE_CONFLICT', kind: 'conflict' },
  INVALID_LIFECYCLE_TRANSITION: { code: 'INVALID_LIFECYCLE_TRANSITION', kind: 'conflict' },
  OUTCOME_INDETERMINATE: { code: 'OUTCOME_INDETERMINATE', kind: 'unavailable' },
  PERSISTENCE_UNAVAILABLE: { code: 'PERSISTENCE_UNAVAILABLE', kind: 'unavailable' },
  PROFILE_NOT_FOUND: { code: 'PROFILE_NOT_FOUND', kind: 'notFound' },
  PROFILE_RECONCILIATION_REQUIRED: { code: 'PROFILE_RECONCILIATION_REQUIRED', kind: 'conflict' },
  REACTIVATION_RECONFIRMATION_REQUIRED: {
    code: 'REACTIVATION_RECONFIRMATION_REQUIRED',
    kind: 'conflict',
  },
} as const satisfies Record<string, ProfileLifecycleDomainProblemIdentity>;
