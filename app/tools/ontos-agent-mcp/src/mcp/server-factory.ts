import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult, JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from '@modelcontextprotocol/server';
import type { ToolResult, ToolSpec } from './types.ts';

export const SERVER_INFO = { name: 'ontos', title: 'OntOS', version: '0.2.0' };
export const CHATGPT_SECURITY_SCHEMES = [{ scopes: ['ontos'], type: 'oauth2' }];
const PERMISSIVE_OBJECT = { additionalProperties: true, type: 'object' };

export const SERVER_INSTRUCTIONS = [
  'OntOS je firemní systém (zákazníci, zakázky, fakturace, úkoly a další moduly). Toto připojení jedná za jednu firmu a jednu identitu.',
  '1. Nejdřív zavolej ontos_whoami: firma, za koho jednáš, moduly a režim zápisu.',
  '2. Co umíš, najdeš přes ontos_capabilities {query: "zákazník"}; vstupní schéma přes ontos_capabilities {id}.',
  '3. Čtení: ontos_read {id, input}. Odpověď je zkrácená: další položky přes offset, vynechané části (omitted) přes path. Zápis: ontos_execute {id, input, reason}.',
  '4. Režim „ke schválení“: zápis se neprovede hned, vznikne návrh, který schválí člověk v OntOS (Nastavení › Ke schválení). Uživateli vrať reviewUrl. Stav návrhů: ontos_list_proposals.',
  'Příklady: „najdi zákazníka“ → ontos_capabilities {query: "zákazník"} a ontos_read; „vytvoř úkol“ → ontos_execute {id: "work.tasks/command/CreateTask", input: {title}}.',
  'English: OntOS business system. Call ontos_whoami first, discover with ontos_capabilities, read with ontos_read, write with ontos_execute. In approval mode writes become proposals a person approves; share the reviewUrl.',
].join('\n');

/**
 * Advertises the schema but lets every value through: tools.ts validates arguments itself (input-check.ts) so a wrong
 * call gets a Czech tool error instead of the SDK's English "Input validation error"; output shapes are unit-tested.
 */
export const PASS_THROUGH_VALIDATOR: jsonSchemaValidator = {
  getValidator: <T>(): JsonSchemaValidator<T> => (input: unknown) => ({
    data: input as T,
    errorMessage: undefined,
    valid: true as const,
  }),
};

/** Catalog schemas are draft 2020-12 documents; drop $schema and fall back to a permissive object. */
export const toolInputSchema = (schema: Readonly<Record<string, unknown>>) => {
  const { $schema: _dialect, ...rest } = schema;
  const candidate = rest['type'] === 'object' ? rest : PERMISSIVE_OBJECT;
  try {
    return fromJsonSchema(candidate as JsonSchemaType, PASS_THROUGH_VALIDATOR);
  } catch {
    return fromJsonSchema(PERMISSIVE_OBJECT as JsonSchemaType, PASS_THROUGH_VALIDATOR);
  }
};

const toCallToolResult = (result: ToolResult): CallToolResult => ({
  content: result.content.map((item) =>
    item.type === 'text'
      ? { text: item.text, type: 'text' as const }
      : {
          name: item.name,
          type: 'resource_link' as const,
          uri: item.uri,
          ...(item.title === undefined ? {} : { title: item.title }),
          ...(item.description === undefined ? {} : { description: item.description }),
          ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
        },
  ),
  ...(result.structuredContent === undefined ? {} : { structuredContent: { ...result.structuredContent } }),
  ...(result.isError === true ? { isError: true } : {}),
  ...(result._meta === undefined ? {} : { _meta: { ...result._meta } }),
});

/** One McpServer per request: the tool list always reflects the current grant (no list_changed needed). */
export const buildMcpServer = (tools: readonly ToolSpec[]): McpServer => {
  const server = new McpServer({ ...SERVER_INFO }, { instructions: SERVER_INSTRUCTIONS });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        _meta: { securitySchemes: CHATGPT_SECURITY_SCHEMES },
        annotations: { ...tool.annotations, title: tool.title },
        description: tool.description,
        inputSchema: toolInputSchema(tool.inputSchema),
        ...(tool.outputSchema === undefined ? {} : { outputSchema: toolInputSchema(tool.outputSchema) }),
        title: tool.title,
      },
      async (args): Promise<CallToolResult> => {
        try {
          return toCallToolResult(await tool.handler((args ?? {}) as Readonly<Record<string, unknown>>));
        } catch (error) {
          return { content: [{ text: `Nástroj selhal: ${error instanceof Error ? error.message : String(error)}`, type: 'text' }], isError: true };
        }
      },
    );
  }
  return server;
};
