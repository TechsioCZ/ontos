/**
 * The Shell's MCP endpoint: one route table for the Node middleware, the Cloudflare Worker root-route hook and the
 * BFF transport. The resource (access-token audience) is always `<shell origin>/mcp`.
 */
export const MCP_ENDPOINT_PATH = '/mcp';
/** BFF routes (below `/shell-super-app-api`) of the endpoint and of its RFC 9728 metadata. */
export const MCP_BFF_ROUTE = '/mcp';
export const MCP_METADATA_BFF_ROUTE = '/mcp-resource-metadata';
const BFF_PREFIX = '/shell-super-app-api';
const PRM_ROOT = '/.well-known/oauth-protected-resource';

export const mcpResourceUrlOf = (shellUrl: string): string => `${new URL(shellUrl).origin}${MCP_ENDPOINT_PATH}`;
export const mcpMetadataUrlOf = (shellUrl: string): string => `${new URL(shellUrl).origin}${PRM_ROOT}${MCP_ENDPOINT_PATH}`;

export const ROOT_ROUTES: ReadonlyMap<string, string> = new Map([
  [MCP_ENDPOINT_PATH, `${BFF_PREFIX}${MCP_BFF_ROUTE}`],
  [PRM_ROOT, `${BFF_PREFIX}${MCP_METADATA_BFF_ROUTE}`],
  [`${PRM_ROOT}${MCP_ENDPOINT_PATH}`, `${BFF_PREFIX}${MCP_METADATA_BFF_ROUTE}`],
]);

/** Root path -> BFF route served in-process (any method), or undefined. */
export const rootRouteTarget = (pathname: string): string | undefined => ROOT_ROUTES.get(pathname);
