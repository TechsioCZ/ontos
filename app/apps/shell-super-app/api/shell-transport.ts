import { Layer } from 'effect';

import { ModuleApiTransportLive } from '../src/module-api/transport.ts';
import { InvitationTransportLive } from './auth/invitation/transport.ts';
import { OAuthServerTransportLive } from './auth/oauth-server/transport.ts';
import { EmailTransportLive } from './email/transport.ts';
import { McpEndpointTransportLive, McpMetadataTransportLive } from './mcp/transport.ts';

/**
 * The Shell-owned routes outside the HTTP API. The BFF assembly builds them in the same Layer as the API handlers,
 * so they resolve the same service instances: the OAuth server routes use the handlers' authentication service,
 * backed by the isolate's Better Auth instance, and the MCP endpoint runs tools as the connection's principal with
 * the agent platform's services once the request identity middleware is provided.
 */
export const ShellTransportLive = Layer.mergeAll(
  ModuleApiTransportLive,
  EmailTransportLive,
  OAuthServerTransportLive,
  InvitationTransportLive,
  McpEndpointTransportLive,
  McpMetadataTransportLive,
);
