/**
 * Shared shapes of the OntOS MCP OAuth resource server (lane mcp-mcp-rs, v2/research/ONTOS-MCP-AUTH-DESIGN.md §5).
 *
 *   verify     (src/oauth/verify.ts)      bearer JWT -> VerifiedAccessToken (jose, EdDSA, exact iss + aud)
 *   connector  (src/oauth/connector.ts)   VerifiedAccessToken -> ConnectionDescription (shell connector/describe)
 *   prm        (src/oauth/prm.ts)         PRM body, WWW-Authenticate challenge
 *   tools      (src/mcp/*.ts)             ConnectionDescription + catalog -> ToolSpec[]
 *   http       (src/http.ts)              web-standard fetch pipeline + node:http server on :3090
 *
 * The wire shape of ConnectionDescription mirrors packages/shared-contracts/src/oauth-connections.ts (lane
 * connection-grants). This package keeps its own zod copy so it never imports the workspace package; unknown extra
 * fields are ignored. Keep this file free of logic.
 */
import { z } from 'zod';

/** The only OAuth scope of the MCP resource. It means "may use OntOS via MCP" and never widens anything. */
export const OAUTH_SCOPE = 'ontos';

/** Access-token claim carrying the connection grant id (= Better Auth consentReferenceId). */
export const GRANT_CLAIM = 'https://ontos.cz/grant';

/** Header with the shared connector secret; always sent together with `authorization: Bearer <user JWT>`. */
export const CONNECTOR_KEY_HEADER = 'x-ontos-connector-key';

/** Shell endpoints the resource server calls (all POST, JSON). */
export const CONNECTOR_PATHS = {
  /** body `{}` -> ConnectionDescription; 401/403/404/410 = grant not active. */
  describe: '/shell-super-app-api/auth/connector/describe',
  /** body `{ audience, compositionRevision }` -> GatewayContextResponse (single-use assertion); 409 = stale revision. */
  gatewayContext: '/shell-super-app-api/auth/connector/gateway-context',
  /** body AgentProposalSubmitRequest -> AgentProposalSubmitResponse (approvals platform). */
  proposals: '/shell-super-app-api/agent-platform/proposals',
  /** body `{ legalEntityId }` -> AgentQueueResponse (own batches). */
  proposalsList: '/shell-super-app-api/agent-platform/proposals/list',
} as const;

export const CONNECTION_WRITE_POLICIES = ['read_only', 'approval', 'direct'] as const;
export type ConnectionWritePolicy = (typeof CONNECTION_WRITE_POLICIES)[number];

/** One module of the connection, already intersected with the acting principal's live rights. */
export const ConnectionModuleSchema = z.object({
  moduleId: z.string().min(1),
  label: z.string(),
  read: z.boolean(),
  write: z.boolean(),
});
export type ConnectionModule = z.infer<typeof ConnectionModuleSchema>;

/** Answer of connector/describe (design §5.4). */
export const ConnectionDescriptionSchema = z.object({
  grantId: z.string().min(1),
  /** Stable per (user, legal entity, acting principal, client); ChatGPT keys accounts by it. */
  profileId: z.string().min(1),
  status: z.literal('active'),
  tenantId: z.string().min(1),
  legalEntityId: z.string().min(1),
  legalName: z.string(),
  acting: z.object({
    principalId: z.string().min(1),
    kind: z.enum(['human', 'agent']),
    displayName: z.string(),
  }),
  delegatedBy: z.object({ principalId: z.string().min(1), displayName: z.string() }).nullable(),
  client: z.object({
    clientId: z.string(),
    name: z.string(),
    host: z.string(),
    kind: z.enum(['cimd', 'dcr', 'loopback']),
  }),
  /** Already min(grant policy, agent profile policy). */
  writePolicy: z.enum(CONNECTION_WRITE_POLICIES),
  modules: z.array(ConnectionModuleSchema),
  compositionRevision: z.string(),
});
export type ConnectionDescription = z.infer<typeof ConnectionDescriptionSchema>;

/** A bearer JWT that passed local verification. `token` is the raw JWT: never log it. */
export interface VerifiedAccessToken {
  readonly token: string;
  /** JWT `sub` (Better Auth user id). */
  readonly subject: string;
  /** JWT `azp` or `client_id`; empty string when absent. */
  readonly clientId: string;
  /** JWT claim GRANT_CLAIM. */
  readonly grantId: string;
  readonly scopes: readonly string[];
  /** JWT `exp`, epoch seconds. */
  readonly expiresAt: number;
}

/** Resource-server configuration (loadRsConfig in src/config.ts). URLs never end with a slash. */
export interface RsConfig {
  /** ONTOS_OAUTH_ISSUER, exact; default http://localhost:3020/shell-super-app-api/oauth. */
  readonly issuer: string;
  /** ONTOS_MCP_RESOURCE_URL, exact JWT audience; default http://localhost:3090/mcp. */
  readonly resourceUrl: string;
  /** Path-inserted PRM URL of resourceUrl, e.g. http://localhost:3090/.well-known/oauth-protected-resource/mcp. */
  readonly prmUrl: string;
  /** ONTOS_OAUTH_JWKS_URL, default `${issuer}/jwks`. */
  readonly jwksUrl: string;
  /** ONTOS_SHELL_INTERNAL_URL, else ONTOS_SHELL_URL, else http://localhost:3020 (connector + vertical calls). */
  readonly shellInternalUrl: string;
  /** ONTOS_SHELL_PUBLIC_URL, else the issuer origin (links shown to people, e.g. review URLs). */
  readonly shellPublicUrl: string;
  /** ONTOS_MCP_CONNECTOR_SECRET (required). Never log it. */
  readonly connectorSecret: string;
  /** ONTOS_MCP_HTTP_HOST, default 127.0.0.1. */
  readonly host: string;
  /** ONTOS_MCP_HTTP_PORT, default 3090. */
  readonly port: number;
  /** Accepted Host header values: resource host, localhost:<port>, 127.0.0.1:<port>, ONTOS_MCP_ALLOWED_HOSTS. */
  readonly allowedHosts: readonly string[];
  /** Accepted Origin header values when an Origin is sent (browser-based clients). */
  readonly allowedOrigins: readonly string[];
  /** Human connect guide, `${shellPublicUrl}/cs/profil`. */
  readonly connectGuideUrl: string;
}

/** Missing, malformed, expired or foreign token -> HTTP 401 with error="invalid_token". */
export class InvalidTokenError extends Error {
  override readonly name = 'InvalidTokenError';
}

/** The grant behind a valid token is not active (revoked, superseded, user disabled) -> HTTP 401 invalid_token. */
export class ConnectionInactiveError extends Error {
  override readonly name = 'ConnectionInactiveError';
}

/** The shell (connector, JWKS) could not be reached or answered garbage -> HTTP 503, never 401. */
export class ConnectorUnavailableError extends Error {
  override readonly name = 'ConnectorUnavailableError';
}
