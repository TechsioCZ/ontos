// Real OAuth end-to-end proof of the OntOS MCP server (lane mcp-mcp-rs).
// Needs the shell AS on localhost:3020 and the MCP resource server on localhost:3090.
// Run via app/scripts/demo/prove-mcp-oauth.mts. Never writes the coordination board.
import { isDeepStrictEqual } from 'node:util';
import { decodeJwt } from 'jose';
import type { Client } from '@modelcontextprotocol/client';
import { E2E, PERSONA, AGENT_OPERATOR_PERSONA, CIMD_CLIENT_ID, GRANT_CLAIM, sleep } from './env.mts';
import { Recorder } from './report.mts';
import { startLoopbackCallback } from './loopback.mts';
import type { LoopbackCallback } from './loopback.mts';
import { E2eOAuthProvider } from './provider.mts';
import { runOAuthFlow, rotateRefreshToken, refreshIsRejected } from './flow.mts';
import { connectMcp, callJson, rawMcpStatus, MODERN_PROTOCOL_VERSION } from './mcp.mts';
import { openSharedTab, approveConnection, sessionPost } from './browser.mts';
import type { ActAs, E2eTab } from './browser.mts';

// Seeded agent (scripts/demo/ai-profiles.mts level B, operator = company administrator via mcp-agent-operators.mts):
// direct writes on work.tasks only, every other module read-only.
const AGENT_NAME = 'AI agent B · čtení + úkoly (Obchodní firma)';
const OUT_OF_GRANT_CANDIDATES = [
  'demo.crm/command/UpdateClient',
  'demo.merchandise/command/ChangePrice',
  'demo.sales-pipeline/command/CreateOpportunity',
  'finance.billing/command/IssueInvoice',
];
const REQUIRED_LEGACY_TOOLS = [
  'ontos_whoami',
  'ontos_capabilities',
  'ontos_read',
  'ontos_list_proposals',
  'ontos_execute',
  'ontos_propose',
];

const runId = `mcp-oauth-e2e-${Date.now()}`;
const argv = process.argv.slice(2);

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

const variantArg = argValue('variant') ?? 'all';
if (variantArg !== '1' && variantArg !== '2' && variantArg !== 'all') {
  throw new Error(`Neplatná hodnota --variant=${variantArg} (očekává se 1, 2 nebo all).`);
}
const keep = argv.includes('--keep');
const checkToken = argValue('check-token');

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

interface VariantDef {
  readonly key: 'v1' | 'v2';
  readonly label: string;
  readonly persona: string;
  readonly actAs: ActAs;
  readonly writeMode: 'approval' | 'direct';
}

interface VariantSummary {
  key: string;
  label: string;
  grantId: string | null;
  profileId: string | null;
}

const VARIANTS: readonly VariantDef[] = [
  // The AS is CIMD-only (no dynamic client registration), so both variants use the Claude Code CIMD document.
  {
    key: 'v1',
    label: 'CIMD Claude Code · Za mě · ke schválení',
    persona: PERSONA,
    actAs: { kind: 'me' },
    writeMode: 'approval',
  },
  {
    key: 'v2',
    label: 'CIMD Claude Code · Za agenta · přímo',
    persona: AGENT_OPERATOR_PERSONA,
    actAs: { kind: 'agent', agentName: AGENT_NAME },
    writeMode: 'direct',
  },
];

const rec = new Recorder();
const variants: VariantSummary[] = [];

async function preflight(): Promise<void> {
  const mcpOrigin = new URL(E2E.mcpUrl).origin;
  const issuerUrl = new URL(E2E.issuer);

  await rec.step('pre', 'PRM', async () => {
    const response = await fetch(`${mcpOrigin}/.well-known/oauth-protected-resource/mcp`);
    const doc = asRecord(await response.json());
    const pass =
      doc.resource === E2E.mcpUrl &&
      isDeepStrictEqual(doc.authorization_servers, [E2E.issuer]) &&
      isDeepStrictEqual(doc.scopes_supported, ['ontos']);
    return {
      pass,
      detail: `resource=${String(doc.resource)}, authorization_servers=${JSON.stringify(doc.authorization_servers)}`,
    };
  });

  await rec.step('pre', 'AS metadata', async () => {
    const response = await fetch(`${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname}`);
    const doc = asRecord(await response.json());
    const pass =
      doc.issuer === E2E.issuer &&
      doc.authorization_response_iss_parameter_supported === true &&
      doc.client_id_metadata_document_supported === true &&
      asArray(doc.code_challenge_methods_supported).includes('S256');
    return {
      pass,
      detail: `issuer=${String(doc.issuer)}, iss=${String(doc.authorization_response_iss_parameter_supported)}, cimd=${String(doc.client_id_metadata_document_supported)}`,
    };
  });

  const expectedChallenge = `Bearer resource_metadata="${mcpOrigin}/.well-known/oauth-protected-resource/mcp", scope="ontos"`;
  await rec.step('pre', '401 bez tokenu', async () => {
    const response = await rawMcpStatus(E2E.mcpUrl, undefined);
    return {
      pass: response.status === 401 && response.wwwAuthenticate === expectedChallenge,
      detail: `status ${response.status}`,
    };
  });

  await rec.step('pre', '401 pro API klíč', async () => {
    const response = await rawMcpStatus(E2E.mcpUrl, 'ontos_not_a_jwt_api_key_value');
    return {
      pass: response.status === 401 && (response.wwwAuthenticate ?? '').includes('error="invalid_token"'),
      detail: `status ${response.status}`,
    };
  });
}

async function runVariant(def: VariantDef, summary: VariantSummary): Promise<void> {
  const k = def.key;
  const tab: E2eTab = await openSharedTab();
  const open: Client[] = [];
  let loopback: LoopbackCallback | undefined = undefined;

  try {
    const lb = await startLoopbackCallback();
    loopback = lb;
    const provider = new E2eOAuthProvider({
      clientName: 'Claude Code',
      clientMetadataUrl: CIMD_CLIENT_ID,
      redirectUrl: lb.redirectUrl,
      onRedirect: (url: URL) =>
        approveConnection(tab.page, url.toString(), {
          actAs: def.actAs,
          email: def.persona,
          password: E2E.password,
          shotPrefix: k,
          shotsDir: E2E.shotsDir,
          writeMode: def.writeMode,
        }),
    });

    const flow = await rec.step(k, 'OAuth přihlášení a souhlas (iss = issuer)', async () => {
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

    const grantId = String(decodeJwt(flow.accessToken)[GRANT_CLAIM]);
    summary.grantId = grantId;
    let access = flow.accessToken;

    // Legacy era (2025-11-25 negotiated via initialize).
    const legacy = await rec.step(k, 'tools/list (2025-11-25, initialize)', async () => {
      const { client, protocolVersion } = await connectMcp(E2E.mcpUrl, access, 'legacy');
      open.push(client);
      const names = await listToolNames(client);
      return {
        pass: REQUIRED_LEGACY_TOOLS.every((name) => names.includes(name)),
        detail: `${names.length} nástrojů, verze ${String(protocolVersion)}`,
        value: client,
      };
    });
    if (legacy === undefined) {
      return;
    }
    const client = legacy;

    const whoami = await rec.step(k, 'ontos_whoami', async () => {
      const outcome = await callJson(client, 'ontos_whoami');
      const value = asRecord(outcome.value);
      const acting = asRecord(value.acting);
      const modules = readModules(value);
      const writable = modules.filter((item) => item.write).map((item) => item.moduleId);
      const profileId = asString(value.profile_id) ?? '';
      const principalId = asString(acting.principalId);
      const delegatedBy = acting.delegatedBy;
      const profileOk = !outcome.isError && profileId !== '';
      const pass =
        def.key === 'v1'
          ? profileOk && acting.kind === 'human' && acting.writePolicy === 'approval'
          : profileOk &&
            acting.kind === 'agent' &&
            delegatedBy !== null &&
            delegatedBy !== undefined &&
            acting.writePolicy === 'direct' &&
            modules.every((item) => !item.write || item.moduleId === 'work.tasks');
      return {
        pass,
        detail: `profil=${profileId === '' ? 'chybí' : 'ano'}, acting=${String(acting.kind)}, writePolicy=${String(acting.writePolicy)}`,
        value: { writable, profileId, principalId },
      };
    });
    summary.profileId = whoami?.profileId ? whoami.profileId : null;
    const writable = whoami?.writable ?? [];

    await rec.step(k, 'čtení', async () => {
      const outcome = await callJson(client, 'ontos_read', { id: 'work.tasks/read/records', limit: 3 });
      return { pass: !outcome.isError, detail: outcome.isError ? 'isError' : 'záznamy načteny' };
    });

    if (def.key === 'v1') {
      // Approval era: the write becomes a proposal awaiting human approval.
      const proposal = await rec.step(k, 'zápis = návrh ke schválení', async () => {
        const outcome = await callJson(client, 'ontos_execute', {
          id: 'work.tasks/command/CreateTask',
          input: { title: `Důkaz MCP OAuth ${runId}` },
          reason: 'Automatický důkaz připojení přes MCP; návrh bude zamítnut.',
          idempotencyKey: `${runId}-v1`,
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
        await rec.step(k, 'úklid: návrh zamítnut', async () => {
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
              note: 'Automatický důkaz MCP OAuth – zamítnuto.',
            },
            { 'idempotency-key': `${runId}-decide` },
          );
          return { pass: decided.status === 200, detail: `status ${decided.status}` };
        });
      }
    } else {
      // Direct era: the write executes at once; the task is cancelled again so the board stays clean.
      await rec.step(k, 'zápis přímo: úkol vytvořen a zrušen', async () => {
        const created = await callJson(client, 'ontos_execute', {
          id: 'work.tasks/command/CreateTask',
          input: { title: `Důkaz MCP OAuth (agent) ${runId}` },
          idempotencyKey: `${runId}-v2`,
        });
        const createdValue = asRecord(created.value);
        const taskRef = asString(asRecord(asRecord(createdValue.result).task).ref);
        if (created.isError || createdValue.status !== 'executed' || taskRef === undefined) {
          return { pass: false, detail: `vytvoření: status ${String(createdValue.status)}, isError=${created.isError}` };
        }
        const cancelled = await callJson(client, 'ontos_execute', {
          id: 'work.tasks/command/ChangeTaskState',
          input: { state: 'CANCELLED', taskRef },
          idempotencyKey: `${runId}-v2-cancel`,
        });
        const cancelledStatus = asRecord(cancelled.value).status;
        return {
          pass: !cancelled.isError && cancelledStatus === 'executed',
          detail: `úkol ${taskRef} vytvořen a zrušen (status ${String(cancelledStatus)})`,
        };
      });
    }

    // Out-of-grant write: the module is not granted for writing, so the tool must refuse with a tool error.
    const candidate = OUT_OF_GRANT_CANDIDATES.find((id) => !writable.includes(id.slice(0, id.indexOf('/'))));
    await rec.step(k, 'zápis mimo oprávnění = chyba nástroje', async () => {
      if (candidate === undefined) {
        return { pass: false, detail: 'žádný kandidát mimo oprávnění' };
      }
      const outcome = await callJson(client, 'ontos_execute', {
        id: candidate,
        input: {},
        reason: 'Test zápisu mimo oprávnění',
      });
      return {
        pass: outcome.isError && /nesmí|jen číst/u.test(outcome.text),
        detail: `${candidate} → isError=${outcome.isError}`,
      };
    });
    await client.close();

    // Modern era (2026-07-28, pinned).
    await rec.step(k, 'tools/list + whoami (2026-07-28)', async () => {
      const { client: modern, protocolVersion } = await connectMcp(E2E.mcpUrl, access, 'modern');
      open.push(modern);
      try {
        const names = await listToolNames(modern);
        const who = await callJson(modern, 'ontos_whoami');
        return {
          pass: protocolVersion === MODERN_PROTOCOL_VERSION && names.includes('ontos_whoami') && !who.isError,
          detail: `${names.length} nástrojů, verze ${String(protocolVersion)}`,
        };
      } finally {
        await modern.close();
      }
    });

    // Refresh rotation: the old refresh token must be rejected once the 30 s grace has passed.
    const rotated = await rec.step(k, 'rotace refresh tokenu (starý odmítnut po 30 s)', async () => {
      const result = await rotateRefreshToken({ issuer: E2E.issuer, provider, resource: E2E.mcpUrl });
      await sleep(31_000);
      const rejected = await refreshIsRejected({
        issuer: E2E.issuer,
        provider,
        refreshToken: result.oldRefreshToken,
        resource: E2E.mcpUrl,
      });
      const pass = result.newRefreshToken !== undefined && result.newRefreshToken !== result.oldRefreshToken && rejected;
      return {
        pass,
        detail: `nový refresh=${result.newRefreshToken === undefined ? 'ne' : 'ano'}, starý odmítnut=${rejected ? 'ano' : 'ne'}`,
        value: result,
      };
    });
    if (rotated !== undefined) {
      access = rotated.accessToken;
    }

    await rec.step(k, 'nový access token funguje', async () => {
      if (rotated === undefined) {
        return { pass: false, detail: 'rotace selhala, nový access token chybí' };
      }
      const { client: fresh } = await connectMcp(E2E.mcpUrl, access, 'modern');
      open.push(fresh);
      try {
        const who = await callJson(fresh, 'ontos_whoami');
        return { pass: !who.isError, detail: who.isError ? 'isError' : 'whoami OK' };
      } finally {
        await fresh.close();
      }
    });

    if (keep) {
      rec.log(`grant ponechán: ${grantId}`);
    } else {
      await rec.step(k, 'odpojení → 401 do 35 s', async () => {
        const revoked = await sessionPost(
          tab.page,
          E2E.shellUrl,
          '/shell-super-app-api/auth/oauth-connections/revoke',
          { grantId, reason: 'user' },
        );
        if (revoked.status !== 200) {
          return { pass: false, detail: `revoke status ${revoked.status}` };
        }
        const waited = await waitForInvalidToken(access);
        return {
          pass: waited.ok,
          detail: waited.ok ? `${waited.seconds} s` : `${waited.seconds} s, poslední status ${waited.status}`,
        };
      });
    }
  } finally {
    for (const item of open) {
      await item.close().catch(() => undefined);
    }
    await loopback?.close().catch(() => undefined);
    await tab.close();
  }
}

if (checkToken) {
  const token: string = checkToken;
  await rec.step('pre', 'odpojený token vrací 401 do 35 s', async () => {
    const waited = await waitForInvalidToken(token);
    return { pass: waited.ok, detail: `${waited.seconds} s` };
  });
  rec.log(`mcp-oauth-e2e-check: ${rec.pass ? 'PASS' : 'FAIL'} (${rec.steps.length} kroků)`);
  await rec.write(E2E.outDir, 'mcp-oauth-e2e-check', { runId, mcpUrl: E2E.mcpUrl });
  process.exitCode = rec.pass ? 0 : 1;
} else {
  await preflight();
  const selected = VARIANTS.filter((def) => variantArg === 'all' || def.key === `v${variantArg}`);
  for (const def of selected) {
    const summary: VariantSummary = { key: def.key, label: def.label, grantId: null, profileId: null };
    variants.push(summary);
    try {
      await runVariant(def, summary);
    } catch (error) {
      await rec.step(def.key, 'výjimka', async () => ({ pass: false, detail: errorText(error) }));
    }
  }
  rec.log(`mcp-oauth-e2e: ${rec.pass ? 'PASS' : 'FAIL'} (${rec.steps.length} kroků)`);
  await rec.write(E2E.outDir, 'mcp-oauth-e2e', {
    runId,
    shellUrl: E2E.shellUrl,
    mcpUrl: E2E.mcpUrl,
    issuer: E2E.issuer,
    variants,
  });
  process.exitCode = rec.pass ? 0 : 1;
}
