// Real OAuth end-to-end proof of an administrator-created agent entity (lane agent-entities-admin).
// Flow: admin creates agent -> MCP OAuth "Za agenta" -> grants match -> write per policy -> deactivate -> 401 -> delete.
// Needs the Shell (authorization server and MCP endpoint /mcp) on localhost:3020.
// Run via app/scripts/demo/prove-agent-entity.mts. Never writes the coordination board.
import { isDeepStrictEqual } from 'node:util';
import { decodeJwt } from 'jose';
import {
  Array as EffectArray,
  Order,
  Cause,
  Clock,
  Console,
  Effect,
  Exit,
  flow as compose,
  Option,
  Redacted,
  Runtime,
  Schema,
} from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';
import { NodeServices } from '@effect/platform-node';
import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/client';
import { E2eSettings, loadE2eSettings, CIMD_CLIENT_ID, GRANT_CLAIM } from './env.mts';
import { Recorder } from './report.mts';
import { startLoopbackCallback } from './loopback.mts';
import type { E2eOAuthProviderOptions } from './provider.mts';
import { runOAuthFlow } from './flow.mts';
import { closeMcpClient, connectMcp, callJson, rawMcpStatus } from './mcp.mts';
import { openSharedTab, ensureLoggedIn, approveConnection, sessionPost } from './browser.mts';
import type { E2eTab } from './browser.mts';

const ADMIN_EMAIL = 'management@siampark.demo';
const ADMIN_ID = '72000000-0000-4000-8000-000000000021';
const LEGAL_ENTITY_ID = '71000000-0000-4000-8000-000000000021';
const LIST = '/shell-super-app-api/auth/identity/agent-entities/list';
const AGENT_NOT_CREATED = 'agent nebyl založen';
const MANAGE = '/shell-super-app-api/auth/identity/agent-entities';
const SHOTS = '/Volumes/TraceDecayKingston/techsio-demo/v2/shots/v5-agent-entities-admin';
const runId = `agent-entity-e2e-${randomUUID()}`;
const AGENT_NAME = `Důkaz agent ${randomUUID().slice(-6)}`;
const PROOF_TITLE = `Důkaz agentní entity ${runId}`;
const GRANTS = [
  { access: 'read', moduleId: 'property.portfolio' },
  { access: 'write', moduleId: 'work.tasks' },
];

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

const sortByModule = <T extends { moduleId: string }>(items: readonly T[]): T[] =>
  EffectArray.sort(
    items,
    Order.mapInput(Order.String, (item: T) => item.moduleId),
  );

/** Finds the agent with the given principalId in an `AgentEntityOverview` answer (`agents`). */
const findByPrincipal = (value: Json, principalId: string): Json | undefined =>
  asArray(value.agents)
    .map((item) => asRecord(item))
    .find((agent) => agent.principalId === principalId);

const hasId = (list: Schema.Json | undefined, id: string): boolean =>
  asArray(list).some((item) => item === id || asRecord(item).principalId === id);

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

const rec = new Recorder();
let grantId: string | null = null;

const run = (policy: 'approval' | 'direct', keep: boolean) =>
  Effect.gen(function* runAgentProof() {
    const E2E = yield* E2eSettings;
    const tab: E2eTab = yield* Effect.acquireRelease(openSharedTab(), (value) => value.close.pipe(Effect.orDie));
    const open: Client[] = [];
    let agentId: string | null = null;
    let cleanupAttempted = false;
    let agentWasDisabled = false;

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* removeInterruptedAgent() {
        if (agentId !== null && !keep && !cleanupAttempted) {
          yield* sessionPost(
            tab.page,
            E2E.shellUrl,
            MANAGE,
            {
              expectedStatus: agentWasDisabled ? 'disabled' : 'active',
              operation: 'delete',
              principalId: agentId,
              reason: 'Úklid po přerušeném důkazu',
            },
            { 'idempotency-key': `${runId}-delete` },
          ).pipe(Effect.ignore);
        }
      }),
    );
    yield* Effect.suspend(() => ensureLoggedIn(tab.page, E2E.shellUrl, ADMIN_EMAIL, E2E.password));
    yield* Effect.suspend(() =>
      sessionPost(tab.page, E2E.shellUrl, '/shell-super-app-api/auth/legal-entity/switch', {
        legalEntityId: LEGAL_ENTITY_ID,
      }),
    );

    // Administrator creates the agent entity with its grants, operator and write policy.
    agentId = Option.getOrNull(
      yield* rec.stepEffect(
        'agent',
        'správce založí agenta',
        Effect.gen(function* createAgentEntity() {
          const res = yield* Effect.suspend(() =>
            sessionPost(
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
            ),
          );
          const json = asRecord(res.json);
          return {
            detail: `status ${res.status}, stav ${displayJson(json.status)}, zásady ${policy}`,
            pass: res.status === 200 && json.status === 'active',
            value: asString(json.principalId),
          };
        }),
      ),
    );

    yield* rec.stepEffect(
      'agent',
      'agent je v seznamu s oprávněními a operátorem',
      Effect.gen(function* verifyAgentDirectory() {
        if (agentId === null) {
          return { detail: AGENT_NOT_CREATED, pass: false };
        }
        const listed = yield* Effect.suspend(() => sessionPost(tab.page, E2E.shellUrl, LIST, {}));
        const agent = findByPrincipal(asRecord(listed.json), agentId);
        if (agent === undefined) {
          return { detail: `agent ${agentId} není v seznamu (status ${listed.status})`, pass: false };
        }
        const modules = sortByModule(
          asArray(agent.modules).map((item) => {
            const module = asRecord(item);
            return { access: asString(module.access) ?? '', moduleId: asString(module.moduleId) ?? '' };
          }),
        );
        const moduleDetails = modules.map((module) => `${module.moduleId}:${module.access}`).join(', ');
        const pass =
          isDeepStrictEqual(modules, sortByModule(GRANTS)) &&
          agent.writePolicy === policy &&
          hasId(agent.operators, ADMIN_ID);
        return {
          detail: `moduly ${moduleDetails}, writePolicy=${displayJson(agent.writePolicy)}`,
          pass,
        };
      }),
    );

    // OAuth exactly like runVariant in prove.mts, acting as the agent ("Za agenta").
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
        actAs: { agentName: AGENT_NAME, kind: 'agent' },
        email: ADMIN_EMAIL,
        password: E2E.password,
        shotPrefix: `agent-${policy}`,
        shotsDir: SHOTS,
        writeMode: policy,
      });
    const providerOptions: E2eOAuthProviderOptions = {
      clientMetadataUrl: CIMD_CLIENT_ID,
      clientName: 'Claude Code',
      redirectUrl: lb.redirectUrl,
    };

    const recordedFlow = yield* rec.stepEffect(
      'agent',
      'OAuth přihlášení a souhlas Za agenta',
      Effect.gen(function* authorizeAgent() {
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

    const access = flow.accessToken;
    const claims = yield* Effect.try(() => decodeJwt(Redacted.value(access)));
    grantId = yield* Schema.decodeUnknownEffect(Schema.String)(claims[GRANT_CLAIM]);

    const { client } = yield* Effect.suspend(() => connectMcp(E2E.mcpUrl, access));
    open.push(client);

    yield* rec.stepEffect(
      'agent',
      'tools/list',
      Effect.gen(function* verifyTools() {
        const names = yield* listToolNames(client);
        const pass = ['ontos_whoami', 'ontos_read', 'ontos_execute'].every((name) => names.includes(name));
        return { detail: `${names.length} nástrojů`, pass };
      }),
    );

    yield* rec.stepEffect(
      'agent',
      'ontos_whoami = agent s oprávněními od správce',
      Effect.gen(function* verifyAgentIdentity() {
        const outcome = yield* Effect.suspend(() => callJson(client, 'ontos_whoami'));
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
          detail: `acting=${displayJson(acting.kind)}, writePolicy=${displayJson(value.writePolicy)}, moduly=${modules
            .map((m) => `${m.moduleId}${m.write ? '(zápis)' : ''}`)
            .join(', ')}`,
          pass,
        };
      }),
    );

    yield* rec.stepEffect(
      'agent',
      'čtení v oprávnění',
      Effect.gen(function* verifyAllowedRead() {
        const outcome = yield* Effect.suspend(() =>
          callJson(client, 'ontos_read', { id: 'work.tasks/read/records', limit: 3 }),
        );
        return { detail: outcome.isError ? 'isError' : 'záznamy načteny', pass: !outcome.isError };
      }),
    );

    yield* rec.stepEffect(
      'agent',
      'čtení mimo oprávnění = chyba nástroje',
      Effect.gen(function* verifyDeniedRead() {
        const outcome = yield* Effect.suspend(() =>
          callJson(client, 'ontos_read', { id: 'finance.billing/read/records', limit: 1 }),
        );
        return { detail: `isError=${outcome.isError}`, pass: outcome.isError };
      }),
    );

    if (policy === 'approval') {
      // Approval policy: the write becomes a proposal awaiting human approval.
      const recordedProposal = yield* rec.stepEffect(
        'agent',
        'zápis = návrh ke schválení',
        Effect.gen(function* proposeAgentTask() {
          const outcome = yield* Effect.suspend(() =>
            callJson(client, 'ontos_execute', {
              id: 'work.tasks/command/CreateTask',
              idempotencyKey: `${runId}-write`,
              input: { title: PROOF_TITLE },
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
            'agent',
            'úklid: návrh zamítnut',
            Effect.gen(function* rejectAgentProposal() {
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
                    note: 'Automatický důkaz agentní entity – zamítnuto.',
                  },
                  { 'idempotency-key': `${runId}-decide` },
                ),
              );
              return { detail: `status ${decided.status}`, pass: decided.status === 200 };
            }),
          );
    } else {
      // Direct policy: the write executes at once; the task is cancelled and hidden again so the board stays clean.
      yield* rec.stepEffect(
        'agent',
        'zápis přímo: úkol vytvořen, zrušen a skryt',
        Effect.gen(function* createCancelAndHideAgentTask() {
          const created = yield* Effect.suspend(() =>
            callJson(client, 'ontos_execute', {
              id: 'work.tasks/command/CreateTask',
              idempotencyKey: `${runId}-write`,
              input: { title: PROOF_TITLE },
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
          const cancelled = yield* Effect.suspend(() =>
            callJson(client, 'ontos_execute', {
              id: 'work.tasks/command/ChangeTaskState',
              idempotencyKey: `${runId}-cancel`,
              input: { state: 'CANCELLED', taskRef },
            }),
          );
          const cancelledStatus = asRecord(cancelled.value).status;
          // Cancelled stays in the journal; hiding it keeps the demo task lists clean.
          const hidden = yield* Effect.suspend(() =>
            callJson(client, 'ontos_execute', {
              id: 'work.tasks/command/SetTaskArchived',
              idempotencyKey: `${runId}-hide`,
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

    yield* Effect.tryPromise(async () => await client.close());

    // Administrator deactivates the agent: its connections must be revoked.
    yield* rec.stepEffect(
      'agent',
      'deaktivace agenta odpojí jeho připojení',
      Effect.gen(function* deactivateAgent() {
        if (agentId === null) {
          return { detail: AGENT_NOT_CREATED, pass: false };
        }
        const res = yield* Effect.suspend(() =>
          sessionPost(
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
          ),
        );
        const revoked = asRecord(res.json).revokedConnections;
        if (res.status === 200) {
          agentWasDisabled = true;
        }
        const count = Option.getOrElse(Schema.decodeUnknownOption(Schema.Number)(revoked), () => 0);
        return { detail: `status ${res.status}, odpojeno ${count}`, pass: res.status === 200 && count >= 1 };
      }),
    );

    yield* rec.stepEffect(
      'agent',
      'další volání MCP selže (401)',
      Effect.gen(function* verifyAgentTokenRevoked() {
        const waited = yield* waitForInvalidToken(access);
        return { detail: `${waited.seconds} s`, pass: waited.ok };
      }),
    );

    if (keep) {
      yield* rec.log(`agent ponechán: ${agentId ?? 'žádný'}`);
    } else {
      cleanupAttempted = true;
      yield* rec.stepEffect(
        'agent',
        'úklid: agent smazán a není v seznamu',
        Effect.gen(function* deleteAgentEntity() {
          if (agentId === null) {
            return { detail: AGENT_NOT_CREATED, pass: false };
          }
          const res = yield* Effect.suspend(() =>
            sessionPost(
              tab.page,
              E2E.shellUrl,
              MANAGE,
              {
                expectedStatus: agentWasDisabled ? 'disabled' : 'active',
                operation: 'delete',
                principalId: agentId,
                reason: 'Úklid po automatickém důkazu',
              },
              { 'idempotency-key': `${runId}-delete` },
            ),
          );
          const listed = yield* Effect.suspend(() => sessionPost(tab.page, E2E.shellUrl, LIST, {}));
          const stillListed = findByPrincipal(asRecord(listed.json), agentId) !== undefined;
          return {
            detail: `smazání status ${res.status}, v seznamu ${stillListed ? 'ano' : 'ne'}`,
            pass: res.status === 200 && !stillListed,
          };
        }),
      );
    }
  }).pipe(Effect.scoped);

const command = Command.make(
  'prove-agent-entity',
  {
    keep: Flag.Boolean('keep').pipe(Flag.withDefault(false)),
    policy: Flag.Literals('policy', ['approval', 'direct']).pipe(Flag.withDefault('approval')),
  },
  ({ keep, policy }) =>
    Effect.gen(function* runAgentProofCommand() {
      const E2E = yield* E2eSettings;
      yield* run(policy, keep).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : rec.stepEffect('agent', 'výjimka', Effect.succeed({ detail: Cause.pretty(cause), pass: false })),
        ),
      );
      yield* rec.log(`agent-entity-e2e: ${rec.pass ? 'PASS' : 'FAIL'} (${rec.steps.length} kroků)`);
      yield* rec.writeEffect(E2E.outDir, 'v5-agent-entities-e2e', {
        agentName: AGENT_NAME,
        grantId,
        mcpUrl: E2E.mcpUrl,
        policy,
        runId,
        shellUrl: E2E.shellUrl,
      });
      if (!rec.pass) {
        return yield* new ProofFailed({ message: 'Agent entity proof failed' });
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
