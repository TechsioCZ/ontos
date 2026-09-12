export type RetailPortalBindingDomainProblemIdentity =
  | { readonly code: 'BINDING_CONFLICT' | 'CURRENT_STATE_CONFLICT'; readonly kind: 'conflict' }
  | {
      readonly code: 'BINDING_AMBIGUOUS' | 'ENROLLMENT_EVIDENCE_INSUFFICIENT' | 'PROFILE_NOT_ACTIVE';
      readonly kind: 'ineligible';
    }
  | { readonly code: 'BINDING_NOT_FOUND' | 'PROFILE_NOT_FOUND'; readonly kind: 'notFound' }
  | {
      readonly code: 'DEPENDENCY_UNAVAILABLE' | 'OUTCOME_INDETERMINATE' | 'PERSISTENCE_UNAVAILABLE';
      readonly kind: 'unavailable';
    };

export const retailPortalBindingActionRejectedProblemByCode = {
  BINDING_AMBIGUOUS: { code: 'BINDING_AMBIGUOUS', kind: 'ineligible' },
  BINDING_CONFLICT: { code: 'BINDING_CONFLICT', kind: 'conflict' },
  BINDING_NOT_FOUND: { code: 'BINDING_NOT_FOUND', kind: 'notFound' },
  CURRENT_STATE_CONFLICT: { code: 'CURRENT_STATE_CONFLICT', kind: 'conflict' },
  DEPENDENCY_UNAVAILABLE: { code: 'DEPENDENCY_UNAVAILABLE', kind: 'unavailable' },
  ENROLLMENT_EVIDENCE_INSUFFICIENT: {
    code: 'ENROLLMENT_EVIDENCE_INSUFFICIENT',
    kind: 'ineligible',
  },
  OUTCOME_INDETERMINATE: { code: 'OUTCOME_INDETERMINATE', kind: 'unavailable' },
  PERSISTENCE_UNAVAILABLE: { code: 'PERSISTENCE_UNAVAILABLE', kind: 'unavailable' },
  PROFILE_NOT_ACTIVE: { code: 'PROFILE_NOT_ACTIVE', kind: 'ineligible' },
  PROFILE_NOT_FOUND: { code: 'PROFILE_NOT_FOUND', kind: 'notFound' },
} as const satisfies Record<string, RetailPortalBindingDomainProblemIdentity>;
