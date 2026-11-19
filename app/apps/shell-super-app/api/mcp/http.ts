/** The API ingress exposes the shared MCP HTTP runtime; SDK handler construction belongs outside api/. */
export {
  landingPage,
  MCP_TOOL_METHODS,
  OAUTH_SCOPE,
  protectedResourceMetadata,
  PUBLIC_CORS_HEADERS,
  serveMcp,
  serveMcpMetadata,
  unauthorizedResponse,
  wwwAuthenticate,
} from '../../src/mcp/http.server.ts';
export type {
  McpAuthentication,
  McpConnectionTools,
  McpEndpointConfig,
  McpEndpointDeps,
} from '../../src/mcp/http.server.ts';
