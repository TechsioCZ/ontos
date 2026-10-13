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
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const SUBJECT_KIND_CS: Record<string, string> = {
  customer: 'zákazníky',
  employee: 'zaměstnance',
  opportunity: 'příležitosti',
  order: 'objednávky',
  product: 'produkty',
};
const VIP_THRESHOLD_CZK = 200_000;
const BIG_ORDER_THRESHOLD_CZK = 100_000;

const serverPath = fileURLToPath(new URL('../src/server.ts', import.meta.url));
const outArgument = process.argv.indexOf('--out');
const outPath =
  outArgument === -1
    ? fileURLToPath(new URL('../../../docs/demo/agent-session.md', import.meta.url))
    : (process.argv[outArgument + 1] ?? '');

const compositionUrl = process.env.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL ?? 'http://127.0.0.1:3041/active';
const composition = (await (await fetch(compositionUrl)).json()) as { composition: { revision: string } };
const revision = composition.composition.revision;

// ---------------------------------------------------------------------------------------------------------------
// Minimal JSON-RPC client over the child's stdio.

const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', serverPath], {
  env: { ...process.env, ONTOS_COMPOSITION_REVISION: revision },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const stderr: string[] = [];
child.stderr.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk));

type JsonRpcResponse = { id: number; result?: unknown; error?: { code: number; message: string } };
const pending = new Map<number, (response: JsonRpcResponse) => void>();
createInterface({ input: child.stdout }).on('line', (line) => {
  const message = JSON.parse(line) as JsonRpcResponse;
  if (typeof message.id === 'number') {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});

let nextId = 1;
const request = (method: string, params: unknown): Promise<JsonRpcResponse> => {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ id, jsonrpc: '2.0', method, params })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`${method} timed out`)), 60_000).unref();
  });
};
const notify = (method: string, params: unknown = {}) =>
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);

// ---------------------------------------------------------------------------------------------------------------
// Transcript.

const transcript: string[] = [];
const say = (text: string) => {
  transcript.push(text, '');
  console.log(text);
};
const abbreviate = (value: unknown, maxItems = 5): unknown => {
  if (Array.isArray(value)) {
    const head = value.slice(0, maxItems).map((item) => abbreviate(item, maxItems));
    return value.length > maxItems ? [...head, `… ${value.length - maxItems} dalších`] : head;
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, abbreviate(item, maxItems)]));
  }
  return value;
};

type ToolResult = { content: { text: string }[]; isError: boolean };
const failures: string[] = [];
// oxlint-disable-next-line typescript/no-explicit-any -- tool results are free-form JSON; the session reads known fields.
const tool = async (name: string, args: Record<string, unknown>, maxItems = 5): Promise<any> => {
  const response = await request('tools/call', { arguments: args, name });
  const result = response.result as ToolResult | undefined;
  const text = result?.content[0]?.text ?? response.error?.message ?? '';
  const isError = result?.isError !== false;
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // plain-text tool error
  }
  transcript.push(
    `**→ \`${name}\`** \`${JSON.stringify(args)}\``,
    '',
    '```json',
    JSON.stringify(abbreviate(parsed, maxItems), null, 2),
    '```',
    '',
  );
  console.log(`${isError ? 'ERROR' : 'ok   '} ${name}`);
  if (isError) {
    failures.push(`${name}: ${text}`);
  }
  return parsed;
};

// ---------------------------------------------------------------------------------------------------------------
// Session.

const today = new Date();
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const from = isoDate(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1)));
const to = isoDate(today);
const inDays = (days: number) => isoDate(new Date(today.getTime() + days * 86_400_000));
const czk = (value: number) => `${Math.round(value).toLocaleString('cs-CZ')} Kč`;

const initialized = await request('initialize', {
  capabilities: {},
  clientInfo: { name: 'ontos-demo-session', version: '1.0.0' },
  protocolVersion: '2025-06-18',
});
notify('notifications/initialized');
const serverInfo = (initialized.result as { serverInfo: { name: string; version: string } }).serverInfo;
const tools = (await request('tools/list', {})).result as { tools: { name: string }[] };

say('# Agent session: OntOS sales demo over MCP');
say(
  `Generated by \`app/tools/ontos-agent-mcp/scripts/demo-session.mts\` on ${to} against the local demo ` +
    `(composition \`${revision.slice(0, 12)}…\`). The client speaks JSON-RPC over stdio to \`${serverInfo.name} ` +
    `${serverInfo.version}\`, authenticated as the \`agent-bot\` service principal (managed API key). ` +
    'Results are abbreviated to the first five items of each list.',
);
say(`Tools (${tools.tools.length}): ${tools.tools.map((item) => `\`${item.name}\``).join(', ')}.`);

await tool('whoami', {});

say('## 1. Čísla: fakturované tržby po měsících za posledních 12 měsíců (požadavek 8)');
const revenue = await tool('get_metrics', { from, groupBy: 'month', metric: 'revenue_invoiced', to }, 12);
if (typeof revenue === 'object' && revenue !== null && 'total' in revenue) {
  say(`Agent: Fakturované tržby ${from} – ${to} celkem **${czk(Number(revenue.total))}**.`);
}

say('## 2. Příležitosti ve fázi Vyjednávání (požadavek 8)');
const negotiation = await tool('list_opportunities', { stage: 'NEGOTIATION' });
const negotiationItems: { id: string; partyId: string; title: string; amountCzk: number }[] = negotiation?.items ?? [];
say(
  `Agent: ${negotiationItems.length} příležitostí ve vyjednávání, otevřená hodnota ` +
    `${czk(negotiation?.summary?.openValueCzk ?? 0)}.`,
);

say('## 3. Úkol pro obchodníka k zákazníkovi (požadavek 9)');
const customers = await tool('list_customers', {}, 3);
const customerItems: { partyId: string; name: string | null }[] = customers?.items ?? [];
const nameOf = (partyId: string) => customerItems.find((item) => item.partyId === partyId)?.name ?? partyId;
const reps = await tool('list_employees', { role: 'SALES_REP' }, 3);
const rep: { id: string; name: string } | undefined = reps?.items?.[0];
const focus = negotiationItems[0];
if (rep !== undefined && focus !== undefined) {
  await tool('create_task', {
    assigneeEmployeeId: rep.id,
    description: `Ověřit rozpočet a termín podpisu u příležitosti „${focus.title}“.`,
    dueDate: inDays(3),
    opportunityId: focus.id,
    partyId: focus.partyId,
    priority: 'HIGH',
    title: `Zavolat ${nameOf(focus.partyId)} kvůli nabídce`,
  });
  say(`Agent: Úkol pro ${rep.name} k zákazníkovi ${nameOf(focus.partyId)} je vytvořen (termín ${inDays(3)}).`);
}

say('## 4. Posunout příležitost do fáze Nabídka (požadavek 9)');
const moved = negotiationItems.at(-1);
if (moved !== undefined) {
  await tool('update_opportunity', {
    id: moved.id,
    note: 'Zákazník chce upravenou nabídku (agent).',
    stage: 'PROPOSAL',
  });
  say(`Agent: Příležitost „${moved.title}“ (${nameOf(moved.partyId)}) je zpět ve fázi Nabídka.`);
}

say('## 5. Štítkování podle pravidla z chatu (požadavek 11)');
say(
  `Pravidlo: zákazník s potvrzenými fakturami nad ${czk(VIP_THRESHOLD_CZK)} → „VIP“; ` +
    `objednávka nad ${czk(BIG_ORDER_THRESHOLD_CZK)} → štítek pro velké objednávky. Částky jsou vč. DPH.`,
);
const confirmed = await tool('list_invoices', { state: 'CONFIRMED' }, 3);
const revenueByParty = new Map<string, number>();
for (const invoice of (confirmed?.items ?? []) as {
  partyId: string | null;
  counterpartyId: string;
  totalCzk: number;
}[]) {
  const partyId = invoice.partyId ?? invoice.counterpartyId;
  revenueByParty.set(partyId, (revenueByParty.get(partyId) ?? 0) + invoice.totalCzk);
}
const vip = [...revenueByParty.entries()]
  .filter(([, total]) => total > VIP_THRESHOLD_CZK)
  .sort(([, left], [, right]) => right - left);
say(
  `Agent: ${vip.length} zákazníků nad limitem: ` +
    vip.map(([partyId, total]) => `${nameOf(partyId)} (${czk(total)})`).join(', ') +
    '.',
);
if (vip.length > 0) {
  await tool('assign_tags', { kind: 'customer', subjectIds: vip.map(([partyId]) => partyId), tagName: 'VIP' });
}

const orders = await tool('list_orders', {}, 3);
const bigOrders = ((orders?.items ?? []) as { id: string; number: string; totalCzk: number }[]).filter(
  (order) => order.totalCzk > BIG_ORDER_THRESHOLD_CZK,
);
say(`Agent: ${bigOrders.length} objednávek nad limitem: ${bigOrders.map((order) => order.number).join(', ')}.`);
const orderTags = await tool('list_tags', { kind: 'order' });
const allTags = await tool('list_tags', {});
const bigTag = ((allTags?.items ?? []) as { name: string; subjectKinds: string[] }[]).find(
  (tag) => tag.name === 'Velká zakázka',
);
let orderTagName = 'Velká zakázka';
if (bigTag === undefined || !bigTag.subjectKinds.includes('order')) {
  orderTagName = 'Velká objednávka';
  say(
    `Agent: Štítek „Velká zakázka“ je jen pro ${bigTag?.subjectKinds.map((kind) => SUBJECT_KIND_CS[kind] ?? kind).join(', ') ?? '—'}, ne pro objednávky, ` +
      'a přejmenovat ani rozšířit ho nesmím. Založím proto nový štítek pro objednávky „Velká objednávka“.',
  );
  const exists = ((orderTags?.items ?? []) as { name: string }[]).some((tag) => tag.name === orderTagName);
  if (!exists) {
    await tool('create_tag', {
      color: 'orange',
      description: `Objednávka nad ${czk(BIG_ORDER_THRESHOLD_CZK)} vč. DPH (pravidlo agenta).`,
      name: orderTagName,
      subjectKinds: ['order'],
    });
  }
}
if (bigOrders.length > 0) {
  await tool('assign_tags', { kind: 'order', subjectIds: bigOrders.map((order) => order.id), tagName: orderTagName });
}

say('## 6. Hranice oprávnění (požadavek 10)');
say(
  'Agent nemá nástroj pro zápis do fakturace, cen ani mazání štítků. Přímé volání těchto příkazů s klíčem bota ' +
    'vrací 403 (ověřuje `app/scripts/demo/prove-sales-demo.mts`). Pokus o čtení fakturace jako čísla je povolen:',
);
await tool('list_invoices', { state: 'DRAFT' }, 3);

child.stdin.end();
child.kill();
if (outPath !== '') {
  writeFileSync(outPath, `${transcript.join('\n').trimEnd()}\n`);
  console.log(`transcript → ${outPath}`);
}
if (failures.length > 0) {
  console.error(
    `\n${failures.length} tool error(s):\n${failures.join('\n')}\n--- server stderr ---\n${stderr.join('')}`,
  );
  process.exitCode = 1;
}
