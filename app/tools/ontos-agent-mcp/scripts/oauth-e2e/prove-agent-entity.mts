// Real OAuth end-to-end proof of an administrator-created agent entity (lane agent-entities-admin).
// Flow: admin creates agent -> MCP OAuth "Za agenta" -> grants match -> write per policy -> deactivate -> 401 -> delete.
// Needs the shell AS on localhost:3020 and the MCP resource server on localhost:3090.
// Run via app/scripts/demo/prove-agent-entity.mts. Never writes the coordination board.
import { isDeepStrictEqual } from 'node:util';
import { decodeJwt } from 'jose';
import type { Client } from '@modelcontextprotocol/client';
import { E2E, CIMD_CLIENT_ID, GRANT_CLAIM, sleep } from './env.mts';
import { Recorder } from './report.mts';
import { startLoopbackCallback } from './loopback.mts';
import type { LoopbackCallback } from './loopback.mts';
import { E2eOAuthProvider } from './provider.mts';
import { runOAuthFlow } from './flow.mts';
import { connectMcp, callJson, rawMcpStatus } from './mcp.mts';
import { openSharedTab, ensureLoggedIn, approveConnection, sessionPost } from './browser.mts';
import type { E2eTab } from './browser.mts';

const USAGE = [
  'Použití (z app/):',
  '  node scripts/demo/prove-agent-entity.mts [--policy=approval|direct] [--keep] [--help]',
  '  --policy=approval|direct  zápis agenta: návrh ke schválení (výchozí), nebo přímý zápis',
  '  --keep                    agenta ponechá (přeskočí závěrečné smazání)',
  '  --help, -h                vypíše nápovědu a skončí',
  '',
].join('\n');

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(USAGE);
  process.exit(0);
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

const policyArg = argValue('policy') ?? 'approval';
if (policyArg !== 'approval' && policyArg !== 'direct') {
  throw new Error(`Neplatná hodnota --policy=${policyArg} (očekává se approval nebo direct).`);
}
const policy: 'approval' | 'direct' = policyArg;
const keep = argv.includes('--keep');

const ADMIN_EMAIL = 'management@siampark.demo';
const ADMIN_ID = '72000000-0000-4000-8000-000000000021';
const LEGAL_ENTITY_ID = '71000000-0000-4000-8000-000000000021';
const LIST = '/shell-super-app-api/auth/identity/agent-entities/list';
const MANAGE = '/shell-super-app-api/auth/identity/agent-entities';
const SHOTS = '/Volumes/TraceDecayKingston/techsio-demo/v2/shots/v5-agent-entities-admin';
const runId = `agent-entity-e2e-${Date.now()}`;
const AGENT_NAME = `Důkaz agent ${String(Date.now()).slice(-6)}`;
const PROOF_TITLE = `Důkaz agentní entity ${runId}`;
const GRANTS = [
  { access: 'read', moduleId: 'property.portfolio' },
  { access: 'write', moduleId: 'work.tasks' },
];

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readModules(value: Json): Array<{ moduleId: string; write: boolean }> {
  return asArray(value.modules).map((item) => {
    const module = asRecord(item);
    return { moduleId: asString(module.moduleId) ?? '', write: module.write === true };
  });
}

function sortByModule<T extends { moduleId: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0));
}

/** Finds the agent with the given principalId in an `AgentEntityOverview` answer (`agents`). */
function findByPrincipal(value: unknown, principalId: string): Json | undefined {
  return asArray(asRecord(value).agents)
    .map(asRecord)
    .find((agent) => agent.principalId === principalId);
}

function hasId(list: unknown, id: string): boolean {
  return asArray(list).some((item) => item === id || asRecord(item).principalId === id);
}

async function listToolNames(client: Client): Promise<string[]> {
  const listed = await client.listTools();
  return listed.tools.map((tool) => tool.name);
}

/** Polls the MCP resource with the given token every 5 s for at most 35 s. */
async function waitForInvalidToken(token: string): Promise<{ ok: boolean; seconds: number; status: number }> {
  const started = Date.now();
  for (;;) {
    const response = await rawMcpStatus(E2E.mcpUrl, token);
    const seconds = Math.round((Date.now() - started) / 1000);
    if (response.status === 401 && (response.wwwAuthenticate ?? '').includes('error="invalid_token"')) {
      return { ok: true, seconds, status: response.status };
    }
    if (Date.now() - started >= 35_000) {
      return { ok: false, seconds, status: response.status };
    }
    await sleep(5_000);
  }
}

const rec = new Recorder();
let grantId: string | null = null;

async function run(): Promise<void> {
  const tab: E2eTab = await openSharedTab();
  const open: Client[] = [];
  let loopback: LoopbackCallback | undefined = undefined;
  let agentId: string | undefined = undefined;
  let cleanupAttempted = false;

  try {
    await ensureLoggedIn(tab.page, E2E.shellUrl, ADMIN_EMAIL, E2E.password);
    await sessionPost(tab.page, E2E.shellUrl, '/shell-super-app-api/auth/legal-entity/switch', {
      legalEntityId: LEGAL_ENTITY_ID,
    });

    // Administrator creates the agent entity with its grants, operator and write policy.
    agentId = await rec.step('agent', 'správce založí agenta', async () => {
      const res = await sessionPost(
        tab.page,
        E2E.shellUrl,
        MANAGE,
        {
          description: 'Agent vytvořený automatickým důkazem; po důkazu se smaže.',
          displayName: AGENT_NAME,
          modules: GRANTS,
          operation: 'create',
          operatorPrincipalIds: [ADMIN_ID],
          ownerPrincipalId: ADMIN_ID,
          writePolicy: policy,
        },
        { 'idempotency-key': `${runId}-create` },
      );
      const json = asRecord(res.json);
      return {
        pass: res.status === 200 && json.status === 'active',
        detail: `status ${res.status}, stav ${String(json.status)}, zásady ${policy}`,
        value: asString(json.principalId),
      };
    });

    await rec.step('agent', 'agent je v seznamu s oprávněními a operátorem', async () => {
      if (agentId === undefined) {
        return { pass: false, detail: 'agent nebyl založen' };
      }
      const listed = await sessionPost(tab.page, E2E.shellUrl, LIST, {});
      const agent = findByPrincipal(listed.json, agentId);
      if (agent === undefined) {
        return { pass: false, detail: `agent ${agentId} není v seznamu (status ${listed.status})` };
      }
      const modules = sortByModule(
        asArray(agent.modules).map((item) => {
          const module = asRecord(item);
          return { access: asString(module.access) ?? '', moduleId: asString(module.moduleId) ?? '' };
        }),
      );
      const pass =
        isDeepStrictEqual(modules, sortByModule(GRANTS)) &&
        agent.writePolicy === policy &&
        hasId(agent.operators, ADMIN_ID);
      return {
        pass,
        detail: `moduly ${modules.map((m) => `${m.moduleId}:${m.access}`).join(', ')}, writePolicy=${String(agent.writePolicy)}`,
      };
    });

    // OAuth exactly like runVariant in prove.mts, acting as the agent ("Za agenta").
    const lb = await startLoopbackCallback();
    loopback = lb;
    const provider = new E2eOAuthProvider({
      clientName: 'Claude Code',
      clientMetadataUrl: CIMD_CLIENT_ID,
      redirectUrl: lb.redirectUrl,
      onRedirect: (url: URL) =>
        approveConnection(tab.page, url.toString(), {
          actAs: { kind: 'agent', agentName: AGENT_NAME },
          email: ADMIN_EMAIL,
          password: E2E.password,
          shotPrefix: `agent-${policy}`,
          shotsDir: SHOTS,
          writeMode: policy,
        }),
    });

    const flow = await rec.step('agent', 'OAuth přihlášení a souhlas Za agenta', async () => {
      const result = await runOAuthFlow({ loopback: lb, provider, serverUrl: E2E.mcpUrl });
      return {
        pass: result.iss === E2E.issuer,
        detail: `iss=${String(result.iss)} code=${result.code.length}zn refresh=${result.refreshToken ? 'ano' : 'ne'}`,
        value: result,
      };
    });
    if (flow === undefined || flow.iss !== E2E.issuer) {
      return;
    }

    const access = flow.accessToken;
    grantId = String(decodeJwt(access)[GRANT_CLAIM]);

    const { client } = await connectMcp(E2E.mcpUrl, access, 'legacy');
    open.push(client);

    await rec.step('agent', 'tools/list', async () => {
      const names = await listToolNames(client);
      const pass = ['ontos_whoami', 'ontos_read', 'ontos_execute'].every((name) => names.includes(name));
      return { pass, detail: `${names.length} nástrojů` };
    });

    await rec.step('agent', 'ontos_whoami = agent s oprávněními od správce', async () => {
      const outcome = await callJson(client, 'ontos_whoami');
      const value = asRecord(outcome.value);
      const acting = asRecord(value.acting);
      const modules = sortByModule(readModules(value));
      const pass =
        !outcome.isError &&
        acting.kind === 'agent' &&
        acting.principalId === agentId &&
        value.writePolicy === policy &&
        isDeepStrictEqual(modules, [
          { moduleId: 'property.portfolio', write: false },
          { moduleId: 'work.tasks', write: true },
        ]);
      return {
        pass,
        detail: `acting=${String(acting.kind)}, writePolicy=${String(value.writePolicy)}, moduly=${modules
          .map((m) => `${m.moduleId}${m.write ? '(zápis)' : ''}`)
          .join(', ')}`,
      };
    });

    await rec.step('agent', 'čtení v oprávnění', async () => {
      const outcome = await callJson(client, 'ontos_read', { id: 'work.tasks/read/records', limit: 3 });
      return { pass: !outcome.isError, detail: outcome.isError ? 'isError' : 'záznamy načteny' };
    });

    await rec.step('agent', 'čtení mimo oprávnění = chyba nástroje', async () => {
      const outcome = await callJson(client, 'ontos_read', { id: 'finance.billing/read/records', limit: 1 });
      return { pass: outcome.isError === true, detail: `isError=${String(outcome.isError)}` };
    });

    if (policy === 'approval') {
      // Approval policy: the write becomes a proposal awaiting human approval.
      const proposal = await rec.step('agent', 'zápis = návrh ke schválení', async () => {
        const outcome = await callJson(client, 'ontos_execute', {
          id: 'work.tasks/command/CreateTask',
          input: { title: PROOF_TITLE },
          reason: 'Automatický důkaz připojení přes MCP; návrh bude zamítnut.',
          idempotencyKey: `${runId}-write`,
        });
        const value = asRecord(outcome.value);
        const proposalId = asString(value.proposalId);
        const batchId = asString(value.batchId);
        const ids = asArray(value.proposalIds).filter(isString);
        const pass =
          !outcome.isError &&
          value.status === 'proposed' &&
          proposalId !== undefined &&
          String(value.reviewUrl).includes('/cs/sprava/ke-schvaleni');
        return {
          pass,
          detail: pass ? `návrh ${String(proposalId)}` : `status ${String(value.status)}, isError=${outcome.isError}`,
          value:
            batchId === undefined
              ? undefined
              : { batchId, proposalIds: ids.length > 0 ? ids : proposalId === undefined ? [] : [proposalId] },
        };
      });

      if (keep) {
        rec.log(`návrh ponechán: ${proposal?.batchId ?? 'žádný'}`);
      } else {
        await rec.step('agent', 'úklid: návrh zamítnut', async () => {
          if (proposal === undefined) {
            return { pass: false, detail: 'chybí batchId návrhu' };
          }
          const decided = await sessionPost(
            tab.page,
            E2E.shellUrl,
            '/shell-super-app-api/agent-platform/decide',
            {
              batchKey: `core:${proposal.batchId}`,
              decision: 'reject',
              itemKeys: proposal.proposalIds.map((id) => `core:${id}`),
              note: 'Automatický důkaz agentní entity – zamítnuto.',
            },
            { 'idempotency-key': `${runId}-decide` },
          );
          return { pass: decided.status === 200, detail: `status ${decided.status}` };
        });
      }
    } else {
      // Direct policy: the write executes at once; the task is cancelled and hidden again so the board stays clean.
      await rec.step('agent', 'zápis přímo: úkol vytvořen, zrušen a skryt', async () => {
        const created = await callJson(client, 'ontos_execute', {
          id: 'work.tasks/command/CreateTask',
          input: { title: PROOF_TITLE },
          idempotencyKey: `${runId}-write`,
        });
        const createdValue = asRecord(created.value);
        // TaskRef is a resource reference object ({ moduleId, resourceId, resourceType, tenantId }), passed back as is.
        const taskRef = asRecord(asRecord(asRecord(createdValue.result).task).ref);
        const taskId = asString(taskRef.resourceId);
        if (created.isError || createdValue.status !== 'executed' || taskId === undefined) {
          return { pass: false, detail: `vytvoření: status ${String(createdValue.status)}, isError=${created.isError}` };
        }
        const cancelled = await callJson(client, 'ontos_execute', {
          id: 'work.tasks/command/ChangeTaskState',
          input: { state: 'CANCELLED', taskRef },
          idempotencyKey: `${runId}-cancel`,
        });
        const cancelledStatus = asRecord(cancelled.value).status;
        // Cancelled stays in the journal; hiding it keeps the demo task lists clean.
        const hidden = await callJson(client, 'ontos_execute', {
          id: 'work.tasks/command/SetTaskArchived',
          input: { archived: true, taskRef },
          idempotencyKey: `${runId}-hide`,
        });
        return {
          pass: !cancelled.isError && cancelledStatus === 'executed' && !hidden.isError,
          detail: `úkol ${taskId} vytvořen, zrušen a skryt (status ${String(cancelledStatus)}, skrytí ${hidden.isError ? 'selhalo' : 'OK'})`,
        };
      });
    }

    await client.close();

    // Administrator deactivates the agent: its connections must be revoked.
    await rec.step('agent', 'deaktivace agenta odpojí jeho připojení', async () => {
      if (agentId === undefined) {
        return { pass: false, detail: 'agent nebyl založen' };
      }
      const res = await sessionPost(
        tab.page,
        E2E.shellUrl,
        MANAGE,
        {
          expectedStatus: 'active',
          newStatus: 'disabled',
          operation: 'change-status',
          principalId: agentId,
          reason: 'Důkaz: deaktivace agenta',
        },
        { 'idempotency-key': `${runId}-disable` },
      );
      const revoked = asRecord(res.json).revokedConnections;
      const count = typeof revoked === 'number' ? revoked : 0;
      return { pass: res.status === 200 && count >= 1, detail: `status ${res.status}, odpojeno ${count}` };
    });

    await rec.step('agent', 'další volání MCP selže (401)', async () => {
      const waited = await waitForInvalidToken(access);
      return { pass: waited.ok, detail: `${waited.seconds} s` };
    });

    if (keep) {
      rec.log(`agent ponechán: ${agentId ?? 'žádný'}`);
    } else {
      cleanupAttempted = true;
      await rec.step('agent', 'úklid: agent smazán a není v seznamu', async () => {
        if (agentId === undefined) {
          return { pass: false, detail: 'agent nebyl založen' };
        }
        const res = await sessionPost(
          tab.page,
          E2E.shellUrl,
          MANAGE,
          { operation: 'delete', principalId: agentId, reason: 'Úklid po automatickém důkazu' },
          { 'idempotency-key': `${runId}-delete` },
        );
        const listed = await sessionPost(tab.page, E2E.shellUrl, LIST, {});
        const stillListed = findByPrincipal(listed.json, agentId) !== undefined;
        return {
          pass: res.status === 200 && !stillListed,
          detail: `smazání status ${res.status}, v seznamu ${stillListed ? 'ano' : 'ne'}`,
        };
      });
    }
  } finally {
    for (const item of open) {
      await item.close().catch(() => undefined);
    }
    await loopback?.close().catch(() => undefined);
    if (agentId !== undefined && !keep && !cleanupAttempted) {
      await sessionPost(
        tab.page,
        E2E.shellUrl,
        MANAGE,
        { operation: 'delete', principalId: agentId, reason: 'Úklid po přerušeném důkazu' },
        { 'idempotency-key': `${runId}-delete` },
      ).catch(() => undefined);
    }
    await tab.close();
  }
}

try {
  await run();
} catch (error) {
  await rec.step('agent', 'výjimka', async () => ({ pass: false, detail: errorText(error) }));
}

rec.log(`agent-entity-e2e: ${rec.pass ? 'PASS' : 'FAIL'} (${rec.steps.length} kroků)`);
await rec.write(E2E.outDir, 'v5-agent-entities-e2e', {
  agentName: AGENT_NAME,
  grantId,
  mcpUrl: E2E.mcpUrl,
  policy,
  runId,
  shellUrl: E2E.shellUrl,
});
process.exitCode = rec.pass ? 0 : 1;
