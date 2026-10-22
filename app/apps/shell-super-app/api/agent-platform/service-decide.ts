/**
 * Human decisions on agent proposals. Approve runs the stored module command as the approving person (their
 * permissions, their audit); the revert plan is built here from the entity read just before the change. Legacy
 * module engines (CRM, sales, merchandise orders) decide and revert through their own AiDecideChanges/AiRevertBatch.
 */
import type {
  AgentDecideRequest,
  AgentDecideResponse,
  AgentRevertRequest,
  AgentRevertResponse,
} from '@app/shared-contracts/agent-proposals';
import { agentChangeStillInPlace, agentPlatformDiff } from '@app/shared-contracts/agent-diff';
import { buildAgentRevertPlan, resolveAgentRevertPlan } from '@app/shared-contracts/agent-revert';
import { Effect } from 'effect';

import { approverCheck, parseCoreKey, revertBeforeLookup, revertResultMessage } from './approval-logic.ts';
import type { TargetRead } from './approval-logic.ts';
import { AgentPlatformForbidden, AgentPlatformInvalid, callerModuleAccess } from './caller.ts';
import type { AgentPlatformCaller } from './caller.ts';
import { parseLegacyKey } from './legacy-normalize.ts';
import { decideLegacy, revertLegacy } from './legacy-queue.ts';
import type { AgentProposalRow } from './mappers.ts';
import { loadComposedModules } from './composed-modules.ts';
import { applyModuleCommand, callModuleAs, readModuleRecords } from './module-call.ts';
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
const notAllowed = (moduleLabel: string) => `Změny v modulu ${moduleLabel} nemůžete schválit ani zamítnout.`;

const audiencesOf = (row: AgentProposalRow) =>
  row.referenceAudiences.length === 0 ? {} : { referenceAudiences: row.referenceAudiences };

/** Current wire JSON of the entity the command changes, read as `principal` (`needed: false` for create commands). */
export const readTargetEntity = Effect.fn('AgentPlatform.readTargetEntity')(function* readTargetEntity(
  principal: AgentPlatformCaller['principal'],
  appId: string,
  command: Readonly<Record<string, unknown>>,
) {
  const lookup = revertBeforeLookup(appId, command);
  if (lookup === undefined) {
    const notNeeded: TargetRead = { needed: false };
    return notNeeded;
  }
  const response = yield* callModuleAs(principal, appId, '/reads/records', lookup.query).pipe(Effect.result);
  // 404: the module answered that the record does not exist for this person (CRM: a colleague's client).
  const status = response._tag === 'Success' ? response.success.status : undefined;
  const body = response._tag === 'Success' && status === 200 ? response.success.body : undefined;
  const read: TargetRead = {
    available: status === 200 || status === 404,
    body,
    needed: true,
    value: body === undefined ? undefined : lookup.pick(body),
  };
  return read;
});

/**
 * Whether this person can carry out the stored command (approval runs as them): their module read and the target
 * record, read as them. The target read already carries the module flags when the command changes one record.
 */
export const checkApprover = Effect.fn('AgentPlatform.checkApprover')(function* checkApprover(
  principal: AgentPlatformCaller['principal'],
  row: Pick<AgentProposalRow, 'appId' | 'command'>,
) {
  const target = yield* readTargetEntity(principal, row.appId, row.command);
  const moduleBody =
    target.needed && target.body !== undefined ? target.body : yield* readModuleRecords(principal, row.appId);
  return approverCheck(row.appId, row.command, moduleBody, target);
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const taskRefOf = (row: AgentProposalRow, applyResult: unknown): unknown => {
  if (row.command['_tag'] !== 'CreateTask') {
    return row.command['taskRef'];
  }
  const task = isRecord(applyResult) ? applyResult['task'] : undefined;
  return isRecord(task) ? task['ref'] : undefined;
};

/**
 * Module history only knows the approving person. For tasks the platform also leaves a comment naming the agent, so
 * Úkoly shows who proposed the change. Best effort: a failed comment never undoes the approved change.
 */
const noteAgentProvenance = Effect.fn('AgentPlatform.noteAgentProvenance')(function* noteAgentProvenance(
  caller: AgentPlatformCaller,
  row: AgentProposalRow,
  applyResult: unknown,
) {
  if (row.appId !== 'work-tasks') {
    return;
  }
  const taskRef = taskRefOf(row, applyResult);
  if (typeof taskRef !== 'object' || taskRef === null) {
    return;
  }
  yield* applyModuleCommand(
    caller.principal,
    row.appId,
    {
      _tag: 'AddTaskComment',
      taskRef,
      text: `Změnu „${row.summary}“ navrhl ${row.agentLabel}; schváleno na stránce Ke schválení.`,
    },
    {
      idempotencyKey: `agent-proposal-${row.proposalId}-provenance`,
      // Work Tasks names the comment author from Workforce.
      referenceAudiences: [...new Set([...row.referenceAudiences, 'workforce'])],
    },
  ).pipe(Effect.ignore);
});

type RowRevert = 'changed' | 'failed' | 'reverted' | 'unavailable';

/** Undoes one applied proposal as the person, unless someone changed the record after the approval. */
const revertRow = Effect.fn('AgentPlatform.revertRow')(function* revertRow(
  caller: AgentPlatformCaller,
  row: AgentProposalRow,
  plan: AgentProposalRow['revert'],
) {
  if (plan === null || plan.kind === 'none') {
    return 'unavailable' satisfies RowRevert;
  }
  const current = yield* readTargetEntity(caller.principal, row.appId, row.command);
  if (current.needed) {
    if (current.value === undefined) {
      yield* markRevertFailed(row.proposalId, { failure: 'Záznam se teď nepodařilo načíst.' });
      return 'failed' satisfies RowRevert;
    }
    if (agentChangeStillInPlace(row.appId, row.command, current.value) === false) {
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
) {
  const itemKey = `core:${row.proposalId}`;
  const by = caller.principal.principalId;
  // One atomic claim: a concurrent reject, approval or „Vrátit vše“ cannot also act on this proposal.
  if (!(yield* claimForApproval(row.proposalId, by))) {
    return result(itemKey, 'skipped', ALREADY_DECIDED);
  }
  const before = yield* readTargetEntity(caller.principal, row.appId, row.command);
  const beforeValue = before.needed ? before.value : undefined;
  const plan = buildAgentRevertPlan(row.appId, {
    before: beforeValue,
    command: row.command,
    tenantId: caller.principal.tenantId,
  });
  const outcome = yield* applyModuleCommand(caller.principal, row.appId, row.command, {
    actionSlug: row.actionSlug,
    idempotencyKey: `agent-proposal-${row.proposalId}`,
    ...audiencesOf(row),
  });
  if (outcome.ok) {
    const revert = resolveAgentRevertPlan(plan, outcome.body);
    yield* markApplied(row.proposalId, {
      applyResult: outcome.body,
      by,
      diff:
        before.needed && beforeValue === undefined ? undefined : agentPlatformDiff(row.appId, row.command, beforeValue),
      revert,
    });
    yield* noteAgentProvenance(caller, row, outcome.body);
    if (yield* isBatchReverted(row.batchId)) {
      // „Vrátit vše“ ran while this change was being applied: undo it right away so the batch stays reverted.
      yield* revertRow(caller, row, revert);
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
        const check = yield* checkApprover(caller.principal, row);
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
        return yield* approveCoreRow(caller, row);
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
    const outcome = yield* revertRow(caller, row, row.revert);
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
