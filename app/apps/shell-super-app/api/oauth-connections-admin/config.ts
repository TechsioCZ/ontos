import { Config, Effect } from 'effect';

import { mcpResourceUrlOf } from '../../shared/mcp-resource.ts';
import { loadConfigurationProvider } from '../auth/configuration-provider.ts';

/** MCP URL people paste into ChatGPT/Claude: the Shell's own `/mcp`, which is also the access-token audience. */
export const mcpResourceUrl: Effect.Effect<string> = loadConfigurationProvider({}, () => 'unavailable' as const).pipe(
  Effect.flatMap((provider) => Config.String('BETTER_AUTH_URL').parse(provider)),
  Effect.map(mcpResourceUrlOf),
  Effect.orElseSucceed(() => mcpResourceUrlOf('http://localhost:3020')),
);
