import type { DatabaseIdentity } from './database-identity-manifest.ts';

/** Static identity data must load in build configuration without an Effect runtime. */
export const freezeIdentity = (identity: DatabaseIdentity): DatabaseIdentity =>
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
export const BEARER_ASSERTION_ROLE_SETTINGS = Object.freeze([
  'log_parameter_max_length=0',
  'log_parameter_max_length_on_error=0',
] as const);
