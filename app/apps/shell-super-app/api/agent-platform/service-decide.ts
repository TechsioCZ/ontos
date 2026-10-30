import {
  AgentDecideResponseSchema,
  AgentDecideResultSchema,
  AgentItemKeySchema,
  AgentProposalIdSchema,
} from '@app/shared-contracts/agent-proposals';
/**
 * Human decisions on agent proposals. Approve runs the stored module command as the approving person (their
 * permissions, their audit); the module's review, read as them just before, says whether they can, gives the undo
 * plan and any follow-up (e.g. a comment naming the proposing agent). Legacy module engines decide and revert through
 * their own AiDecideChanges/AiRevertBatch.
 */
import type { AgentProposalCommandResult } from '@app/core-runtime';
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
import { Effect, Schema } from 'effect';

import { approverCheck, parseCoreKey, revertResultMessage } from './approval-logic.ts';
import { AgentPlatformForbidden, AgentPlatformInvalid, callerModuleAccess } from './caller.ts';
import type { AgentPlatformCaller } from './caller.ts';
import { parseLegacyKey } from '../../shared/proposal-key.ts';
import { decideLegacy, revertLegacy } from './legacy-queue.ts';
import type { AgentProposalRow } from './mappers.ts';
import { loadComposedModules } from './composed-modules.ts';
import { applyModuleCommand, readModuleRecords } from './module-call.ts';
import type { ModuleCommandOutcome } from './module-call.ts';
import { reviewedItem, reviewInModule } from './module-review.ts';
import type { ModuleReview } from './module-review.ts';
import {
  AgentStoreUnavailable,
  batchHasApprovalInProgress,
  claimBatchRevert,
  claimForApproval,
  closePendingInBatch,
  loadBatchProposals,
  loadProposalBatch,
  markApplied,
  markRejected,
  markRevertFailed,
  markReverted,
  requireCurrentProposalClaim,
} from './proposal-store.ts';

type DecideResult = AgentDecideResponse['results'][number];
/** No module recovery producer supplies an exact original invocation result yet. Even a later refusal cannot
 * disprove an earlier delivery's commit. Keep the reservation on every unsuccessful/unknown delivery; in
 * particular AlreadyCommitted is not a result and a timeout is not a business failure or release authority.
 */
export const requireModuleCommandResult = (outcome: ModuleCommandOutcome) =>
  outcome.ok
    ? Effect.succeed(outcome.body)
    : Effect.fail(
        new AgentStoreUnavailable({
          cause: { code: outcome.code, message: outcome.message, status: outcome.status },
        }),
      );

const result = (itemKey: string, outcome: DecideResult['outcome'], message?: string): DecideResult =>
  AgentDecideResultSchema.make(
    message === undefined
      ? { itemKey: AgentItemKeySchema.make(itemKey), outcome }
      : { itemKey: AgentItemKeySchema.make(itemKey), message, outcome },
  );

const BATCH_NOT_FOUND = 'Dávka návrhů nebyla nalezena.';
const ALREADY_DECIDED = 'Změnu už vyřídil někdo jiný nebo se právě schvaluje. Obnovte seznam.';
const ITEM_NOT_IN_BATCH = 'Změna do této dávky nepatří.';
const BATCH_REVERTED = 'Dávka už byla vrácena, změnu nelze schválit.';
const NOT_READABLE = 'Záznam se teď nepodařilo načíst.';
const notAllowed = (moduleLabel: string) => `Změny v modulu ${moduleLabel} nemůžete schválit ani zamítnout.`;

const audiencesOf = (row: AgentProposalRow) =>
  row.referenceAudiences.length === 0 ? {} : { referenceAudiences: row.referenceAudiences };

interface RowReview {
  readonly item: AgentReviewItem | null;
  readonly review: ModuleReview;
}

/** The module's review of one stored proposal, read as `principal`. */
const reviewRow = Effect.fn('AgentPlatform.reviewRow')(function* reviewRow(
  principal: AgentPlatformCaller['principal'],
  row: AgentProposalRow,
  stage: 'proposed' | 'undo',
) {
  const module = (yield* loadComposedModules).byAppId(row.appId);
  const subject = { actionSlug: row.actionSlug, command: row.command, key: row.proposalId, stage };
  const review: ModuleReview =
    module === undefined
      ? { state: 'none' }
      : yield* reviewInModule(
          principal,
          module,
          stage === 'proposed'
            ? [
                {
                  ...subject,
                  proposal: {
                    agentLabel: row.agentLabel,
                    proposalId: AgentProposalIdSchema.make(row.proposalId),
                    summary: row.summary,
                  },
                },
              ]
            : [subject],
        );
  return { item: reviewedItem(review, row.proposalId) ?? null, review } satisfies RowReview;
});

/** Whether this person can carry out the stored command (approval runs as them), with the module's review. */
const checkApprover = Effect.fn('AgentPlatform.checkApprover')(function* checkApprover(
  principal: AgentPlatformCaller['principal'],
  row: AgentProposalRow,
) {
  const reviewed = yield* reviewRow(principal, row, 'proposed');
  const moduleBody = reviewed.item === null ? yield* readModuleRecords(principal, row.appId) : undefined;
  return { check: approverCheck(reviewed.review, reviewed.item ?? undefined, moduleBody), reviewed };
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
  item: AgentReviewItem | null,
  applyResult: Schema.Json,
) {
  const followUp = item?.followUp;
  if (followUp === undefined) {
    return;
  }
  const commands = withAgentCreatedId(followUp.commands, followUp.createdIdPath, applyResult);
  yield* Effect.forEach(
    commands ?? [],
    (command, index) =>
      applyModuleCommand(caller.principal, row.appId, command, {
        idempotencyKey: `agent-proposal-${row.proposalId}-follow-up-${index}`,
        referenceAudiences: [...new Set([...row.referenceAudiences, ...followUp.referenceAudiences])],
      }).pipe(Effect.ignore),
    { concurrency: 1, discard: true },
  );
});

/** A native command's commit marker alone is not proof that this row changed. */
const requireAffected = (command: AgentProposalCommandResult, proposalId: string) =>
  command.affectedProposalIds.includes(proposalId)
    ? Effect.void
    : Effect.fail(new AgentStoreUnavailable({ cause: 'The native proposal transition did not affect its target' }));

const RowRevertSchema = Schema.Literals(['changed', 'failed', 'reverted', 'unavailable']);
type RowRevert = typeof RowRevertSchema.Type;

/** Undoes one applied proposal as the person, unless someone changed the record after the approval. */
const revertRow = Effect.fn('AgentPlatform.revertRow')(function* revertRow(
  caller: AgentPlatformCaller,
  row: AgentProposalRow,
  plan: AgentProposalRow['revert'],
  current: RowReview,
  reservationId: string,
) {
  if (plan === null || plan.kind === 'none') {
    return 'unavailable' satisfies RowRevert;
  }
  if (current.review.state !== 'none') {
    if (current.item === null || !current.item.visible) {
      yield* requireAffected(
        yield* markRevertFailed(caller.principal, {
          batchId: row.batchId,
          failure: NOT_READABLE,
          proposalId: row.proposalId,
          reservationId,
        }),
        row.proposalId,
      );
      return 'failed' satisfies RowRevert;
    }
    if (current.item.stillInPlace === false) {
      return 'changed' satisfies RowRevert;
    }
  }
  yield* Effect.forEach(
    plan.commands,
    Effect.fn('AgentPlatform.revertCommand')(function* revertCommand(command, index) {
      const outcome = yield* applyModuleCommand(caller.principal, row.appId, command, {
        actionSlug: row.actionSlug,
        idempotencyKey: `agent-revert-${row.proposalId}-${index}`,
        ...audiencesOf(row),
      });
      yield* requireModuleCommandResult(outcome);
    }),
    { concurrency: 1, discard: true },
  );
  yield* requireAffected(
    yield* markReverted(caller.principal, {
      batchId: row.batchId,
      proposalId: row.proposalId,
      reservationId,
    }),
    row.proposalId,
  );
  return 'reverted' satisfies RowRevert;
});

const approveCoreRow = Effect.fn('AgentPlatform.approveCoreRow')(function* approveCoreRow(
  caller: AgentPlatformCaller,
  row: AgentProposalRow,
  reviewed: RowReview,
) {
  const itemKey = `core:${row.proposalId}`;
  // One atomic claim: a concurrent reject, approval or „Vrátit vše“ cannot also act on this proposal.
  const claim = yield* claimForApproval(caller.principal, { batchId: row.batchId, proposalId: row.proposalId });
  if (!claim.affectedProposalIds.includes(row.proposalId)) {
    return result(itemKey, 'skipped', ALREADY_DECIDED);
  }
  const { reservationId } = claim;
  if (reservationId === undefined) {
    return yield* new AgentStoreUnavailable({ cause: 'The native approval claim returned no reservation' });
  }
  yield* requireCurrentProposalClaim(caller.principal, claim, 'claim-approval');
  const plan = revertPlanOf(reviewed);
  const outcome = yield* applyModuleCommand(caller.principal, row.appId, row.command, {
    actionSlug: row.actionSlug,
    idempotencyKey: `agent-proposal-${row.proposalId}`,
    ...audiencesOf(row),
  });
  const applyResult = yield* requireModuleCommandResult(outcome);
  const revert = resolveAgentRevertPlan(plan, applyResult);
  const applied = {
    applyResult,
    batchId: row.batchId,
    proposalId: row.proposalId,
    reservationId,
    revert,
  };
  yield* requireAffected(
    yield* markApplied(
      caller.principal,
      reviewed.item?.diff === undefined ? applied : { ...applied, diff: reviewed.item.diff },
    ),
    row.proposalId,
  );
  yield* runFollowUp(caller, row, reviewed.item, applyResult);
  // A revert can acquire the batch after mark-applied commits. Only a CURRENT caller-owned batch
  // reservation authorizes compensation; a different person's reservation must never be borrowed.
  const batch = yield* loadProposalBatch(caller.principal, row.batchId);
  if (batch.batchReverted) {
    const currentRow = batch.proposals.find((candidate) => candidate.proposalId === row.proposalId);
    if (currentRow?.status === 'reverted') {
      return result(itemKey, 'skipped', BATCH_REVERTED);
    }
    const reservation = batch.reservations?.find(
      (candidate) => candidate.operation === 'claim-batch-revert' && candidate.proposalIds.includes(row.proposalId),
    );
    if (currentRow === undefined || reservation === undefined) {
      return yield* new AgentStoreUnavailable({
        cause: 'Concurrent compensation remains with the native batch reservation owner',
      });
    }
    const current = yield* reviewRow(caller.principal, currentRow, 'undo');
    const compensated = yield* revertRow(caller, currentRow, currentRow.revert, current, reservation.reservationId);
    if (compensated !== 'reverted') {
      return yield* new AgentStoreUnavailable({ cause: 'Concurrent compensation has not completed' });
    }
    return result(itemKey, 'skipped', BATCH_REVERTED);
  }
  return result(itemKey, 'applied');
});

const decideCore = Effect.fn('AgentPlatform.decideCore')(function* decideCore(
  caller: AgentPlatformCaller,
  batchId: string,
  request: AgentDecideRequest,
) {
  // Complete-batch authorization and private visibility must succeed before the first claim or mutation.
  // A forbidden sibling denies the entire request; do not translate it into per-item forbidden counts.
  const rows = yield* loadBatchProposals(caller.principal, batchId);
  if (rows.length === 0) {
    return yield* new AgentPlatformInvalid({ reason: BATCH_NOT_FOUND });
  }
  const results = yield* Effect.forEach(
    request.itemKeys,
    Effect.fn('AgentPlatform.decideOne')(function* decideOne(itemKey) {
      const proposalId = parseCoreKey(itemKey);
      const row = rows.find((candidate) => candidate.proposalId === proposalId);
      if (row === undefined) {
        return result(itemKey, 'skipped', ITEM_NOT_IN_BATCH);
      }
      if (row.status !== 'pending') {
        return result(itemKey, 'skipped', 'Změna už byla vyřízena.');
      }
      const { check, reviewed } = yield* checkApprover(caller.principal, row);
      if (!check.ok) {
        return result(itemKey, 'forbidden', check.hidden ? ITEM_NOT_IN_BATCH : check.reason);
      }
      if (request.decision === 'reject') {
        const target = { batchId, proposalId: row.proposalId };
        const rejected = yield* markRejected(
          caller.principal,
          request.note === undefined ? target : { ...target, note: request.note },
        );
        return rejected.affectedProposalIds.includes(row.proposalId)
          ? result(itemKey, 'rejected')
          : result(itemKey, 'skipped', ALREADY_DECIDED);
      }
      if (row.batchRevertedAt !== null) {
        return result(itemKey, 'skipped', BATCH_REVERTED);
      }
      return yield* approveCoreRow(caller, row, reviewed);
    }),
    { concurrency: 1 },
  );
  return AgentDecideResponseSchema.make({ results });
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
    return AgentDecideResponseSchema.make({
      results: request.itemKeys.map((itemKey) => result(itemKey, 'forbidden', notAllowed(module.label))),
    });
  }
  const outcome = yield* decideLegacy(caller.principal, module.appId, changeIds, request.decision, request.note);
  const decisionResult = (itemKey: string) =>
    outcome.ok
      ? result(itemKey, request.decision === 'approve' ? 'applied' : 'rejected')
      : result(itemKey, outcome.status === 403 ? 'forbidden' : 'failed', outcome.message);
  return AgentDecideResponseSchema.make({
    results: request.itemKeys.map((itemKey) =>
      changeIdOf(itemKey) === undefined ? result(itemKey, 'skipped', ITEM_NOT_IN_BATCH) : decisionResult(itemKey),
    ),
  });
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
  // Complete-batch authorization and private visibility must succeed before the first claim or mutation.
  // A forbidden sibling denies the entire request; do not translate it into per-item forbidden counts.
  const rows = yield* loadBatchProposals(caller.principal, batchId);
  if (rows.length === 0) {
    return yield* new AgentPlatformInvalid({ reason: BATCH_NOT_FOUND });
  }
  // A batch marker is not completion: the same persisted ingress may still need to finish its reservation.
  if (
    !rows.some((row) => row.batchRevertedAt !== null) &&
    !rows.some((row) => row.status === 'applied' || row.status === 'revert_failed')
  ) {
    return revertResultMessage({ changed: 0, failed: 0, reverted: 0, unavailable: 0 });
  }
  if (yield* batchHasApprovalInProgress(caller.principal, batchId)) {
    return {
      message: 'Některá změna z dávky se právě schvaluje. Zkuste to prosím za chvíli znovu.',
      outcome: 'failed',
    } satisfies AgentRevertResponse;
  }
  const claim = yield* claimBatchRevert(
    caller.principal,
    request.note === undefined ? { batchId } : { batchId, note: request.note },
  );
  if (claim.affectedProposalIds.length === 0) {
    return { message: 'Dávka už byla vrácena.', outcome: 'failed' } satisfies AgentRevertResponse;
  }
  const { reservationId } = claim;
  if (reservationId === undefined) {
    return yield* new AgentStoreUnavailable({ cause: 'The native batch revert claim returned no reservation' });
  }
  const batch = yield* requireCurrentProposalClaim(caller.principal, claim, 'claim-batch-revert');
  const applied = batch.proposals
    .filter((row) => row.status === 'applied' || row.status === 'revert_failed')
    .toSorted((left, right) => right.position - left.position);
  // The batch is closed: proposals nobody decided yet will not run any more. Cleanup errors remain errors.
  yield* closePendingInBatch(caller.principal, {
    batchId,
    note: 'Dávka byla vrácena, návrh se už neprovede.',
    reservationId,
  });
  const counts = yield* Effect.reduce(
    applied,
    () => ({ changed: 0, failed: 0, reverted: 0, unavailable: 0 }),
    Effect.fn('AgentPlatform.revertBatchItem')(function* revertBatchItem(previous, row) {
      // Checked immediately before undo: an earlier undo may have restored this record.
      const current: RowReview =
        row.revert?.kind === 'commands'
          ? yield* reviewRow(caller.principal, row, 'undo')
          : { item: null, review: { state: 'none' } };
      const outcome = yield* revertRow(caller, row, row.revert, current, reservationId);
      return { ...previous, [outcome]: previous[outcome] + 1 };
    }),
  );
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
