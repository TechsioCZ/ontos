/** Canonical database identity facts, safe to load in build-tool CJS configuration loaders. */
const DATABASE_SCOPE_AUTHORITIES = ['gateway_grant', 'session_setting', 'none'] as const;
export type DatabaseScopeAuthority = (typeof DATABASE_SCOPE_AUTHORITIES)[number];

const DATABASE_TABLE_PRIVILEGES = ['select', 'insert', 'update', 'delete'] as const;
export type DatabaseTablePrivilege = (typeof DATABASE_TABLE_PRIVILEGES)[number];

const DATABASE_IDENTITY_IDS = [
  'shared_runtime',
  'shell_gateway_issuer',
  'party_registry_request',
  'party_registry_worker',
] as const;
export type DatabaseIdentityId = (typeof DATABASE_IDENTITY_IDS)[number];

const DATABASE_URL_KEYS = [
  'DATABASE_URL',
  'SHELL_GATEWAY_ISSUER_DATABASE_URL',
  'PARTY_REGISTRY_DATABASE_URL',
  'PARTY_REGISTRY_WORKER_DATABASE_URL',
] as const;
export type DatabaseUrlKey = (typeof DATABASE_URL_KEYS)[number];

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
  /** The identity runs protected Actions, so it locks their access scope fence. */
  readonly runsActions: boolean;
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
  runsActions: true,
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
  runsActions: false,
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
  runsActions: true,
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
  runsActions: false,
  scopeAuthority: 'session_setting',
  urlKey: 'PARTY_REGISTRY_WORKER_DATABASE_URL',
});

export const DATABASE_IDENTITIES: readonly DatabaseIdentity[] = Object.freeze([
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  PARTY_REGISTRY_REQUEST_IDENTITY,
  PARTY_REGISTRY_WORKER_IDENTITY,
]);

export const DEDICATED_IDENTITY_MODULE_KEYS: readonly string[] = Object.freeze([
  ...new Set(
    DATABASE_IDENTITIES.flatMap((identity) => (identity.ownerModuleKey === null ? [] : [identity.ownerModuleKey])),
  ),
]);

export const BEARER_ASSERTION_ROLE_SETTINGS = Object.freeze([
  'log_parameter_max_length=0',
  'log_parameter_max_length_on_error=0',
] as const);

/**
 * What one access decision reads and writes in `core`, as the least-privilege request identity sees it.
 *
 * Every entry is reached by `access/enforcement/**` or `access/intent/**` on the request path only:
 * the acting principal's kind (actor.ts), the scope, membership, live cells, connection and teams the
 * decision is taken from (tenant-intent-loader.ts), the tenant's companies (legal-entities.ts) and the
 * one evidence row a denial, an approval request or sensitive work appends (decision-log.ts). The
 * projection writer's catalog reads and the approval store's proposal, mandate and journal writes are
 * the worker's and the admin BFF's, never the request path's, so no request identity gets them here.
 *
 * This is a declaration, not authority: a composing role only ever receives the union of these
 * columns, and PostgreSQL row security still decides which tenant's rows the request may see.
 */
export const ACCESS_DECISION_REQUEST_GRANTS: readonly DatabaseTableGrant[] = Object.freeze([
  {
    columns: { select: ['kind', 'principal_id', 'tenant_id'] },
    privileges: ['select'],
    reason: 'Core access/enforcement/actor.ts reads the acting principal kind before the engine is asked',
    table: 'core.principals',
  },
  {
    columns: { select: ['legal_entity_id', 'tenant_id'] },
    privileges: ['select'],
    reason: 'Core access/enforcement/legal-entities.ts lists the companies the engine may then narrow',
    table: 'core.legal_entities',
  },
  {
    columns: { select: ['legal_entity_id', 'scope_id', 'tenant_context_id', 'tenant_id'] },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts resolves the scope a request asks in',
    table: 'core.access_scopes',
  },
  {
    columns: {
      select: [
        'agent_id',
        'created_at',
        'kind',
        'membership_id',
        'principal_id',
        'recorded_by',
        'scope_id',
        'status',
        'tenant_id',
        'valid_from',
        'valid_until',
      ],
    },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts reads the membership deadlines of every holder (D6)',
    table: 'core.access_memberships',
  },
  {
    columns: {
      select: [
        'agent_id',
        'assigned_by',
        'delegated_by',
        'delegation_envelope_json',
        'incarnation_id',
        'principal_id',
        'role_id',
        'role_revision_id',
        'scope_id',
        'status',
        'tenant_id',
        'valid_from',
        'valid_until',
      ],
    },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts reads the live assignments of the asked capability',
    table: 'core.access_assignments',
  },
  {
    columns: {
      select: [
        'catalog_snapshot_id',
        'cells_json',
        'created_at',
        'created_by',
        'provenance',
        'revision',
        'role_id',
        'role_revision_id',
        'template_key',
        'tenant_id',
      ],
    },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts reads the role revision a live assignment pins',
    table: 'core.access_role_revisions',
  },
  {
    columns: {
      select: ['capability_key', 'grant_incarnation_id', 'mode', 'role_id', 'scope_id', 'slot', 'status', 'tenant_id'],
    },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts reads the live grant incarnation of one cell',
    table: 'core.access_grant_incarnations',
  },
  {
    columns: {
      select: [
        'amount_ceiling_json',
        'capability_keys',
        'delegation_id',
        'granted_by',
        'manager_id',
        'people',
        'role_ids',
        'scope_id',
        'status',
        'tenant_id',
        'until',
        'valid_from',
      ],
    },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts reads the delegation that bounds a delegated cell',
    table: 'core.access_delegations',
  },
  {
    columns: {
      select: [
        'agent_id',
        'connection_id',
        'principal_id',
        'revision',
        'scope_id',
        'status',
        'tenant_id',
        'valid_from',
        'valid_until',
      ],
    },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts reads the agent connection a decision is asked for',
    table: 'core.access_agent_connections',
  },
  {
    columns: { select: ['ceiling_json', 'connection_id', 'revision', 'tenant_id'] },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts reads the consent ceiling at the connection revision',
    table: 'core.access_consent_snapshots',
  },
  {
    columns: { select: ['agent_id', 'principal_id', 'team_id', 'tenant_id'] },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts reads the teams a holder takes part in (team selector)',
    table: 'core.access_team_members',
  },
  {
    columns: { select: ['scope_id', 'team_id', 'tenant_id'] },
    privileges: ['select'],
    reason: 'Core access/intent/tenant-intent-loader.ts reads the team a team membership reaches',
    table: 'core.access_teams',
  },
  {
    columns: {
      select: [
        'action_key',
        'capability_key',
        'command_digest',
        'command_json',
        'created_at',
        'proposal_id',
        'scope_id',
        'tenant_id',
      ],
    },
    privileges: ['select'],
    reason: 'Core mandate dispatch reads the frozen command bound to the proposal (O75)',
    table: 'core.access_frozen_commands',
  },
  {
    columns: { select: ['binding_id', 'incarnation', 'principal_id', 'status', 'tenant_id', 'workload_key'] },
    privileges: ['select'],
    reason: 'Core access/workloads/bindings.ts reads the active workloads the acting workload is registered for (O73)',
    table: 'core.access_workload_bindings',
  },
  {
    columns: {
      insert: [
        'actor_json',
        'actor_principal_id',
        'admission_deadline',
        'capability_key',
        'correlation_id',
        'decided_at',
        'decision_log_id',
        'delegate_app_id',
        'delegate_principal_id',
        'mode',
        'on_behalf_of_principal_id',
        'operation_id',
        'outcome',
        'reasons_json',
        'scope_id',
        'target',
        'tenant_id',
      ],
    },
    privileges: ['insert'],
    // Drizzle names every column of the table in the insert (an unset one as `default`), and PostgreSQL
    // checks the column privilege for each named column, so the request path's unset `operation_id` needs it too.
    reason:
      'Core access/enforcement/decision-log.ts appends the evidence row of one denial, approval or sensitive allow',
    table: 'core.access_decision_logs',
  },
]);

export interface TrustRoutine {
  readonly executableBy: readonly string[];
  readonly securityDefiner: boolean;
  readonly signature: string;
}

const REGISTER_GATEWAY_SCOPE_GRANT_SIGNATURE =
  'trust.register_gateway_scope_grant(text,text,uuid,uuid,uuid,uuid,timestamptz)';

/**
 * Locks one access scope fence for the Action transaction (`lockActionAccessFence`). Request
 * identities hold no grant on `core.access_scope_fences`; the routine reaches only a fence of the
 * tenant the transaction's established scope allows.
 */
const LOCK_ACCESS_SCOPE_FENCE_SIGNATURE = 'trust.lock_access_scope_fence(uuid,uuid)';

const gatewayScopeGrantRegistrarRoles = DATABASE_IDENTITIES.flatMap((identity) =>
  identity.registersGatewayScopeGrants ? [identity.role] : [],
);
const gatewayGrantRoles = DATABASE_IDENTITIES.flatMap((identity) =>
  identity.scopeAuthority === 'gateway_grant' ? [identity.role] : [],
);
const actionRunnerRoles = DATABASE_IDENTITIES.flatMap((identity) => (identity.runsActions ? [identity.role] : []));

/** Every routine in schema trust with its hardening contract and the only roles allowed to execute it. */
export const TRUST_ROUTINES: readonly TrustRoutine[] = [
  {
    executableBy: [SHARED_RUNTIME_IDENTITY.role],
    securityDefiner: true,
    signature: 'trust.open_source_execution_fence(uuid,uuid)',
  },
  {
    executableBy: [SHARED_RUNTIME_IDENTITY.role],
    securityDefiner: true,
    signature: 'trust.cancel_source_execution_fence(uuid,uuid)',
  },
  { executableBy: actionRunnerRoles, securityDefiner: true, signature: 'trust.lock_source_execution_fence(uuid,uuid)' },
  { executableBy: actionRunnerRoles, securityDefiner: true, signature: 'trust.read_source_execution_fence(uuid,uuid)' },
  {
    executableBy: [SHARED_RUNTIME_IDENTITY.role, ...gatewayGrantRoles],
    securityDefiner: true,
    signature: 'trust.registered_workload_delivery_is_active(uuid,text,text,text,uuid)',
  },
  {
    executableBy: gatewayScopeGrantRegistrarRoles,
    securityDefiner: true,
    signature: REGISTER_GATEWAY_SCOPE_GRANT_SIGNATURE,
  },
  { executableBy: gatewayGrantRoles, securityDefiner: true, signature: 'trust.establish_gateway_scope(text)' },
  { executableBy: gatewayGrantRoles, securityDefiner: true, signature: 'trust.current_tenant_id()' },
  { executableBy: gatewayGrantRoles, securityDefiner: true, signature: 'trust.current_legal_entity_id()' },
  {
    executableBy: actionRunnerRoles,
    securityDefiner: true,
    signature: LOCK_ACCESS_SCOPE_FENCE_SIGNATURE,
  },
  { executableBy: [], securityDefiner: false, signature: 'trust.verified_scope()' },
  { executableBy: [], securityDefiner: false, signature: 'trust.scope_payload(xid8,timestamptz,uuid,uuid)' },
  { executableBy: [], securityDefiner: false, signature: 'trust.scope_mac(text)' },
];
