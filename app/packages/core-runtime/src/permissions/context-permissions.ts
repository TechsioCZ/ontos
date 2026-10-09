export const TENANT_PERMISSION_KEYS = [
  'access',
  'impersonate',
  'manage_identity',
  'manage_party_identity',
  'manage_party_relationships',
  'merge_party_identity',
  'read_party_identity',
  'review_party_identity',
] as const;
export type TenantPermissionKey = (typeof TENANT_PERMISSION_KEYS)[number];

export const IDENTITY_NAMESPACE_PERMISSION_KEYS = ['provision'] as const;
export type IdentityNamespacePermissionKey = (typeof IDENTITY_NAMESPACE_PERMISSION_KEYS)[number];

export const LEGAL_ENTITY_PERMISSION_KEYS = ['access', 'manage_counterparty', 'read_counterparty'] as const;
export type LegalEntityPermissionKey = (typeof LEGAL_ENTITY_PERMISSION_KEYS)[number];
