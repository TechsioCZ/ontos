export const LEGAL_ENTITY_SCOPES = ['required', 'optional', 'forbidden'] as const;
export type LegalEntityScope = (typeof LEGAL_ENTITY_SCOPES)[number];
