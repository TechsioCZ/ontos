/**
 * Human decisions on agent proposals. Approve runs the stored module command as the approving person (their
 * permissions, their audit); the revert plan is built here from the entity read just before the change. Legacy
 * module engines (CRM, sales, merchandise orders) decide and revert through their own AiDecideChanges/AiRevertBatch.
 */
import { agentApprovalModuleByAppId, agentModuleLabel } from '@app/shared-contracts/agent-proposals';
import type {
  AgentDecideRequest,
  AgentDecideResponse,
  AgentRevertRequest,
  AgentRevertResponse,
} from '@app/shared-contracts/agent-proposals';
import { buildAgentRevertPlan, resolveAgentRevertPlan } from '@app/shared-contracts/agent-revert';
import { Effect } from 'effect';

import { parseCoreKey, revertBeforeLookup, revertResultMessage } from './approval-logic.ts';
import { AgentPlatformForbidden, AgentPlatformInvalid, callerModuleAccess } from './caller.ts';
import type { AgentPlatformCaller } from './caller.ts';
import { parseLegacyKey } from './legacy-normalize.ts';
import { decideLegacy, revertLegacy } from './legacy-queue.ts';
import type { AgentProposalRow } from './mappers.ts';
import { applyModuleCommand, callModuleAs } from './module-call.ts';
import {
  loadBatchProposals,
  markApplied,
  markBatchReverted,
  markFailed,
  markRejected,
  markRevertFailed,
  markReverted,
} from './proposal-store.ts';

type DecideResult = AgentDecideResponse['results'][number];

const result = (itemKey: string, outcome: DecideResult['outcome'], message?: string): DecideResult =>
  message === undefined ? { itemKey, outcome } : { itemKey, message, outcome };

const BATCH_NOT_FOUND = 'Dávka návrhů nebyla nalezena.';
const notAllowed = (moduleLabel: string) => `Změny v modulu ${moduleLabel} nemůžete schválit ani zamítnout.`;

const audiencesOf = (row: AgentProposalRow) =>
  row.referenceAudiences.length === 0 ? {} : { referenceAudiences: row.referenceAudiences };

/** Current wire JSON of the entity the command changes, read as the person; undefined when not needed/unreadable. */
const readBefore = Effect.fn('AgentPlatform.readBefore')(function* readBefore(
  caller: AgentPlatformCaller,
  row: AgentProposalRow,
) {
  const lookup = revertBeforeLookup(row.appId, row.command);
  if (lookup === undefined) {
    return undefined;
  }
  const response = yield* callModuleAs(caller.principal, row.appId, '/reads/records', lookup.query).pipe(Effect.result);
  if (response._tag === 'Failure' || response.success.status !== 200) {
    return undefined;
  }
  return lookup.pick(response.success.body);
});

const approveCoreRow = Effect.fn('AgentPlatform.approveCoreRow')(function* approveCoreRow(
  caller: AgentPlatformCaller,
  row: AgentProposalRow,
) {
  const itemKey = `core:${row.proposalId}`;
  const by = caller.principal.principalId;
  const before = yield* readBefore(caller, row);
  const plan = buildAgentRevertPlan(row.appId, { before, command: row.command, tenantId: caller.principal.tenantId });
  const outcome = yield* applyModuleCommand(caller.principal, row.appId, row.command, {
    actionSlug: row.actionSlug,
    idempotencyKey: `agent-proposal-${row.proposalId}`,
    ...audiencesOf(row),
  });
  if (outcome.ok) {
    yield* markApplied(row.proposalId, {
      applyResult: outcome.body,
      by,
      revert: resolveAgentRevertPlan(plan, outcome.body),
    });
    return result(itemKey, 'applied');
  }
  if (outcome.status === 403) {
    // The module refused this person: the proposal stays pending for someone with the right permission.
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
          return result(itemKey, 'forbidden', notAllowed(agentModuleLabel(row.moduleKey)));
        }
        if (request.decision === 'reject') {
          yield* markRejected(row.proposalId, { by: principalId, note: request.note ?? null });
          return result(itemKey, 'rejected');
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
  const module = agentApprovalModuleByAppId(batch.appId);
  if (module === undefined || !module.legacyEngine) {
    return yield* new AgentPlatformInvalid({ reason: BATCH_NOT_FOUND });
  }
  const changeIds = request.itemKeys.flatMap((key) => {
    const parsed = parseLegacyKey(key);
    return parsed !== undefined && parsed.appId === batch.appId ? [parsed.id] : [];
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
      outcome.ok
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
  const applied = rows.filter((row) => row.status === 'applied').toSorted((left, right) => right.position - left.position);
  if (applied.some((row) => !modules.write.has(row.moduleKey))) {
    return yield* new AgentPlatformForbidden({
      reason: 'Dávku může vrátit jen člověk s oprávněním k zápisu ve všech jejích modulech.',
    });
  }
  let reverted = 0;
  let unavailable = 0;
  let failed = 0;
  for (const row of applied) {
    const plan = row.revert;
    if (plan === null || plan.kind === 'none') {
      unavailable += 1;
      continue;
    }
    let failure: string | undefined;
    for (const [index, command] of plan.commands.entries()) {
      const outcome = yield* applyModuleCommand(caller.principal, row.appId, command, {
        actionSlug: row.actionSlug,
        idempotencyKey: `agent-revert-${row.proposalId}-${index}`,
        ...audiencesOf(row),
      });
      if (!outcome.ok) {
        failure = outcome.message;
        break;
      }
    }
    if (failure === undefined) {
      yield* markReverted(row.proposalId, { by: principalId });
      reverted += 1;
    } else {
      yield* markRevertFailed(row.proposalId, { failure });
      failed += 1;
    }
  }
  if (reverted > 0) {
    yield* markBatchReverted(batchId, { by: principalId, note: request.note ?? null });
  }
  return revertResultMessage({ failed, reverted, unavailable });
});

const revertLegacyBatch = Effect.fn('AgentPlatform.revertLegacyBatch')(function* revertLegacyBatch(
  caller: AgentPlatformCaller,
  batch: { readonly appId: string; readonly id: string },
  request: AgentRevertRequest,
) {
  const module = agentApprovalModuleByAppId(batch.appId);
  if (module === undefined || !module.legacyEngine) {
    return yield* new AgentPlatformInvalid({ reason: BATCH_NOT_FOUND });
  }
  const modules = yield* callerModuleAccess(caller);
  if (!modules.write.has(module.moduleKey)) {
    return yield* new AgentPlatformForbidden({ reason: `Dávku v modulu ${module.label} nemůžete vrátit.` });
  }
  const outcome = yield* revertLegacy(caller.principal, module.appId, batch.id, request.note);
  return outcome.ok
    ? ({ message: 'Změny dávky byly vráceny. Historie zůstala zachována.', outcome: 'reverted' } satisfies AgentRevertResponse)
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
