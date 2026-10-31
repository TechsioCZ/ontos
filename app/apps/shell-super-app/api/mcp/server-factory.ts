import type {
  CallToolResult,
  McpServer as SdkMcpServer,
  RegisteredTool,
  ResourceLink,
  StandardSchemaWithJSON,
  ToolCallback,
} from '@modelcontextprotocol/server';
import { Effect, Function as Fn, Schema } from 'effect';

import type { ToolResult, ToolSpec } from './types.ts';

export const SERVER_INFO = { name: 'ontos', title: 'OntOS', version: '0.3.0' };
export const CHATGPT_SECURITY_SCHEMES = [{ scopes: ['ontos'], type: 'oauth2' }];
const PERMISSIVE_OBJECT = { additionalProperties: true, type: 'object' };

export const SERVER_INSTRUCTIONS = [
  'OntOS je firemní systém (zákazníci, zakázky, fakturace, úkoly a další moduly). Toto připojení jedná za jednu firmu a jednu identitu.',
  '1. Nejdřív zavolej ontos_whoami: firma, za koho jednáš, moduly a režim zápisu.',
  '2. Co umíš, najdeš přes ontos_capabilities {query: "zákazník"}; vstupní schéma přes ontos_capabilities {id}.',
  '3. Čtení: ontos_read {id, input}. Odpověď je zkrácená: další položky přes offset, vynechané části (omitted) přes path. Zápis: ontos_execute {id, input, reason, idempotencyKey}.',
  'Každý zápis vyžaduje vlastní idempotencyKey (1–200 tisknutelných ASCII znaků bez mezer). Před odesláním uchovej klíč i celý vstup. Při opakování stejné změny po chybě nebo nejisté odpovědi použij přesně stejný klíč i vstup; nový klíč patří jen nové změně. Platí i pro ontos_propose a typované nástroje zápisu.',
  '4. Režim „ke schválení“: zápis se neprovede hned, vznikne návrh, který schválí člověk v OntOS (Nastavení › Ke schválení). Uživateli vrať reviewUrl. Stav návrhů: ontos_list_proposals.',
  'Příklady: „najdi zákazníka“ → ontos_capabilities {query: "zákazník"} a ontos_read; změna → ontos_capabilities {id} pro vstupní schéma, pak ontos_execute {id, input, reason, idempotencyKey}.',
  'English: OntOS business system. Call ontos_whoami first, discover with ontos_capabilities, read with ontos_read, write with ontos_execute {id, input, reason, idempotencyKey}. Every mutation requires a caller idempotencyKey (1–200 printable ASCII characters without spaces). Retain the key and complete input before sending; retry uncertain responses with that exact key and input, using a new key only for a new intent. This also applies to ontos_propose and typed mutation tools. In approval mode writes become proposals a person approves; share the reviewUrl.',
].join('\n');

/**
 * The SDK parses network JSON before invoking this validator. Keep every parsed JSON kind and
 * arbitrary object fields here, including numeric overflow such as `1e400`: recursive Schema.Json
 * validation here would move that failure ahead of the existing handler. Tools still own DTO errors.
 */
const SdkParsedJsonKindSchema = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Number,
  Schema.String,
  Schema.ObjectKeyword,
]);
export const PASS_THROUGH_VALIDATOR = Schema.toStandardSchemaV1(SdkParsedJsonKindSchema);

/** Catalog schemas are draft 2020-12 documents; drop $schema and fall back to a permissive object. */
const toolInputSchema = (schema: ToolSpec['inputSchema']): StandardSchemaWithJSON => {
  const { $schema: _dialect, ...rest } = schema;
  const candidate = rest['type'] === 'object' ? rest : PERMISSIVE_OBJECT;
  return {
    '~standard': {
      ...PASS_THROUGH_VALIDATOR['~standard'],
      jsonSchema: {
        input: () => candidate,
        output: () => candidate,
      },
    },
  };
};

const toCallToolResult = (result: ToolResult): CallToolResult => {
  const response: CallToolResult = {
    content: result.content.map((item): CallToolResult['content'][number] => {
      if (item.type === 'text') {
        return { text: item.text, type: 'text' };
      }
      const link: ResourceLink = { name: item.name, type: 'resource_link', uri: item.uri };
      if (item.title !== undefined) {
        link.title = item.title;
      }
      if (item.description !== undefined) {
        link.description = item.description;
      }
      if (item.mimeType !== undefined) {
        link.mimeType = item.mimeType;
      }
      return link;
    }),
  };
  if (result.structuredContent !== undefined) {
    response.structuredContent = Object.fromEntries(Object.entries(result.structuredContent));
  }
  if (result.isError === true) {
    response.isError = true;
  }
  if (result._meta !== undefined) {
    response._meta = Object.fromEntries(Object.entries(result._meta));
  }
  return response;
};

/** The request's Effect runner returns the SDK callback's native sync/async result at this framework edge. */
export type McpToolRunner = (effect: Effect.Effect<CallToolResult>) => ReturnType<ToolCallback<StandardSchemaWithJSON>>;

type McpToolConfiguration = Pick<
  RegisteredTool,
  '_meta' | 'annotations' | 'description' | 'inputSchema' | 'outputSchema' | 'title'
>;

/** One McpServer per request: the tool list always reflects the current grant (no list_changed needed). */
export const buildMcpServer = (
  tools: readonly ToolSpec[],
  {
    run,
    sdk,
  }: {
    readonly run: McpToolRunner;
    readonly sdk: { readonly McpServer: typeof SdkMcpServer };
  },
): SdkMcpServer => {
  // The HTTP adapter loads SDK values only for this request. A static value import here
  // would be hoisted by Rspack even when the factory itself is imported lazily.
  const { McpServer } = sdk;
  const server = new McpServer({ ...SERVER_INFO }, { instructions: SERVER_INSTRUCTIONS });
  for (const tool of tools) {
    const configuration: McpToolConfiguration = {
      _meta: { securitySchemes: CHATGPT_SECURITY_SCHEMES },
      annotations: { ...tool.annotations, title: tool.title },
      description: tool.description,
      inputSchema: toolInputSchema(tool.inputSchema),
      title: tool.title,
    };
    if (tool.outputSchema !== undefined) {
      configuration.outputSchema = toolInputSchema(tool.outputSchema);
    }
    server.registerTool(
      tool.name,
      configuration,
      // Expected failures are Czech `isError` results; defects remain owned by the SDK/HTTP boundary.
      Fn.compose(
        (args: Parameters<ToolCallback<StandardSchemaWithJSON>>[0]) =>
          Schema.decodeUnknownEffect(Schema.JsonObject)(args ?? {}).pipe(
            Effect.flatMap(tool.handler),
            Effect.map(toCallToolResult),
            Effect.orDie,
          ),
        run,
      ),
    );
  }
  return server;
};
