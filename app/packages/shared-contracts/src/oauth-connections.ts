// MCP OAuth connections (ONTOS-MCP-AUTH-DESIGN.md §3, §4, §5.4). Shared wire contract of the shell connect flow
// (/cs/pripojit, /cs/pripojit/souhlas) and the "Připojené aplikace" management endpoints. The MCP endpoint itself is
// the Shell's `/mcp` route; it verifies tokens and describes connections in-process.
//
//   Connection grant  one row per approved connection: one company + one acting principal (me or an agent I may
//                     operate) + requested modules + write policy. Its id is the Better Auth consent referenceId and
//                     the access-token claim `https://ontos.cz/grant`.
//   MCP request       `authorization: Bearer <user access JWT>` (aud = `<shell>/mcp`). 401 = token/grant invalid,
//                     revoked or principal inactive (the host re-runs OAuth).
//   Effective access  live OntOS rights of the acting principal ∩ grant modules; write policy =
//                     min(grant policy, agent profile policy), order read_only < approval < direct.
// CIMD only (no DCR), current MCP spec only (NO-COMPAT rule, v2/lanes/COMMON.md).
import { Duration, Schema } from 'effect';

import { AgentModuleGrantSchema, AgentWritePolicySchema } from './agent-access.ts';
import { AgentLegalEntityIdSchema, AgentModuleKeySchema, AgentPrincipalIdSchema } from './agent-proposals.ts';

export const OAUTH_CONNECTION_PATHS = {
  // browser, session-authenticated (connect flow, screens 2 and 3)
  /** Body `ConnectOptionsRequest` -> `ConnectOptions`. */
  connectOptions: '/shell-super-app-api/auth/oauth-connections/options',
  /** Body `ConnectDraftRequest` -> `ConnectDraftResponse`. */
  connectDraft: '/shell-super-app-api/auth/oauth-connections/draft',
  /** Body `ConnectDraftSummaryRequest` -> `ConnectDraftSummary` (screen 3). */
  connectDraftSummary: '/shell-super-app-api/auth/oauth-connections/draft-summary',
  /** Body `ConnectApproveRequest` -> `ConnectApproveResponse`. */
  connectApprove: '/shell-super-app-api/auth/oauth-connections/approve',
  /** Body `ConnectDenyRequest` -> `ConnectDenyResponse`. */
  connectDeny: '/shell-super-app-api/auth/oauth-connections/deny',
  // browser, session-authenticated (management, lane mcp-connections-ui)
  admin: '/shell-super-app-api/auth/oauth-connections/admin-list',
  mine: '/shell-super-app-api/auth/oauth-connections/mine',
  operators: '/shell-super-app-api/auth/identity/agent-entities/operators',
  revoke: '/shell-super-app-api/auth/oauth-connections/revoke',
  update: '/shell-super-app-api/auth/oauth-connections/update',
} as const;

/** Access-token claim carrying the grant id. */
export const OAUTH_GRANT_CLAIM = 'https://ontos.cz/grant' as const;
/** The only OAuth capability scope; it never widens anything. */
export const OAUTH_MCP_SCOPE = 'ontos' as const;
/** `TrustedPrincipalContext.authContextRef` prefix of an OAuth connection. */
export const OAUTH_GRANT_CONTEXT_PREFIX = 'oauth-grant:' as const;
/** Drafts older than this are deleted and can no longer be approved. */
export const OAUTH_DRAFT_TTL_SECONDS = Duration.toSeconds(Duration.minutes(30));

export const ConnectionClientIdSchema = Schema.String.pipe(Schema.brand('OAuthClientId'));
export const ConnectionGrantIdSchema = Schema.String.pipe(Schema.brand('OAuthGrantId'));
export const ConnectionLegalEntityIdSchema = AgentLegalEntityIdSchema;
export const ConnectionModuleIdSchema = AgentModuleKeySchema;
export const ConnectionPrincipalIdSchema = AgentPrincipalIdSchema;
export const ConnectionProfileIdSchema = Schema.String.pipe(Schema.brand('OAuthProfileId'));
export const ConnectionTenantIdSchema = Schema.String.pipe(Schema.brand('TenantId'));

// Request limits stay identical to the original ingress contract; response identities add no new validation.
const GrantIdInput = ConnectionGrantIdSchema.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const LegalEntityIdInput = ConnectionLegalEntityIdSchema.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const PrincipalIdInput = ConnectionPrincipalIdSchema.check(Schema.isMinLength(1), Schema.isMaxLength(500));
/** The signed OAuth query string Better Auth appended to /cs/pripojit (without the leading `?`). */
const OAuthQuery = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8000));

export const ConnectionWritePolicySchema = AgentWritePolicySchema;
export type ConnectionWritePolicy = typeof ConnectionWritePolicySchema.Type;

/** `cimd`: client id is a CIMD document URL with a public redirect; `loopback`: CIMD client redirecting to localhost. */
export const ConnectionClientKindSchema = Schema.Literals(['cimd', 'loopback']);
export type ConnectionClientKind = typeof ConnectionClientKindSchema.Type;

export const ConnectionActingKindSchema = Schema.Literals(['human', 'agent']);
export type ConnectionActingKind = typeof ConnectionActingKindSchema.Type;

export const ConnectionGrantStatusSchema = Schema.Literals(['draft', 'active', 'denied', 'revoked', 'superseded']);
export type ConnectionGrantStatus = typeof ConnectionGrantStatusSchema.Type;

export const ConnectionRevokeReasonSchema = Schema.Literals([
  'user',
  'admin',
  'superseded',
  'operator_removed',
  'agent_disabled',
  'user_disabled',
  'password_changed',
]);
export type ConnectionRevokeReason = typeof ConnectionRevokeReasonSchema.Type;

/** Requested ceiling chosen on screen 2: everything the acting principal may do, or an explicit module list. */
export const ConnectionModulesRequestSchema = Schema.Union([
  Schema.Literal('all'),
  Schema.Array(AgentModuleGrantSchema).check(Schema.isMaxLength(100)),
]);
export type ConnectionModulesRequest = typeof ConnectionModulesRequestSchema.Type;

/** One module with its effective (or offered) rights; `label` is Czech. */
export const ConnectionModuleSchema = Schema.Struct({
  label: Schema.String,
  moduleId: ConnectionModuleIdSchema,
  read: Schema.Boolean,
  write: Schema.Boolean,
});
export type ConnectionModule = typeof ConnectionModuleSchema.Type;

export const ConnectionClientSchema = Schema.Struct({
  clientId: ConnectionClientIdSchema,
  /** Redirect host shown as a badge, e.g. `chatgpt.com`, `claude.ai`, `localhost`. */
  host: Schema.String,
  kind: ConnectionClientKindSchema,
  logoUri: Schema.OptionFromNullOr(Schema.String),
  name: Schema.String,
});
export type ConnectionClient = typeof ConnectionClientSchema.Type;

export const ConnectionPrincipalSchema = Schema.Struct({
  displayName: Schema.String,
  principalId: ConnectionPrincipalIdSchema,
});
export type ConnectionPrincipal = typeof ConnectionPrincipalSchema.Type;

/** What an active connection may do right now (described live on every MCP request). */
export const ConnectionDescriptionSchema = Schema.Struct({
  acting: Schema.Struct({
    displayName: Schema.String,
    kind: ConnectionActingKindSchema,
    principalId: ConnectionPrincipalIdSchema,
  }),
  client: ConnectionClientSchema,
  compositionRevision: Schema.String,
  /** The human who connected an agent; null when the person acts for themselves. */
  delegatedBy: Schema.OptionFromNullOr(ConnectionPrincipalSchema),
  grantId: ConnectionGrantIdSchema,
  legalEntityId: ConnectionLegalEntityIdSchema,
  legalName: Schema.String,
  /** Already ∩ live rights; modules without read are omitted. */
  modules: Schema.Array(ConnectionModuleSchema),
  /** Stable per (user, company, acting principal, client): ChatGPT keeps one account per profile. */
  profileId: ConnectionProfileIdSchema,
  status: Schema.Literal('active'),
  tenantId: ConnectionTenantIdSchema,
  /** Already min(grant policy, agent profile policy). */
  writePolicy: ConnectionWritePolicySchema,
});
export type ConnectionDescription = typeof ConnectionDescriptionSchema.Type;

/** One row of "Připojené aplikace" (profile and admin). */
export const ConnectionSummarySchema = Schema.Struct({
  acting: ConnectionDescriptionSchema.fields.acting,
  client: ConnectionClientSchema,
  /** ISO 8601. */
  createdAt: Schema.DateTimeUtcFromString,
  delegatedBy: Schema.OptionFromNullOr(ConnectionPrincipalSchema),
  grantId: ConnectionGrantIdSchema,
  /** ISO 8601, null when never used. */
  lastUsedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
  legalEntityId: ConnectionLegalEntityIdSchema,
  legalName: Schema.String,
  /** Effective modules for active grants; the requested ceiling for other statuses. */
  modules: Schema.Array(ConnectionModuleSchema),
  profileId: ConnectionProfileIdSchema,
  /** The ceiling chosen at consent (`all` or a list). */
  requestedModules: ConnectionModulesRequestSchema,
  status: ConnectionGrantStatusSchema,
  tenantId: ConnectionTenantIdSchema,
  /** Display name of the person who consented. */
  userDisplayName: Schema.String,
  writePolicy: ConnectionWritePolicySchema,
});
export type ConnectionSummary = typeof ConnectionSummarySchema.Type;

export const ConnectionListResponseSchema = Schema.Struct({
  company: Schema.Struct({ legalEntityId: ConnectionLegalEntityIdSchema, legalName: Schema.String }),
  connections: Schema.Array(ConnectionSummarySchema),
});
export type ConnectionListResponse = typeof ConnectionListResponseSchema.Type;

// ── connect flow (browser, session cookie) ─────────────────────────────────────────────────────────────────────

export const ConnectOptionsRequestSchema = Schema.Struct({ oauthQuery: OAuthQuery });
export type ConnectOptionsRequest = typeof ConnectOptionsRequestSchema.Type;

/** An agent the signed-in person may operate (`principal:{agent}#operate@principal:{me}`) in one company. */
export const ConnectAgentOptionSchema = Schema.Struct({
  displayName: Schema.String,
  /** Modules of the agent profile ∩ its live rights; `write` = may write or propose. */
  modules: Schema.Array(ConnectionModuleSchema),
  principalId: ConnectionPrincipalIdSchema,
  /** The agent profile's policy: the strictest choice the connection may use as ceiling. */
  writePolicy: ConnectionWritePolicySchema,
});
export type ConnectAgentOption = typeof ConnectAgentOptionSchema.Type;

export const ConnectCompanyOptionSchema = Schema.Struct({
  agents: Schema.Array(ConnectAgentOptionSchema),
  legalEntityId: ConnectionLegalEntityIdSchema,
  legalName: Schema.String,
  /** The person's own live rights in the company. */
  modules: Schema.Array(ConnectionModuleSchema),
});
export type ConnectCompanyOption = typeof ConnectCompanyOptionSchema.Type;

export const ConnectOptionsSchema = Schema.Struct({
  client: ConnectionClientSchema,
  /** Empty when `state` is `access_blocked`. */
  companies: Schema.Array(ConnectCompanyOptionSchema),
  /** Pre-selection from `?company=` / `?agent=` or the active shell company; null when none applies. */
  preselect: Schema.Struct({
    agentPrincipalId: Schema.OptionFromNullOr(ConnectionPrincipalIdSchema),
    legalEntityId: Schema.OptionFromNullOr(ConnectionLegalEntityIdSchema),
  }),
  state: Schema.Literals(['ready', 'access_blocked']),
  user: ConnectionPrincipalSchema,
});
export type ConnectOptions = typeof ConnectOptionsSchema.Type;

export const ConnectDraftRequestSchema = Schema.Struct({
  /** null = the signed-in person acts for themselves. */
  actingPrincipalId: Schema.OptionFromNullOr(PrincipalIdInput),
  legalEntityId: LegalEntityIdInput,
  modules: ConnectionModulesRequestSchema,
  oauthQuery: OAuthQuery,
  writePolicy: ConnectionWritePolicySchema,
});
export type ConnectDraftRequest = typeof ConnectDraftRequestSchema.Type;

export const ConnectDraftResponseSchema = Schema.Struct({ grantId: ConnectionGrantIdSchema });
export type ConnectDraftResponse = typeof ConnectDraftResponseSchema.Type;

export const ConnectDraftSummaryRequestSchema = Schema.Struct({ oauthQuery: OAuthQuery });
export type ConnectDraftSummaryRequest = typeof ConnectDraftSummaryRequestSchema.Type;

/** Screen 3 summary of the session's newest valid draft for this client. */
export const ConnectDraftSummarySchema = Schema.Struct({
  acting: ConnectionDescriptionSchema.fields.acting,
  client: ConnectionClientSchema,
  delegatedBy: Schema.OptionFromNullOr(ConnectionPrincipalSchema),
  grantId: ConnectionGrantIdSchema,
  legalName: Schema.String,
  /** `all` = "Vše, co smíte" / "Vše, co agent smí"; otherwise the effective list. */
  modules: Schema.Union([Schema.Literal('all'), Schema.Array(ConnectionModuleSchema)]),
  writePolicy: ConnectionWritePolicySchema,
});
export type ConnectDraftSummary = typeof ConnectDraftSummarySchema.Type;

export const ConnectApproveRequestSchema = Schema.Struct({ grantId: GrantIdInput, oauthQuery: OAuthQuery });
export type ConnectApproveRequest = typeof ConnectApproveRequestSchema.Type;

export const ConnectApproveResponseSchema = Schema.Struct({
  grantId: ConnectionGrantIdSchema,
  profileId: ConnectionProfileIdSchema,
  status: Schema.Literal('active'),
});
export type ConnectApproveResponse = typeof ConnectApproveResponseSchema.Type;

/** `grantId` null when the person cancels on screen 2 before any draft exists. */
export const ConnectDenyRequestSchema = Schema.Struct({
  grantId: Schema.OptionFromNullOr(GrantIdInput),
  oauthQuery: OAuthQuery,
});
export type ConnectDenyRequest = typeof ConnectDenyRequestSchema.Type;

/** `redirectTo` = the client's redirect_uri with `error=access_denied`, the original `state` and `iss` (RFC 9207). */
export const ConnectDenyResponseSchema = Schema.Struct({ redirectTo: Schema.String, status: Schema.Literal('denied') });
export type ConnectDenyResponse = typeof ConnectDenyResponseSchema.Type;

/** Problem `code` values of the connect endpoints (Czech copy lives in the screens). */
export const ConnectProblemCodeSchema = Schema.Literals([
  'oauth_query_invalid',
  'draft_not_found',
  'access_blocked',
  'acting_principal_forbidden',
  'write_policy_forbidden',
]);
export type ConnectProblemCode = typeof ConnectProblemCodeSchema.Type;

// ── management (lane mcp-connections-ui) ───────────────────────────────────────────────────────────────────────

export const ConnectionAdminListRequestSchema = Schema.Struct({
  actingPrincipalId: Schema.optionalKey(ConnectionPrincipalIdSchema),
  clientId: Schema.optionalKey(ConnectionClientIdSchema),
  status: Schema.optionalKey(ConnectionGrantStatusSchema),
  userPrincipalId: Schema.optionalKey(ConnectionPrincipalIdSchema),
});
export type ConnectionAdminListRequest = typeof ConnectionAdminListRequestSchema.Type;

/** Can only narrow: the server intersects with the acting principal's live rights and the previous policy cap. */
export const ConnectionUpdateRequestSchema = Schema.Struct({
  grantId: GrantIdInput,
  modules: ConnectionModulesRequestSchema,
  writePolicy: ConnectionWritePolicySchema,
});
export type ConnectionUpdateRequest = typeof ConnectionUpdateRequestSchema.Type;

export const ConnectionRevokeRequestSchema = Schema.Struct({
  grantId: GrantIdInput,
  /** Optional Czech note for the audit log. */
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  reason: Schema.Literals(['user', 'admin']),
});
export type ConnectionRevokeRequest = typeof ConnectionRevokeRequestSchema.Type;

export const AgentOperatorsRequestSchema = Schema.Struct({
  agentPrincipalId: PrincipalIdInput,
  operatorPrincipalIds: Schema.Array(PrincipalIdInput).check(Schema.isMaxLength(200)),
});
export type AgentOperatorsRequest = typeof AgentOperatorsRequestSchema.Type;
