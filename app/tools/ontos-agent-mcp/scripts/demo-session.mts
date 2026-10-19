#!/usr/bin/env node
/**
 * Scripted agent session against the LOCAL sales demo, over the real MCP stdio transport (requirements 8, 9, 11).
 *
 *   cd app/tools/ontos-agent-mcp
 *   node --experimental-strip-types scripts/demo-session.mts [--out ../../docs/demo/agent-session.md]
 *
 * Spawns `src/server.ts` as a child process and speaks newline-delimited JSON-RPC 2.0 to it, exactly like
 * Claude Code does. The API key comes from app/.env.demo.local (scripts/demo/reset-permissions.mts); the
 * composition revision is read live from the composition publisher (ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL,
 * default http://127.0.0.1:3041/active) and passed as ONTOS_COMPOSITION_REVISION, so a stale value in the env
 * file does not matter. The transcript is written as Markdown (tool calls, arguments and abbreviated results).
 *
 * The "agent" here is deterministic code standing in for the chat model: it reads numbers, then writes a task,
 * moves an opportunity and applies the tagging rule agreed in chat:
 *   - customers with confirmed invoice revenue above 200 000 Kč (incl. VAT) get the tag "VIP";
 *   - orders above 100 000 Kč (incl. VAT) get "Velká zakázka" when that tag allows orders, otherwise an order tag
 *     "Velká objednávka" is created (the bot may create tags, but not rename or delete them).
 */
import { fileURLToPath } from 'node:url';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Config, Console, DateTime, Effect, FileSystem, Layer, Option, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { FetchHttpClient, HttpClient, HttpClientResponse } from 'effect/unstable/http';

class DemoSessionError extends Schema.TaggedError<DemoSessionError>()('DemoSessionError', {
  operation: Schema.String,
}) {}
const jsonCodec = Schema.fromJsonString(Schema.Json);
const encodeJson = Schema.encodeEffect(jsonCodec);

const SUBJECT_KIND_CS = new Map([
  ['customer', 'zákazníky'],
  ['employee', 'zaměstnance'],
  ['opportunity', 'příležitosti'],
  ['order', 'objednávky'],
  ['product', 'produkty'],
]);
const VIP_THRESHOLD_CZK = 200_000;
const BIG_ORDER_THRESHOLD_CZK = 100_000;

// ---------------------------------------------------------------------------------------------------------------
// Wire decoding. Every reply is parsed at this boundary; the session only reads the fields it shows.

type JsonValue = Schema.Json;
type JsonObject = Schema.JsonObject;
const ToolCallResult = Schema.Struct({
  content: Schema.Array(Schema.Struct({ text: Schema.String })),
  isError: Schema.optional(Schema.Boolean),
});
const CustomerRef = Schema.Struct({ name: Schema.NullOr(Schema.String), partyId: Schema.String });
const OpportunityRef = Schema.Struct({
  amountCzk: Schema.Number,
  id: Schema.String,
  partyId: Schema.String,
  title: Schema.String,
});
const EmployeeRef = Schema.Struct({ id: Schema.String, name: Schema.String });
const InvoiceRef = Schema.Struct({
  counterpartyId: Schema.String,
  partyId: Schema.NullOr(Schema.String),
  totalCzk: Schema.Number,
});
const OrderRef = Schema.Struct({ id: Schema.String, number: Schema.String, totalCzk: Schema.Number });
const TagRef = Schema.Struct({ name: Schema.String, subjectKinds: Schema.Array(Schema.String) });
const Negotiation = Schema.Struct({
  items: Schema.Array(OpportunityRef),
  summary: Schema.Struct({ openValueCzk: Schema.Number }),
});
const Revenue = Schema.Struct({ total: Schema.NullOr(Schema.Number) });
const decodeOptional = <S extends Schema.ConstraintDecoder<JsonValue>>(schema: S, input: JsonValue) =>
  Schema.decodeUnknownOption(schema)(input);
/** The `items` of a list tool result. A result that does not decode has no items. */
const itemsOf = <S extends Schema.ConstraintDecoder<JsonValue>>(item: S, result: JsonValue): readonly S['Type'][] =>
  Option.match(decodeOptional(Schema.Struct({ items: Schema.Array(item) }), result), {
    onNone: () => [],
    onSome: ({ items }) => items,
  });
const sessionConfig = Config.all({
  apiKey: Config.Redacted('ONTOS_AGENT_API_KEY').pipe(Config.option),
  compositionUrl: Config.String('ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL').pipe(
    Config.withDefault('http://127.0.0.1:3041/active'),
  ),
  legalEntityId: Config.String('ONTOS_LEGAL_ENTITY_ID').pipe(Config.option),
  shellUrl: Config.String('ONTOS_SHELL_URL').pipe(Config.option),
});
const serverPath = fileURLToPath(new URL('../src/server.ts', import.meta.url));
const defaultOutPath = fileURLToPath(new URL('../../../docs/demo/agent-session.md', import.meta.url));

const abbreviate = (value: JsonValue, maxItems = 5): JsonValue => {
  const array = decodeOptional(Schema.Array(Schema.Json), value);
  if (Option.isSome(array)) {
    const head = array.value.slice(0, maxItems).map((item) => abbreviate(item, maxItems));
    return array.value.length > maxItems ? [...head, `… ${array.value.length - maxItems} dalších`] : head;
  }
  const entries = decodeOptional(Schema.JsonObject, value);
  if (Option.isNone(entries)) {
    return value;
  }
  return Object.fromEntries(Object.entries(entries.value).map(([key, item]) => [key, abbreviate(item, maxItems)]));
};

const makeTool =
  (client: Client, transcript: string[], failures: string[]) =>
  (name: string, args: JsonObject, maxItems = 5) =>
    Effect.gen(function* callTool() {
      const response = yield* Effect.tryPromise({
        catch: () => new DemoSessionError({ operation: `call MCP tool ${name}` }),
        try: async () => await client.callTool({ arguments: args, name }),
      });
      const result = yield* Schema.decodeUnknownEffect(ToolCallResult)(response);
      const text = result.content.at(0)?.text ?? '';
      const isError = result.isError !== false;
      const parsed = Option.getOrElse(Schema.decodeUnknownOption(jsonCodec)(text), () => text);
      const encodedArgs = yield* encodeJson(args);
      const encodedResult = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json, { space: 2 }))(
        abbreviate(parsed, maxItems),
      );
      transcript.push(`**→ \`${name}\`** \`${encodedArgs}\``, '', '```json', encodedResult, '```', '');
      yield* Console.log(`${isError ? 'ERROR' : 'ok   '} ${name}`);
      if (isError) {
        failures.push(`${name}: ${text}`);
      }
      return parsed;
    });

const czk = (value: number) => `${Math.round(value).toLocaleString('cs-CZ')} Kč`;

const runSession = (outPath: string) =>
  Effect.gen(function* demoSession() {
    const config = yield* sessionConfig;
    const http = yield* HttpClient.HttpClient;
    const compositionResponse = yield* http.get(config.compositionUrl);
    const {
      composition: { revision },
    } = yield* HttpClientResponse.schemaBodyJson(
      Schema.Struct({ composition: Schema.Struct({ revision: Schema.String }) }),
    )(compositionResponse);
    const environment = {
      ...getDefaultEnvironment(),
      ...Object.fromEntries(
        Option.toArray(config.apiKey).map((value) => ['ONTOS_AGENT_API_KEY', Redacted.value(value)]),
      ),
      ...Object.fromEntries(Option.toArray(config.shellUrl).map((value) => ['ONTOS_SHELL_URL', value])),
      ...Object.fromEntries(Option.toArray(config.legalEntityId).map((value) => ['ONTOS_LEGAL_ENTITY_ID', value])),
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: config.compositionUrl,
      ONTOS_COMPOSITION_REVISION: revision,
    };
    const transport = new StdioClientTransport({
      args: ['--experimental-strip-types', '--no-warnings', serverPath],
      command: process.execPath,
      env: environment,
      stderr: 'pipe',
    });
    const stderr: string[] = [];
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk.toString('utf-8'));
    });
    const client = yield* Effect.acquireRelease(
      Effect.succeed(new Client({ name: 'ontos-demo-session', version: '1.0.0' })),
      (activeClient) =>
        Effect.tryPromise({
          catch: () => new DemoSessionError({ operation: 'close MCP transport' }),
          try: async () => await activeClient.close(),
        }).pipe(Effect.orDie),
    );
    yield* Effect.tryPromise({
      catch: () => new DemoSessionError({ operation: 'connect MCP server' }),
      try: async () => await client.connect(transport),
    });
    const serverInfo = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ name: Schema.String, version: Schema.String }),
    )(client.getServerVersion());
    const { tools } = yield* Effect.tryPromise({
      catch: () => new DemoSessionError({ operation: 'list MCP tools' }),
      try: async () => await client.listTools(),
    });

    // ---------------------------------------------------------------------------------------------------------------
    // Transcript.

    const transcript: string[] = [];
    const say = (text: string) =>
      Effect.gen(function* recordTranscript() {
        transcript.push(text, '');
        yield* Console.log(text);
      });

    const failures: string[] = [];
    const tool = makeTool(client, transcript, failures);

    // ---------------------------------------------------------------------------------------------------------------
    // Session.

    const today = yield* DateTime.now;
    const from = DateTime.formatIsoDateUtc(DateTime.subtract(DateTime.startOf(today, 'month'), { months: 11 }));
    const to = DateTime.formatIsoDateUtc(today);
    const inDays = (days: number) => DateTime.formatIsoDateUtc(DateTime.add(today, { days }));

    yield* say('# Agent session: OntOS sales demo over MCP');
    yield* say(
      `Generated by \`app/tools/ontos-agent-mcp/scripts/demo-session.mts\` on ${to} against the local demo ` +
        `(composition \`${revision.slice(0, 12)}…\`). The client speaks JSON-RPC over stdio to \`${serverInfo.name} ` +
        `${serverInfo.version}\`, authenticated as the \`agent-bot\` service principal (managed API key). ` +
        'Results are abbreviated to the first five items of each list.',
    );
    const toolList = tools.map((item) => `\`${item.name}\``).join(', ');
    yield* say(`Tools (${tools.length}): ${toolList}.`);

    yield* tool('whoami', {});

    yield* say('## 1. Čísla: fakturované tržby po měsících za posledních 12 měsíců (požadavek 8)');
    const revenueResult = yield* tool('get_metrics', { from, groupBy: 'month', metric: 'revenue_invoiced', to }, 12);
    const revenue = Option.getOrUndefined(decodeOptional(Revenue, revenueResult));
    if (revenue !== undefined) {
      yield* say(`Agent: Fakturované tržby ${from} – ${to} celkem **${czk(revenue.total ?? 0)}**.`);
    }

    yield* say('## 2. Příležitosti ve fázi Vyjednávání (požadavek 8)');
    const negotiation = Option.getOrUndefined(
      decodeOptional(Negotiation, yield* tool('list_opportunities', { stage: 'NEGOTIATION' })),
    );
    const negotiationItems = negotiation?.items ?? [];
    yield* say(
      `Agent: ${negotiationItems.length} příležitostí ve vyjednávání, otevřená hodnota ` +
        `${czk(negotiation?.summary.openValueCzk ?? 0)}.`,
    );

    yield* say('## 3. Úkol pro obchodníka k zákazníkovi (požadavek 9)');
    const customers = yield* tool('list_customers', {}, 3);
    const customerItems = itemsOf(CustomerRef, customers);
    const nameOf = (partyId: string) => customerItems.find((item) => item.partyId === partyId)?.name ?? partyId;
    yield* Effect.gen(function* writeFollowUps() {
      const reps = yield* tool('list_employees', { role: 'SALES_REP' }, 3);
      const rep = itemsOf(EmployeeRef, reps).at(0);
      const [focus] = negotiationItems;
      if (rep !== undefined && focus !== undefined) {
        yield* tool('create_task', {
          assigneeEmployeeId: rep.id,
          description: `Ověřit rozpočet a termín podpisu u příležitosti „${focus.title}“.`,
          dueDate: inDays(3),
          opportunityId: focus.id,
          partyId: focus.partyId,
          priority: 'HIGH',
          title: `Zavolat ${nameOf(focus.partyId)} kvůli nabídce`,
        });
        yield* say(
          `Agent: Úkol pro ${rep.name} k zákazníkovi ${nameOf(focus.partyId)} je vytvořen (termín ${inDays(3)}).`,
        );
      }

      yield* say('## 4. Posunout příležitost do fáze Nabídka (požadavek 9)');
      const moved = negotiationItems.at(-1);
      if (moved !== undefined) {
        yield* tool('update_opportunity', {
          id: moved.id,
          note: 'Zákazník chce upravenou nabídku (agent).',
          stage: 'PROPOSAL',
        });
        yield* say(`Agent: Příležitost „${moved.title}“ (${nameOf(moved.partyId)}) je zpět ve fázi Nabídka.`);
      }
    });

    yield* say('## 5. Štítkování podle pravidla z chatu (požadavek 11)');
    yield* say(
      `Pravidlo: zákazník s potvrzenými fakturami nad ${czk(VIP_THRESHOLD_CZK)} → „VIP“; ` +
        `objednávka nad ${czk(BIG_ORDER_THRESHOLD_CZK)} → štítek pro velké objednávky. Částky jsou vč. DPH.`,
    );
    const confirmed = yield* tool('list_invoices', { state: 'CONFIRMED' }, 3);
    const revenueByParty = new Map<string, number>();
    for (const invoice of itemsOf(InvoiceRef, confirmed)) {
      const partyId = invoice.partyId ?? invoice.counterpartyId;
      revenueByParty.set(partyId, (revenueByParty.get(partyId) ?? 0) + invoice.totalCzk);
    }
    const vip = [...revenueByParty.entries()]
      .filter(([, total]) => total > VIP_THRESHOLD_CZK)
      .toSorted(([, left], [, right]) => right - left);
    const vipList = vip.map(([partyId, total]) => `${nameOf(partyId)} (${czk(total)})`).join(', ');
    yield* say(`Agent: ${vip.length} zákazníků nad limitem: ${vipList}.`);
    if (vip.length > 0) {
      yield* tool('assign_tags', { kind: 'customer', subjectIds: vip.map(([partyId]) => partyId), tagName: 'VIP' });
    }

    const orders = yield* tool('list_orders', {}, 3);
    const bigOrders = itemsOf(OrderRef, orders).filter((order) => order.totalCzk > BIG_ORDER_THRESHOLD_CZK);
    yield* say(
      `Agent: ${bigOrders.length} objednávek nad limitem: ${bigOrders.map((order) => order.number).join(', ')}.`,
    );
    const orderTags = yield* tool('list_tags', { kind: 'order' });
    const allTags = yield* tool('list_tags', {});
    const bigTag = itemsOf(TagRef, allTags).find((tag) => tag.name === 'Velká zakázka');
    let orderTagName = 'Velká zakázka';
    if (bigTag === undefined || !bigTag.subjectKinds.includes('order')) {
      orderTagName = 'Velká objednávka';
      yield* say(
        `Agent: Štítek „Velká zakázka“ je jen pro ${bigTag?.subjectKinds.map((kind) => SUBJECT_KIND_CS.get(kind) ?? kind).join(', ') ?? '—'}, ne pro objednávky, ` +
          'a přejmenovat ani rozšířit ho nesmím. Založím proto nový štítek pro objednávky „Velká objednávka“.',
      );
      const exists = itemsOf(TagRef, orderTags).some((tag) => tag.name === orderTagName);
      if (!exists) {
        yield* tool('create_tag', {
          color: 'orange',
          description: `Objednávka nad ${czk(BIG_ORDER_THRESHOLD_CZK)} vč. DPH (pravidlo agenta).`,
          name: orderTagName,
          subjectKinds: ['order'],
        });
      }
    }
    if (bigOrders.length > 0) {
      yield* tool('assign_tags', {
        kind: 'order',
        subjectIds: bigOrders.map((order) => order.id),
        tagName: orderTagName,
      });
    }

    yield* say('## 6. Hranice oprávnění (požadavek 10)');
    yield* say(
      'Agent nemá nástroj pro zápis do fakturace, cen ani mazání štítků. Přímé volání těchto příkazů s klíčem bota ' +
        'vrací 403 (ověřuje `app/scripts/demo/prove-sales-demo.mts`). Pokus o čtení fakturace jako čísla je povolen:',
    );
    yield* tool('list_invoices', { state: 'DRAFT' }, 3);

    if (outPath !== '') {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(outPath, `${transcript.join('\n').trimEnd()}\n`);
      yield* Console.log(`transcript → ${outPath}`);
    }
    if (failures.length > 0) {
      yield* Console.error(
        `\n${failures.length} tool error(s):\n${failures.join('\n')}\n--- server stderr ---\n${stderr.join('')}`,
      );
      return yield* new DemoSessionError({ operation: `${failures.length} MCP tool calls failed` });
    }
    return yield* Effect.void;
  });

const command = Command.make(
  'ontos-demo-session',
  {
    out: Flag.String('out').pipe(Flag.withDefault(defaultOutPath)),
  },
  ({ out }) => runSession(out).pipe(Effect.scoped),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Effect.scoped(
      Layer.build(
        Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
          Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
        ),
      ),
    ),
  );
}
