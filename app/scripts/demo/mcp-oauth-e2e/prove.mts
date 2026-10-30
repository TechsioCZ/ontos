// Real OAuth end-to-end proof of the OntOS MCP server (lane mcp-mcp-rs).
// Needs the Shell (authorization server and MCP endpoint /mcp) on localhost:3020.
// Run via app/scripts/demo/prove-mcp-oauth.mts. Never writes the coordination board.
import { isDeepStrictEqual } from 'node:util';
import { decodeJwt } from 'jose';
import {
  Array as EffectArray,
  Cause,
  Clock,
  Console,
  Duration,
  Effect,
  Exit,
  flow as compose,
  Option,
  Redacted,
  Runtime,
  Schema,
} from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { NodeServices } from '@effect/platform-node';
import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/client';
import {
  E2eSettings,
  loadE2eSettings,
  PERSONA,
  VERIFICATION_PERSONA,
  AGENT_OPERATOR_PERSONA,
  CIMD_CLIENT_ID,
  GRANT_CLAIM,
} from './env.mts';
import { Recorder } from './report.mts';
import { startLoopbackCallback } from './loopback.mts';
import type { E2eOAuthProviderOptions } from './provider.mts';
import { runOAuthFlow, rotateRefreshToken, refreshIsRejected } from './flow.mts';
import {
  closeMcpClient,
  connectMcp,
  callJson,
  rawLegacyInitialize,
  rawMcpStatus,
  MODERN_PROTOCOL_VERSION,
} from './mcp.mts';
import { openSharedTab, approveConnection, sessionPost } from './browser.mts';
import type { ActAs, E2eTab } from './browser.mts';

// Seeded agent (scripts/demo/ai-profiles.mts level B, operator = company administrator via setup-agent-operators.mts):
// direct writes on work.tasks only, every other module read-only.
const AGENT_NAME = 'AI agent B · čtení + úkoly (Obchodní firma)';
const PROOF_TASK_PREFIX = 'Důkaz MCP OAuth (agent)';
const OUT_OF_GRANT_CANDIDATES = [
  'demo.crm/command/UpdateClient',
  'demo.merchandise/command/ChangePrice',
  'demo.sales-pipeline/command/CreateOpportunity',
  'finance.billing/command/IssueInvoice',
];
const REQUIRED_TOOLS = [
  'ontos_whoami',
  'ontos_capabilities',
  'ontos_read',
  'ontos_list_proposals',
  'ontos_execute',
  'ontos_propose',
];

const runId = `mcp-oauth-e2e-${randomUUID()}`;
type Json = Schema.JsonObject;

class ProofFailed extends Schema.TaggedError<ProofFailed>()('ProofFailed', {
  message: Schema.String,
}) {}

const asRecord = compose(
  Schema.decodeUnknownOption(Schema.JsonObject),
  Option.getOrElse((): Json => ({})),
);
const asArray = compose(
  Schema.decodeUnknownOption(Schema.Array(Schema.Json)),
  Option.getOrElse((): readonly Schema.Json[] => []),
);
const asString = compose(Schema.decodeUnknownOption(Schema.String), Option.getOrUndefined);
const isString = Schema.is(Schema.String);
const displayJson = (value: Schema.Json | undefined): string => {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  if (EffectArray.isArray<Schema.Json | undefined>(value)) {
    return value.map((item) => (item === null ? '' : displayJson(item))).join(',');
  }
  if (Schema.is(Schema.JsonObject)(value)) {
    return '[object Object]';
  }
  return String(value);
};

const readModules = (value: Json): { moduleId: string; write: boolean }[] =>
  asArray(value.modules).map((item) => {
    const module = asRecord(item);
    return { moduleId: asString(module.moduleId) ?? '', write: module.write === true };
  });

/** Proof tasks still shown in task lists: open ones (an interrupted v2 run) and cancelled ones not yet hidden. */
const visibleProofTasks = (
  value: Schema.Json,
  found: { open: boolean; ref: Json }[] = [],
): { open: boolean; ref: Json }[] => {
  if (EffectArray.isArray<Schema.Json>(value)) {
    for (const item of value) {
      visibleProofTasks(item, found);
    }
  } else if (Schema.is(Schema.JsonObject)(value)) {
    const record = asRecord(value);
    const title = asString(record.title);
    const ref = asRecord(record.ref);
    if (title?.startsWith(PROOF_TASK_PREFIX) === true && ref.resourceType === 'work.tasks.task') {
      if (record.archivedAt === undefined || record.archivedAt === null) {
        found.push({ open: record.state !== 'CANCELLED' && record.state !== 'DONE', ref });
      }
    } else {
      for (const item of Object.values(record)) {
        visibleProofTasks(item, found);
      }
    }
  }
  return found;
};

const listToolNames = (client: Client) =>
  Effect.gen(function* listClientTools() {
    const listed = yield* Effect.tryPromise(async () => await client.listTools());
    return listed.tools.map((tool) => tool.name);
  });

/** Polls the MCP resource with the given token every 5 s for at most 35 s. */
const waitForInvalidToken = (token: Redacted.Redacted) =>
  Effect.gen(function* pollInvalidToken() {
    const E2E = yield* E2eSettings;
    const started = yield* Clock.monotonicTimeNanos;
    for (;;) {
      const response = yield* Effect.suspend(() => rawMcpStatus(E2E.mcpUrl, Option.some(token)));
      const now = yield* Clock.monotonicTimeNanos;
      const seconds = Math.round(Number(now - started) / 1_000_000_000);
      if (
        response.status === 401 &&
        Option.getOrElse(response.wwwAuthenticate, () => '').includes('error="invalid_token"')
      ) {
        return { ok: true, seconds, status: response.status };
      }
      if (now - started >= 35_000_000_000n) {
        return { ok: false, seconds, status: response.status };
      }
      yield* Effect.sleep(5000);
    }
  });

interface VariantDef {
  readonly actAs: ActAs;
  readonly key: 'v1' | 'v2';
  readonly label: string;
  readonly persona: string;
  readonly writeMode: 'approval' | 'direct';
}

interface VariantSummary {
  grantId: string | null;
  key: string;
  label: string;
  profileId: string | null;
}

const VARIANTS: readonly VariantDef[] = [
  // The AS is CIMD-only (no dynamic client registration), so both variants use the Claude Code CIMD document.
  {
    actAs: { kind: 'me' },
    key: 'v1',
    label: 'CIMD Claude Code · Za mě · ke schválení',
    persona: PERSONA,
    writeMode: 'approval',
  },
  {
    actAs: { agentName: AGENT_NAME, kind: 'agent' },
    key: 'v2',
    label: 'CIMD Claude Code · Za agenta · přímo',
    persona: AGENT_OPERATOR_PERSONA,
    writeMode: 'direct',
  },
];

const rec = new Recorder();
const variants: VariantSummary[] = [];

const preflight = () =>
  Effect.gen(function* preflightMetadata() {
    const E2E = yield* E2eSettings;
    const mcpOrigin = new URL(E2E.mcpUrl).origin;
    const issuerUrl = new URL(E2E.issuer);

    yield* rec.stepEffect(
      'pre',
      'PRM',
      Effect.gen(function* verifyProtectedResourceMetadata() {
        const http = yield* HttpClient.HttpClient;
        const response = yield* http.get(`${mcpOrigin}/.well-known/oauth-protected-resource/mcp`);
        const doc = asRecord(yield* response.json);
        const pass =
          doc.resource === E2E.mcpUrl &&
          isDeepStrictEqual(doc.authorization_servers, [E2E.issuer]) &&
          isDeepStrictEqual(doc.scopes_supported, ['ontos']);
        const servers = doc.authorization_servers;
        const serversDetail =
          servers === undefined ? 'undefined' : yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(servers);
        return {
          detail: `resource=${displayJson(doc.resource)}, authorization_servers=${serversDetail}`,
          pass,
        };
      }),
    );

    yield* rec.stepEffect(
      'pre',
      'AS metadata',
      Effect.gen(function* verifyAuthorizationMetadata() {
        const http = yield* HttpClient.HttpClient;
        const response = yield* http.get(
          `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname}`,
        );
        const doc = asRecord(yield* response.json);
        const pass =
          doc.issuer === E2E.issuer &&
          doc.authorization_response_iss_parameter_supported === true &&
          doc.client_id_metadata_document_supported === true &&
          asArray(doc.code_challenge_methods_supported).includes('S256');
        return {
          detail: `issuer=${displayJson(doc.issuer)}, iss=${displayJson(doc.authorization_response_iss_parameter_supported)}, cimd=${displayJson(doc.client_id_metadata_document_supported)}`,
          pass,
        };
      }),
    );

    const expectedChallenge = `Bearer resource_metadata="${mcpOrigin}/.well-known/oauth-protected-resource/mcp", scope="ontos"`;
    yield* rec.stepEffect(
      'pre',
      '401 bez tokenu',
      Effect.gen(function* verifyMissingTokenChallenge() {
        const response = yield* Effect.suspend(() => rawMcpStatus(E2E.mcpUrl, Option.none()));
        return {
          detail: `status ${response.status}`,
          pass: response.status === 401 && Option.contains(response.wwwAuthenticate, expectedChallenge),
        };
      }),
    );

    yield* rec.stepEffect(
      'pre',
      '401 pro API klíč',
      Effect.gen(function* verifyInvalidTokenChallenge() {
        const response = yield* Effect.suspend(() =>
          rawMcpStatus(E2E.mcpUrl, Option.some(Redacted.make('ontos_not_a_jwt_api_key_value'))),
        );
        return {
          detail: `status ${response.status}`,
          pass:
            response.status === 401 &&
            Option.getOrElse(response.wwwAuthenticate, () => '').includes('error="invalid_token"'),
        };
      }),
    );
  });

const runVariant = (def: VariantDef, summary: VariantSummary, verification: boolean, keep: boolean) =>
  Effect.gen(function* runOAuthVariant() {
    const E2E = yield* E2eSettings;
    const k = def.key;
    const tab: E2eTab = yield* Effect.acquireRelease(openSharedTab(), (value) => value.close.pipe(Effect.orDie));
    const open: Client[] = [];

    const lb = yield* Effect.acquireRelease(startLoopbackCallback(), (value) => value.close.pipe(Effect.ignore));
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* closeProofClients() {
        for (const item of open) {
          yield* closeMcpClient(item).pipe(Effect.ignore);
        }
      }),
    );
    const approve = (url: URL) =>
      approveConnection(tab.page, url.toString(), {
        actAs: def.actAs,
        email: def.persona,
        password: E2E.password,
        shotPrefix: k,
        shotsDir: E2E.shotsDir,
        writeMode: def.writeMode,
      });
    const providerOptions: E2eOAuthProviderOptions = {
      clientMetadataUrl: CIMD_CLIENT_ID,
      clientName: 'Claude Code',
      redirectUrl: lb.redirectUrl,
    };

    const recordedFlow = yield* rec.stepEffect(
      k,
      'OAuth přihlášení a souhlas (iss = issuer)',
      Effect.gen(function* authorizeVariant() {
        const result = yield* runOAuthFlow({ approve, loopback: lb, providerOptions, serverUrl: E2E.mcpUrl });
        return {
          detail: `iss=${String(Option.getOrNull(result.iss))} code=${result.code.length}zn refresh=${Option.exists(result.refreshToken, (token) => Redacted.value(token) !== '') ? 'ano' : 'ne'}`,
          pass: Option.contains(result.iss, E2E.issuer),
          value: result,
        };
      }),
    );
    const flow = Option.getOrUndefined(recordedFlow);
    if (flow === undefined || !Option.contains(flow.iss, E2E.issuer)) {
      return;
    }

    const { provider } = flow;
    const claims = yield* Effect.try(() => decodeJwt(Redacted.value(flow.accessToken)));
    const grantId = yield* Schema.decodeUnknownEffect(Schema.String)(claims[GRANT_CLAIM]);
    summary.grantId = grantId;
    let access = flow.accessToken;

    // Current MCP revision only (2026-07-28, server/discover).
    const recordedConnection = yield* rec.stepEffect(
      k,
      'tools/list (2026-07-28)',
      Effect.gen(function* verifyCurrentProtocol() {
        const { client, protocolVersion } = yield* Effect.suspend(() => connectMcp(E2E.mcpUrl, access));
        open.push(client);
        const names = yield* listToolNames(client);
        return {
          detail: `${names.length} nástrojů, verze ${protocolVersion}`,
          pass: protocolVersion === MODERN_PROTOCOL_VERSION && REQUIRED_TOOLS.every((name) => names.includes(name)),
          value: client,
        };
      }),
    );
    const connected = Option.getOrUndefined(recordedConnection);
    if (connected === undefined) {
      return;
    }
    const client = connected;

    const recordedIdentity = yield* rec.stepEffect(
      k,
      'ontos_whoami',
      Effect.gen(function* verifyActingIdentity() {
        const outcome = yield* Effect.suspend(() => callJson(client, 'ontos_whoami'));
        const value = asRecord(outcome.value);
        const acting = asRecord(value.acting);
        const modules = readModules(value);
        const writable = modules.filter((item) => item.write).map((item) => item.moduleId);
        const profileId = asString(value.profile_id) ?? '';
        const principalId = asString(acting.principalId);
        const { delegatedBy } = value;
        const profileOk = !outcome.isError && profileId !== '';
        const pass =
          def.key === 'v1'
            ? profileOk &&
              acting.kind === 'human' &&
              value.writePolicy === 'approval' &&
              (!verification ||
                (acting.principalId === '72000000-0000-4000-8000-000000000090' &&
                  asRecord(value.company).legalEntityId === '71000000-0000-4000-8000-000000000090' &&
                  modules.length === 1 &&
                  modules[0]?.moduleId === 'work.tasks'))
            : profileOk &&
              acting.kind === 'agent' &&
              delegatedBy !== null &&
              delegatedBy !== undefined &&
              value.writePolicy === 'direct' &&
              modules.every((item) => !item.write || item.moduleId === 'work.tasks');
        return {
          detail: `profil=${profileId === '' ? 'chybí' : 'ano'}, acting=${displayJson(acting.kind)}, writePolicy=${displayJson(value.writePolicy)}`,
          pass,
          value: { principalId, profileId, writable },
        };
      }),
    );
    const whoami = Option.getOrUndefined(recordedIdentity);
    const profileId = whoami?.profileId;
    summary.profileId = profileId === undefined || profileId === '' ? null : profileId;
    const writable = whoami?.writable ?? [];
    if (verification && (whoami === undefined || !rec.pass)) {
      return;
    }

    yield* rec.stepEffect(
      k,
      'čtení',
      Effect.gen(function* verifyRead() {
        const outcome = yield* Effect.suspend(() =>
          callJson(client, 'ontos_read', { id: 'work.tasks/read/records', limit: 3 }),
        );
        return { detail: outcome.isError ? 'isError' : 'záznamy načteny', pass: !outcome.isError };
      }),
    );

    if (def.key === 'v1') {
      // Approval era: the write becomes a proposal awaiting human approval.
      const recordedProposal = yield* rec.stepEffect(
        k,
        'zápis = návrh ke schválení',
        Effect.gen(function* proposeTask() {
          const outcome = yield* Effect.suspend(() =>
            callJson(client, 'ontos_execute', {
              id: 'work.tasks/command/CreateTask',
              idempotencyKey: `${runId}-v1`,
              input: { title: `Důkaz MCP OAuth ${runId}` },
              reason: 'Automatický důkaz připojení přes MCP; návrh bude zamítnut.',
            }),
          );
          const value = asRecord(outcome.value);
          const proposalId = asString(value.proposalId);
          const batchId = asString(value.batchId);
          const ids = asArray(value.proposalIds).filter(isString);
          const pass =
            !outcome.isError &&
            value.status === 'proposed' &&
            proposalId !== undefined &&
            displayJson(value.reviewUrl).includes('/cs/sprava/ke-schvaleni');
          const fallbackIds = proposalId === undefined ? [] : [proposalId];
          const result = {
            detail: pass ? `návrh ${proposalId}` : `status ${displayJson(value.status)}, isError=${outcome.isError}`,
            pass,
          };
          if (batchId === undefined) {
            return result;
          }
          return { ...result, value: { batchId, proposalIds: ids.length > 0 ? ids : fallbackIds } };
        }),
      );

      const proposal = Option.getOrUndefined(recordedProposal);
      yield* keep
        ? rec.log(`návrh ponechán: ${proposal?.batchId ?? 'žádný'}`)
        : rec.stepEffect(
            k,
            'úklid: návrh zamítnut',
            Effect.gen(function* rejectTaskProposal() {
              if (proposal === undefined) {
                return { detail: 'chybí batchId návrhu', pass: false };
              }
              const itemKeys = proposal.proposalIds.map((id) => `core:${id}`);
              const decided = yield* Effect.suspend(() =>
                sessionPost(
                  tab.page,
                  E2E.shellUrl,
                  '/shell-super-app-api/agent-platform/decide',
                  {
                    batchKey: `core:${proposal.batchId}`,
                    decision: 'reject',
                    itemKeys,
                    note: 'Automatický důkaz MCP OAuth – zamítnuto.',
                  },
                  { 'idempotency-key': `${runId}-decide` },
                ),
              );
              const results = asArray(asRecord(decided.json).results).map((item) => asRecord(item));
              return {
                detail: `status ${decided.status}`,
                pass:
                  decided.status === 200 &&
                  proposal.proposalIds.length > 0 &&
                  results.length === proposal.proposalIds.length &&
                  results.every((entry) => entry.outcome === 'rejected'),
              };
            }),
          );
    } else {
      // Earlier runs: cancel tasks an interrupted run left open, and hide cancelled proof tasks from task lists.
      yield* rec.stepEffect(
        k,
        'úklid: staré důkazní úkoly zrušeny a skryty',
        Effect.gen(function* removeOldProofTasks() {
          const listed = yield* Effect.suspend(() =>
            callJson(client, 'ontos_read', { id: 'work.tasks/read/records', limit: 500 }),
          );
          if (listed.isError) {
            return { detail: 'čtení úkolů selhalo', pass: false };
          }
          const leftovers = visibleProofTasks(
            Option.getOrElse(Schema.decodeUnknownOption(Schema.Json)(listed.value), () => null),
          );
          let done = 0;
          for (const [index, task] of leftovers.entries()) {
            const cancelled = task.open
              ? yield* Effect.suspend(() =>
                  callJson(client, 'ontos_execute', {
                    id: 'work.tasks/command/ChangeTaskState',
                    idempotencyKey: `${runId}-v2-leftover-${index}`,
                    input: { state: 'CANCELLED', taskRef: task.ref },
                  }),
                )
              : undefined;
            if (cancelled !== undefined && (cancelled.isError || asRecord(cancelled.value).status !== 'executed')) {
              continue;
            }
            const hidden = yield* Effect.suspend(() =>
              callJson(client, 'ontos_execute', {
                id: 'work.tasks/command/SetTaskArchived',
                idempotencyKey: `${runId}-v2-leftover-hide-${index}`,
                input: { archived: true, taskRef: task.ref },
              }),
            );
            if (!hidden.isError && asRecord(hidden.value).status === 'executed') {
              done += 1;
            }
          }
          return { detail: `uklizeno ${done}/${leftovers.length}`, pass: done === leftovers.length };
        }),
      );

      // Direct era: the write executes at once; the task is cancelled again so the board stays clean.
      yield* rec.stepEffect(
        k,
        'zápis přímo: úkol vytvořen, zrušen a skryt',
        Effect.gen(function* createCancelAndHideTask() {
          yield* rec.log(`[${k}] přímý zápis: CreateTask`);
          const created = yield* Effect.suspend(() =>
            callJson(client, 'ontos_execute', {
              id: 'work.tasks/command/CreateTask',
              idempotencyKey: `${runId}-v2`,
              input: { title: `${PROOF_TASK_PREFIX} ${runId}` },
            }),
          );
          const createdValue = asRecord(created.value);
          // TaskRef is a resource reference object ({ moduleId, resourceId, resourceType, tenantId }), passed back as is.
          const taskRef = asRecord(asRecord(asRecord(createdValue.result).task).ref);
          const taskId = asString(taskRef.resourceId);
          if (created.isError || createdValue.status !== 'executed' || taskId === undefined) {
            return {
              detail: `vytvoření: status ${displayJson(createdValue.status)}, isError=${created.isError}`,
              pass: false,
            };
          }
          yield* rec.log(`[${k}] přímý zápis: ChangeTaskState`);
          const cancelled = yield* Effect.suspend(() =>
            callJson(client, 'ontos_execute', {
              id: 'work.tasks/command/ChangeTaskState',
              idempotencyKey: `${runId}-v2-cancel`,
              input: { state: 'CANCELLED', taskRef },
            }),
          );
          const cancelledStatus = asRecord(cancelled.value).status;
          // Cancelled stays in the journal; hiding it keeps the demo task lists clean.
          yield* rec.log(`[${k}] přímý zápis: SetTaskArchived`);
          const hidden = yield* Effect.suspend(() =>
            callJson(client, 'ontos_execute', {
              id: 'work.tasks/command/SetTaskArchived',
              idempotencyKey: `${runId}-v2-hide`,
              input: { archived: true, taskRef },
            }),
          );
          const hiddenStatus = asRecord(hidden.value).status;
          const cancelDetail = cancelled.isError ? ` (${cancelled.text})` : '';
          const hideDetail = hidden.isError ? ` (${hidden.text})` : '';
          return {
            detail: `úkol ${taskId}: zrušení ${displayJson(cancelledStatus)}${cancelDetail}; skrytí ${displayJson(hiddenStatus)}${hideDetail}`,
            pass:
              !cancelled.isError && cancelledStatus === 'executed' && !hidden.isError && hiddenStatus === 'executed',
          };
        }),
      );
    }

    // Out-of-grant write: the module is not granted for writing, so the tool must refuse with a tool error.
    const candidate = OUT_OF_GRANT_CANDIDATES.find((id) => !writable.includes(id.slice(0, id.indexOf('/'))));
    yield* rec.stepEffect(
      k,
      'zápis mimo oprávnění = chyba nástroje',
      Effect.gen(function* verifyOutOfGrantWrite() {
        if (candidate === undefined) {
          return { detail: 'žádný kandidát mimo oprávnění', pass: false };
        }
        const outcome = yield* Effect.suspend(() =>
          callJson(client, 'ontos_execute', {
            id: candidate,
            input: {},
            reason: 'Test zápisu mimo oprávnění',
          }),
        );
        return {
          detail: `${candidate} → isError=${outcome.isError}`,
          pass: outcome.isError && /nesmí|jen číst/u.test(outcome.text),
        };
      }),
    );
    yield* Effect.tryPromise(async () => await client.close());

    // A 2025-era client is told which revision the server speaks instead of being served.
    yield* rec.stepEffect(
      k,
      'initialize 2025-11-25 odmítnut (jen 2026-07-28)',
      Effect.gen(function* verifyLegacyProtocolRejected() {
        const { body, status } = yield* Effect.suspend(() => rawLegacyInitialize(E2E.mcpUrl, access));
        return {
          detail: `HTTP ${status} ${body.slice(0, 160)}`,
          pass: body.includes('"error"') && body.includes(MODERN_PROTOCOL_VERSION) && !body.includes('"result"'),
        };
      }),
    );

    // Refresh rotation: the rotated pair works at once.
    let rotatedAt = yield* Clock.monotonicTimeNanos;
    const recordedRotation = yield* rec.stepEffect(
      k,
      'rotace refresh tokenu + nový access token funguje',
      Effect.gen(function* verifyRotatedTokens() {
        const result = yield* Effect.suspend(() =>
          rotateRefreshToken({ issuer: E2E.issuer, provider, resource: E2E.mcpUrl }),
        );
        rotatedAt = yield* Clock.monotonicTimeNanos;
        const { client: fresh } = yield* Effect.acquireRelease(connectMcp(E2E.mcpUrl, result.accessToken), (value) =>
          closeMcpClient(value.client).pipe(Effect.orDie),
        );
        open.push(fresh);
        const who = yield* callJson(fresh, 'ontos_whoami');
        const pass =
          Option.exists(
            result.newRefreshToken,
            (token) => Redacted.value(token) !== Redacted.value(result.oldRefreshToken),
          ) && !who.isError;
        return {
          detail: `nový refresh=${Option.isNone(result.newRefreshToken) ? 'ne' : 'ano'}, whoami=${who.isError ? 'isError' : 'OK'}`,
          pass,
          value: result,
        };
      }).pipe(Effect.scoped),
    );
    const rotated = Option.getOrUndefined(recordedRotation);
    if (rotated !== undefined) {
      access = rotated.accessToken;
    }

    /** Waits until the 30 s reuse grace of the rotated-out refresh token has passed, then presents it. */
    const oldRefreshRejected = () =>
      Effect.gen(function* replayOldRefreshToken() {
        if (rotated === undefined) {
          return false;
        }
        const now = yield* Clock.monotonicTimeNanos;
        const remaining = rotatedAt + 31_000_000_000n - now;
        yield* Effect.sleep(Duration.nanos(remaining > 0n ? remaining : 0n));
        return yield* refreshIsRejected({
          issuer: E2E.issuer,
          provider,
          refreshToken: rotated.oldRefreshToken,
          resource: E2E.mcpUrl,
        });
      });

    if (keep) {
      yield* rec.log(`grant ponechán: ${grantId}`);
    } else if (def.key === 'v1') {
      // Design §2.5: presenting the old refresh token after the 30 s grace is reuse; it is rejected and the
      // connection is revoked (audit oauth.token.refresh_reuse), so the current access token stops working too.
      yield* rec.stepEffect(
        k,
        'starý refresh po 30 s odmítnut → připojení zrušeno, 401 do 35 s',
        Effect.gen(function* verifyRefreshReuseRevokes() {
          const rejected = yield* oldRefreshRejected();
          if (!rejected) {
            return { detail: 'starý refresh token prošel', pass: false };
          }
          const waited = yield* waitForInvalidToken(access);
          return {
            detail: waited.ok ? `odmítnut, 401 za ${waited.seconds} s` : `odmítnut, poslední status ${waited.status}`,
            pass: waited.ok,
          };
        }),
      );
    } else {
      yield* rec.stepEffect(
        k,
        'odpojení → 401 do 35 s',
        Effect.gen(function* revokeConnection() {
          const revoked = yield* Effect.suspend(() =>
            sessionPost(tab.page, E2E.shellUrl, '/shell-super-app-api/auth/oauth-connections/revoke', {
              grantId,
              reason: 'user',
            }),
          );
          if (revoked.status !== 200) {
            return { detail: `revoke status ${revoked.status}`, pass: false };
          }
          const waited = yield* waitForInvalidToken(access);
          return {
            detail: waited.ok ? `${waited.seconds} s` : `${waited.seconds} s, poslední status ${waited.status}`,
            pass: waited.ok,
          };
        }),
      );
      yield* rec.stepEffect(
        k,
        'starý refresh token odmítnut (po 30 s)',
        Effect.gen(function* verifyOldRefreshRejected() {
          const rejected = yield* oldRefreshRejected();
          return { detail: rejected ? 'invalid_grant' : 'starý refresh token prošel', pass: rejected };
        }),
      );
    }
  }).pipe(Effect.scoped);

const command = Command.make(
  'prove-mcp-oauth',
  {
    checkToken: Flag.String('check-token').pipe(Flag.withDefault('')),
    keep: Flag.Boolean('keep').pipe(Flag.withDefault(false)),
    variantArg: Flag.Literals('variant', ['1', '2', 'all']).pipe(Flag.withDefault('all')),
    verification: Flag.Boolean('verification').pipe(Flag.withDefault(false)),
  },
  ({ checkToken, keep, variantArg, verification }) =>
    Effect.gen(function* runProofCommand() {
      const E2E = yield* E2eSettings;
      if (verification && (variantArg !== '1' || keep)) {
        return yield* new ProofFailed({
          message: `Neplatné volby: --variant=${variantArg}; ověření vyžaduje --variant=1 bez --keep.`,
        });
      }

      if (checkToken === '') {
        yield* preflight();
        const selected = VARIANTS.filter((def) => variantArg === 'all' || def.key === `v${variantArg}`);
        for (const def of selected) {
          const summary: VariantSummary = { grantId: null, key: def.key, label: def.label, profileId: null };
          variants.push(summary);
          const selectedDef = verification ? { ...def, persona: VERIFICATION_PERSONA } : def;
          yield* runVariant(selectedDef, summary, verification, keep).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : rec.stepEffect(def.key, 'výjimka', Effect.succeed({ detail: Cause.pretty(cause), pass: false })),
            ),
          );
        }
        yield* rec.log(`mcp-oauth-e2e: ${rec.pass ? 'PASS' : 'FAIL'} (${rec.steps.length} kroků)`);
        yield* rec.writeEffect(E2E.outDir, 'mcp-oauth-e2e', {
          issuer: E2E.issuer,
          mcpUrl: E2E.mcpUrl,
          runId,
          shellUrl: E2E.shellUrl,
          variants,
        });
      } else {
        const token = Redacted.make(checkToken);
        yield* rec.stepEffect(
          'pre',
          'odpojený token vrací 401 do 35 s',
          Effect.gen(function* verifyPreviouslyRevokedToken() {
            const waited = yield* waitForInvalidToken(token);
            return { detail: `${waited.seconds} s`, pass: waited.ok };
          }),
        );
        yield* rec.log(`mcp-oauth-e2e-check: ${rec.pass ? 'PASS' : 'FAIL'} (${rec.steps.length} kroků)`);
        yield* rec.writeEffect(E2E.outDir, 'mcp-oauth-e2e-check', { mcpUrl: E2E.mcpUrl, runId });
      }

      if (!rec.pass) {
        return yield* new ProofFailed({ message: 'MCP OAuth proof failed' });
      }
      return yield* Effect.void;
    }),
);

const abort = new AbortController();
const interrupt = (): void => {
  abort.abort();
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const exit = await Effect.runPromiseExit(
  Command.run(command, { version: '1.0.0' }).pipe(
    Effect.provideServiceEffect(E2eSettings, loadE2eSettings),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(NodeServices.layer),
    Effect.tapCause((cause) =>
      Runtime.getErrorReported(Cause.squash(cause)) ? Console.error(Cause.pretty(cause)) : Effect.void,
    ),
  ),
  { signal: abort.signal },
);
process.off('SIGINT', interrupt);
process.off('SIGTERM', interrupt);
const outcomeCode = Exit.match(exit, {
  onFailure: (cause) => (Cause.hasInterruptsOnly(cause) ? 130 : Runtime.getErrorExitCode(Cause.squash(cause))),
  onSuccess: () => 0,
});
process.exitCode = outcomeCode;
