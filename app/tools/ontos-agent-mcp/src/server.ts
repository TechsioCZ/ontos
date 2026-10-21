import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Predicate, Schema } from 'effect';
import { z } from 'zod';
import { getConfig } from './config.ts';
import { getAssertion } from './gateway.ts';
import { readRecords } from './ontos-client.ts';
import { profileLabel, profileTools, restrictToProfile } from './profiles.ts';
import { registerDomainTools } from './tools/index.ts';

const SERVER_NAME = 'ontos-sales-agent';
const SERVER_VERSION = '0.1.0';
const PROBE_AUDIENCE = 'siampark-work';

const textResult = <A>(value: A, isError = false) => {
  const text = Predicate.isString(value) ? value : JSON.stringify(value, null, 2);
  return { content: [{ text, type: 'text' as const }], isError };
};

/** `cause` is whatever was thrown; only its message is reported. */
const errorMessage = (cause: unknown): string => (Predicate.isError(cause) ? cause.message : String(cause));

// Fail fast on missing configuration. Startup errors go to stderr; stdout stays reserved for MCP.
try {
  getConfig();
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
}

const config = getConfig();
const mcpServer = new McpServer({
  name: config.profile === undefined ? SERVER_NAME : `${SERVER_NAME}-${config.profile.toLowerCase()}`,
  version: SERVER_VERSION,
});
// With ONTOS_AGENT_PROFILE=A|B|C only that level's tools for that company are registered (see profiles.ts).
const server = restrictToProfile(mcpServer, config.profile, config.company);
/** Audience whose assertion proves the key works: the module the level actually uses. */
const probeAudience =
  config.profile === 'C' ? (config.company === 'obchod' ? 'sales-pipeline' : 'crm') : PROBE_AUDIENCE;

const profileInfo = () =>
  config.profile === undefined
    ? { profile: 'legacy agent-bot (všechny nástroje)' }
    : {
        apiKeySource: config.apiKeySource,
        company: config.company,
        legalEntityId: config.legalEntityId,
        profile: config.profile,
        profileLabel: profileLabel(config.profile, config.company),
        tools: [...profileTools(config.profile, config.company)],
      };

server.registerTool(
  'whoami',
  {
    description:
      'Show the AI agent level (A = read-only, B = reads + tasks, C = proposals a person approves), its company, its tools, the shell URL and whether a gateway assertion can be obtained. Never returns the API key or the token.',
    inputSchema: {},
  },
  async () => {
    try {
      await getAssertion(probeAudience);
      return textResult({
        ...profileInfo(),
        assertionAudience: probeAudience,
        assertionObtained: true,
        legalEntityIdConfigured: config.legalEntityId !== undefined,
        shellUrl: config.shellUrl,
      });
    } catch (error) {
      return textResult(
        {
          ...profileInfo(),
          assertionAudience: probeAudience,
          assertionObtained: false,
          error: errorMessage(error),
          legalEntityIdConfigured: config.legalEntityId !== undefined,
          shellUrl: config.shellUrl,
        },
        true,
      );
    }
  },
);

server.registerTool(
  'raw_read',
  {
    description:
      'Plumbing probe: POST a vertical records read through the shell with a gateway assertion. Returns the raw JSON.',
    inputSchema: {
      query: z.record(z.string(), z.string()).describe('Read query fields, sent as the JSON body.'),
      readName: z.string().min(1).describe('Read name, e.g. "records".'),
      vertical: z.string().min(1).describe('Vertical app ID, e.g. "siampark-work".'),
    },
  },
  async ({ query, readName, vertical }) => {
    try {
      return textResult(await readRecords(vertical, readName, query, Schema.Json));
    } catch (error) {
      return textResult(errorMessage(error), true);
    }
  },
);

registerDomainTools(server);

await mcpServer.connect(new StdioServerTransport());
process.stderr.write(
  `${SERVER_NAME} ${SERVER_VERSION} ready on stdio${config.profile === undefined ? '' : ` (profile ${config.profile}, ${config.company})`}\n`,
);
