/**
 * Platform approval queue (reads and agent submissions). Agents submit proposals for any registered module; people
 * see one queue of core proposals (core.agent_proposals) and legacy module engines (CRM, sales, merchandise).
 */
import { randomUUID } from 'node:crypto';

import {
  AGENT_APPROVALS_PATH,
  agentApprovalModuleByAppId,
  agentApprovalModules,
} from '@app/shared-contracts/agent-proposals';
import type {
  AgentActivityRequest,
  AgentProposalSubmitRequest,
  AgentProposalSubmitResponse,
  AgentQueueBatch,
  AgentQueueResponse,
} from '@app/shared-contracts/agent-proposals';
import { agentPlatformDiff } from '@app/shared-contracts/agent-diff';
import { Effect } from 'effect';

import { loadAgentProfiles } from '../auth/agent-store.ts';

import { AgentPlatformForbidden, AgentPlatformInvalid, callerModuleAccess } from './caller.ts';
import { readTargetEntity } from './service-decide.ts';
import type { AgentPlatformCaller } from './caller.ts';
import { readLegacyBatches } from './legacy-queue.ts';
import { rowsToQueueBatches } from './mappers.ts';
import {
  AgentStoreUnavailable,
  findRunProposals,
  insertProposals,
  listAgentActivity,
  listCompanyAgentIds,
  listCompanyProposals,
  principalNames,
} from './proposal-store.ts';
import type { NewAgentProposal } from './proposal-store.ts';

const HUMAN_ONLY_COMMANDS: ReadonlySet<string> = new Set(['AiDecideChanges', 'AiRevertBatch']);
const QUEUE_LIMIT = 300;
const REVIEW_PATH = `/cs${AGENT_APPROVALS_PATH}`;
const NO_DECIDER = 'Návrhy agentů schvalují jen lidé s oprávněním k zápisu v některém modulu firmy.';

const countPending = (batches: readonly AgentQueueBatch[], onlyDecidable: boolean): number =>
  batches.reduce(
    (sum, batch) =>
      sum + batch.items.filter((item) => item.status === 'pending' && (!onlyDecidable || item.canDecide)).length,
    0,
  );

/** Stores an agent's batch as pending proposals. Repeating a runId returns the stored batch (`replayed`). */
export const submitAgentProposals = Effect.fn('AgentPlatform.submitAgentProposals')(function* submitAgentProposals(
  agent: AgentPlatformCaller,
  request: AgentProposalSubmitRequest,
) {
  const { legalEntityId, principalId, tenantId } = agent.principal;
  if (request.runId !== undefined) {
    const existing = yield* findRunProposals(tenantId, principalId, request.runId);
    const first = existing[0];
    if (first !== undefined) {
      return {
        batchId: first.batchId,
        proposalIds: existing.map((row) => row.proposalId),
        replayed: true,
        reviewPath: REVIEW_PATH,
      } satisfies AgentProposalSubmitResponse;
    }
  }
  const modules = yield* callerModuleAccess(agent);
  const names = yield* principalNames(tenantId);
  const batchId = randomUUID();
  const rows: NewAgentProposal[] = [];
  for (const [index, proposal] of request.proposals.entries()) {
    const module = agentApprovalModuleByAppId(proposal.appId);
    if (module === undefined) {
      return yield* new AgentPlatformInvalid({ reason: `Modul ${proposal.appId} nepřijímá návrhy agentů.` });
    }
    if (!modules.access.has(module.moduleKey)) {
      return yield* new AgentPlatformForbidden({ reason: `Agent nemá přístup k modulu ${module.label}.` });
    }
    const tag = proposal.command['_tag'];
    if (typeof tag !== 'string' || tag === '' || HUMAN_ONLY_COMMANDS.has(tag)) {
      return yield* new AgentPlatformInvalid({ reason: `Návrh ${index + 1} nemá povolený příkaz modulu.` });
    }
    // The platform describes commands it understands itself (read as the agent), never trusting the agent's diff.
    const target = yield* readTargetEntity(agent.principal, module.appId, proposal.command);
    const platformDiff = agentPlatformDiff(module.appId, proposal.command, target.needed ? target.value : undefined);
    rows.push({
      actionSlug: proposal.actionSlug ?? 'apply-command',
      agentLabel: request.agentLabel ?? names.get(principalId) ?? 'AI agent',
      agentPrincipalId: principalId,
      appId: module.appId,
      batchId,
      batchInstruction: request.instruction,
      command: proposal.command,
      diff: platformDiff ?? proposal.diff,
      legalEntityId,
      moduleKey: module.moduleKey,
      position: index,
      proposalId: randomUUID(),
      reason: proposal.reason,
      referenceAudiences: proposal.referenceAudiences ?? [],
      // The revert plan is always rebuilt on the server when a person approves (see service-decide.ts).
      revert: null,
      risk: proposal.risk,
      runId: request.runId ?? null,
      summary: proposal.summary,
      targetLabel: proposal.targetLabel,
      tenantId,
    });
  }
  yield* insertProposals(rows);
  return {
    batchId,
    proposalIds: rows.map((row) => row.proposalId),
    replayed: false,
    reviewPath: REVIEW_PATH,
  } satisfies AgentProposalSubmitResponse;
});

/** The agent's own core batches in its company (newest first); the agent decides nothing. */
export const listOwnAgentBatches = Effect.fn('AgentPlatform.listOwnAgentBatches')(function* listOwnAgentBatches(
  agent: AgentPlatformCaller,
) {
  const { legalEntityId, principalId, tenantId } = agent.principal;
  const rows = yield* listCompanyProposals(tenantId, legalEntityId, {
    agentPrincipalId: principalId,
    limit: QUEUE_LIMIT,
  });
  const names = yield* principalNames(tenantId);
  const batches = rowsToQueueBatches(rows, { canDecide: () => false, names });
  return {
    batches,
    company: { legalEntityId, legalName: agent.legalName },
    pendingCount: countPending(batches, false),
    unavailableModules: [],
  } satisfies AgentQueueResponse;
});

/** One queue for the person: core proposals of modules they can open plus legacy module engines. */
export const loadAgentQueue = Effect.fn('AgentPlatform.loadAgentQueue')(function* loadAgentQueue(
  caller: AgentPlatformCaller,
) {
  const { legalEntityId, tenantId } = caller.principal;
  const modules = yield* callerModuleAccess(caller);
  if (modules.write.size === 0) {
    return yield* new AgentPlatformForbidden({ reason: NO_DECIDER });
  }
  const names = yield* principalNames(tenantId);
  const rows = (yield* listCompanyProposals(tenantId, legalEntityId, { limit: QUEUE_LIMIT })).filter(
    (row) => modules.access.has(row.moduleKey) || modules.write.has(row.moduleKey),
  );
  // Pending items show "before" from the live record, read as this person.
  const live = yield* Effect.forEach(
    rows.filter((row) => row.status === 'pending'),
    (row) =>
      readTargetEntity(caller.principal, row.appId, row.command).pipe(
        Effect.map((read) => (read.needed && read.value !== undefined ? [[row.proposalId, read.value] as const] : [])),
      ),
    { concurrency: 4 },
  );
  const coreBatches = rowsToQueueBatches(rows, {
    canDecide: (moduleKey) => modules.write.has(moduleKey),
    liveBefore: new Map(live.flat()),
    names,
  });
  const legacyModules = agentApprovalModules.filter(
    (module) => module.legacyEngine && modules.access.has(module.moduleKey),
  );
  const legacy = yield* Effect.forEach(
    legacyModules,
    (module) =>
      readLegacyBatches(caller.principal, module, { canDecide: modules.write.has(module.moduleKey), names }).pipe(
        Effect.map((result) => ({ module, result })),
      ),
    { concurrency: 3 },
  );
  const legacyBatches = legacy.flatMap(({ result }) => (result.state === 'ok' ? result.batches : []));
  const unavailableModules = legacy
    .filter(({ result }) => result.state === 'unavailable')
    .map(({ module }) => module.label);
  const batches = [...coreBatches, ...legacyBatches].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
  return {
    batches,
    company: { legalEntityId, legalName: caller.legalName },
    pendingCount: countPending(batches, true),
    unavailableModules,
  } satisfies AgentQueueResponse;
});

/** Agent reads, writes, denials, proposals and decisions in the modules where the person approves changes. */
export const loadAgentActivity = Effect.fn('AgentPlatform.loadAgentActivity')(function* loadAgentActivity(
  caller: AgentPlatformCaller,
  request: AgentActivityRequest,
) {
  const modules = yield* callerModuleAccess(caller);
  if (modules.write.size === 0) {
    return yield* new AgentPlatformForbidden({ reason: NO_DECIDER });
  }
  const { legalEntityId, tenantId } = caller.principal;
  const agentIds = yield* listCompanyAgentIds(tenantId);
  const profiles = yield* loadAgentProfiles(tenantId, agentIds).pipe(
    Effect.mapError((cause) => new AgentStoreUnavailable({ cause })),
  );
  const proposalOnlyAgents = new Set(
    agentIds.filter((principalId) => profiles.get(principalId)?.writePolicy === 'approval'),
  );
  // People see agent activity only in modules where they approve agent changes.
  return yield* listAgentActivity(tenantId, legalEntityId, request, {
    proposalOnlyAgents,
    visibleModules: modules.write,
  });
});
