#!/usr/bin/env node
/**
 * Proof of the AI agent levels A and B against the RUNNING local demo (specs AGENT.md). LOCAL ONLY.
 *
 *   pnpm demo:prove:ai            # from app/; needs http://localhost:3020 and keys from scripts/demo/ai-profiles.mts
 *
 * Level A (read-only) and level B (reads + tasks) are separate service principals with their own managed API keys
 * and backend grants. The proof uses both channels an AI client could use:
 *   - the real MCP server (tools/ontos-agent-mcp, stdio JSON-RPC, ONTOS_AGENT_PROFILE=A|B), and
 *   - direct HTTP calls to the vertical Action API with the same key, bypassing the MCP tool list, to show that the
 *     backend (not the hidden tool) refuses the write: HTTP 403 + a denied Core audit event.
 * Writes performed: one task created by B (+ idempotent replay), then cancelled through the same governed Action.
 * Cleanup also cancels older open tasks carrying this proof's exact title/description signature; history is retained.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { Config, ConfigProvider, Effect, Layer, Path, Redacted } from 'effect';
import { NodeServices } from '@effect/platform-node';

import { DatabaseConfig, parseDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { actionInvocations, auditEvents } from '../../packages/core-runtime/src/db/schema.ts';
import { AuthDatabase, AuthDatabaseFromDatabaseConfigLive } from '../../apps/shell-super-app/api/auth/db/client.ts';
import { aiPrincipals } from './ai-profiles.mts';
import type { AiPrincipal } from './ai-profiles.mts';

const appRoot = new URL('../..', import.meta.url);
const ENV_FILE = new URL('.env.demo.local', appRoot);
const MCP_SERVER = new URL('tools/ontos-agent-mcp/src/server.ts', appRoot);
const SIAMPARK_LEGAL_ENTITY = '71000000-0000-4000-8000-000000000021';

const fileEnv = (): ReadonlyMap<string, string> =>
  new Map(
    (existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf-8') : '').split('\n').flatMap((line) => {
      const match = /^(?<key>[A-Z][A-Z0-9_]*)=(?<value>.*)$/u.exec(line.trim());
      return match?.groups?.key === undefined ? [] : [[match.groups.key, match.groups.value ?? ''] as const];
    }),
  );
const env = fileEnv();
const shellUrl = (process.env.ONTOS_SHELL_URL ?? env.get('ONTOS_SHELL_URL') ?? 'http://localhost:3020').replace(
  /\/+$/u,
  '',
);
const compositionUrl = process.env.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL ?? 'http://127.0.0.1:3041/active';

const principalOf = (level: 'A' | 'B'): AiPrincipal => {
  const found = aiPrincipals.find((principal) => principal.level === level && principal.company.key === 'obchod');
  if (found === undefined) {
    throw new Error(`No level ${level} principal`);
  }
  return found;
};
const levelA = principalOf('A');
const levelB = principalOf('B');
const keyOf = (principal: AiPrincipal): string => {
  const key = process.env[principal.envVar] ?? env.get(principal.envVar);
  if (key === undefined || key === '') {
    throw new Error(`${principal.envVar} missing in app/.env.demo.local: run node scripts/demo/ai-profiles.mts first`);
  }
  return key;
};

// ---------------------------------------------------------------------------------------------- result table

interface Row {
  readonly actual: string;
  readonly cs: string;
  readonly en: string;
  readonly expected: string;
  readonly level: string;
  readonly pass: boolean;
}
const rows: Row[] = [];
const record = (level: string, cs: string, en: string, expected: string, actual: string, pass: boolean) => {
  rows.push({ actual, cs, en, expected, level, pass });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  [${level}] ${cs} — ${actual}\n`);
};

// ---------------------------------------------------------------------------------------------- direct HTTP

const revision: string = await (async () => {
  const response = await fetch(compositionUrl);
  if (!response.ok) {
    throw new Error(`Composition publisher ${compositionUrl} answered HTTP ${response.status}`);
  }
  const body = (await response.json()) as { composition: { revision: string } };
  return body.composition.revision;
})();

interface Answer {
  readonly body: Record<string, unknown>;
  readonly status: number;
}

const gateway = async (key: string, audience: string, legalEntityId: string) => {
  const response = await fetch(`${shellUrl}/shell-super-app-api/auth/api-key/gateway-context`, {
    body: JSON.stringify({ audience, compositionRevision: revision, legalEntityId }),
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'x-correlation-id': randomUUID() },
    method: 'POST',
  });
  const text = await response.text();
  const body = (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>;
  return { body, status: response.status };
};

const verticalCall = async (
  principal: AiPrincipal,
  vertical: string,
  path: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Answer> => {
  const context = await gateway(keyOf(principal), vertical, principal.company.legalEntityId);
  if (context.status !== 200) {
    return context;
  }
  const { apiBaseUrl, token } = context.body as { apiBaseUrl: string; token: string };
  const response = await fetch(`${shellUrl}${apiBaseUrl}${path}`, {
    body: JSON.stringify(payload),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-correlation-id': randomUUID(),
      'x-ontos-composition-revision': revision,
      ...headers,
    },
    method: 'POST',
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    body = { text: text.slice(0, 200) };
  }
  return { body, status: response.status };
};

const readRecordsAs = async (principal: AiPrincipal, vertical: string, query: Record<string, unknown> = {}) =>
  await verticalCall(principal, vertical, '/reads/records', query);

const applyCommandAs = async (principal: AiPrincipal, vertical: string, command: Record<string, unknown>) => {
  const current = await readRecordsAs(principal, vertical);
  const expectedRevision = typeof current.body.revision === 'number' ? current.body.revision : 0;
  return await verticalCall(
    principal,
    vertical,
    `/${vertical}/actions/apply-command`,
    { command, expectedRevision },
    { 'idempotency-key': `prove-ai-${randomUUID()}` },
  );
};

const describe = ({ body, status }: Answer): string => {
  const code = typeof body.code === 'string' ? ` ${body.code}` : '';
  const detail = typeof body.detail === 'string' ? ` — ${body.detail}` : '';
  return `HTTP ${status}${code}${detail}`.slice(0, 160);
};

// ---------------------------------------------------------------------------------------------- MCP stdio

interface McpSession {
  readonly call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; value: unknown }>;
  readonly close: () => void;
  readonly tools: () => Promise<readonly string[]>;
}

const startMcp = async (level: 'A' | 'B'): Promise<McpSession> => {
  const child = spawn(process.execPath, ['--no-warnings', MCP_SERVER.pathname], {
    env: {
      ...process.env,
      ONTOS_AGENT_COMPANY: 'obchod',
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

const countOf = (value: unknown, field = 'count'): number | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'number' ? raw : Array.isArray(raw) ? raw.length : undefined;
};

// ---------------------------------------------------------------------------------------------- scenario

const startedAt = new Date(Date.now() - 1000);
const WRITE_TOOLS = [
  'create_task',
  'update_task',
  'create_opportunity',
  'update_opportunity',
  'create_tag',
  'assign_tags',
  'unassign_tags',
];

process.stdout.write(`\nOntOS AI agent levels — proof against ${shellUrl} (composition ${revision.slice(0, 12)}…)\n\n`);

// Level A over MCP
const mcpA = await startMcp('A');
const toolsA = await mcpA.tools();
const leakedA = toolsA.filter((name) => WRITE_TOOLS.includes(name));
record(
  'A',
  'MCP nabízí jen čtecí nástroje',
  'MCP lists read-only tools only',
  'žádný zápis',
  leakedA.length === 0 ? `${toolsA.length} nástrojů, žádný zápis` : `zápis: ${leakedA.join(', ')}`,
  leakedA.length === 0,
);
const whoA = await mcpA.call('whoami');
record(
  'A',
  'Identita agenta (whoami)',
  'Agent identity (whoami)',
  'profil A',
  `${JSON.stringify((whoA.value as Record<string, unknown>).profile)} / ${JSON.stringify((whoA.value as Record<string, unknown>).company)}`,
  !whoA.isError && (whoA.value as Record<string, unknown>).profile === 'A',
);
const ordersA = await mcpA.call('list_orders');
record(
  'A',
  'Čte objednávky (list_orders)',
  'Reads orders',
  'OK',
  ordersA.isError
    ? String(ordersA.value)
    : `OK, ${countOf(ordersA.value) ?? countOf(ordersA.value, 'items') ?? '?'} objednávek`,
  !ordersA.isError,
);
const oppsA = await mcpA.call('list_opportunities');
record(
  'A',
  'Čte příležitosti (list_opportunities)',
  'Reads opportunities',
  'OK',
  oppsA.isError
    ? String(oppsA.value)
    : `OK, ${countOf(oppsA.value) ?? countOf(oppsA.value, 'items') ?? '?'} příležitostí`,
  !oppsA.isError,
);
const tasksA = await mcpA.call('list_tasks');
record(
  'A',
  'Čte úkoly (list_tasks)',
  'Reads tasks',
  'OK',
  tasksA.isError ? String(tasksA.value) : `OK, ${countOf(tasksA.value) ?? '?'} úkolů`,
  !tasksA.isError,
);
const employeesA = await mcpA.call('list_employees');
record(
  'A',
  'Čte zaměstnance (list_employees)',
  'Reads employees',
  'OK',
  employeesA.isError
    ? String(employeesA.value)
    : `OK, ${countOf(employeesA.value) ?? countOf(employeesA.value, 'items') ?? '?'} zaměstnanců`,
  !employeesA.isError,
);
const createViaMcpA = await mcpA.call('create_task', { title: 'Nemělo by projít' });
record(
  'A',
  'create_task přes MCP',
  'create_task via MCP',
  'nástroj neexistuje',
  createViaMcpA.isError ? 'ZAMÍTNUTO: nástroj není registrován' : 'vytvořeno!',
  createViaMcpA.isError,
);
mcpA.close();

// Level A direct API (bypassing MCP): the backend must refuse.
const createDirectA = await applyCommandAs(levelA, 'siampark-work', {
  _tag: 'CreateTask',
  priority: 'NORMAL',
  title: 'Úroveň A — nesmí projít',
});
record(
  'A',
  'Přímé API: založit úkol',
  'Direct API: create task',
  'HTTP 403',
  describe(createDirectA),
  createDirectA.status === 403,
);

const oppRead = await readRecordsAs(levelA, 'sales-pipeline');
const firstOpp = (oppRead.body.items as { id: string; stage: string }[] | undefined)?.[0];
const orderRead = await readRecordsAs(levelA, 'merchandise');
const firstOrder = (orderRead.body.orders as { id: string; status: string }[] | undefined)?.[0];
if (firstOpp !== undefined) {
  const stageA = await applyCommandAs(levelA, 'sales-pipeline', {
    _tag: 'ChangeOpportunityStage',
    id: firstOpp.id,
    toStage: firstOpp.stage,
  });
  record(
    'A',
    'Přímé API: změnit příležitost',
    'Direct API: update opportunity',
    'HTTP 403',
    describe(stageA),
    stageA.status === 403,
  );
}
const crossCompany = await gateway(keyOf(levelA), 'siampark-work', SIAMPARK_LEGAL_ENTITY);
record(
  'A',
  'Cizí firma (Siampark) se stejným klíčem',
  'Other company with the same key',
  'zamítnuto',
  crossCompany.status === 200 ? 'POVOLENO!' : describe(crossCompany),
  crossCompany.status !== 200,
);

// Level B over MCP
const mcpB = await startMcp('B');
// Only clean earlier proof tasks observed before this run and the task this run creates. A concurrent
// rehearsal may be verifying its own still-open task; do not cancel tasks that appeared after our read.
const earlierTaskIds = new Set(((tasksA.value as { items?: { id: string }[] }).items ?? []).map((task) => task.id));
let proofTaskTitle: string | undefined;
try {
  const toolsB = await mcpB.tools();
  const leakedB = toolsB.filter(
    (name) => WRITE_TOOLS.includes(name) && name !== 'create_task' && name !== 'update_task',
  );
  record(
    'B',
    'MCP nabízí čtení + úkoly',
    'MCP lists reads + tasks',
    'create_task, update_task',
    `${toolsB.includes('create_task') ? 'create_task ✓' : 'create_task chybí'}${leakedB.length === 0 ? ', nic dalšího' : `, navíc: ${leakedB.join(', ')}`}`,
    toolsB.includes('create_task') && leakedB.length === 0,
  );
  const employees =
    (employeesA.value as { items?: { active: boolean; id: string; name: string; role: string }[] }).items ?? [];
  const assignee =
    employees.find((employee) => employee.active && employee.role === 'SALES_REP') ??
    employees.find((employee) => employee.active) ??
    employees[0];
  const due = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const stamp = new Date().toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' });
  const requestId = `prove-ai-${randomUUID()}`;
  const taskInput = {
    ...(assignee === undefined ? {} : { assigneeEmployeeId: assignee.id }),
    description: `Vytvořil AI agent úrovně B (důkaz ${stamp}).`,
    dueDate: due,
    priority: 'HIGH',
    requestId,
    title: `AI: zavolat zákazníkovi kvůli nabídce (${stamp})`,
  };
  proofTaskTitle = taskInput.title;
  const createdB = await mcpB.call('create_task', taskInput);
  const createdTask = (createdB.value as { task?: { id: string } | null }).task ?? null;
  record(
    'B',
    'Založí úkol (create_task)',
    'Creates a task',
    'OK',
    createdB.isError
      ? String(createdB.value)
      : `OK, úkol ${createdTask?.id.slice(0, 8) ?? '?'}… pro ${assignee?.name ?? 'bez přiřazení'}`,
    !createdB.isError && createdTask !== null,
  );
  const reread = await mcpB.call('list_tasks', {});
  const matching = ((reread.value as { items?: { id: string; title: string }[] }).items ?? []).filter(
    (task) => task.title === taskInput.title,
  );
  record(
    'B',
    'Úkol je znovu načten (list_tasks)',
    'Task re-read',
    '1 úkol',
    `${matching.length}× nalezen`,
    matching.length === 1,
  );
  const replay = await mcpB.call('create_task', taskInput);
  const reread2 = await mcpB.call('list_tasks', {});
  const matching2 = ((reread2.value as { items?: { title: string }[] }).items ?? []).filter(
    (task) => task.title === taskInput.title,
  );
  record(
    'B',
    'Opakované volání se stejným requestId',
    'Replay with the same requestId',
    'žádný duplikát',
    `deduplicated=${String((replay.value as { deduplicated?: boolean }).deduplicated)}, úkolů ${matching2.length}`,
    matching2.length === 1,
  );
  // Level B direct API: everything except tasks must be refused.
  if (firstOpp !== undefined) {
    const stageB = await applyCommandAs(levelB, 'sales-pipeline', {
      _tag: 'ChangeOpportunityStage',
      id: firstOpp.id,
      toStage: firstOpp.stage,
    });
    record(
      'B',
      'Přímé API: změnit příležitost',
      'Direct API: update opportunity',
      'HTTP 403',
      describe(stageB),
      stageB.status === 403,
    );
  }
  const tagB = await applyCommandAs(levelB, 'tagging', {
    _tag: 'CreateTag',
    color: 'gray',
    name: `AI test ${requestId.slice(-6)}`,
    subjectKinds: ['customer'],
  });
  record('B', 'Přímé API: založit štítek', 'Direct API: create tag', 'HTTP 403', describe(tagB), tagB.status === 403);
  if (firstOrder !== undefined) {
    const orderB = await applyCommandAs(levelB, 'merchandise', {
      _tag: 'ChangeOrderStatus',
      id: firstOrder.id,
      status: firstOrder.status,
    });
    record(
      'B',
      'Přímé API: změnit objednávku',
      'Direct API: change order',
      'HTTP 403',
      describe(orderB),
      orderB.status === 403,
    );
  }
} finally {
  // A timeout can hide a successful create response. Re-read by the proof signature rather than relying
  // only on createdTask; never touch a human task that merely happens to have a similar title.
  try {
    const listed = await mcpB.call('list_tasks');
    if (listed.isError) throw new Error(String(listed.value));
    const tasks =
      (listed.value as { items?: { id: string; title: string; description?: string; state: string }[] }).items ?? [];
    const leftovers = tasks.filter(
      (task) =>
        task.title.startsWith('AI: zavolat zákazníkovi kvůli nabídce (') &&
        task.description?.startsWith('Vytvořil AI agent úrovně B (důkaz ') === true &&
        (task.title === proofTaskTitle || earlierTaskIds.has(task.id)) &&
        ['NEW', 'IN_PROGRESS', 'WAITING'].includes(task.state),
    );
    for (const task of leftovers) {
      const cancelled = await mcpB.call('update_task', { id: task.id, state: 'CANCELLED' });
      if (cancelled.isError) throw new Error(`Úklid ${task.id}: ${String(cancelled.value)}`);
      process.stdout.write(
        `ÚKLID: důkazový úkol ${task.id} zrušen agentem B přes governed Action; historie zachována.\n`,
      );
    }
    const verified = await mcpB.call('list_tasks');
    if (verified.isError) throw new Error(String(verified.value));
    const after = (verified.value as { items?: { id: string; state: string }[] }).items ?? [];
    const clean = leftovers.every((task) => after.some((item) => item.id === task.id && item.state === 'CANCELLED'));
    record(
      'Úklid',
      'Důkazové úkoly zrušeny přes Action',
      'Proof tasks cancelled via Action',
      'žádný otevřený důkazový úkol',
      `${leftovers.length} zrušeno; historie zachována`,
      clean,
    );
  } catch (error) {
    record(
      'Úklid',
      'Důkazové úkoly zrušeny přes Action',
      'Proof tasks cancelled via Action',
      'žádný otevřený důkazový úkol',
      `RUČNÍ ÚKLID NUTNÝ: ${String(error)}`,
      false,
    );
  } finally {
    mcpB.close();
  }
}

// Core audit evidence for both principals since the proof started.
const auditRows = await Effect.runPromise(
  Effect.gen(function* readAudit() {
    const { executor } = yield* AuthDatabase;
    return yield* executor
      .select({
        actionKey: actionInvocations.actionKey,
        occurredAt: auditEvents.occurredAt,
        outcome: auditEvents.outcome,
        outcomeCode: auditEvents.outcomeCode,
        principalId: auditEvents.principalId,
      })
      .from(auditEvents)
      .leftJoin(actionInvocations, eq(actionInvocations.actionInvocationId, auditEvents.actionInvocationId))
      .where(
        and(
          inArray(auditEvents.principalId, [levelA.principalId, levelB.principalId]),
          gte(auditEvents.occurredAt, startedAt),
        ),
      )
      .orderBy(desc(auditEvents.occurredAt))
      .limit(40);
  }).pipe(
    Effect.provide(
      AuthDatabaseFromDatabaseConfigLive.pipe(
        Layer.provide(
          Layer.effect(
            DatabaseConfig,
            Config.Redacted('DATABASE_ADMIN_URL').pipe(
              Effect.flatMap((url) => parseDatabaseConfig({ DATABASE_URL: Redacted.value(url) })),
            ),
          ),
        ),
        Layer.provide(
          ConfigProvider.layer(
            Effect.gen(function* loadEnv() {
              const path = yield* Path.Path;
              const root = yield* path.fromFileUrl(appRoot);
              const file = yield* ConfigProvider.fromDotEnv({ path: path.join(root, '.env') });
              return ConfigProvider.orElse(ConfigProvider.fromEnv(), file);
            }),
          ),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
const actorOf = (principalId: string | null) =>
  principalId === levelA.principalId ? 'A' : principalId === levelB.principalId ? 'B' : '?';
const denied = auditRows.filter((row) => row.outcome === 'denied');
const succeeded = auditRows.filter((row) => row.outcome === 'succeeded' && actorOf(row.principalId) === 'B');
const expectedDenied = rows.filter((row) => row.expected === 'HTTP 403').length;
record(
  'Audit',
  'Core audit: zamítnuté pokusy',
  'Core audit: denied attempts',
  `≥ ${expectedDenied}`,
  `${denied.length} denied`,
  denied.length >= expectedDenied,
);
record(
  'Audit',
  'Core audit: úkol od B proveden',
  'Core audit: B task succeeded',
  '≥ 1',
  `${succeeded.length} succeeded`,
  succeeded.length >= 1,
);

// ---------------------------------------------------------------------------------------------- report

const pad = (value: string, width: number) =>
  value.length >= width ? value.slice(0, width) : value + ' '.repeat(width - value.length);
process.stdout.write('\nCore audit (actor · action · result · time):\n');
for (const row of auditRows.toReversed()) {
  process.stdout.write(
    `  ${actorOf(row.principalId)} · ${pad(row.actionKey ?? '(read/gateway)', 34)} · ${pad(`${row.outcome} ${row.outcomeCode}`, 42)} · ${row.occurredAt.toLocaleTimeString('cs-CZ', { timeZone: 'Europe/Prague' })}\n`,
  );
}
const short = (value: string) => value.replace(/ — .*$/u, '');
const header = `${pad('', 5)}  ${pad('Úroveň', 6)}  ${pad('Krok', 40)}  ${pad('Step', 34)}  ${pad('Očekáváno / Expected', 22)}  Výsledek / Result`;
process.stdout.write(`\n${header}\n${'─'.repeat(header.length + 12)}\n`);
for (const row of rows) {
  process.stdout.write(
    `${pad(row.pass ? 'PASS' : 'FAIL', 5)}  ${pad(row.level, 6)}  ${pad(row.cs, 40)}  ${pad(row.en, 34)}  ${pad(row.expected, 22)}  ${short(row.actual)}\n`,
  );
}
const failed = rows.filter((row) => !row.pass).length;
process.stdout.write(
  `\n${failed === 0 ? 'VŠE PROŠLO / ALL PASS' : `SELHALO ${failed} / ${failed} FAILED`} (${rows.length} kroků)\n`,
);
process.exitCode = failed === 0 ? 0 : 1;
