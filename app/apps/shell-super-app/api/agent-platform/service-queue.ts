/**
 * Platform approval queue (reads and agent submissions). Agents submit proposals for any registered module; people
 * see one queue of core proposals (core.agent_proposals) and legacy module engines (CRM, sales, merchandise).
 */
import {
  AGENT_APPROVALS_PATH,
  AGENT_PAGE_SIZE,
  AgentCommandSchema,
  compareAgentPage,
} from '@app/shared-contracts/agent-proposals';
import type {
  AgentActivityRequest,
  AgentCommand,
  AgentProposalSubmitRequest,
  AgentProposalSubmitResponse,
  AgentPageCursor,
  AgentQueueBatch,
  AgentQueueResponse,
  AgentQueueRequest,
} from '@app/shared-contracts/agent-proposals';
import { agentCommandDiff } from '@app/shared-contracts/agent-diff';
import { Effect, Match, Predicate, Schema } from 'effect';

import type { AgentProposalCommandPayload } from '@app/core-runtime';

import { AgentActionRequestIdentity } from '../auth/agent-action-request-identity.ts';
import { AgentReadRequestIdentity } from '../auth/agent-request-identity.ts';
import { demoAccountCapability, derivedUuid } from '../auth/demo-accounts.ts';
import { listGrants } from '../oauth-connections/grant-store.ts';
import { CompanyDirectory } from '../oauth-connections-admin/company-directory.ts';
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
import { moduleActivityFromRecords } from './legacy-normalize.ts';
import { buildActivityResponse, rowsToQueueBatches } from './mappers.ts';
import type { AgentProposalRow } from './mappers.ts';
import { recordsReadOf, callModuleAs } from './module-call.ts';
import { reviewByModule, reviewedItem, reviewInModule } from './module-review.ts';
import {
  AgentStoreUnavailable,
  insertProposals,
  listAgentActivity,
  listCompanyProposals,
  listCompanyProposalPage,
  principalNames,
} from './proposal-store.ts';

const HUMAN_ONLY_COMMANDS: ReadonlySet<string> = new Set(['AiDecideChanges', 'AiRevertBatch']);
const DEFAULT_ACTION_SLUG = 'apply-command';
/** Named Action slugs, e.g. `update-party`; `apply-command` is the default command envelope. */
const ACTION_SLUG = /^[a-z][a-z0-9-]{0,99}$/u;
const REVIEW_PATH = `/cs${AGENT_APPROVALS_PATH}`;
const NO_DECIDER = 'Návrhy agentů schvalují jen lidé s oprávněním k zápisu v některém modulu firmy.';

const agentCommandAllowed = (actionSlug: string, command: AgentCommand) =>
  ACTION_SLUG.test(actionSlug) &&
  (actionSlug === DEFAULT_ACTION_SLUG
    ? Match.value(command['_tag']).pipe(
        Match.when(Match.nonEmptyString, (value) => !HUMAN_ONLY_COMMANDS.has(value)),
        Match.orElse(() => false),
      )
    : Predicate.isUndefined(command['_tag']));

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

/** Compare the decoded command meaning: object key order is irrelevant, proposal and array order is not. */
const sameProposalCommands = Schema.toEquivalence(
  Schema.Array(Schema.Tuple([Schema.String, Schema.String, AgentCommandSchema])),
);

/** Batches whose proposals all still wait for a decision, each ordered by position. */
const pendingBatchesOf = (rows: readonly AgentProposalRow[]): AgentProposalRow[][] => {
  const batches = new Map<string, AgentProposalRow[]>();
  for (const row of rows) {
    batches.set(row.batchId, [...(batches.get(row.batchId) ?? []), row]);
  }
  return [...batches.values()].flatMap((batch) =>
    batch.every((row) => row.status === 'pending' && row.batchRevertedAt === null)
      ? [batch.toSorted((left, right) => left.position - right.position)]
      : [],
  );
};

/** A pending retry is identified by the ordered module/Action/command triples, not presentation metadata. */
export const findPendingDuplicateBatch = (
  rows: readonly AgentProposalRow[],
  proposals: AgentProposalSubmitRequest['proposals'],
) => {
  const commands = proposals.map(
    (proposal) => [proposal.appId, proposal.actionSlug ?? DEFAULT_ACTION_SLUG, proposal.command] as const,
  );
  return pendingBatchesOf(rows).find((batch) =>
    sameProposalCommands(
      batch.map((row) => [row.appId, row.actionSlug, row.command] as const),
      commands,
    ),
  );
};

/** Stores an agent's batch as pending proposals. Repeating a runId returns the stored batch (`replayed`). */
export const submitAgentProposals = Effect.fn('AgentPlatform.submitAgentProposals')(function* submitAgentProposals(
  agent: AgentPlatformCaller,
  request: AgentProposalSubmitRequest,
) {
  const { legalEntityId, principalId, tenantId } = agent.principal;
  yield* assertAgentProposalsAuthorized(agent, request.proposals);
  // Core owns atomic run/pending deduplication and rejects a reused ingress key with a different payload.
  // Never return an early Shell replay before the native Action can check that request hash.
  const actionTransport = yield* AgentActionRequestIdentity;
  const modules = yield* callerModuleAccess(agent);
  const composed = yield* loadComposedModules;
  const transport = yield* AgentReadRequestIdentity;
  const names = yield* principalNames(agent.principal, transport);
  const identitySeed = `${tenantId}/${legalEntityId}/${principalId}/${actionTransport.idempotencyKey}`;
  const batchId = derivedUuid(`${identitySeed}/insert/batch`);
  // The modules describe their own commands (read as the agent); the platform never trusts the agent's diff.
  const reviews = yield* reviewByModule(
    agent.principal,
    composed.byAppId,
    request.proposals.map((proposal, index) => ({
      actionSlug: proposal.actionSlug ?? DEFAULT_ACTION_SLUG,
      appId: proposal.appId,
      command: proposal.command,
      key: `p${index}`,
      stage: 'proposed' as const,
    })),
  );
  const proposals: Extract<AgentProposalCommandPayload, { readonly operation: 'insert' }>['proposals'][number][] = [];
  for (const [index, proposal] of request.proposals.entries()) {
    const composedModule = composed.byAppId(proposal.appId);
    if (composedModule === undefined || !composedModule.approvals) {
      return yield* new AgentPlatformInvalid({ reason: `Modul ${proposal.appId} nepřijímá návrhy agentů.` });
    }
    const module = { appId: composedModule.appId, label: composedModule.label.cs, moduleKey: composedModule.moduleId };
    if (!modules.access.has(module.moduleKey)) {
      return yield* new AgentPlatformForbidden({ reason: `Agent nemá přístup k modulu ${module.label}.` });
    }
    const actionSlug = proposal.actionSlug ?? DEFAULT_ACTION_SLUG;
    // apply-command needs a command `_tag`; a named Action (party-registry, commerce) takes its payload without one.
    if (!agentCommandAllowed(actionSlug, proposal.command)) {
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
    proposals.push({
      actionSlug,
      appId: module.appId,
      command: proposal.command,
      diff: platformDiff ?? (commandDiff.length > 0 ? commandDiff : proposal.diff),
      moduleKey: module.moduleKey,
      proposalId: derivedUuid(`${identitySeed}/insert/proposal/${index}`),
      reason: proposal.reason,
      referenceAudiences: proposal.referenceAudiences ?? [],
      risk: proposal.risk,
      summary: proposal.summary,
      targetLabel: proposal.targetLabel,
    });
  }
  const insertion = {
    agentLabel: request.agentLabel ?? names.get(principalId) ?? 'AI agent',
    batchId,
    instruction: request.instruction,
    proposals,
  };
  const stored = yield* insertProposals(
    agent.principal,
    request.runId === undefined ? insertion : { ...insertion, runId: request.runId },
  );
  return {
    batchId: stored.batchId,
    proposalIds: stored.proposalIds,
    replayed: stored.outcome === 'replayed',
    reviewPath: REVIEW_PATH,
  } satisfies AgentProposalSubmitResponse;
});

/** The agent's own core batches in its company (newest first); the agent decides nothing. */
export const listOwnAgentBatches = Effect.fn('AgentPlatform.listOwnAgentBatches')(function* listOwnAgentBatches(
  agent: AgentPlatformCaller,
) {
  const { legalEntityId } = agent.principal;
  const transport = yield* AgentReadRequestIdentity;
  const [rows, names, composed] = yield* Effect.all(
    [listCompanyProposals(agent.principal), principalNames(agent.principal, transport), loadComposedModules],
    // Independent read-only sources, bounded below the Worker's outbound connection limit.
    { concurrency: 2 },
  );
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

/** Page by complete candidate identity, not the rows left after private-record visibility filtering. */
export const paginateAgentQueue = (
  coreCandidates: readonly AgentPageCursor[],
  coreBatches: readonly AgentQueueBatch[],
  legacyBatches: readonly AgentQueueBatch[],
) => {
  const candidates = [
    ...coreCandidates,
    ...legacyBatches.map((batch) => ({ at: batch.createdAt, id: batch.key })),
  ].toSorted(compareAgentPage);
  const selected = candidates.slice(0, AGENT_PAGE_SIZE);
  const selectedKeys = new Set(selected.map((entry) => entry.id));
  const batches = [...coreBatches, ...legacyBatches]
    .filter((batch) => selectedKeys.has(batch.key))
    .toSorted((left, right) =>
      compareAgentPage({ at: left.createdAt, id: left.key }, { at: right.createdAt, id: right.key }),
    );
  const last = selected.at(-1);
  return candidates.length > AGENT_PAGE_SIZE && last !== undefined ? { batches, nextCursor: last } : { batches };
};

/** One queue for the person: core proposals of modules they can open plus legacy module engines. */
export const loadAgentQueue = Effect.fn('AgentPlatform.loadAgentQueue')(function* loadAgentQueue(
  caller: AgentPlatformCaller,
  request: AgentQueueRequest = {},
) {
  const { legalEntityId } = caller.principal;
  const modules = yield* callerModuleAccess(caller);
  if (modules.write.size === 0) {
    return yield* new AgentPlatformForbidden({ reason: NO_DECIDER });
  }
  const transport = yield* AgentReadRequestIdentity;
  const names = yield* principalNames(caller.principal, transport);
  const composed = yield* loadComposedModules;
  const page = yield* listCompanyProposalPage(caller.principal, request);
  const moduleRows = page.proposals;
  // Approval runs as the approver: each module reviews its proposals once as this person (visibility, whether they
  // can carry them out, live before -> after lines). Other modules use the existing SpiceDB write grant;
  // their governed Action checks its command-specific permissions again when approved.
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
  // Native Core already enforced exact Action rights and private-record visibility. This second projection
  // supplies live diffs and canApply, which the native visibility-only contract intentionally does not return.
  const pending = moduleRows.filter((row) => row.status === 'pending');
  const checks = new Map(
    pending.map((row) => [row.proposalId, approverCheck(reviews.get(row.appId), itemOf(row), {})] as const),
  );
  const coreBatches = rowsToQueueBatches(moduleRows, {
    canDecide: (row) => {
      const check = checks.get(row.proposalId);
      return check === undefined || check.ok ? { allowed: true } : { allowed: false, reason: check.reason };
    },
    modules: moduleTextsOf(composed),
    names,
    reviewOf: itemOf,
  });
  const legacyModules = composed.all.flatMap((module) => {
    if (
      !module.ownProposalEngine ||
      !modules.access.has(module.moduleId) ||
      (request.moduleKey !== undefined && request.moduleKey !== module.moduleId)
    ) {
      return [];
    }
    const entry = { appId: module.appId, label: module.label.cs, moduleKey: module.moduleId };
    return [module.approvalsPage === undefined ? entry : { ...entry, approvalsPage: module.approvalsPage }];
  });
  const legacy = yield* Effect.forEach(
    legacyModules,
    (module) =>
      readLegacyBatches(caller.principal, module, {
        canDecide: modules.write.has(module.moduleKey),
        names,
        request,
      }).pipe(Effect.map((result) => ({ module, result }))),
    { concurrency: 3 },
  );
  const legacyBatches = legacy.flatMap(({ result }) => (result.state === 'ok' ? result.batches : []));
  const unavailableModules = legacy.flatMap(({ module, result }) =>
    result.state === 'unavailable' ? [module.label] : [],
  );
  const pageResult = paginateAgentQueue(page.candidates, coreBatches, legacyBatches);
  const { batches } = pageResult;
  const response = {
    batches,
    company: { legalEntityId, legalName: caller.legalName },
    modules: composed.all.flatMap((module) =>
      modules.access.has(module.moduleId) ? [{ label: module.label.cs, moduleKey: module.moduleId }] : [],
    ),
    pendingCount: countPending(batches, true),
    unavailableModules,
  } satisfies AgentQueueResponse;
  return pageResult.nextCursor === undefined ? response : { ...response, nextCursor: pageResult.nextCursor };
});

/** Agent reads, writes, denials, proposals and decisions in the modules where the person approves changes.
 * Transport is the Core Read request identity from ingress, not an ambient tracing correlation.
 */
export const loadAgentActivity = Effect.fn('AgentPlatform.loadAgentActivity')(function* loadAgentActivity(
  caller: AgentPlatformCaller,
  request: AgentActivityRequest,
) {
  const transport = yield* AgentReadRequestIdentity;
  const modules = yield* callerModuleAccess(caller);
  if (modules.write.size === 0) {
    return yield* new AgentPlatformForbidden({ reason: NO_DECIDER });
  }
  const { legalEntityId, tenantId } = caller.principal;
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
  const activity = yield* listAgentActivity(
    caller.principal,
    request,
    {
      modules: moduleTextsOf(composed),
      visibleModules: new Set([...modules.write].filter((moduleKey) => !hidden.has(moduleKey))),
    },
    transport,
  );
  const recordModules = composed.all.filter(
    (module) =>
      modules.access.has(module.moduleId) &&
      modules.write.has(module.moduleId) &&
      !hidden.has(module.moduleId) &&
      module.ownProposalEngine &&
      (request.moduleKey === undefined || request.moduleKey === module.moduleId),
  );
  const records = new Map(
    yield* Effect.forEach(
      recordModules,
      (module) =>
        recordsReadOf(module.appId).pipe(
          Effect.flatMap((read) =>
            callModuleAs(caller.principal, module.appId, read.path, {
              ...read.query,
              agentHistory: { ...request, mode: 'activity' },
            }),
          ),
          Effect.map((result) => [module.moduleId, result.status === 200 ? result.body : undefined] as const),
          Effect.mapError((cause) => new AgentStoreUnavailable({ cause })),
        ),
      { concurrency: 2 },
    ),
  );
  const names =
    recordModules.length === 0 ? new Map<string, string>() : yield* principalNames(caller.principal, transport);
  const native = recordModules.flatMap((module) =>
    module.ownProposalEngine
      ? moduleActivityFromRecords(
          { appId: module.appId, label: module.label.cs, moduleKey: module.moduleId },
          records.get(module.moduleId),
          {
            names,
            recordLinks: module.recordLinks,
          },
        )
      : [],
  );
  const combined = buildActivityResponse([...activity.entries, ...native], request);
  // Same live capability as the destination. Never turn approval rights into identity-administration rights.
  const canManage = yield* demoAccountCapability(caller).pipe(
    Effect.map((capability) => capability.canManage),
    Effect.orElseSucceed(() => false),
  );
  const visiblePrincipals = canManage
    ? yield* (yield* CompanyDirectory).snapshot.pipe(
        Effect.map(({ agents, people }) => ({
          agents: new Set(agents.flatMap((agent) => (agent.status === 'archived' ? [] : [agent.principalId]))),
          people: new Set(people.map((person) => person.principalId)),
        })),
        Effect.orElseSucceed(() => ({ agents: new Set<string>(), people: new Set<string>() })),
      )
    : { agents: new Set<string>(), people: new Set<string>() };
  const grants = canManage ? yield* listGrants({ legalEntityId, tenantId }).pipe(Effect.orElseSucceed(() => [])) : [];
  // Identity management belongs to the Shell, independent of installed workforce modules.
  const identityPage = canManage ? '/sprava/lide-a-role' : undefined;
  return {
    ...combined,
    agents: [...new Map([...activity.agents, ...combined.agents].map((agent) => [agent.principalId, agent])).values()],
    entries: combined.entries.map((entry) => {
      const module = entry.moduleKey === null ? undefined : composed.byModuleId(entry.moduleKey);
      return resolveActivityLinks(entry, {
        agentExists: visiblePrincipals.agents.has(entry.agentPrincipalId),
        canManageAgents: canManage,
        canOpenModule: module !== undefined && modules.access.has(module.moduleId),
        canReviewProposals: true,
        grants,
        identityPage,
        module,
        personExists: visiblePrincipals.people.has(entry.agentPrincipalId),
        records: entry.moduleKey === null ? undefined : records.get(entry.moduleKey),
      });
    }),
    modules: [
      ...new Map([...activity.modules, ...combined.modules].map((module) => [module.moduleKey, module])).values(),
    ],
  };
});
