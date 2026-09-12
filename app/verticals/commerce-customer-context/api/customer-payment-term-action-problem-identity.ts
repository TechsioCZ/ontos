export type CustomerPaymentTermDomainProblemIdentity =
  | {
      readonly code: 'ENTITLEMENT_OVERLAP' | 'PREFERENCE_CONFLICT' | 'REMOVAL_CONFLICT' | 'REVISION_CONFLICT';
      readonly kind: 'conflict';
    }
  | { readonly code: 'SCOPE_MISMATCH'; readonly kind: 'forbidden' }
  | {
      readonly code:
        | 'PAYMENT_TERM_INCOMPATIBLE'
        | 'PAYMENT_TERM_NOT_CURRENT'
        | 'PAYMENT_TERM_RETIREMENT_RESERVED'
        | 'PROFILE_COUNTERPARTY_MISMATCH'
        | 'PROFILE_INELIGIBLE';
      readonly kind: 'ineligible';
    }
  | {
      readonly code: 'ENTITLEMENT_NOT_FOUND' | 'PAYMENT_TERM_NOT_FOUND' | 'PROFILE_NOT_FOUND';
      readonly kind: 'notFound';
    }
  | {
      readonly code: 'DEPENDENCY_UNAVAILABLE' | 'OUTCOME_INDETERMINATE' | 'PERSISTENCE_UNAVAILABLE';
      readonly kind: 'unavailable';
    };

export const customerPaymentTermsActionRejectedProblemByCode = {
  DEPENDENCY_UNAVAILABLE: { code: 'DEPENDENCY_UNAVAILABLE', kind: 'unavailable' },
  ENTITLEMENT_NOT_FOUND: { code: 'ENTITLEMENT_NOT_FOUND', kind: 'notFound' },
  ENTITLEMENT_OVERLAP: { code: 'ENTITLEMENT_OVERLAP', kind: 'conflict' },
  OUTCOME_INDETERMINATE: { code: 'OUTCOME_INDETERMINATE', kind: 'unavailable' },
  PAYMENT_TERM_INCOMPATIBLE: { code: 'PAYMENT_TERM_INCOMPATIBLE', kind: 'ineligible' },
  PAYMENT_TERM_NOT_CURRENT: { code: 'PAYMENT_TERM_NOT_CURRENT', kind: 'ineligible' },
  PAYMENT_TERM_NOT_FOUND: { code: 'PAYMENT_TERM_NOT_FOUND', kind: 'notFound' },
  PAYMENT_TERM_RETIREMENT_RESERVED: {
    code: 'PAYMENT_TERM_RETIREMENT_RESERVED',
    kind: 'ineligible',
  },
  PERSISTENCE_UNAVAILABLE: { code: 'PERSISTENCE_UNAVAILABLE', kind: 'unavailable' },
  PREFERENCE_CONFLICT: { code: 'PREFERENCE_CONFLICT', kind: 'conflict' },
  PROFILE_COUNTERPARTY_MISMATCH: { code: 'PROFILE_COUNTERPARTY_MISMATCH', kind: 'ineligible' },
  PROFILE_INELIGIBLE: { code: 'PROFILE_INELIGIBLE', kind: 'ineligible' },
  PROFILE_NOT_FOUND: { code: 'PROFILE_NOT_FOUND', kind: 'notFound' },
  REMOVAL_CONFLICT: { code: 'REMOVAL_CONFLICT', kind: 'conflict' },
  REVISION_CONFLICT: { code: 'REVISION_CONFLICT', kind: 'conflict' },
  SCOPE_MISMATCH: { code: 'SCOPE_MISMATCH', kind: 'forbidden' },
} as const satisfies Record<string, CustomerPaymentTermDomainProblemIdentity>;
