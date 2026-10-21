import { Config, Effect } from 'effect';

import { DEFAULT_MCP_RESOURCE_URL } from '../auth/config.ts';
import { loadConfigurationProvider } from '../auth/configuration-provider.ts';

/**
 * MCP resource URL people paste into ChatGPT/Claude; equals the access-token audience. Read from the same sources
 * as `AuthConfig.mcpResourceUrl` (process environment, then the app env file), falling back to the same default.
 */
export const mcpResourceUrl: Effect.Effect<string> = loadConfigurationProvider({}, () => 'unavailable' as const).pipe(
  Effect.flatMap((provider) => Config.String('ONTOS_MCP_RESOURCE_URL').parse(provider)),
  Effect.map((value) => value.trim()),
  Effect.map((value) => (value === '' ? DEFAULT_MCP_RESOURCE_URL : value)),
  Effect.orElseSucceed(() => DEFAULT_MCP_RESOURCE_URL),
);
