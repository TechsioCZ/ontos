import { Effect, Result, Schema } from 'effect';

import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '../modules/active-application-composition.ts';
import { buildApplicationCompositionCatalog } from '../modules/application-composition-catalog.ts';
import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
import { ActionAuthority } from '../permissions/action-authority.ts';
import { ContextAccess } from '../permissions/context-access.ts';
import type { ReadPrepareContext, ReadLoadContext, ReadFinishContext } from '../reads/context.ts';
import { defineRead } from '../reads/definition.ts';
import { proposalLifecycleAdministrator } from './agent-proposal-command-preparation.ts';
import {
  AGENT_PROPOSAL_COMMAND_RECOVERY_MODE,
  AgentProposalQueueInputSchema,
  AgentProposalQueueModuleReview,
  AgentProposalQueueResultSchema,
  AgentProposalQueueVisibilitySchema,
} from './agent-proposal-queue-contract.ts';
import type { AgentProposalQueueInput, AgentProposalQueueRow } from './agent-proposal-queue-contract.ts';
import { proposalQueueFromTransaction } from './agent-proposal-queue-persistence.ts';
import type { AgentProposalQueueAction } from './agent-proposal-queue-persistence.ts';
import {
  agentProposalQueueDenied,
  agentProposalQueueUnavailable as unavailable,
} from './agent-proposal-queue-unavailable.ts';

const prepare = Effect.fn('AgentProposalQueueRead.prepare')(function* prepare(
  input: AgentProposalQueueInput,
  context: ReadPrepareContext,
) {
  const { legalEntityId, principalId, tenantId } = context.scope;
  if (legalEntityId === undefined) {
    return yield* unavailable('An exact company context is required');
  }
  if (
    input.mode === 'withdrawal-batches' ||
    (input.mode === AGENT_PROPOSAL_COMMAND_RECOVERY_MODE && input.payload.operation === 'withdraw-pending-of-agent')
  ) {
    if (
      !(yield* proposalLifecycleAdministrator(context.scope, yield* ContextAccess).pipe(Effect.mapError(unavailable)))
    ) {
      return yield* agentProposalQueueDenied();
    }
    const actions: readonly AgentProposalQueueAction[] = [];
    return { actions, revision: '' };
  }
  if (
    input.mode === 'own-run' ||
    input.mode === 'own-recent' ||
    (input.mode === AGENT_PROPOSAL_COMMAND_RECOVERY_MODE && input.payload.operation === 'insert')
  ) {
    // Kind is checked against the current principal row in the owner transaction, not client input.
    const actions: readonly AgentProposalQueueAction[] = [];
    return { actions, revision: '' };
  }
  const snapshot = yield* (yield* ActiveApplicationCompositionService).load.pipe(
    Effect.flatMap(validateActiveApplicationCompositionSnapshot),
    Effect.mapError(unavailable),
  );
  const { revision } = snapshot.composition;
  if (context.compositionRevision !== undefined && context.compositionRevision !== revision) {
    return yield* unavailable('The active composition changed during admission');
  }
  const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition).pipe(Effect.mapError(unavailable));
  const modules = yield* (yield* ContextAccess).modules({
    legalEntityId,
    moduleIds: catalog.moduleIds,
    principalId,
    tenantId,
  });
  if (modules.some(({ decision }) => decision === 'unavailable')) {
    return yield* unavailable('Module authorization is unavailable');
  }
  const accessible = new Set(modules.flatMap(({ decision, key }) => (decision === 'allowed' ? [key] : [])));
  const declared = catalog.contracts.flatMap(({ deployment, manifest }) => {
    const moduleKey = manifest.module.id;
    if (!accessible.has(moduleKey)) {
      return [];
    }
    return manifest.publicSurface.actions.flatMap((action) => {
      if (action.owningModuleId !== moduleKey || action.legalEntityScope === 'forbidden') {
        return [];
      }
      const prefix = `${action.owningModuleId}.`;
      return [
        {
          actionKey: action.actionKey,
          actionSlug: action.actionKey.startsWith(prefix) ? action.actionKey.slice(prefix.length) : action.actionKey,
          appId: deployment.appId,
          moduleKey,
          review: manifest.publicSurface.mcp?.approvalReview,
        },
      ];
    });
  });
  const decisions = yield* (yield* ActionAuthority)
    .checkActionAuthorities(declared.map(({ actionKey }) => ({ actionKey, legalEntityId, principalId, tenantId })))
    .pipe(Effect.mapError(unavailable));
  const executable = new Set(
    decisions.flatMap((decision) =>
      decision.execute === 'allowed' &&
      decision.legalEntityId === legalEntityId &&
      decision.principalId === principalId &&
      decision.tenantId === tenantId
        ? [decision.actionKey]
        : [],
    ),
  );
  const actions = declared.filter(
    (action) =>
      executable.has(action.actionKey) &&
      declared.filter((other) => other.appId === action.appId && other.actionSlug === action.actionSlug).length === 1,
  );
  if (actions.length === 0) {
    return yield* agentProposalQueueDenied();
  }
  return { actions, revision };
});

type Prepared = Effect.Success<ReturnType<typeof prepare>>;
type Services = ReturnType<typeof proposalQueueFromTransaction>;
const load = Effect.fn('AgentProposalQueueRead.load')(function* load(
  input: AgentProposalQueueInput,
  context: ReadLoadContext<Services, Prepared>,
) {
  return yield* context.services.load(input, context.prepared.actions);
});
type Loaded = Effect.Success<ReturnType<typeof load>>;

const actionOf = (row: AgentProposalQueueRow, actions: readonly AgentProposalQueueAction[]) =>
  actions.find(
    (action) =>
      action.appId === row.appId && action.moduleKey === row.moduleKey && action.actionSlug === row.actionSlug,
  );

const moduleVisibility = Effect.fn('AgentProposalQueueRead.moduleVisibility')(function* moduleVisibility(
  action: AgentProposalQueueAction,
  rows: readonly AgentProposalQueueRow[],
  context: ReadFinishContext<Prepared, Loaded>,
) {
  const { review } = action;
  if (review === undefined || rows.length === 0) {
    return rows.map((row) => row.proposalId);
  }
  const reviewer = yield* AgentProposalQueueModuleReview;
  const chunks = Array.from({ length: Math.ceil(rows.length / 300) }, (_, index) =>
    rows.slice(index * 300, (index + 1) * 300),
  );
  const responses = yield* Effect.forEach(
    chunks,
    (chunk) =>
      reviewer
        .review({
          appId: action.appId,
          compositionRevision: context.prepared.revision,
          path: review.path,
          principal: context.scope,
          subjects: chunk.map((row) => ({
            actionSlug: row.actionSlug,
            command: row.command,
            key: row.proposalId,
            stage: row.status === 'pending' ? ('proposed' as const) : ('history' as const),
          })),
          transport: context.scope,
        })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(AgentProposalQueueVisibilitySchema)), Effect.result),
    { concurrency: 1 },
  );
  const available = responses.every((response) => Result.isSuccess(response) && response.success.state === 'ok');
  if (!available) {
    return review.privateRecords ? [] : rows.map((row) => row.proposalId);
  }
  const visibility = new Map(
    responses.flatMap((response) =>
      Result.isSuccess(response) ? response.success.items.map((item) => [item.key, item.visible] as const) : [],
    ),
  );
  return rows.flatMap((row) =>
    visibility.get(row.proposalId) === false || (review.privateRecords && !visibility.has(row.proposalId))
      ? []
      : [row.proposalId],
  );
});

const finish = Effect.fn('AgentProposalQueueRead.finish')(function* finish(
  input: AgentProposalQueueInput,
  context: ReadFinishContext<Prepared, Loaded>,
) {
  const { loaded, prepared } = context;
  if (input.mode === 'withdrawal-batches') {
    return { evidence: { resultCount: loaded.withdrawalBatches?.batchIds.length ?? 0 }, result: loaded };
  }
  if (input.mode === AGENT_PROPOSAL_COMMAND_RECOVERY_MODE && input.payload.operation === 'withdraw-pending-of-agent') {
    // Lifecycle administration never grants a view of private business commands or results.
    return { evidence: { resultCount: 1 }, result: { ...loaded, candidates: [], proposals: [] } };
  }
  if (
    input.mode === 'own-run' ||
    input.mode === 'own-recent' ||
    (input.mode === AGENT_PROPOSAL_COMMAND_RECOVERY_MODE && input.payload.operation === 'insert')
  ) {
    return { evidence: { resultCount: loaded.proposals.length }, result: loaded };
  }
  const batchState = input.mode === 'batch-state';
  const exactBatch = input.mode === 'batch' || batchState || input.mode === AGENT_PROPOSAL_COMMAND_RECOVERY_MODE;
  if (exactBatch && loaded.proposals.some((row) => actionOf(row, prepared.actions) === undefined)) {
    return yield* agentProposalQueueDenied();
  }
  const authorized = loaded.proposals.filter((row) => actionOf(row, prepared.actions) !== undefined);
  // Remote owner reads are after commit, never inside the scoped SQL transaction.
  const modules = [...new Map(prepared.actions.map((action) => [action.appId, action])).values()];
  const visibility = yield* Effect.forEach(
    modules,
    (action) =>
      moduleVisibility(
        action,
        authorized.filter((row) => row.appId === action.appId),
        context,
      ),
    { concurrency: 2 },
  );
  const visible = new Set(visibility.flat());
  if (exactBatch && visible.size !== loaded.proposals.length) {
    return yield* agentProposalQueueDenied();
  }
  const proposals = batchState ? [] : authorized.filter((row) => visible.has(row.proposalId));
  return {
    evidence: { resultCount: batchState ? 1 : proposals.length },
    result: { ...loaded, proposals },
  };
});

/** Original trusted principal and transport must be passed to ReadRuntime.runRead; no scalar-scope entrypoint. */
export const agentProposalQueueRead = defineRead(
  {
    accessKind: 'list',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'authenticated_principal' },
      entrypointKey: 'core.identity.agent-proposal-queue',
      moduleKey: 'core.identity',
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: 'core.identity.agent-proposal-queue.access.v1' },
    inputSchema: AgentProposalQueueInputSchema,
    legalEntityScope: 'required',
    owningModuleKey: 'core.identity',
    permissionTarget: 'legal_entity',
    policies: [],
    readKey: 'core.identity.agent-proposal-queue',
    resultSchema: Schema.toType(AgentProposalQueueResultSchema),
    schemaVersion: '1',
  },
  { finish, load, prepare },
  (transaction, scope) => Effect.succeed(proposalQueueFromTransaction(transaction, scope)),
  () => ({ kind: 'legal_entity' }),
);
