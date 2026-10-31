import { Layer } from 'effect';

import { ModuleApiTransportLive } from '../src/module-api/transport.ts';
import { InvitationTransportLive } from './auth/invitation/transport.ts';
import { OAuthServerTransportLive } from './auth/oauth-server/transport.ts';
import { EmailTransportLive } from './email/transport.ts';
import { McpMetadataTransportLive } from './mcp/transport.ts';

/**
 * The Shell-owned routes outside the HTTP API, except the MCP endpoint, which the API root registers under its own
 * request identity middleware. The root provides their request services from the same instances as the handlers:
 * the OAuth server routes use the handlers' authentication service, backed by the isolate's Better Auth instance.
 */
export const ShellTransportLive = Layer.mergeAll(
  ModuleApiTransportLive,
  EmailTransportLive,
  OAuthServerTransportLive,
  InvitationTransportLive,
  McpMetadataTransportLive,
);
