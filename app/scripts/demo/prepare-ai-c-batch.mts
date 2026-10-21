#!/usr/bin/env node
/**
 * LOCAL ONLY. Prepares the waiting AI level C batch the in-app demo guide (Hanák, chapter "AI agent A / B / C") walks
 * through: the real MCP server with profile C proposes a new telephone and a website for Bistro Král s.r.o. Nothing
 * changes in the client record until a person approves it in /cs/sprava/ke-schvaleni.
 *
 * Idempotent: when a batch of this kind is still fully pending, it is reused and no second batch is created. After a
 * demo ("Vrátit vše") run it again to get a fresh batch for the next customer.
 *
 *   node scripts/demo/prepare-ai-c-batch.mts        # from app/ (or ontos-runtime/app)
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
const compositionUrl = process.env.ONTOS_COMPOSITION_URL ?? 'http://127.0.0.1:3041';
const legalEntityId = '71000000-0000-4000-8000-000000000022';
const clientName = 'Bistro Král s.r.o.';
/** The guide finds the batch by this instruction; keep both in sync. */
const instruction = 'Ověření kontaktů Bistra Král po dnešní schůzce: nový telefon a web ke schválení vedením.';
const proposedPhone = '+420 577 702 555';
const proposedWebsite = 'https://bistro-kral.demo';

const key = process.env.ONTOS_AGENT_C_HANAK_API_KEY ?? env.ONTOS_AGENT_C_HANAK_API_KEY;
assert.ok(key, 'Chybí klíč AI úrovně C: spusťte nejprve pnpm demo:ai-profiles');
const revision = (await (await fetch(`${compositionUrl}/active`)).json()).composition.revision as string;

const jar = new Map<string, string>();
const cookies = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${shellUrl}${path}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', origin: shellUrl, 'x-correlation-id': randomUUID(), ...headers },
    method: 'POST',
  });
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(';')[0] ?? '';
    const at = pair.indexOf('=');
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return { body: await response.json(), status: response.status };
};

// The sales lead reads the approval queue the same way the page does.
const signIn = await post('/shell-super-app-api/auth/sign-in', { email: 'vedouci@hanak.demo', password: 'password1234' });
assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
const switched = await post('/shell-super-app-api/auth/legal-entity/switch', { legalEntityId }, { cookie: cookies() });
assert.equal(switched.status, 200, JSON.stringify(switched.body));

interface AiBatch {
  readonly id: string;
  readonly instruction: string;
  readonly runId: string;
}
interface AiChange {
  readonly batchId: string;
  readonly status: string;
}
interface CrmClient {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}
interface CrmRecords {
  readonly state: {
    readonly aiChanges: { readonly batches: readonly AiBatch[]; readonly changes: readonly AiChange[] };
    readonly clients: { readonly items: readonly CrmClient[] };
  };
}
const read = async (): Promise<CrmRecords> => {
  const gateway = await post(
    '/shell-super-app-api/auth/gateway-context',
    { audience: 'crm', compositionRevision: revision, legalEntityId },
    { cookie: cookies() },
  );
  assert.equal(gateway.status, 200, JSON.stringify(gateway.body));
  const records = await post(
    `${gateway.body.apiBaseUrl}/reads/records`,
    { refreshToken: randomUUID() },
    {
      authorization: `Bearer ${gateway.body.token}`,
      cookie: cookies(),
      'idempotency-key': randomUUID(),
      'x-ontos-composition-revision': revision,
    },
  );
  assert.equal(records.status, 200, JSON.stringify(records.body));
  return records.body as CrmRecords;
};

const waitingBatch = (records: CrmRecords): AiBatch | undefined =>
  records.state.aiChanges.batches.find((batch) => {
    const changes = records.state.aiChanges.changes.filter((change) => change.batchId === batch.id);
    return (
      batch.instruction === instruction && changes.length > 0 && changes.every((change) => change.status === 'pending')
    );
  });

const before = await read();
const existing = waitingBatch(before);
if (existing !== undefined) {
  console.log(`Dávka už čeká na schválení (${existing.id}); nic nového nevzniklo.`);
  process.exit(0);
}
const client = before.state.clients.items.find((entry) => entry.name === clientName && entry.status === 'active');
assert.ok(client, `Klient ${clientName} v CRM Hanák chybí`);

// Real MCP stdio session with profile C: the same tool an AI client (Claude, Codex) calls.
const child = spawn(process.execPath, ['--no-warnings', MCP_SERVER.pathname], {
  env: {
    ...process.env,
    ONTOS_AGENT_COMPANY: 'hanak',
    ONTOS_AGENT_PROFILE: 'C',
    ONTOS_COMPOSITION_REVISION: revision,
    ONTOS_SHELL_URL: shellUrl,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk: Buffer) => {
  stderr += chunk.toString();
});
const pending = new Map<number, (message: Record<string, unknown>) => void>();
let buffer = '';
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
    const timer = setTimeout(() => reject(new Error(`MCP ${method} timeout; ${stderr.slice(-400)}`)), 60_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ id, jsonrpc: '2.0', method, params })}\n`);
  });

try {
  await request('initialize', {
    capabilities: {},
    clientInfo: { name: 'prepare-ai-c-batch', version: '1.0.0' },
    protocolVersion: '2025-06-18',
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const message = await request('tools/call', {
    arguments: {
      changes: [
        {
          operation: { _tag: 'UpdateClient', id: client.id, patch: { phone: proposedPhone } },
          reason: 'Telefon ověřený při dnešní schůzce s majitelem; před uložením vyžaduje schválení.',
        },
        {
          operation: { _tag: 'UpdateClient', id: client.id, patch: { website: proposedWebsite } },
          reason: 'Web uvedl klient ústně, vedení ho zatím nepotvrdilo.',
        },
      ],
      instruction,
      runId: `presenter-c-${randomUUID()}`,
    },
    name: 'propose_crm_changes',
  });
  const result = message.result as { content?: { text?: string }[]; isError?: boolean } | undefined;
  assert.ok(message.error === undefined && result?.isError !== true, result?.content?.[0]?.text ?? stderr.slice(-400));
  const created = waitingBatch(await read());
  assert.ok(created, 'Návrh se neuložil jako čekající dávka');
  console.log(`Připraveno: dávka ${created.id} (telefon + web pro ${clientName}) čeká na schválení.`);
} finally {
  child.kill();
}
