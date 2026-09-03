export const PARTY_SEARCH_SEMANTICS = Object.freeze({
  aliasResolution: 'CANONICAL_SURVIVOR' as const,
  archivedDefault: 'EXCLUDED' as const,
  contactPointIdentityAuthority: 'NON_UNIQUE' as const,
  physicalOwner: 'core.search' as const,
  resultMatchAuthority: 'NONE' as const,
  searchableFacts: Object.freeze([
    'DISPLAY_NAME',
    'ACTIVE_OFFICIAL_IDENTIFIER',
    'ACTIVE_EMAIL',
    'ACTIVE_PHONE',
  ] as const),
});

export const COUNTERPARTY_SEARCH_SEMANTICS = Object.freeze({
  aliasResolution: 'CANONICAL_SURVIVOR' as const,
  collisionHandling: 'SURFACE_FOR_RECONCILIATION' as const,
  deduplicateBy: 'COUNTERPARTY_IDENTITY' as const,
  legalEntityScope: 'REQUIRED_TRUSTED_CONTEXT' as const,
  physicalOwner: 'core.search' as const,
  resultMatchAuthority: 'NONE' as const,
  roleFilters: Object.freeze(['CUSTOMER', 'SUPPLIER'] as const),
  rolePeriodSemantics: 'CURRENT_AT_EFFECTIVE_TIME' as const,
});
