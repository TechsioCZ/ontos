/**
 * Human decisions on agent proposals. Approve runs the stored module command as the approving person (their
 * permissions, their audit); the module's review, read as them just before, says whether they can, gives the undo
 * plan and any follow-up (e.g. a comment naming the proposing agent). Legacy module engines decide and revert through
 * their own AiDecideChanges/AiRevertBatch.
 */
import type {
  AgentDecideRequest,
  AgentDecideResponse,
  AgentRevertPlan,
  AgentRevertRequest,
  AgentRevertResponse,
} from '@app/shared-contracts/agent-proposals';
import type { AgentReviewItem } from '@app/shared-contracts/agent-review';
import {
  AGENT_REVERT_MISSING_BEFORE,
  agentRevertNone,
  resolveAgentRevertPlan,
  withAgentCreatedId,
} from '@app/shared-contracts/agent-revert';
import { Effect } from 'effect';

import { approverCheck, parseCoreKey, revertResultMessage } from './approval-logic.ts';
import { AgentPlatformForbidden, AgentPlatformInvalid, callerModuleAccess } from './caller.ts';
import type { AgentPlatformCaller } from './caller.ts';
import { parseLegacyKey } from '../../shared/proposal-key.ts';
import { decideLegacy, revertLegacy } from './legacy-queue.ts';
import type { AgentProposalRow } from './mappers.ts';
import { loadComposedModules } from './composed-modules.ts';
import { applyModuleCommand, readModuleRecords } from './module-call.ts';
import { reviewedItem, reviewInModule } from './module-review.ts';
import type { ModuleReview } from './module-review.ts';
import {
  batchHasApprovalInProgress,
  claimBatchRevert,
  claimForApproval,
  closePendingInBatch,
  isBatchReverted,
  loadBatchProposals,
  markApplied,
  markFailed,
  markRejected,
  markRevertFailed,
  markReverted,
  releaseApprovalClaim,
} from './proposal-store.ts';

type DecideResult = AgentDecideResponse['results'][number];

const result = (itemKey: string, outcome: DecideResult['outcome'], message?: string): DecideResult =>
  message === undefined ? { itemKey, outcome } : { itemKey, message, outcome };

const BATCH_NOT_FOUND = 'Dávka návrhů nebyla nalezena.';
const ALREADY_DECIDED = 'Změnu už vyřídil někdo jiný nebo se právě schvaluje. Obnovte seznam.';
const BATCH_REVERTED = 'Dávka už byla vrácena, změnu nelze schválit.';
const NOT_READABLE = 'Záznam se teď nepodařilo načíst.';
const notAllowed = (moduleLabel: string) => `Změny v modulu ${moduleLabel} nemůžete schválit ani zamítnout.`;

const audiencesOf = (row: AgentProposalRow) =>
  row.referenceAudiences.length === 0 ? {} : { referenceAudiences: row.referenceAudiences };

interface RowReview {
  readonly item: AgentReviewItem | undefined;
  readonly review: ModuleReview;
}

/** The module's review of one stored proposal, read as `principal`. */
const reviewRow = Effect.fn('AgentPlatform.reviewRow')(function* reviewRow(
  principal: AgentPlatformCaller['principal'],
  row: AgentProposalRow,
  stage: 'proposed' | 'undo',
) {
  const module = (yield* loadComposedModules).byAppId(row.appId);
  const review: ModuleReview =
    module === undefined
      ? { state: 'none' }
      : yield* reviewInModule(principal, module, [
          {
            actionSlug: row.actionSlug,
            command: row.command,
            key: row.proposalId,
            stage,
            ...(stage === 'proposed'
              ? { proposal: { agentLabel: row.agentLabel, proposalId: row.proposalId, summary: row.summary } }
              : {}),
          },
        ]);
  return { item: reviewedItem(review, row.proposalId), review } satisfies RowReview;
});

/** Whether this person can carry out the stored command (approval runs as them), with the module's review. */
const checkApprover = Effect.fn('AgentPlatform.checkApprover')(function* checkApprover(
  principal: AgentPlatformCaller['principal'],
  row: AgentProposalRow,
) {
  const reviewed = yield* reviewRow(principal, row, 'proposed');
  const moduleBody = reviewed.item === undefined ? yield* readModuleRecords(principal, row.appId) : undefined;
  return { check: approverCheck(reviewed.review, reviewed.item, moduleBody), reviewed };
});

/** The undo plan of an approval: the module's (from the live record), or why there is none. */
const revertPlanOf = ({ item, review }: RowReview): AgentRevertPlan =>
  item?.revert ?? (review.state === 'none' ? agentRevertNone() : agentRevertNone(AGENT_REVERT_MISSING_BEFORE));

/**
 * The module's follow-up after an approval (e.g. a comment naming the proposing agent, since module history only
 * knows the approving person). Best effort: a failed follow-up never undoes the approved change.
 */
const runFollowUp = Effect.fn('AgentPlatform.runFollowUp')(function* runFollowUp(
  caller: AgentPlatformCaller,
  row: AgentProposalRow,
  item: AgentReviewItem | undefined,
  applyResult: unknown,
) {
  const followUp = item?.followUp;
  if (followUp === undefined) {
    return;
  }
  const commands = withAgentCreatedId(followUp.commands, followUp.createdIdPath, applyResult);
  for (const [index, command] of (commands ?? []).entries()) {
    yield* applyModuleCommand(caller.principal, row.appId, command, {
      idempotencyKey: `agent-proposal-${row.proposalId}-follow-up-${index}`,
      referenceAudiences: [...new Set([...row.referenceAudiences, ...followUp.referenceAudiences])],
    }).pipe(Effect.ignore);
  }
});

type RowRevert = 'changed' | 'failed' | 'reverted' | 'unavailable';

/** Undoes one applied proposal as the person, unless someone changed the record after the approval. */
const revertRow = Effect.fn('AgentPlatform.revertRow')(function* revertRow(
  caller: AgentPlatformCaller,
  row: AgentProposalRow,
  plan: AgentProposalRow['revert'],
  current: RowReview,
) {
  if (plan === null || plan.kind === 'none') {
    return 'unavailable' satisfies RowRevert;
  }
  if (current.review.state !== 'none') {
    if (current.item === undefined || !current.item.visible) {
      yield* markRevertFailed(row.proposalId, { failure: NOT_READABLE });
      return 'failed' satisfies RowRevert;
    }
    if (current.item.stillInPlace === false) {
      return 'changed' satisfies RowRevert;
    }
  }
  for (const [index, command] of plan.commands.entries()) {
    const outcome = yield* applyModuleCommand(caller.principal, row.appId, command, {
      actionSlug: row.actionSlug,
      idempotencyKey: `agent-revert-${row.proposalId}-${index}`,
      ...audiencesOf(row),
    });
    if (!outcome.ok) {
      yield* markRevertFailed(row.proposalId, { failure: outcome.message });
      return 'failed' satisfies RowRevert;
    }
  }
  yield* markReverted(row.proposalId, { by: caller.principal.principalId });
  return 'reverted' satisfies RowRevert;
});

const approveCoreRow = Effect.fn('AgentPlatform.approveCoreRow')(function* approveCoreRow(
  caller: AgentPlatformCaller,
  row: AgentProposalRow,
  reviewed: RowReview,
) {
  const itemKey = `core:${row.proposalId}`;
  const by = caller.principal.principalId;
  // One atomic claim: a concurrent reject, approval or „Vrátit vše“ cannot also act on this proposal.
  if (!(yield* claimForApproval(row.proposalId, by))) {
    return result(itemKey, 'skipped', ALREADY_DECIDED);
  }
  const plan = revertPlanOf(reviewed);
  const outcome = yield* applyModuleCommand(caller.principal, row.appId, row.command, {
    actionSlug: row.actionSlug,
    idempotencyKey: `agent-proposal-${row.proposalId}`,
    ...audiencesOf(row),
  });
  if (outcome.ok) {
    const revert = resolveAgentRevertPlan(plan, outcome.body);
    yield* markApplied(row.proposalId, { applyResult: outcome.body, by, diff: reviewed.item?.diff, revert });
    yield* runFollowUp(caller, row, reviewed.item, outcome.body);
    if (yield* isBatchReverted(row.batchId)) {
      // „Vrátit vše“ ran while this change was being applied: undo it right away so the batch stays reverted.
      yield* revertRow(caller, row, revert, yield* reviewRow(caller.principal, row, 'undo'));
      return result(itemKey, 'skipped', 'Dávka byla mezitím vrácena, změna byla hned vrácena také.');
    }
    return result(itemKey, 'applied');
  }
  if (outcome.status === 403 || outcome.status === 404) {
    // The module refused this person or does not show them the record: the proposal stays pending for someone with
    // the right permission instead of being used up.
    yield* releaseApprovalClaim(row.proposalId, by);
    return result(itemKey, 'forbidden', outcome.message);
  }
  yield* markFailed(row.proposalId, { by, failure: outcome.message });
  return result(itemKey, 'failed', outcome.message);
});

const decideCore = Effect.fn('AgentPlatform.decideCore')(function* decideCore(
  caller: AgentPlatformCaller,
  batchId: string,
  request: AgentDecideRequest,
) {
  const { legalEntityId, principalId, tenantId } = caller.principal;
  const rows = yield* loadBatchProposals(tenantId, legalEntityId, batchId);
  if (rows.length === 0) {
    return yield* new AgentPlatformInvalid({ reason: BATCH_NOT_FOUND });
  }
  const modules = yield* callerModuleAccess(caller);
  const results = yield* Effect.forEach(
    request.itemKeys,
    (itemKey) =>
      Effect.gen(function* decideOne() {
        const proposalId = parseCoreKey(itemKey);
        const row = rows.find((candidate) => candidate.proposalId === proposalId);
        if (row === undefined) {
          return result(itemKey, 'skipped', 'Změna do této dávky nepatří.');
        }
        if (row.status !== 'pending') {
          return result(itemKey, 'skipped', 'Změna už byla vyřízena.');
        }
        if (!modules.write.has(row.moduleKey)) {
          return result(itemKey, 'forbidden', notAllowed((yield* loadComposedModules).labelOf(row.moduleKey)));
        }
        const { check, reviewed } = yield* checkApprover(caller.principal, row);
        if (!check.ok) {
          return result(itemKey, 'forbidden', check.hidden ? 'Změna do této dávky nepatří.' : check.reason);
        }
        if (request.decision === 'reject') {
          const rejected = yield* markRejected(row.proposalId, { by: principalId, note: request.note ?? null });
          return rejected ? result(itemKey, 'rejected') : result(itemKey, 'skipped', ALREADY_DECIDED);
        }
        if (row.batchRevertedAt !== null) {
          return result(itemKey, 'skipped', BATCH_REVERTED);
        }
        return yield* approveCoreRow(caller, row, reviewed);
      }),
    { concurrency: 1 },
  );
  return { results } satisfies AgentDecideResponse;
});

const decideLegacyBatch = Effect.fn('AgentPlatform.decideLegacyBatch')(function* decideLegacyBatch(
  caller: AgentPlatformCaller,
  batch: { readonly appId: string; readonly id: string },
  request: AgentDecideRequest,
) {
  const composed = (yield* loadComposedModules).byAppId(batch.appId);
  if (composed === undefined || !composed.ownProposalEngine) {
    return yield* new AgentPlatformInvalid({ reason: BATCH_NOT_FOUND });
  }
  const module = { appId: composed.appId, label: composed.label.cs, moduleKey: composed.moduleId };
  const changeIdOf = (key: string) => {
    const parsed = parseLegacyKey(key);
    return parsed !== undefined && parsed.appId === batch.appId ? parsed.id : undefined;
  };
  const changeIds = request.itemKeys.flatMap((key) => {
    const id = changeIdOf(key);
    return id === undefined ? [] : [id];
  });
  if (changeIds.length === 0) {
    return yield* new AgentPlatformInvalid({ reason: 'Vyberte alespoň jednu změnu z této dávky.' });
  }
  const modules = yield* callerModuleAccess(caller);
  if (!modules.write.has(module.moduleKey)) {
    return {
      results: request.itemKeys.map((itemKey) => result(itemKey, 'forbidden', notAllowed(module.label))),
    } satisfies AgentDecideResponse;
  }
  const outcome = yield* decideLegacy(caller.principal, module.appId, changeIds, request.decision, request.note);
  return {
    results: request.itemKeys.map((itemKey) =>
      changeIdOf(itemKey) === undefined
        ? result(itemKey, 'skipped', 'Změna do této dávky nepatří.')
        : outcome.ok
          ? result(itemKey, request.decision === 'approve' ? 'applied' : 'rejected')
          : result(itemKey, outcome.status === 403 ? 'forbidden' : 'failed', outcome.message),
    ),
  } satisfies AgentDecideResponse;
});

/** Approve or reject items of one batch (`core:` or `legacy:` keys from the queue). */
export const decideAgentItems = Effect.fn('AgentPlatform.decideAgentItems')(function* decideAgentItems(
  caller: AgentPlatformCaller,
  request: AgentDecideRequest,
) {
  const coreBatchId = parseCoreKey(request.batchKey);
  if (coreBatchId !== undefined) {
    return yield* decideCore(caller, coreBatchId, request);
  }
  const legacy = parseLegacyKey(request.batchKey);
  if (legacy !== undefined) {
    return yield* decideLegacyBatch(caller, legacy, request);
  }
  return yield* new AgentPlatformInvalid({ reason: 'Neznámá dávka návrhů.' });
});

const revertCoreBatch = Effect.fn('AgentPlatform.revertCoreBatch')(function* revertCoreBatch(
  caller: AgentPlatformCaller,
  batchId: string,
  request: AgentRevertRequest,
) {
  const { legalEntityId, principalId, tenantId } = caller.principal;
  const rows = yield* loadBatchProposals(tenantId, legalEntityId, batchId);
  if (rows.length === 0) {
    return yield* new AgentPlatformInvalid({ reason: BATCH_NOT_FOUND });
  }
  if (rows.some((row) => row.batchRevertedAt !== null)) {
    return { message: 'Dávka už byla vrácena.', outcome: 'failed' } satisfies AgentRevertResponse;
  }
  const modules = yield* callerModuleAccess(caller);
  const applied = rows
    .filter((row) => row.status === 'applied')
    .toSorted((left, right) => right.position - left.position);
  if (applied.some((row) => !modules.write.has(row.moduleKey))) {
    return yield* new AgentPlatformForbidden({
      reason: 'Dávku může vrátit jen člověk s oprávněním k zápisu ve všech jejích modulech.',
    });
  }
  if (applied.length === 0) {
    return revertResultMessage({ changed: 0, failed: 0, reverted: 0, unavailable: 0 });
  }
  if (yield* batchHasApprovalInProgress(batchId)) {
    return {
      message: 'Některá změna z dávky se právě schvaluje. Zkuste to prosím za chvíli znovu.',
      outcome: 'failed',
    } satisfies AgentRevertResponse;
  }
  if (!(yield* claimBatchRevert(batchId, { by: principalId, note: request.note ?? null }))) {
    return { message: 'Dávka už byla vrácena.', outcome: 'failed' } satisfies AgentRevertResponse;
  }
  // The batch is closed: proposals nobody decided yet will not run any more.
  yield* closePendingInBatch(batchId, { by: principalId, note: 'Dávka byla vrácena, návrh se už neprovede.' });
  const counts = { changed: 0, failed: 0, reverted: 0, unavailable: 0 };
  for (const row of applied) {
    // Checked per change, right before undoing it: an earlier undo in this batch may have restored the record.
    const current =
      row.revert?.kind === 'commands'
        ? yield* reviewRow(caller.principal, row, 'undo')
        : { item: undefined, review: { state: 'none' } as const };
    const outcome = yield* revertRow(caller, row, row.revert, current);
    counts[outcome] += 1;
  }
  return revertResultMessage(counts);
});

const revertLegacyBatch = Effect.fn('AgentPlatform.revertLegacyBatch')(function* revertLegacyBatch(
  caller: AgentPlatformCaller,
  batch: { readonly appId: string; readonly id: string },
  request: AgentRevertRequest,
) {
  const composed = (yield* loadComposedModules).byAppId(batch.appId);
  if (composed === undefined || !composed.ownProposalEngine) {
    return yield* new AgentPlatformInvalid({ reason: BATCH_NOT_FOUND });
  }
  const module = { appId: composed.appId, label: composed.label.cs, moduleKey: composed.moduleId };
  const modules = yield* callerModuleAccess(caller);
  if (!modules.write.has(module.moduleKey)) {
    return yield* new AgentPlatformForbidden({ reason: `Dávku v modulu ${module.label} nemůžete vrátit.` });
  }
  const outcome = yield* revertLegacy(caller.principal, module.appId, batch.id, request.note);
  return outcome.ok
    ? ({
        message: 'Změny dávky byly vráceny. Historie zůstala zachována.',
        outcome: 'reverted',
      } satisfies AgentRevertResponse)
    : ({ message: outcome.message, outcome: 'failed' } satisfies AgentRevertResponse);
});

/** „Vrátit vše“: undo every applied, revertible change of one batch as the person. */
export const revertAgentBatch = Effect.fn('AgentPlatform.revertAgentBatch')(function* revertAgentBatch(
  caller: AgentPlatformCaller,
  request: AgentRevertRequest,
) {
  const coreBatchId = parseCoreKey(request.batchKey);
  if (coreBatchId !== undefined) {
    return yield* revertCoreBatch(caller, coreBatchId, request);
  }
  const legacy = parseLegacyKey(request.batchKey);
  if (legacy !== undefined) {
    return yield* revertLegacyBatch(caller, legacy, request);
  }
  return yield* new AgentPlatformInvalid({ reason: 'Neznámá dávka návrhů.' });
});
