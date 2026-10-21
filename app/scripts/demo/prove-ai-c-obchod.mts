#!/usr/bin/env node
/**
 * LOCAL ONLY: AI level C for Obchodní firma against the running demo.
 * Real MCP C -> pending proposals (opportunity stage + order cancellation) -> data unchanged -> direct API denied ->
 * human approval (obchod@demo.ontos) -> opportunity moved, order cancelled, stock returned -> Vrátit vše -> exact
 * original values and stock -> rejection changes nothing. Cleans up only its own runs.
 *
 *   node scripts/demo/prove-ai-c-obchod.mts
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const appRoot = new URL('../..', import.meta.url);
const MCP_SERVER = new URL('tools/ontos-agent-mcp/src/server.ts', appRoot);
const env = Object.fromEntries(
  readFileSync(new URL('.env.demo.local', appRoot), 'utf8')
    .split('\n')
    .flatMap((line) => {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line.trim());
      return match ? [[match[1], match[2]]] : [];
    }),
);
const shellUrl = process.env.ONTOS_SHELL_URL ?? 'http://localhost:3020';
const legalEntityId = '71000000-0000-4000-8000-000000000020';
const revision = (await (await fetch('http://127.0.0.1:3041/active')).json()).composition.revision;
const key = process.env.ONTOS_AGENT_C_OBCHOD_API_KEY ?? env.ONTOS_AGENT_C_OBCHOD_API_KEY;
assert.ok(key, 'Chybí klíč C pro Obchodní firmu: spusťte pnpm demo:ai-profiles z ontos-runtime/app');

const jar = new Map<string, string>();
const absorb = (response: Response) => {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(';')[0] ?? '';
    const at = pair.indexOf('=');
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
};
const cookies = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${shellUrl}${path}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', origin: shellUrl, 'x-correlation-id': randomUUID(), ...headers },
    method: 'POST',
  });
  absorb(response);
  return { body: await response.json(), status: response.status };
};
const signIn = await post('/shell-super-app-api/auth/sign-in', { email: 'obchod@demo.ontos', password: 'password1234' });
assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
const switched = await post('/shell-super-app-api/auth/legal-entity/switch', { legalEntityId }, { cookie: cookies() });
assert.equal(switched.status, 200, JSON.stringify(switched.body));

type Vertical = 'merchandise' | 'sales-pipeline';
const call = async (human: boolean, vertical: Vertical, path: string, body: unknown) => {
  const gateway = await post(
    human ? '/shell-super-app-api/auth/gateway-context' : '/shell-super-app-api/auth/api-key/gateway-context',
    { audience: vertical, compositionRevision: revision, legalEntityId },
    human ? { cookie: cookies() } : { 'x-api-key': key },
  );
  if (gateway.status !== 200) return gateway;
  return await post(`${gateway.body.apiBaseUrl}${path}`, body, {
    authorization: `Bearer ${gateway.body.token}`,
    'idempotency-key': randomUUID(),
    'x-ontos-composition-revision': revision,
    ...(human ? { cookie: cookies() } : {}),
  });
};
const readQuery = { merchandise: { view: {} }, 'sales-pipeline': {} } as const;
const read = async (vertical: Vertical, human = true) => {
  const result = await call(human, vertical, '/reads/records', readQuery[vertical]);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const command = async (vertical: Vertical, value: unknown, human = true) => {
  const before = await read(vertical);
  return await call(human, vertical, `/${vertical}/actions/apply-command`, {
    command: value,
    expectedRevision: before.revision,
  });
};
const humanCommand = async (vertical: Vertical, value: unknown) => {
  const result = await command(vertical, value);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const pass = (message: string) => console.log(`PASS [C/obchod] ${message}`);

interface McpSession {
  readonly call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; value: unknown }>;
  readonly close: () => void;
  readonly tools: () => Promise<readonly string[]>;
}
const startMcp = async (): Promise<McpSession> => {
  const child = spawn(process.execPath, ['--no-warnings', MCP_SERVER.pathname], {
    env: {
      ...process.env,
      ONTOS_AGENT_COMPANY: 'obchod',
      ONTOS_AGENT_PROFILE: 'C',
      ONTOS_COMPOSITION_REVISION: revision,
      ONTOS_SHELL_URL: shellUrl,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== '') {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (typeof message.id === 'number') {
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        }
      }
    }
  });
  let nextId = 0;
  const request = async (method: string, params: Record<string, unknown> = {}) =>
    await new Promise<Record<string, unknown>>((resolve, reject) => {
      nextId += 1;
      const id = nextId;
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out; stderr: ${stderr.slice(-400)}`)), 90_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ id, jsonrpc: '2.0', method, params })}\n`);
    });
  await request('initialize', {
    capabilities: {},
    clientInfo: { name: 'prove-ai-c-obchod', version: '1.0.0' },
    protocolVersion: '2025-06-18',
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    call: async (name, args = {}) => {
      const message = await request('tools/call', { arguments: args, name });
      const result = message.result as { content?: { text?: string }[]; isError?: boolean } | undefined;
      const text = result?.content?.[0]?.text ?? JSON.stringify(message.error ?? {});
      let value: unknown = text;
      try {
        value = JSON.parse(text);
      } catch {
        // plain-text tool error
      }
      return { isError: result?.isError === true || message.error !== undefined, value };
    },
    close: () => child.kill(),
    tools: async () => {
      const message = await request('tools/list');
      return (message.result as { tools: { name: string }[] }).tools.map(({ name }) => name).toSorted();
    },
  };
};

interface Opportunity {
  readonly id: string;
  readonly stage: string;
  readonly title: string;
}
interface OrderLine {
  readonly productId: string;
  readonly quantity: number;
  readonly variantId?: string;
}
interface Order {
  readonly id: string;
  readonly lines: readonly OrderLine[];
  readonly number: string;
  readonly status: string;
}
interface Product {
  readonly id: string;
  readonly stockOnHand: number;
}
const stockOf = (merchandise: { products: readonly Product[] }, order: Order) =>
  order.lines.map((line) => merchandise.products.find((product) => product.id === line.productId)?.stockOnHand ?? NaN);
const stripVolatile = ({ updatedAt: _u, stageHistory: _s, ...rest }: Record<string, unknown>) => rest;
const orderCore = (order: Record<string, unknown>) => {
  const { updatedAt: _u, history: _h, ...rest } = order;
  return rest;
};

const mcp = await startMcp();
const runId = `proof-c-obchod-${randomUUID()}`;
try {
  const tools = await mcp.tools();
  const legacyTools = tools.filter((name) => !name.startsWith('ontos_') && !name.includes('__'));
  assert.deepEqual(legacyTools, [
    'list_ai_proposals',
    'list_customers',
    'list_employees',
    'list_opportunities',
    'list_orders',
    'list_products',
    'propose_sales_changes',
    'whoami',
  ]);
  for (const name of ['ontos_describe', 'ontos_execute', 'ontos_list_capabilities', 'ontos_read']) {
    assert.ok(tools.includes(name), `chybí ${name}`);
  }
  const typedWrites = tools.filter((name) => name.includes('__') && !name.includes('__read_'));
  assert.ok(
    typedWrites.length > 0 &&
      typedWrites.every((name) => name.startsWith('sales_pipeline__') || name.startsWith('merchandise__')),
    typedWrites.join(', '),
  );
  assert.ok(!typedWrites.some((name) => /ai_decide_changes|ai_revert_batch|reset_demo_data/u.test(name)), typedWrites.join(', '));
  const capabilities = await mcp.call('ontos_list_capabilities');
  assert.equal((capabilities.value as { writePolicy?: string }).writePolicy, 'approval', JSON.stringify(capabilities.value));
  pass('Zásada zápisu C: jen přes schválení');
  pass('MCP C nabízí čtení a návrhy; žádný přímý zápis, schválení ani vrácení');
  const identity = await mcp.call('whoami');
  assert.equal(identity.isError, false, JSON.stringify(identity.value));
  pass('Identita C / Obchodní firma a gateway příležitostí fungují');

  const pipeline = await read('sales-pipeline');
  const merchandise = await read('merchandise');
  const opportunity: Opportunity = pipeline.items.find(
    (entry: Opportunity) => entry.stage === 'QUALIFIED' || entry.stage === 'PROPOSAL',
  );
  const order: Order = merchandise.orders.find(
    (entry: Order) => entry.status === 'NEW' && entry.lines.every((line) => line.variantId === undefined),
  );
  assert.ok(opportunity, 'Chybí otevřená příležitost ve fázi Kvalifikovaná/Nabídka');
  assert.ok(order, 'Chybí nová objednávka');
  const toStage = opportunity.stage === 'PROPOSAL' ? 'NEGOTIATION' : 'PROPOSAL';
  const stockBefore = stockOf(merchandise, order);
  const proposalArgs = {
    changes: [
      {
        operation: { kind: 'ChangeOpportunityStage', opportunityId: opportunity.id, toStage },
        reason: 'Zákazník potvrdil další krok na dnešní schůzce.',
      },
      {
        operation: { kind: 'ChangeOrderStatus', orderId: order.id, reason: 'Zákazník objednávku zrušil.', status: 'CANCELLED' },
        reason: 'Zákazník v e-mailu objednávku zrušil.',
      },
    ],
    instruction: 'Posuň příležitost o fázi dál a stornuj zrušenou objednávku.',
    runId,
  };
  const proposal = await mcp.call('propose_sales_changes', proposalArgs);
  assert.equal(proposal.isError, false, JSON.stringify(proposal.value));
  let opportunities = await read('sales-pipeline');
  let orders = await read('merchandise');
  const pipelineBatch = opportunities.aiChanges.batches.find((entry: { runId?: string }) => entry.runId === runId);
  const orderBatch = orders.aiChanges.batches.find((entry: { runId?: string }) => entry.runId === runId);
  assert.ok(pipelineBatch && orderBatch);
  const pipelineChanges = opportunities.aiChanges.changes.filter((entry: { batchId: string }) => entry.batchId === pipelineBatch.id);
  const orderChanges = orders.aiChanges.changes.filter((entry: { batchId: string }) => entry.batchId === orderBatch.id);
  assert.deepEqual([...pipelineChanges, ...orderChanges].map((entry: { status: string }) => entry.status), ['pending', 'pending']);
  assert.equal(opportunities.items.find((entry: Opportunity) => entry.id === opportunity.id).stage, opportunity.stage);
  assert.equal(orders.orders.find((entry: Order) => entry.id === order.id).status, 'NEW');
  assert.deepEqual(stockOf(orders, order), stockBefore);
  pass('Návrhy uloženy jako pending v příležitostech i objednávkách; data ani sklad se nezměnily');

  const repeated = await mcp.call('propose_sales_changes', proposalArgs);
  assert.equal(repeated.isError, false);
  opportunities = await read('sales-pipeline');
  assert.equal(opportunities.aiChanges.batches.filter((entry: { runId?: string }) => entry.runId === runId).length, 1);
  pass('Opakovaný runId nevytvoří druhou dávku');

  const won = opportunities.items.find((entry: Opportunity) => entry.stage === 'WON');
  if (won !== undefined) {
    const refused = await mcp.call('propose_sales_changes', {
      changes: [{ operation: { kind: 'ChangeOpportunityStage', opportunityId: won.id, toStage: 'LOST' }, reason: 'Test' }],
      instruction: 'Přesuň vyhranou příležitost do prohraných',
      runId: `${runId}-closed`,
    });
    assert.equal(refused.isError, true);
    assert.match(String(refused.value), /Uzavřenou/u);
    pass(`Nepovolený návrh (uzavřená příležitost) odmítnut hned: ${String(refused.value).slice(0, 90)}…`);
  }

  for (const [vertical, value] of [
    ['sales-pipeline', { _tag: 'ChangeOpportunityStage', id: opportunity.id, toStage: 'WON' }],
    ['sales-pipeline', { _tag: 'AiDecideChanges', changeIds: [pipelineChanges[0].id], decision: 'approve' }],
    ['merchandise', { _tag: 'ChangeOrderStatus', id: order.id, status: 'CANCELLED' }],
    ['merchandise', { _tag: 'AiRevertBatch', batchId: orderBatch.id }],
  ] as const) {
    const denied = await command(vertical, value, false);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    pass(`Přímé API ${vertical} ${value._tag} klíčem agenta: HTTP 403`);
  }

  await humanCommand('sales-pipeline', {
    _tag: 'AiDecideChanges',
    changeIds: pipelineChanges.map((entry: { id: string }) => entry.id),
    decision: 'approve',
    note: 'Ověřeno s obchodníkem',
  });
  await humanCommand('merchandise', {
    _tag: 'AiDecideChanges',
    changeIds: orderChanges.map((entry: { id: string }) => entry.id),
    decision: 'approve',
    note: 'Storno potvrzeno zákazníkem',
  });
  opportunities = await read('sales-pipeline');
  orders = await read('merchandise');
  assert.equal(opportunities.items.find((entry: Opportunity) => entry.id === opportunity.id).stage, toStage);
  assert.equal(orders.orders.find((entry: Order) => entry.id === order.id).status, 'CANCELLED');
  assert.deepEqual(
    stockOf(orders, order),
    stockBefore.map((stock, index) => stock + (order.lines[index]?.quantity ?? 0)),
  );
  pass('Schválení člověkem provedlo změnu fáze i storno objednávky; zboží se vrátilo na sklad');

  await humanCommand('sales-pipeline', { _tag: 'AiRevertBatch', batchId: pipelineBatch.id, note: 'Úklid po důkazu' });
  await humanCommand('merchandise', { _tag: 'AiRevertBatch', batchId: orderBatch.id, note: 'Úklid po důkazu' });
  opportunities = await read('sales-pipeline');
  orders = await read('merchandise');
  assert.deepEqual(
    stripVolatile(opportunities.items.find((entry: Opportunity) => entry.id === opportunity.id)),
    stripVolatile(pipeline.items.find((entry: Opportunity) => entry.id === opportunity.id)),
  );
  assert.deepEqual(
    orderCore(orders.orders.find((entry: Order) => entry.id === order.id)),
    orderCore(merchandise.orders.find((entry: Order) => entry.id === order.id)),
  );
  assert.deepEqual(stockOf(orders, order), stockBefore);
  const log = [
    ...opportunities.aiChanges.log.filter((entry: { batchId: string }) => entry.batchId === pipelineBatch.id),
    ...orders.aiChanges.log.filter((entry: { batchId: string }) => entry.batchId === orderBatch.id),
  ];
  assert.ok(log.every((entry: { actorPrincipalId: string; at: string; invocationId: string }) => entry.at && entry.actorPrincipalId && entry.invocationId));
  pass('Vrátit vše obnovilo příležitost, objednávku i sklad; deník má autora, čas a krok Core auditu');

  const rejected = await mcp.call('propose_sales_changes', { ...proposalArgs, runId: `${runId}-reject` });
  assert.equal(rejected.isError, false, JSON.stringify(rejected.value));
  opportunities = await read('sales-pipeline');
  const rejectedBatch = opportunities.aiChanges.batches.find((entry: { runId?: string }) => entry.runId === `${runId}-reject`);
  const rejectedItem = opportunities.aiChanges.changes.find((entry: { batchId: string }) => entry.batchId === rejectedBatch.id);
  await humanCommand('sales-pipeline', { _tag: 'AiDecideChanges', changeIds: [rejectedItem.id], decision: 'reject' });
  opportunities = await read('sales-pipeline');
  assert.equal(opportunities.items.find((entry: Opportunity) => entry.id === opportunity.id).stage, opportunity.stage);
  pass('Zamítnutí nic nemění a zůstává v deníku');
  console.log('VŠE PROŠLO / ALL PASS — AI level C (Obchodní firma)');
} finally {
  try {
    // Only this run's proposals: pending ones are rejected, applied ones reverted. The presenter's stay untouched.
    for (const vertical of ['sales-pipeline', 'merchandise'] as const) {
      const current = await read(vertical);
      const owned = (current.aiChanges?.batches ?? []).filter(
        (entry: { runId?: string }) => entry.runId?.startsWith(runId) === true,
      );
      for (const batch of owned) {
        const changes = current.aiChanges.changes.filter((entry: { batchId: string }) => entry.batchId === batch.id);
        if (changes.some((entry: { status: string }) => entry.status === 'applied') && batch.revertedAt === undefined) {
          await humanCommand(vertical, { _tag: 'AiRevertBatch', batchId: batch.id, note: 'Úklid přerušeného důkazu' });
        }
        const pendingIds = changes
          .filter((entry: { status: string }) => entry.status === 'pending')
          .map((entry: { id: string }) => entry.id);
        if (pendingIds.length > 0) {
          await humanCommand(vertical, { _tag: 'AiDecideChanges', changeIds: pendingIds, decision: 'reject', note: 'Úklid důkazu' });
        }
      }
    }
    pass('ÚKLID: žádný otevřený návrh tohoto běhu; původní údaje obnoveny, historie zachována');
  } catch (error) {
    console.error('POZOR: úklid důkazu C/obchod selhal; zkontrolujte AI změny ke schválení', runId, String(error));
    process.exitCode = 1;
  } finally {
    mcp.close();
  }
}
