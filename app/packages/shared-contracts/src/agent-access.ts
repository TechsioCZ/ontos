// Agent entities and MCP access tokens (lane agent-entities). Shared wire contract of the shell endpoints, the
// people-administration page (workforce), the shell profile page and the MCP gateway.
//
//   Agent entity  non-human principal (Core kind `agent`) of exactly one company. The company administrator names
//                 it, picks per module `read` / `write` and a write policy. Grants are written to SpiceDB with the
//                 same relationships the company's human roles use (copied from the role template personas).
//   Write policy  `read_only`  Core grants are read-only.
//                 `direct`     Core grants follow `modules` (write modules get executor + write permissions).
//                 `approval`   Core grants are READ-ONLY. `modules[].access === 'write'` lists where the agent may
//                              PROPOSE changes; an approved proposal runs as the approving human (approvals lane).
//   MCP token     a managed Better Auth API key (agent) or a personal API key (human), scoped to one company.
//                 Clients send it as `Authorization: Bearer <token>` to the MCP gateway, which forwards it as
//                 `x-api-key` to `describe` and to `/shell-super-app-api/auth/api-key/gateway-context`.
//                 Deactivating the principal or revoking the token takes effect on the next request.
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

/** Shell endpoint paths (all POST, JSON). Admin and personal endpoints use the session cookie. */
export const AGENT_ACCESS_PATHS = {
  /** `x-api-key: <token>`; answers `AgentAccessDescription`, 401 for an unknown/revoked token or inactive principal. */
  describe: '/shell-super-app-api/auth/agent-access/describe',
  /** Company administrator; body `{}`; answers `AgentEntityOverview`. */
  list: '/shell-super-app-api/auth/identity/agent-entities/list',
  /** Company administrator; header `idempotency-key`; body `ManageAgentEntityRequest`. */
  manage: '/shell-super-app-api/auth/identity/agent-entities',
  /** Company administrator; header `idempotency-key`; body `AgentTokenRequest`; answers `McpTokenIssueResponse`. */
  token: '/shell-super-app-api/auth/identity/agent-entities/token',
  /** Any signed-in person; body `{}`; answers `PersonalMcpOverview` for the selected company. */
  personalList: '/shell-super-app-api/auth/identity/personal-mcp/list',
  /** Any signed-in person; header `idempotency-key`; body `PersonalMcpTokenRequest`. */
  personalToken: '/shell-super-app-api/auth/identity/personal-mcp/token',
} as const;

/** Public MCP endpoint used in connection snippets when `ONTOS_MCP_PUBLIC_URL` is not set (mcp-gateway lane). */
export const DEFAULT_MCP_PUBLIC_URL = 'http://localhost:3020/mcp';

/** Token metadata; the secret itself is returned only once, by the issue/rotate answer. */
export const McpTokenSchema = Schema.Struct({
  authBindingId: Schema.String,
  /** ISO 8601. */
  createdAt: Schema.String,
  enabled: Schema.Boolean,
  /** ISO 8601 of the last audited use (`authn.api_key_used`), null when never used. */
  lastUsedAt: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  /** First characters of the secret, for recognition. */
  start: Schema.NullOr(Schema.String),
});
export type McpToken = typeof McpTokenSchema.Type;

/** What a token may do. Read by the MCP gateway (and approvals) before every tool call. */
export const AgentAccessDescriptionSchema = Schema.Struct({
  authBindingId: Schema.String,
  displayName: Schema.String,
  /** The only company the token works in; pass it as `legalEntityId` to the gateway-context endpoint. */
  legalEntityId: Schema.String,
  legalName: Schema.String,
  /** Agent: the configured modules. Human: empty (the person's own role grants apply, Core decides). */
  modules: Schema.Array(AgentModuleGrantSchema),
  principalId: Schema.String,
  principalKind: Schema.Literals(['agent', 'human']),
  tenantId: Schema.String,
  /** Human: always `direct` (the token acts exactly as the person). */
  writePolicy: AgentWritePolicySchema,
});
export type AgentAccessDescription = typeof AgentAccessDescriptionSchema.Type;

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
  displayName: Schema.String,
  modules: Schema.Array(AgentModuleGrantSchema),
  principalId: Schema.String,
  /** True while the profile still comes from the demo seed (no change made in the app yet). */
  seeded: Schema.Boolean,
  status: AgentStatusSchema,
  /** Active and disabled tokens (revoked ones are omitted). */
  tokens: Schema.Array(McpTokenSchema),
  writePolicy: AgentWritePolicySchema,
});
export type AgentEntity = typeof AgentEntitySchema.Type;

export const AgentEntityOverviewSchema = Schema.Struct({
  agents: Schema.Array(AgentEntitySchema),
  audit: Schema.Array(AgentAuditEntrySchema),
  company: Schema.Struct({ legalEntityId: Schema.String, legalName: Schema.String }),
  mcpUrl: Schema.String,
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

export const AgentTokenRequestSchema = Schema.Union([
  Schema.Struct({ operation: Schema.Literal('issue'), principalId: Schema.String }),
  Schema.Struct({
    authBindingId: Schema.String,
    operation: Schema.Literal('rotate'),
    principalId: Schema.String,
    reason: Text(500),
  }),
  Schema.Struct({
    authBindingId: Schema.String,
    operation: Schema.Literal('revoke'),
    principalId: Schema.String,
    reason: Text(500),
  }),
]);
export type AgentTokenRequest = typeof AgentTokenRequestSchema.Type;

export const McpTokenIssueResponseSchema = Schema.Struct({
  mcpUrl: Schema.String,
  /** Plain secret, present once for issue/rotate, null for revoke. Responses are `cache-control: no-store`. */
  secret: Schema.NullOr(Schema.String),
  token: McpTokenSchema,
});
export type McpTokenIssueResponse = typeof McpTokenIssueResponseSchema.Type;

export const PersonalMcpOverviewSchema = Schema.Struct({
  company: Schema.Struct({ legalEntityId: Schema.String, legalName: Schema.String }),
  displayName: Schema.String,
  mcpUrl: Schema.String,
  /** Personal tokens of the signed-in person scoped to the selected company (revoked omitted). */
  tokens: Schema.Array(McpTokenSchema),
});
export type PersonalMcpOverview = typeof PersonalMcpOverviewSchema.Type;

export const PersonalMcpTokenRequestSchema = Schema.Union([
  Schema.Struct({ operation: Schema.Literal('issue') }),
  Schema.Struct({ authBindingId: Schema.String, operation: Schema.Literal('revoke'), reason: Text(500) }),
]);
export type PersonalMcpTokenRequest = typeof PersonalMcpTokenRequestSchema.Type;

export interface McpConnectionSnippets {
  /** ChatGPT (Settings › Connectors › custom MCP server): server URL + Authorization header value. */
  readonly chatgptAuthorization: string;
  readonly chatgptUrl: string;
  /** `claude mcp add` command for Claude Code. */
  readonly claudeCodeCommand: string;
  /** `claude_desktop_config.json` fragment (Claude Desktop through the `mcp-remote` bridge). */
  readonly claudeDesktopJson: string;
}

/** Ready-to-paste connection snippets for one token. */
export const mcpConnectionSnippets = (mcpUrl: string, secret: string, serverName = 'ontos'): McpConnectionSnippets => ({
  chatgptAuthorization: `Bearer ${secret}`,
  chatgptUrl: mcpUrl,
  claudeCodeCommand: `claude mcp add --transport http ${serverName} ${mcpUrl} --header "Authorization: Bearer ${secret}"`,
  claudeDesktopJson: JSON.stringify(
    {
      mcpServers: {
        [serverName]: {
          args: ['-y', 'mcp-remote', mcpUrl, '--header', `Authorization: Bearer ${secret}`],
          command: 'npx',
        },
      },
    },
    null,
    2,
  ),
});
