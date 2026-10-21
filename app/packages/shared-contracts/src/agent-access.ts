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

const Text = (maximum: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

export const AGENT_WRITE_POLICIES = ['read_only', 'direct', 'approval'] as const;
export const AgentWritePolicySchema = Schema.Literals(AGENT_WRITE_POLICIES);
export type AgentWritePolicy = typeof AgentWritePolicySchema.Type;

export const AgentModuleAccessSchema = Schema.Literals(['read', 'write']);
export type AgentModuleAccess = typeof AgentModuleAccessSchema.Type;

/** One module the principal may use; modules that are not listed are not accessible at all. */
export const AgentModuleGrantSchema = Schema.Struct({
  access: AgentModuleAccessSchema,
  moduleId: Text(120),
});
export type AgentModuleGrant = typeof AgentModuleGrantSchema.Type;

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
  /** Administrator of the selected company; body `{}`; answers `AgentConnectionsOverview`. */
  agentConnections: '/shell-super-app-api/auth/identity/agent-entities/connections',
} as const;

/** Grant states shown in management (drafts are never listed). */
export const CONNECTION_STATUSES = ['active', 'denied', 'revoked', 'superseded'] as const;
export const ConnectionStatusSchema = Schema.Literals(CONNECTION_STATUSES);
export type ConnectionStatus = typeof ConnectionStatusSchema.Type;

/** `cimd` = verified client metadata document, `dcr` = registered client, `loopback` = runs on this computer. */
export const ConnectionClientKindSchema = Schema.Literals(['cimd', 'dcr', 'loopback']);
export type ConnectionClientKind = typeof ConnectionClientKindSchema.Type;

export const PrincipalRefSchema = Schema.Struct({ displayName: Schema.String, principalId: Schema.String });
export type PrincipalRef = typeof PrincipalRefSchema.Type;

export const ConnectionCompanySchema = Schema.Struct({ legalEntityId: Schema.String, legalName: Schema.String });
export type ConnectionCompany = typeof ConnectionCompanySchema.Type;

/** One module of a connection, or of the acting principal's live rights. `label` is Czech. */
export const ConnectionModuleSchema = Schema.Struct({
  label: Schema.String,
  moduleId: Schema.String,
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
    principalId: Schema.String,
  }),
  /** True when the grant covers everything the acting principal may use ("Vše, co smíte"). */
  allModules: Schema.Boolean,
  client: Schema.Struct({
    clientId: Schema.String,
    /** Redirect host shown as a badge, e.g. `chatgpt.com`, `claude.ai`, `localhost`. */
    host: Schema.String,
    kind: ConnectionClientKindSchema,
    logoUri: Schema.NullOr(Schema.String),
    name: Schema.String,
  }),
  createdAt: Schema.String,
  /** Person who connected an agent; null for a person's own connection. */
  delegatedBy: Schema.NullOr(PrincipalRefSchema),
  grantId: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  legalEntityId: Schema.String,
  legalName: Schema.String,
  limits: ConnectionLimitsSchema,
  /** Effective modules: the grant intersected with the acting principal's live rights. */
  modules: Schema.Array(ConnectionModuleSchema),
  profileId: Schema.String,
  revokedAt: Schema.NullOr(Schema.String),
  revokeReason: Schema.NullOr(Schema.String),
  status: ConnectionStatusSchema,
  tenantId: Schema.String,
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
  actingPrincipalId: Schema.optionalKey(Schema.String),
  clientId: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(ConnectionStatusSchema),
  userPrincipalId: Schema.optionalKey(Schema.String),
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
    clients: Schema.Array(Schema.Struct({ clientId: Schema.String, name: Schema.String })),
    people: Schema.Array(PrincipalRefSchema),
  }),
  /** Tiles over the company's ACTIVE connections, independent of the filter. */
  stats: Schema.Struct({ active: Schema.Finite, agentsConnected: Schema.Finite, directWrite: Schema.Finite }),
});
export type ConnectionAdminListResponse = typeof ConnectionAdminListResponseSchema.Type;

export const ConnectionUpdateRequestSchema = Schema.Struct({
  allModules: Schema.Boolean,
  grantId: Schema.String,
  /** Complete new module list; must be empty when `allModules` is true. */
  modules: Schema.Array(AgentModuleGrantSchema),
  writePolicy: AgentWritePolicySchema,
});
export type ConnectionUpdateRequest = typeof ConnectionUpdateRequestSchema.Type;

export const ConnectionRevokeRequestSchema = Schema.Struct({
  grantId: Schema.String,
  /** Required when an administrator revokes someone else's connection; optional for the owner. */
  reason: Schema.optionalKey(Text(500)),
});
export type ConnectionRevokeRequest = typeof ConnectionRevokeRequestSchema.Type;

export const ConnectionMutationResponseSchema = Schema.Struct({
  grantId: Schema.String,
  status: ConnectionStatusSchema,
});
export type ConnectionMutationResponse = typeof ConnectionMutationResponseSchema.Type;

export const AgentOperatorsRequestSchema = Schema.Struct({
  agentPrincipalId: Schema.String,
  /** Complete new operator set (SpiceDB `principal:{agent}#operator`); active people of the agent's company only. */
  operatorPrincipalIds: Schema.Array(Schema.String),
});
export type AgentOperatorsRequest = typeof AgentOperatorsRequestSchema.Type;

export const AgentOperatorsResponseSchema = Schema.Struct({
  agentPrincipalId: Schema.String,
  operators: Schema.Array(PrincipalRefSchema),
  /** Active connections revoked because their operator was removed (reason `operator_removed`). */
  revokedConnections: Schema.Finite,
});
export type AgentOperatorsResponse = typeof AgentOperatorsResponseSchema.Type;

/** Shell endpoint paths (all POST, JSON, session cookie). */
export const AGENT_ACCESS_PATHS = {
  /** Company administrator; body `{}`; answers `AgentEntityOverview`. */
  list: '/shell-super-app-api/auth/identity/agent-entities/list',
  /** Company administrator; header `idempotency-key`; body `ManageAgentEntityRequest`. */
  manage: '/shell-super-app-api/auth/identity/agent-entities',
} as const;

export const AgentAuditEntrySchema = Schema.Struct({
  actorName: Schema.NullOr(Schema.String),
  auditEventId: Schema.String,
  details: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  eventType: Schema.String,
  occurredAt: Schema.String,
  outcome: Schema.String,
  outcomeCode: Schema.String,
  targetName: Schema.NullOr(Schema.String),
});
export type AgentAuditEntry = typeof AgentAuditEntrySchema.Type;

export const AgentModuleOptionSchema = Schema.Struct({
  label: Schema.String,
  /** Highest access any role of the company has in this module. */
  maxAccess: AgentModuleAccessSchema,
  moduleId: Schema.String,
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
  displayName: Schema.String,
  modules: Schema.Array(AgentModuleGrantSchema),
  /** People allowed to connect the agent (SpiceDB `principal:{agent}#operator`). */
  operators: Schema.Array(PrincipalRefSchema),
  principalId: Schema.String,
  /** True while the profile still comes from the demo seed (no change made in the app yet). */
  seeded: Schema.Boolean,
  status: AgentStatusSchema,
  writePolicy: AgentWritePolicySchema,
});
export type AgentEntity = typeof AgentEntitySchema.Type;

export const AgentEntityOverviewSchema = Schema.Struct({
  agents: Schema.Array(AgentEntitySchema),
  audit: Schema.Array(AgentAuditEntrySchema),
  company: Schema.Struct({ legalEntityId: Schema.String, legalName: Schema.String }),
  modules: Schema.Array(AgentModuleOptionSchema),
  presets: Schema.Array(AgentRolePresetSchema),
});
export type AgentEntityOverview = typeof AgentEntityOverviewSchema.Type;

export const ManageAgentEntityRequestSchema = Schema.Union([
  Schema.Struct({
    displayName: Text(200),
    modules: Schema.Array(AgentModuleGrantSchema),
    operation: Schema.Literal('create'),
    writePolicy: AgentWritePolicySchema,
  }),
  Schema.Struct({
    displayName: Text(200),
    modules: Schema.Array(AgentModuleGrantSchema),
    operation: Schema.Literal('configure'),
    principalId: Schema.String,
    writePolicy: AgentWritePolicySchema,
  }),
  Schema.Struct({
    expectedStatus: Schema.Literals(['active', 'disabled']),
    newStatus: Schema.Literals(['active', 'disabled']),
    operation: Schema.Literal('change-status'),
    principalId: Schema.String,
    reason: Schema.optionalKey(Text(500)),
  }),
]);
export type ManageAgentEntityRequest = typeof ManageAgentEntityRequestSchema.Type;

export const ManageAgentEntityResponseSchema = Schema.Struct({
  grantsGranted: Schema.Finite,
  grantsRevoked: Schema.Finite,
  operation: Schema.Literals(['create', 'configure', 'change-status']),
  principalId: Schema.String,
  status: Schema.Literals(['active', 'disabled']),
});
export type ManageAgentEntityResponse = typeof ManageAgentEntityResponseSchema.Type;

/** Agents of the selected company with who may connect them and their connections (workforce › Lidé a role). */
export const AgentConnectionsOverviewSchema = Schema.Struct({
  /** Agents of the company with operators and active connections. */
  agents: Schema.Array(AgentEntitySchema),
  company: ConnectionCompanySchema,
  /** Active people of the company: the only allowed operators. */
  members: Schema.Array(PrincipalRefSchema),
});
export type AgentConnectionsOverview = typeof AgentConnectionsOverviewSchema.Type;
