/**
 * Platform approval queue (reads and agent submissions). Agents submit proposals for any registered module; people
 * see one queue of core proposals (core.agent_proposals) and legacy module engines (CRM, sales, merchandise).
 */
import { randomUUID } from 'node:crypto';

import { AGENT_APPROVALS_PATH } from '@app/shared-contracts/agent-proposals';
import type {
  AgentActivityRequest,
  AgentCommand,
  AgentProposalSubmitRequest,
  AgentProposalSubmitResponse,
  AgentQueueBatch,
  AgentQueueResponse,
} from '@app/shared-contracts/agent-proposals';
import { agentCommandDiff } from '@app/shared-contracts/agent-diff';
import { Effect } from 'effect';

import { loadAgentProfiles } from '../auth/agent-store.ts';
import { demoAccountCapability } from '../auth/demo-accounts.ts';
import { listGrants } from '../oauth-connections/grant-store.ts';
import { companyDirectoryLive } from '../oauth-connections-admin/company-directory-live.ts';
import { commandRecordReference, resolveActivityLinks } from './activity-links.ts';

import { approverCheck, hiddenByReview } from './approval-logic.ts';
import {
  AgentPlatformForbidden,
  AgentPlatformInvalid,
  assertAgentProposalsAuthorized,
  callerModuleAccess,
} from './caller.ts';
import { loadComposedModules } from './composed-modules.ts';
import type { ComposedModules } from './composed-modules.ts';
import type { AgentPlatformCaller } from './caller.ts';
import { readLegacyBatches } from './legacy-queue.ts';
import { rowsToQueueBatches } from './mappers.ts';
import type { AgentProposalRow } from './mappers.ts';
import { readModuleRecords } from './module-call.ts';
import { reviewByModule, reviewedItem, reviewInModule } from './module-review.ts';
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
/** Named Action slugs, e.g. `update-party`; `apply-command` is the default command envelope. */
const ACTION_SLUG = /^[a-z][a-z0-9-]{0,99}$/u;
const QUEUE_LIMIT = 300;
const REVIEW_PATH = `/cs${AGENT_APPROVALS_PATH}`;
const NO_DECIDER = 'Návrhy agentů schvalují jen lidé s oprávněním k zápisu v některém modulu firmy.';

const moduleTextsOf = (composed: ComposedModules) => ({
  commandFieldLabelsOf: (appId: string) => composed.byAppId(appId)?.commandFieldLabels ?? {},
  hasOwnProposalEngine: (moduleKey: string) => composed.byModuleId(moduleKey)?.ownProposalEngine === true,
  labelOf: composed.labelOf,
  recordReferenceOf: (moduleKey: string, command: AgentCommand) =>
    commandRecordReference(composed.byModuleId(moduleKey)?.recordLinks ?? [], command),
});

const countPending = (batches: readonly AgentQueueBatch[], onlyDecidable: boolean): number =>
  batches.reduce(
    (sum, batch) =>
      sum + batch.items.filter((item) => item.status === 'pending' && (!onlyDecidable || item.canDecide)).length,
    0,
  );

/** Order-independent JSON of a value (object keys sorted), so equal commands compare equal. */
const canonicalJson = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonicalJson).join(',')}]`
    : typeof value === 'object' && value !== null
      ? `{${Object.entries(value)
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
          .join(',')}}`
      : JSON.stringify(value);

const proposalsSignature = (proposals: readonly (readonly [string, string, unknown])[]): string =>
  canonicalJson(proposals);

/** Batches whose proposals all still wait for a decision, each ordered by position. */
const pendingBatchesOf = (rows: readonly AgentProposalRow[]): AgentProposalRow[][] => {
  const batches = new Map<string, AgentProposalRow[]>();
  for (const row of rows) {
    batches.set(row.batchId, [...(batches.get(row.batchId) ?? []), row]);
  }
  return [...batches.values()]
    .filter((batch) => batch.every((row) => row.status === 'pending' && row.batchRevertedAt === null))
    .map((batch) => batch.toSorted((left, right) => left.position - right.position));
};

/** Stores an agent's batch as pending proposals. Repeating a runId returns the stored batch (`replayed`). */
export const submitAgentProposals = Effect.fn('AgentPlatform.submitAgentProposals')(function* submitAgentProposals(
  agent: AgentPlatformCaller,
  request: AgentProposalSubmitRequest,
) {
  const { legalEntityId, principalId, tenantId } = agent.principal;
  yield* assertAgentProposalsAuthorized(agent, request.proposals);
  if (request.runId !== undefined) {
    const existing = yield* findRunProposals(tenantId, legalEntityId, principalId, request.runId);
    const first = existing[0];
    if (first !== undefined) {
      // A run ID does not authorize the stored Actions if the request has changed or rights were revoked.
      yield* assertAgentProposalsAuthorized(agent, existing);
      return {
        batchId: first.batchId,
        proposalIds: existing.map((row) => row.proposalId),
        replayed: true,
        reviewPath: REVIEW_PATH,
      } satisfies AgentProposalSubmitResponse;
    }
  }
  // The same change sent again while the first one still waits (a retried tool call with a fresh key) returns the
  // waiting batch instead of queueing a duplicate a person would have to reject.
  const signature = proposalsSignature(
    request.proposals.map((proposal) => [proposal.appId, proposal.actionSlug ?? 'apply-command', proposal.command]),
  );
  const waiting = yield* listCompanyProposals(tenantId, legalEntityId, {
    agentPrincipalId: principalId,
    limit: QUEUE_LIMIT,
  });
  const duplicate = pendingBatchesOf(waiting).find(
    (batch) => proposalsSignature(batch.map((row) => [row.appId, row.actionSlug, row.command])) === signature,
  );
  if (duplicate !== undefined) {
    return {
      batchId: duplicate[0]?.batchId ?? '',
      proposalIds: duplicate.map((row) => row.proposalId),
      replayed: true,
      reviewPath: REVIEW_PATH,
    } satisfies AgentProposalSubmitResponse;
  }
  const modules = yield* callerModuleAccess(agent);
  const composed = yield* loadComposedModules;
  const names = yield* principalNames(tenantId);
  const batchId = randomUUID();
  // The modules describe their own commands (read as the agent); the platform never trusts the agent's diff.
  const reviews = yield* reviewByModule(
    agent.principal,
    composed.byAppId,
    request.proposals.map((proposal, index) => ({
      actionSlug: proposal.actionSlug ?? 'apply-command',
      appId: proposal.appId,
      command: proposal.command,
      key: `p${index}`,
      stage: 'proposed' as const,
    })),
  );
  const rows: NewAgentProposal[] = [];
  for (const [index, proposal] of request.proposals.entries()) {
    const composedModule = composed.byAppId(proposal.appId);
    if (composedModule === undefined || !composedModule.approvals) {
      return yield* new AgentPlatformInvalid({ reason: `Modul ${proposal.appId} nepřijímá návrhy agentů.` });
    }
    const module = { appId: composedModule.appId, label: composedModule.label.cs, moduleKey: composedModule.moduleId };
    if (!modules.access.has(module.moduleKey)) {
      return yield* new AgentPlatformForbidden({ reason: `Agent nemá přístup k modulu ${module.label}.` });
    }
    const actionSlug = proposal.actionSlug ?? 'apply-command';
    const tag = proposal.command['_tag'];
    // apply-command needs a command `_tag`; a named Action (party-registry, commerce) takes its payload without one.
    const allowedCommand =
      ACTION_SLUG.test(actionSlug) &&
      (actionSlug === 'apply-command'
        ? typeof tag === 'string' && tag !== '' && !HUMAN_ONLY_COMMANDS.has(tag)
        : tag === undefined);
    if (!allowedCommand) {
      return yield* new AgentPlatformInvalid({ reason: `Návrh ${index + 1} nemá povolený příkaz modulu.` });
    }
    const review = reviews.get(module.appId);
    const reviewed = reviewedItem(review, `p${index}`);
    if (hiddenByReview(review, reviewed)) {
      // Approval runs as a person who could not apply a change to a record the proposer cannot even see.
      return yield* new AgentPlatformInvalid({
        reason: `Návrh ${index + 1}: záznam, který má změnit, neexistuje nebo k němu nemáte přístup. Načtěte ho znovu přes ontos_read.`,
      });
    }
    const platformDiff = reviewed?.diff;
    const commandDiff = agentCommandDiff(proposal.command, composedModule.commandFieldLabels);
    rows.push({
      actionSlug,
      agentLabel: request.agentLabel ?? names.get(principalId) ?? 'AI agent',
      agentPrincipalId: principalId,
      appId: module.appId,
      batchId,
      batchInstruction: request.instruction,
      command: proposal.command,
      diff: platformDiff ?? (commandDiff.length > 0 ? commandDiff : proposal.diff),
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
  const composed = yield* loadComposedModules;
  const batches = rowsToQueueBatches(rows, {
    canDecide: () => ({ allowed: false }),
    modules: moduleTextsOf(composed),
    names,
  });
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
  const composed = yield* loadComposedModules;
  const moduleRows = (yield* listCompanyProposals(tenantId, legalEntityId, { limit: QUEUE_LIMIT })).filter(
    (row) => modules.access.has(row.moduleKey) || modules.write.has(row.moduleKey),
  );
  // Approval runs as the approver: each module reviews its proposals once as this person (visibility, whether they
  // can carry them out, live before -> after lines). Modules without a review are read once for their write flag.
  const reviews = yield* reviewByModule(
    caller.principal,
    composed.byAppId,
    moduleRows.map((row) => ({
      actionSlug: row.actionSlug,
      appId: row.appId,
      command: row.command,
      key: row.proposalId,
      stage: row.status === 'pending' ? ('proposed' as const) : ('history' as const),
    })),
  );
  const itemOf = (row: AgentProposalRow) => reviewedItem(reviews.get(row.appId), row.proposalId);
  const visible = moduleRows.filter((row) => !hiddenByReview(reviews.get(row.appId), itemOf(row)));
  const pending = visible.filter((row) => row.status === 'pending');
  const unreviewed = [...new Set(pending.filter((row) => itemOf(row) === undefined).map((row) => row.appId))];
  const moduleReads = new Map(
    yield* Effect.forEach(
      unreviewed,
      (appId) => readModuleRecords(caller.principal, appId).pipe(Effect.map((body) => [appId, body] as const)),
      { concurrency: 3 },
    ),
  );
  const checks = new Map(
    pending.map(
      (row) =>
        [row.proposalId, approverCheck(reviews.get(row.appId), itemOf(row), moduleReads.get(row.appId))] as const,
    ),
  );
  const coreBatches = rowsToQueueBatches(visible, {
    canDecide: (row) => {
      if (!modules.write.has(row.moduleKey)) {
        return {
          allowed: false,
          reason: `Tuto změnu může schválit jen člověk s oprávněním k zápisu v modulu ${composed.labelOf(row.moduleKey)}.`,
        };
      }
      const check = checks.get(row.proposalId);
      return check === undefined || check.ok ? { allowed: true } : { allowed: false, reason: check.reason };
    },
    modules: moduleTextsOf(composed),
    names,
    reviewOf: itemOf,
  });
  const legacyModules = composed.all
    .filter((module) => module.ownProposalEngine && modules.access.has(module.moduleId))
    .map((module) => ({
      appId: module.appId,
      label: module.label.cs,
      moduleKey: module.moduleId,
      ...(module.approvalsPage === undefined ? {} : { approvalsPage: module.approvalsPage }),
    }));
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
  // People see agent activity only in modules where they approve agent changes, and in modules with private
  // records only when the module shows them every record (not only their own).
  const composed = yield* loadComposedModules;
  const scoped = yield* Effect.forEach(
    composed.all.filter(
      (module) => module.approvalReview?.privateRecords === true && modules.write.has(module.moduleId),
    ),
    (module) =>
      reviewInModule(caller.principal, module, []).pipe(
        Effect.map((review) => (review.state === 'ok' && review.seesAllRecords ? [] : [module.moduleId])),
      ),
    { concurrency: 2 },
  );
  const hidden = new Set(scoped.flat());
  const activity = yield* listAgentActivity(tenantId, legalEntityId, request, {
    modules: moduleTextsOf(composed),
    proposalOnlyAgents,
    visibleModules: new Set([...modules.write].filter((moduleKey) => !hidden.has(moduleKey))),
  });
  const recordModules = composed.all.filter(
    (module) =>
      modules.access.has(module.moduleId) &&
      (module.recordLinks?.length ?? 0) > 0 &&
      activity.entries.some((entry) => entry.moduleKey === module.moduleId && entry.recordReference !== undefined),
  );
  const records = new Map(
    yield* Effect.forEach(
      recordModules,
      (module) =>
        readModuleRecords(caller.principal, module.appId).pipe(Effect.map((body) => [module.moduleId, body] as const)),
      { concurrency: 2 },
    ),
  );
  // Same live capability as the destination. Never turn approval rights into identity-administration rights.
  const canManage = yield* demoAccountCapability(caller).pipe(
    Effect.map((capability) => capability.canManage),
    Effect.orElseSucceed(() => false),
  );
  const visibleAgents = canManage
    ? yield* companyDirectoryLive.members(tenantId, legalEntityId).pipe(
        Effect.flatMap((members) => companyDirectoryLive.agents(tenantId, members)),
        Effect.map(
          (agents) => new Set(agents.filter((agent) => agent.status !== 'archived').map((agent) => agent.principalId)),
        ),
        Effect.orElseSucceed(() => new Set<string>()),
      )
    : new Set<string>();
  const grants = canManage ? yield* listGrants({ tenantId, legalEntityId }).pipe(Effect.orElseSucceed(() => [])) : [];
  const identityPage = canManage
    ? composed.all.find((module) => module.agentAdministrationPage !== undefined && modules.access.has(module.moduleId))
        ?.agentAdministrationPage
    : undefined;
  return {
    ...activity,
    entries: activity.entries.map((entry) => {
      const module = entry.moduleKey === null ? undefined : composed.byModuleId(entry.moduleKey);
      return resolveActivityLinks(entry, {
        agentExists: visibleAgents.has(entry.agentPrincipalId),
        canManageAgents: canManage,
        canOpenModule: module !== undefined && modules.access.has(module.moduleId),
        canReviewProposals: true,
        grants,
        identityPage,
        module,
        records: entry.moduleKey === null ? undefined : records.get(entry.moduleKey),
      });
    }),
  };
});
