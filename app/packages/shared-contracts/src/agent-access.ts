// Agent entities and OAuth connection management (lanes agent-entities, mcp-connections-ui). Shared wire contract of
// the shell endpoints, the people-administration page (workforce) and the shell profile page.
//
//   Agent entity  non-human principal (Core kind `agent`) of exactly one company. The company administrator names
//                 it, picks per module `read` / `write` and a write policy. Grants are written to SpiceDB with the
//                 same relationships the company's human roles use (copied from the role template personas).
//   Write policy  `read_only`  Core grants are read-only.
//                 `direct`     Core grants follow `modules` (write modules get executor + write permissions).
//                 `approval`   Core grants are READ-ONLY. `modules[].access === 'write'` lists where the agent may
//                              PROPOSE changes; an approved proposal runs as the approving human (approvals lane).
//   Connection    an OAuth grant (ONTOS-MCP-AUTH-DESIGN.md): a person adds the OntOS MCP URL to ChatGPT or Claude,
//                 signs in and approves; nobody copies a token. Management types follow `CONNECTION_MANAGEMENT_PATHS`.
import { Schema } from 'effect';

import { AgentLegalEntityIdSchema, AgentModuleKeySchema, AgentPrincipalIdSchema } from './agent-proposals.ts';

export const AgentAccessClientIdSchema = Schema.String.pipe(Schema.brand('OAuthClientId'));
export const AgentAccessGrantIdSchema = Schema.String.pipe(Schema.brand('OAuthGrantId'));
export const AgentAccessProfileIdSchema = Schema.String.pipe(Schema.brand('OAuthProfileId'));
export const AgentAccessTenantIdSchema = Schema.String.pipe(Schema.brand('TenantId'));
export const AgentAccessAuditEventIdSchema = Schema.String.pipe(Schema.brand('AuditEventId'));

const Text = (maximum: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

export const AGENT_WRITE_POLICIES = ['read_only', 'direct', 'approval'] as const;
export const AgentWritePolicySchema = Schema.Literals(AGENT_WRITE_POLICIES);
export type AgentWritePolicy = typeof AgentWritePolicySchema.Type;

export const AgentModuleAccessSchema = Schema.Literals(['read', 'write']);
export type AgentModuleAccess = typeof AgentModuleAccessSchema.Type;

/** One module the principal may use; modules that are not listed are not accessible at all. */
export const AgentModuleGrantSchema = Schema.Struct({
  access: AgentModuleAccessSchema,
  moduleId: AgentModuleKeySchema.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
});
export type AgentModuleGrant = typeof AgentModuleGrantSchema.Type;

const AgentExpectedStatusSchema = Schema.Literals(['active', 'disabled']);
export const AgentStatusSchema = Schema.Literals(['active', 'disabled', 'archived']);
export type AgentStatus = typeof AgentStatusSchema.Type;

// ---------------------------------------------------------------------------------------------------------------
// OAuth connections: management ("Připojené aplikace", lane mcp-connections-ui, ONTOS-MCP-AUTH-DESIGN.md §7.2).
// The connect flow and the private connector surface live in `./oauth-connections.ts` (lane connection-grants).

/** Session-authenticated management endpoints (all POST, JSON, answered with `cache-control: no-store`). */
export const CONNECTION_MANAGEMENT_PATHS = {
  /** Any signed-in person; body `{}`; answers `ConnectionListResponse` (the person's active connections). */
  mine: '/shell-super-app-api/auth/oauth-connections/mine',
  /** Administrator of the selected company; body `ConnectionAdminListRequest`; answers `ConnectionAdminListResponse`. */
  adminList: '/shell-super-app-api/auth/oauth-connections/admin-list',
  /** Owner of the connection; body `ConnectionUpdateRequest`; answers `ConnectionMutationResponse`. Narrowing only. */
  update: '/shell-super-app-api/auth/oauth-connections/update',
  /** Owner, or administrator of the connection's company; body `ConnectionRevokeRequest`; answers `ConnectionMutationResponse`. */
  revoke: '/shell-super-app-api/auth/oauth-connections/revoke',
  /** Administrator of the selected company; body `AgentOperatorsRequest`; answers `AgentOperatorsResponse`. */
  operators: '/shell-super-app-api/auth/identity/agent-entities/operators',
} as const;

/** Grant states shown in management (drafts are never listed). */
export const CONNECTION_STATUSES = ['active', 'denied', 'revoked', 'superseded'] as const;
export const ConnectionStatusSchema = Schema.Literals(CONNECTION_STATUSES);
export type ConnectionStatus = typeof ConnectionStatusSchema.Type;

/** `cimd` = verified client metadata document, `dcr` = registered client, `loopback` = runs on this computer. */
export const ConnectionClientKindSchema = Schema.Literals(['cimd', 'dcr', 'loopback']);
export type ConnectionClientKind = typeof ConnectionClientKindSchema.Type;

export const PrincipalRefSchema = Schema.Struct({ displayName: Schema.String, principalId: AgentPrincipalIdSchema });
export type PrincipalRef = typeof PrincipalRefSchema.Type;

export const ConnectionCompanySchema = Schema.Struct({
  legalEntityId: AgentLegalEntityIdSchema,
  legalName: Schema.String,
});
export type ConnectionCompany = typeof ConnectionCompanySchema.Type;

/** One module of a connection, or of the acting principal's live rights. `label` is Czech. */
export const ConnectionModuleSchema = Schema.Struct({
  label: Schema.String,
  moduleId: AgentModuleKeySchema,
  read: Schema.Boolean,
  write: Schema.Boolean,
});
export type ConnectionModule = typeof ConnectionModuleSchema.Type;

/** What the acting principal may do right now. An update may only stay within these limits. */
export const ConnectionLimitsSchema = Schema.Struct({
  maxWritePolicy: AgentWritePolicySchema,
  modules: Schema.Array(ConnectionModuleSchema),
});
export type ConnectionLimits = typeof ConnectionLimitsSchema.Type;

/** One OAuth connection (grant) as management screens show it. Times are ISO 8601. */
export const ConnectionSummarySchema = Schema.Struct({
  acting: Schema.Struct({
    displayName: Schema.String,
    kind: Schema.Literals(['human', 'agent']),
    principalId: AgentPrincipalIdSchema,
  }),
  /** True when the grant covers everything the acting principal may use ("Vše, co smíte"). */
  allModules: Schema.Boolean,
  client: Schema.Struct({
    clientId: AgentAccessClientIdSchema,
    /** Redirect host shown as a badge, e.g. `chatgpt.com`, `claude.ai`, `localhost`. */
    host: Schema.String,
    kind: ConnectionClientKindSchema,
    logoUri: Schema.OptionFromNullOr(Schema.String),
    name: Schema.String,
  }),
  createdAt: Schema.DateTimeUtcFromString,
  /** Person who connected an agent; null for a person's own connection. */
  delegatedBy: Schema.OptionFromNullOr(PrincipalRefSchema),
  grantId: AgentAccessGrantIdSchema,
  lastUsedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
  legalEntityId: AgentLegalEntityIdSchema,
  legalName: Schema.String,
  limits: ConnectionLimitsSchema,
  /**
   * What the connection may use at most, as approved on the consent screen and narrowed since. "Upravit přístup"
   * may only stay within it (and within `limits`); widening needs a new connection with a new consent.
   */
  granted: Schema.Struct({
    /** Empty when `allModules` is true. */
    modules: Schema.Array(AgentModuleGrantSchema),
    writePolicy: AgentWritePolicySchema,
  }),
  /** Effective modules: the grant intersected with the acting principal's live rights. */
  modules: Schema.Array(ConnectionModuleSchema),
  profileId: AgentAccessProfileIdSchema,
  revokedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
  /** Revocation code (`user`, `admin`, `superseded`, `operator_removed`, …); null while active. */
  revokeReason: Schema.OptionFromNullOr(Schema.String),
  /** Free-text reason an administrator gave when revoking (from the `oauth.connection.revoked` audit row). */
  revokeNote: Schema.OptionFromNullOr(Schema.String),
  status: ConnectionStatusSchema,
  tenantId: AgentAccessTenantIdSchema,
  /** Person who approved the connection. */
  user: PrincipalRefSchema,
  /** Effective write policy: the stricter of the grant and the agent profile. */
  writePolicy: AgentWritePolicySchema,
});
export type ConnectionSummary = typeof ConnectionSummarySchema.Type;

export const ConnectionListResponseSchema = Schema.Struct({
  connections: Schema.Array(ConnectionSummarySchema),
  /** MCP server URL people paste into ChatGPT or Claude (`ONTOS_MCP_RESOURCE_URL`). A URL, not a credential. */
  mcpUrl: Schema.String,
});
export type ConnectionListResponse = typeof ConnectionListResponseSchema.Type;

export const ConnectionAdminFilterSchema = Schema.Struct({
  actingPrincipalId: Schema.optionalKey(AgentPrincipalIdSchema),
  clientId: Schema.optionalKey(AgentAccessClientIdSchema),
  /** A `ConnectionStatus`; any other value is answered with a Czech 422 problem, not a bare 400. */
  status: Schema.optionalKey(Schema.String),
  userPrincipalId: Schema.optionalKey(AgentPrincipalIdSchema),
});
export type ConnectionAdminFilter = typeof ConnectionAdminFilterSchema.Type;

export const ConnectionAdminListRequestSchema = Schema.Struct({ filter: ConnectionAdminFilterSchema });
export type ConnectionAdminListRequest = typeof ConnectionAdminListRequestSchema.Type;

export const ConnectionAdminListResponseSchema = Schema.Struct({
  company: ConnectionCompanySchema,
  /** Connections of the selected company that match the filter, newest first. */
  connections: Schema.Array(ConnectionSummarySchema),
  /** Choices for the filters, from every connection of the company (not only the filtered ones). */
  filterOptions: Schema.Struct({
    agents: Schema.Array(PrincipalRefSchema),
    clients: Schema.Array(Schema.Struct({ clientId: AgentAccessClientIdSchema, name: Schema.String })),
    people: Schema.Array(PrincipalRefSchema),
  }),
  /** Public environment MCP resource URL for the connection guide; never a credential. */
  mcpUrl: Schema.String,
  /** Tiles over the company's ACTIVE connections, independent of the filter. */
  stats: Schema.Struct({ active: Schema.Finite, agentsConnected: Schema.Finite, directWrite: Schema.Finite }),
});
export type ConnectionAdminListResponse = typeof ConnectionAdminListResponseSchema.Type;

export const ConnectionUpdateRequestSchema = Schema.Struct({
  allModules: Schema.Boolean,
  grantId: AgentAccessGrantIdSchema,
  /** Complete new module list; must be empty when `allModules` is true. */
  modules: Schema.Array(AgentModuleGrantSchema),
  writePolicy: AgentWritePolicySchema,
});
export type ConnectionUpdateRequest = typeof ConnectionUpdateRequestSchema.Type;

export const CONNECTION_REVOKE_REASON_MAX = 500;

export const ConnectionRevokeRequestSchema = Schema.Struct({
  grantId: AgentAccessGrantIdSchema,
  /**
   * Required when an administrator revokes someone else's connection; optional for the owner. At most
   * `CONNECTION_REVOKE_REASON_MAX` characters, checked by the handler so a longer one gets a Czech 422 problem.
   */
  reason: Schema.optionalKey(Schema.String),
});
export type ConnectionRevokeRequest = typeof ConnectionRevokeRequestSchema.Type;

export const ConnectionMutationResponseSchema = Schema.Struct({
  grantId: AgentAccessGrantIdSchema,
  status: ConnectionStatusSchema,
});
export type ConnectionMutationResponse = typeof ConnectionMutationResponseSchema.Type;

export const AgentOperatorsRequestSchema = Schema.Struct({
  agentPrincipalId: AgentPrincipalIdSchema,
  /** Complete new operator set (SpiceDB `principal:{agent}#operator`); active people of the agent's company only. */
  operatorPrincipalIds: Schema.Array(AgentPrincipalIdSchema),
});
export type AgentOperatorsRequest = typeof AgentOperatorsRequestSchema.Type;

export const AgentOperatorsResponseSchema = Schema.Struct({
  agentPrincipalId: AgentPrincipalIdSchema,
  operators: Schema.Array(PrincipalRefSchema),
  /** Active connections revoked because their operator was removed (reason `operator_removed`). */
  revokedConnections: Schema.Finite,
});
export type AgentOperatorsResponse = typeof AgentOperatorsResponseSchema.Type;

/**
 * Shell endpoint paths (all POST, JSON, session cookie, `cache-control: no-store`). Errors are problem JSON whose
 * `detail` is Czech: 403 not the company administrator, 404 unknown agent, 409 changed meanwhile, 422 invalid input.
 */
export const AGENT_ACCESS_PATHS = {
  /** Company administrator; body `{}`; answers `AgentEntityOverview`. */
  list: '/shell-super-app-api/auth/identity/agent-entities/list',
  /** Company administrator; header `idempotency-key`; body `ManageAgentEntityRequest`; answers `ManageAgentEntityResponse`. */
  manage: '/shell-super-app-api/auth/identity/agent-entities',
} as const;

export const AGENT_NAME_MAX = 200;
export const AGENT_DESCRIPTION_MAX = 500;
export const AGENT_REASON_MAX = 500;

export const AgentAuditEntrySchema = Schema.Struct({
  actorName: Schema.OptionFromNullOr(Schema.String),
  auditEventId: AgentAccessAuditEventIdSchema,
  details: Schema.Record(Schema.String, Schema.OptionFromNullOr(Schema.String)),
  eventType: Schema.String,
  occurredAt: Schema.DateTimeUtcFromString,
  outcome: Schema.String,
  outcomeCode: Schema.String,
  targetName: Schema.OptionFromNullOr(Schema.String),
});
export type AgentAuditEntry = typeof AgentAuditEntrySchema.Type;

export const AgentModuleOptionSchema = Schema.Struct({
  label: Schema.String,
  /** Highest access any role of the company has in this module. */
  maxAccess: AgentModuleAccessSchema,
  moduleId: AgentModuleKeySchema,
});
export type AgentModuleOption = typeof AgentModuleOptionSchema.Type;

/** A human role of the company as a module preset ("Převzít oprávnění z role"). */
export const AgentRolePresetSchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  modules: Schema.Array(AgentModuleGrantSchema),
});
export type AgentRolePreset = typeof AgentRolePresetSchema.Type;

export const AgentEntitySchema = Schema.Struct({
  /** Active connections acting as this agent. */
  connections: Schema.Array(ConnectionSummarySchema),
  /** What the agent is for (administrator's text); null when left empty. */
  description: Schema.OptionFromNullOr(Schema.String),
  displayName: Schema.String,
  /** Whether an audited agent profile has been configured. */
  hasProfile: Schema.Boolean,
  modules: Schema.Array(AgentModuleGrantSchema),
  /** People allowed to connect the agent (SpiceDB `principal:{agent}#operator`). */
  operators: Schema.Array(PrincipalRefSchema),
  /** Person of the company responsible for the agent; null when no audited profile owner was chosen. */
  owner: Schema.OptionFromNullOr(PrincipalRefSchema),
  principalId: AgentPrincipalIdSchema,
  status: AgentStatusSchema,
  writePolicy: AgentWritePolicySchema,
});
export type AgentEntity = typeof AgentEntitySchema.Type;

/** Lidé a role › Agentní entity: everything the administrator page needs in one answer. */
export const AgentEntityOverviewSchema = Schema.Struct({
  /** Agents of the company (active and deactivated; deleted agents are gone), sorted by name (cs). */
  agents: Schema.Array(AgentEntitySchema),
  /** Newest first: agent create/configure/status/delete rows and operator changes of this company. */
  audit: Schema.Array(AgentAuditEntrySchema),
  company: Schema.Struct({ legalEntityId: AgentLegalEntityIdSchema, legalName: Schema.String }),
  /** Active people of the company: the only allowed owners and operators. */
  members: Schema.Array(PrincipalRefSchema),
  /** Modules an agent of this company may get, sorted by label (cs). */
  modules: Schema.Array(AgentModuleOptionSchema),
  /** The company's human roles as module presets, in role order. */
  presets: Schema.Array(AgentRolePresetSchema),
});
export type AgentEntityOverview = typeof AgentEntityOverviewSchema.Type;

/**
 * `create`      new agent; `modules` may only use `AgentEntityOverview.modules` (access <= maxAccess); owner and
 *               operators must be active people of the company. Grants follow the module list and the write policy.
 * `configure`   replaces name, description, owner, modules and write policy (operators: `CONNECTION_MANAGEMENT_PATHS.operators`).
 * `change-status` deactivate (`reason` required) or reactivate. Deactivation revokes the agent's active connections.
 * `delete`      archives the agent: its grants, operators and active connections are removed; it leaves the list.
 */
export const ManageAgentEntityRequestSchema = Schema.Union([
  Schema.Struct({
    description: Schema.OptionFromNullOr(Text(AGENT_DESCRIPTION_MAX)),
    displayName: Text(AGENT_NAME_MAX),
    modules: Schema.Array(AgentModuleGrantSchema),
    operation: Schema.Literal('create'),
    operatorPrincipalIds: Schema.Array(AgentPrincipalIdSchema),
    ownerPrincipalId: AgentPrincipalIdSchema,
    writePolicy: AgentWritePolicySchema,
  }),
  Schema.Struct({
    description: Schema.OptionFromNullOr(Text(AGENT_DESCRIPTION_MAX)),
    displayName: Text(AGENT_NAME_MAX),
    modules: Schema.Array(AgentModuleGrantSchema),
    operation: Schema.Literal('configure'),
    ownerPrincipalId: AgentPrincipalIdSchema,
    principalId: AgentPrincipalIdSchema,
    writePolicy: AgentWritePolicySchema,
  }),
  Schema.Struct({
    expectedStatus: AgentExpectedStatusSchema,
    newStatus: AgentExpectedStatusSchema,
    operation: Schema.Literal('change-status'),
    principalId: AgentPrincipalIdSchema,
    reason: Schema.optionalKey(Text(AGENT_REASON_MAX)),
  }),
  Schema.Struct({
    /** Original expected-before state, retained with the idempotency key even after archive removes the agent. */
    expectedStatus: AgentExpectedStatusSchema,
    operation: Schema.Literal('delete'),
    principalId: AgentPrincipalIdSchema,
    reason: Text(AGENT_REASON_MAX),
  }),
]);
export type ManageAgentEntityRequest = typeof ManageAgentEntityRequestSchema.Type;

export const ManageAgentEntityResponseSchema = Schema.Struct({
  grantsGranted: Schema.Finite,
  grantsRevoked: Schema.Finite,
  operation: Schema.Literals(['create', 'configure', 'change-status', 'delete']),
  principalId: AgentPrincipalIdSchema,
  /** Active connections of the agent revoked by this change (deactivation, deletion). */
  revokedConnections: Schema.Finite,
  status: AgentStatusSchema,
});
export type ManageAgentEntityResponse = typeof ManageAgentEntityResponseSchema.Type;
