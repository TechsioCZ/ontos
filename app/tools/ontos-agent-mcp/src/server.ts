import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getConfig } from './config.ts';
import { getAssertion } from './gateway.ts';
import { readRecords } from './ontos-client.ts';
import { registerDomainTools } from './tools/index.ts';

const SERVER_NAME = 'ontos-sales-agent';
const SERVER_VERSION = '0.1.0';
const PROBE_AUDIENCE = 'siampark-work';

function textResult(value: unknown, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ text, type: 'text' as const }], isError };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Fail fast on missing configuration. Startup errors go to stderr; stdout stays reserved for MCP.
try {
  getConfig();
} catch (error) {
  console.error(errorMessage(error));
  process.exit(1);
}

const config = getConfig();
const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

server.registerTool(
  'whoami',
  {
    description:
      'Show the configured OntOS shell URL and whether a gateway assertion for the siampark-work audience can be obtained. Never returns the API key or the token.',
    inputSchema: {},
  },
  async () => {
    try {
      await getAssertion(PROBE_AUDIENCE);
      return textResult({
        assertionAudience: PROBE_AUDIENCE,
        assertionObtained: true,
        legalEntityIdConfigured: config.legalEntityId !== undefined,
        shellUrl: config.shellUrl,
      });
    } catch (error) {
      return textResult(
        {
          assertionAudience: PROBE_AUDIENCE,
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
      return textResult(await readRecords(vertical, readName, query));
    } catch (error) {
      return textResult(errorMessage(error), true);
    }
  },
);

registerDomainTools(server);

await server.connect(new StdioServerTransport());
console.error(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio`);
