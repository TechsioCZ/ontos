export type TenantStatus = 'active' | 'suspended' | 'archived';
export type PrincipalKind = 'human' | 'service' | 'integration' | 'agent' | 'system';
export type PrincipalStatus = 'active' | 'disabled' | 'revoked';
export type AuthSubjectType = 'user' | 'api_key';

export type TenantModuleState =
  | 'inactive'
  | 'active'
  | 'read_only'
  | 'suspended'
  | 'quarantined'
  | 'deprecated'
  | 'archived';

export interface RuntimeTenant {
  tenantId: string;
  slug: string;
  name: string;
  status: TenantStatus;
  defaultLocale: string;
}

export interface RuntimeLegalEntity {
  legalEntityId: string;
  tenantId: string;
  legalName: string;
  registrationCountry: string;
  registrationNumber: string;
  vatId: string | null;
  status: string;
}

export interface RuntimePrincipal {
  principalId: string;
  tenantId: string;
  kind: PrincipalKind;
  displayName: string;
  status: PrincipalStatus;
  authBindingId: string;
  provider: 'better_auth';
  subjectType: AuthSubjectType;
  providerSubjectId: string;
}

export interface RuntimeModuleState {
  tenantId: string;
  moduleKey: string;
  state: TenantModuleState;
}

export interface RuntimeContext {
  tenant: RuntimeTenant;
  legalEntity: RuntimeLegalEntity;
  principal: RuntimePrincipal;
  moduleStates: RuntimeModuleState[];
  auth: {
    method: 'session' | 'api_key';
    contextRef: string;
  };
}

export interface RuntimeContextInput {
  providerSubjectId: string;
  tenantSlug?: string;
  authMethod?: 'session' | 'api_key';
  authContextRef?: string;
}

export type SerializableFailureCode =
  | 'context_missing'
  | 'tenant_not_active'
  | 'principal_not_active'
  | 'module_not_writable'
  | 'authorization_denied'
  | 'policy_denied'
  | 'runtime_error';

export type SerializableGateResult =
  | {
      ok: true;
      tenantSlug: string;
      principalId: string;
      moduleKey: string;
      moduleState: TenantModuleState;
      authorization: 'allowed';
      policy: 'allowed';
    }
  | {
      ok: false;
      code: SerializableFailureCode;
      message: string;
      tenantSlug?: string;
      principalId?: string;
      moduleKey?: string;
      moduleState?: TenantModuleState;
      authorization?: 'allowed' | 'denied' | 'unavailable';
      policy?: 'allowed' | 'denied';
    };
