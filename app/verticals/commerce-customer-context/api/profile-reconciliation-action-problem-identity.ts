export type ProfileReconciliationDomainProblemIdentity =
  | { readonly code: 'CURRENT_STATE_CONFLICT'; readonly kind: 'conflict' }
  | { readonly code: 'CROSS_LEGAL_ENTITY_RECONCILIATION_FORBIDDEN'; readonly kind: 'forbidden' }
  | {
      readonly code: 'RECONCILIATION_INCOMPLETE' | 'RECONCILIATION_OUT_OF_ORDER';
      readonly kind: 'ineligible';
    }
  | { readonly code: 'PROFILE_NOT_FOUND' | 'RECONCILIATION_NOT_FOUND'; readonly kind: 'notFound' }
  | {
      readonly code: 'DEPENDENCY_UNAVAILABLE' | 'OUTCOME_INDETERMINATE' | 'PERSISTENCE_UNAVAILABLE';
      readonly kind: 'unavailable';
    };

export const profileReconciliationActionRejectedProblemByCode = {
  CROSS_LEGAL_ENTITY_RECONCILIATION_FORBIDDEN: {
    code: 'CROSS_LEGAL_ENTITY_RECONCILIATION_FORBIDDEN',
    kind: 'forbidden',
  },
  CURRENT_STATE_CONFLICT: { code: 'CURRENT_STATE_CONFLICT', kind: 'conflict' },
  DEPENDENCY_UNAVAILABLE: { code: 'DEPENDENCY_UNAVAILABLE', kind: 'unavailable' },
  OUTCOME_INDETERMINATE: { code: 'OUTCOME_INDETERMINATE', kind: 'unavailable' },
  PERSISTENCE_UNAVAILABLE: { code: 'PERSISTENCE_UNAVAILABLE', kind: 'unavailable' },
  PROFILE_NOT_FOUND: { code: 'PROFILE_NOT_FOUND', kind: 'notFound' },
  RECONCILIATION_INCOMPLETE: { code: 'RECONCILIATION_INCOMPLETE', kind: 'ineligible' },
  RECONCILIATION_NOT_FOUND: { code: 'RECONCILIATION_NOT_FOUND', kind: 'notFound' },
  RECONCILIATION_OUT_OF_ORDER: { code: 'RECONCILIATION_OUT_OF_ORDER', kind: 'ineligible' },
} as const satisfies Record<string, ProfileReconciliationDomainProblemIdentity>;
