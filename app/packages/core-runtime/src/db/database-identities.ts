import { fromUndefinedOr } from 'effect/Option';
import type { Option } from 'effect/Option';
import { Literals } from 'effect/Schema';

export const DatabaseScopeAuthoritySchema = Literals(['gateway_grant', 'session_setting', 'none']);
export type DatabaseScopeAuthority = typeof DatabaseScopeAuthoritySchema.Type;

const DatabaseTablePrivilegeSchema = Literals(['select', 'insert', 'update', 'delete']);
export type DatabaseTablePrivilege = typeof DatabaseTablePrivilegeSchema.Type;

export const DatabaseIdentityIdSchema = Literals([
  'shared_runtime',
  'shell_gateway_issuer',
  'party_registry_request',
  'party_registry_worker',
]);
export type DatabaseIdentityId = typeof DatabaseIdentityIdSchema.Type;

export const DatabaseUrlKeySchema = Literals([
  'DATABASE_URL',
  'SHELL_GATEWAY_ISSUER_DATABASE_URL',
  'PARTY_REGISTRY_DATABASE_URL',
  'PARTY_REGISTRY_WORKER_DATABASE_URL',
]);
export type DatabaseUrlKey = typeof DatabaseUrlKeySchema.Type;

export interface CloudflareHyperdriveBinding {
  readonly binding: string;
  readonly idVariable: string;
}

export interface DatabaseIdentity {
  readonly cloudflareHyperdrive: CloudflareHyperdriveBinding | null;
  readonly gatewayScopeAudiences: readonly string[];
  readonly handlesBearerAssertions: boolean;
  readonly id: DatabaseIdentityId;
  readonly ownerModuleKey: string | null;
  readonly registersGatewayScopeGrants: boolean;
  readonly role: string;
  readonly scopeAuthority: DatabaseScopeAuthority;
  readonly urlKey: DatabaseUrlKey;
}

export interface DatabaseTableGrant {
  /** A privilege listed here is granted on exactly these columns; otherwise on the table. */
  readonly columns?: Readonly<Partial<Record<'select' | 'insert' | 'update', readonly string[]>>>;
  readonly privileges: readonly DatabaseTablePrivilege[];
  readonly reason: string;
  /** Qualified `schema.table` name. */
  readonly table: string;
}

export interface DatabaseSequenceGrant {
  readonly privileges: readonly ('usage' | 'select')[];
  readonly reason: string;
  readonly sequence: string;
}

export interface DatabaseAcceptedFinding {
  readonly code: string;
  readonly objects: readonly string[] | 'all';
  readonly reason: string;
}

export interface DatabaseRoleGrants {
  readonly acceptedFindings: readonly DatabaseAcceptedFinding[];
  readonly routines: readonly string[];
  readonly schemas: readonly string[];
  readonly sequences: readonly DatabaseSequenceGrant[];
  readonly tables: readonly DatabaseTableGrant[];
}

const freezeIdentity = (identity: DatabaseIdentity): DatabaseIdentity =>
  Object.freeze({
    ...identity,
    cloudflareHyperdrive:
      identity.cloudflareHyperdrive === null ? null : Object.freeze({ ...identity.cloudflareHyperdrive }),
    gatewayScopeAudiences: Object.freeze([...identity.gatewayScopeAudiences]),
  });

export const SHARED_RUNTIME_IDENTITY: DatabaseIdentity = freezeIdentity({
  cloudflareHyperdrive: { binding: 'HYPERDRIVE', idVariable: 'ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID' },
  gatewayScopeAudiences: [],
  handlesBearerAssertions: false,
  id: 'shared_runtime',
  ownerModuleKey: null,
  registersGatewayScopeGrants: false,
  role: 'ontos_runtime',
  scopeAuthority: 'session_setting',
  urlKey: 'DATABASE_URL',
});

export const SHELL_GATEWAY_ISSUER_IDENTITY: DatabaseIdentity = freezeIdentity({
  cloudflareHyperdrive: {
    binding: 'GATEWAY_ISSUER_HYPERDRIVE',
    idVariable: 'ULTRAMODERN_CLOUDFLARE_GATEWAY_ISSUER_HYPERDRIVE_ID',
  },
  gatewayScopeAudiences: [],
  handlesBearerAssertions: true,
  id: 'shell_gateway_issuer',
  ownerModuleKey: null,
  registersGatewayScopeGrants: true,
  role: 'shell_gateway_issuer',
  scopeAuthority: 'none',
  urlKey: 'SHELL_GATEWAY_ISSUER_DATABASE_URL',
});

export const PARTY_REGISTRY_REQUEST_IDENTITY: DatabaseIdentity = freezeIdentity({
  cloudflareHyperdrive: {
    binding: 'PARTY_REGISTRY_HYPERDRIVE',
    idVariable: 'ULTRAMODERN_CLOUDFLARE_PARTY_REGISTRY_HYPERDRIVE_ID',
  },
  gatewayScopeAudiences: ['party-registry'],
  handlesBearerAssertions: true,
  id: 'party_registry_request',
  ownerModuleKey: 'party.registry',
  registersGatewayScopeGrants: false,
  role: 'party_registry_runtime',
  scopeAuthority: 'gateway_grant',
  urlKey: 'PARTY_REGISTRY_DATABASE_URL',
});

export const PARTY_REGISTRY_WORKER_IDENTITY: DatabaseIdentity = freezeIdentity({
  cloudflareHyperdrive: null,
  gatewayScopeAudiences: [],
  handlesBearerAssertions: false,
  id: 'party_registry_worker',
  ownerModuleKey: 'party.registry',
  registersGatewayScopeGrants: false,
  role: 'party_registry_worker',
  scopeAuthority: 'session_setting',
  urlKey: 'PARTY_REGISTRY_WORKER_DATABASE_URL',
});

export const DATABASE_IDENTITIES: readonly DatabaseIdentity[] = Object.freeze([
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  PARTY_REGISTRY_REQUEST_IDENTITY,
  PARTY_REGISTRY_WORKER_IDENTITY,
]);

export const gatewayScopeGrantRoleForAudience = (audience: string): Option<string> =>
  fromUndefinedOr(
    DATABASE_IDENTITIES.find(
      (identity) => identity.scopeAuthority === 'gateway_grant' && identity.gatewayScopeAudiences.includes(audience),
    )?.role,
  );

export const DEDICATED_IDENTITY_MODULE_KEYS: readonly string[] = Object.freeze([
  ...new Set(
    DATABASE_IDENTITIES.flatMap((identity) => (identity.ownerModuleKey === null ? [] : [identity.ownerModuleKey])),
  ),
]);

export const BEARER_ASSERTION_ROLE_SETTINGS = Object.freeze([
  'log_parameter_max_length=0',
  'log_parameter_max_length_on_error=0',
] as const);

export interface TrustRoutine {
  readonly executableBy: readonly string[];
  readonly securityDefiner: boolean;
  readonly signature: string;
}

const REGISTER_GATEWAY_SCOPE_GRANT_SIGNATURE =
  'trust.register_gateway_scope_grant(text,text,uuid,uuid,uuid,uuid,timestamptz)';

const gatewayScopeGrantRegistrarRoles = DATABASE_IDENTITIES.flatMap((identity) =>
  identity.registersGatewayScopeGrants ? [identity.role] : [],
);
const gatewayGrantRoles = DATABASE_IDENTITIES.flatMap((identity) =>
  identity.scopeAuthority === 'gateway_grant' ? [identity.role] : [],
);

/** Every routine in schema trust with its hardening contract and the only roles allowed to execute it. */
export const TRUST_ROUTINES: readonly TrustRoutine[] = [
  {
    executableBy: gatewayScopeGrantRegistrarRoles,
    securityDefiner: true,
    signature: REGISTER_GATEWAY_SCOPE_GRANT_SIGNATURE,
  },
  { executableBy: gatewayGrantRoles, securityDefiner: true, signature: 'trust.establish_gateway_scope(text)' },
  { executableBy: gatewayGrantRoles, securityDefiner: true, signature: 'trust.current_tenant_id()' },
  { executableBy: gatewayGrantRoles, securityDefiner: true, signature: 'trust.current_legal_entity_id()' },
  { executableBy: [], securityDefiner: false, signature: 'trust.verified_scope()' },
  { executableBy: [], securityDefiner: false, signature: 'trust.scope_payload(xid8,timestamptz,uuid,uuid)' },
  { executableBy: [], securityDefiner: false, signature: 'trust.scope_mac(text)' },
];
