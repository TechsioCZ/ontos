#!/usr/bin/env node
/** LOCAL ONLY: real MCP C -> pending -> human approval -> persisted -> revert -> original; direct API denials. */
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
const legalEntityId = '71000000-0000-4000-8000-000000000022';
const revision = (await (await fetch('http://127.0.0.1:3041/active')).json()).composition.revision;
const key = process.env.ONTOS_AGENT_C_HANAK_API_KEY ?? env.ONTOS_AGENT_C_HANAK_API_KEY;
assert.ok(key, 'Chybí klíč C: spusťte pnpm demo:ai-profiles z ontos-runtime/app');
const jar = new Map<string, string>();
const absorb = (response: Response) => {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(';')[0] ?? '';
    const at = pair.indexOf('=');
    jar.set(pair.slice(0, at), pair.slice(at + 1));
    if (pair.startsWith('__Secure-')) jar.set(pair.slice('__Secure-'.length, at), pair.slice(at + 1));
  }
};
const cookies = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${shellUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: shellUrl, 'x-correlation-id': randomUUID(), ...headers },
    body: JSON.stringify(body),
  });
  absorb(response);
  return { status: response.status, body: await response.json() };
};
const signIn = await post('/shell-super-app-api/auth/sign-in', {
  email: 'vedouci@hanak.demo',
  password: 'password1234',
});
assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
const switched = await post('/shell-super-app-api/auth/legal-entity/switch', { legalEntityId }, { cookie: cookies() });
assert.equal(switched.status, 200, JSON.stringify(switched.body));
const call = async (human: boolean, vertical: string, path: string, body: unknown, scope = legalEntityId) => {
  const gateway = await post(
    human ? '/shell-super-app-api/auth/gateway-context' : '/shell-super-app-api/auth/api-key/gateway-context',
    { audience: vertical, compositionRevision: revision, legalEntityId: scope },
    human ? { cookie: cookies() } : { 'x-api-key': key },
  );
  if (gateway.status !== 200) return gateway;
  return await post(`${gateway.body.apiBaseUrl}${path}`, body, {
    authorization: `Bearer ${gateway.body.token}`,
    'x-ontos-composition-revision': revision,
    'idempotency-key': randomUUID(),
    ...(human ? { cookie: cookies() } : {}),
  });
};
const read = async (human = true) => {
  const result = await call(human, 'crm', '/reads/records', {});
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const command = async (value: unknown) => {
  const before = await read();
  const result = await call(true, 'crm', '/crm/actions/apply-command', {
    expectedRevision: before.revision,
    command: value,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const pass = (message: string) => console.log(`PASS [C] ${message}`);
interface McpSession {
  readonly call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; value: unknown }>;
  readonly close: () => void;
  readonly tools: () => Promise<readonly string[]>;
}

const startMcp = async (level: 'C'): Promise<McpSession> => {
  const child = spawn(process.execPath, ['--no-warnings', MCP_SERVER.pathname], {
    env: {
      ...process.env,
      ONTOS_AGENT_COMPANY: 'hanak',
      ONTOS_AGENT_PROFILE: level,
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
      const timer = setTimeout(
        () => reject(new Error(`MCP ${method} timed out; stderr: ${stderr.slice(-400)}`)),
        60_000,
      );
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ id, jsonrpc: '2.0', method, params })}\n`);
    });
  await request('initialize', {
    capabilities: {},
    clientInfo: { name: 'prove-ai-levels', version: '1.0.0' },
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
      const result = message.result as { tools: { name: string }[] };
      return result.tools.map(({ name }) => name).toSorted();
    },
  };
};

const mcp = await startMcp('C');
let appliedBatch: string | undefined;
try {
  const tools = await mcp.tools();
  assert.deepEqual(tools, ['list_crm', 'propose_crm_changes', 'whoami']);
  pass('MCP C nabízí jen čtení CRM a návrhy (nikoli přímý zápis ani schválení)');
  const identity = await mcp.call('whoami');
  assert.equal(identity.isError, false, JSON.stringify(identity.value));
  pass('Identita C / Hanák a gateway CRM fungují');
  const before = await read(false);
  const client = before.state.clients.items.find((entry: { status: string }) => entry.status === 'active');
  assert.ok(client);
  const phone = client.phone === '+420 577 700 101' ? '+420 577 700 102' : '+420 577 700 101';
  const runId = `proof-c-${randomUUID()}`;
  const proposalArgs = {
    instruction: 'Ověřte změnu telefonu klienta podle posledního kontaktu',
    runId,
    changes: [
      {
        operation: { _tag: 'UpdateClient', id: client.id, patch: { phone } },
        reason: 'Telefon ověřen při dnešním hovoru s klientem',
      },
    ],
  };
  const proposal = await mcp.call('propose_crm_changes', proposalArgs);
  assert.equal(proposal.isError, false, JSON.stringify(proposal.value));
  let current = await read();
  const batch = current.state.aiChanges.batches.find((entry: { runId: string }) => entry.runId === runId);
  assert.ok(batch);
  appliedBatch = batch.id;
  const changes = current.state.aiChanges.changes.filter((entry: { batchId: string }) => entry.batchId === batch.id);
  assert.equal(changes[0].status, 'pending');
  assert.deepEqual(
    current.state.clients.items.find((entry: { id: string }) => entry.id === client.id),
    client,
  );
  pass('MCP návrh je trvale uložen jako pending; původní data se nezměnila');
  const repeated = await mcp.call('propose_crm_changes', proposalArgs);
  assert.equal(repeated.isError, false);
  current = await read();
  assert.equal(current.state.aiChanges.batches.filter((entry: { runId: string }) => entry.runId === runId).length, 1);
  pass('Opakovaný runId nevytvoří druhou dávku');
  for (const value of [
    { _tag: 'UpdateClient', id: client.id, patch: { phone: '+420 111 000 999' } },
    { _tag: 'AiDecideChanges', changeIds: [changes[0].id], decision: 'approve' },
    { _tag: 'AiRevertBatch', batchId: batch.id },
  ]) {
    const denied = await call(false, 'crm', '/crm/actions/apply-command', {
      expectedRevision: current.revision,
      command: value,
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    pass(`Přímé API ${value._tag}: HTTP 403 (server, nikoli skrytý nástroj)`);
  }
  const foreign = await call(false, 'crm', '/reads/records', {}, '71000000-0000-4000-8000-000000000021');
  assert.equal(foreign.status, 403);
  pass('Cizí firma je odmítnuta serverem');
  const deniedWork = await call(false, 'siampark-work', '/siampark-work/actions/apply-command', {
    expectedRevision: 0,
    command: { _tag: 'CreateTask', title: 'Kontaktovat klienta', priority: 'NORMAL' },
  });
  assert.equal(deniedWork.status, 403, JSON.stringify(deniedWork.body));
  pass('Zápis do jiného modulu (úkoly) HTTP 403');
  await command({
    _tag: 'AiDecideChanges',
    changeIds: changes.map((entry: { id: string }) => entry.id),
    decision: 'approve',
    note: 'Telefon ověřen vedoucím obchodu',
  });
  current = await read();
  assert.equal(current.state.clients.items.find((entry: { id: string }) => entry.id === client.id).phone, phone);
  assert.equal(
    current.state.aiChanges.changes.find((entry: { id: string }) => entry.id === changes[0].id).status,
    'applied',
  );
  pass('Lidské schválení provedlo normální CRM příkaz; nový telefon načten z backendu');
  await command({ _tag: 'AiRevertBatch', batchId: batch.id, note: 'Obnovení původních údajů po ukázce' });
  appliedBatch = undefined;
  current = await read();
  assert.deepEqual(
    current.state.clients.items.find((entry: { id: string }) => entry.id === client.id),
    client,
  );
  const log = current.state.aiChanges.log.filter((entry: { batchId: string }) => entry.batchId === batch.id);
  assert.deepEqual(
    log.map((entry: { action: string }) => entry.action),
    ['proposed', 'approved', 'reverted', 'batch_reverted'],
  );
  assert.ok(
    log.every(
      (entry: { at: string; actorPrincipalId: string; invocationId: string }) =>
        entry.at && entry.actorPrincipalId && entry.invocationId,
    ),
  );
  pass('Vrátit vše obnovilo přesný původní záznam; deník má autora, čas i výsledek každého kroku');
  // A rejected item remains a recorded human decision without changing data.
  const rejected = await mcp.call('propose_crm_changes', { ...proposalArgs, runId: `${runId}-reject` });
  assert.equal(rejected.isError, false);
  current = await read();
  const rejectedBatch = current.state.aiChanges.batches.find(
    (entry: { runId: string }) => entry.runId === `${runId}-reject`,
  );
  const item = current.state.aiChanges.changes.find((entry: { batchId: string }) => entry.batchId === rejectedBatch.id);
  await command({
    _tag: 'AiDecideChanges',
    changeIds: [item.id],
    decision: 'reject',
    note: 'Ukázka zamítnutí bez zásahu do dat',
  });
  current = await read();
  assert.deepEqual(
    current.state.clients.items.find((entry: { id: string }) => entry.id === client.id),
    client,
  );
  pass('Zamítnutí položky nic nemění a zůstává v historii');
  console.log('VŠE PROŠLO / ALL PASS — AI level C');
} finally {
  if (appliedBatch !== undefined) {
    try {
      await command({ _tag: 'AiRevertBatch', batchId: appliedBatch, note: 'Bezpečný úklid přerušeného důkazu' });
    } catch (error) {
      console.error('POZOR: dávku je třeba vrátit v UI', appliedBatch, String(error));
    }
  }
  mcp.close();
}
