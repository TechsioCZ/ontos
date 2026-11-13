import { Effect, Result, Schema } from 'effect';

import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '../modules/active-application-composition.ts';
import { buildApplicationCompositionCatalog } from '../modules/application-composition-catalog.ts';
import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
import { ActionAuthority } from '../permissions/action-authority-contract.ts';
import type { ReadPrepareContext, ReadLoadContext, ReadFinishContext } from '../reads/context.ts';
import type { ReadHandlerUnavailable } from '../reads/errors.ts';
import { defineRead } from '../reads/definition.ts';
import { proposalLifecycleAdministrator } from './agent-proposal-command-preparation.ts';
import { decodeTrustedPrincipalContext } from './system-principal-context-provenance.ts';
import {
  AGENT_PROPOSAL_COMMAND_RECOVERY_MODE,
  AgentProposalQueueInputSchema,
  AgentProposalQueueModuleReview,
  AgentProposalQueueResultSchema,
  AgentProposalQueueVisibilitySchema,
} from './agent-proposal-queue-contract.ts';
import type { AgentProposalQueueInput, AgentProposalQueueRow } from './agent-proposal-queue-contract.ts';
import { isOwnProposalRead, proposalQueueFromTransaction } from './agent-proposal-queue-persistence.ts';
import type { AgentProposalQueueAction } from './agent-proposal-queue-persistence.ts';
import {
  agentProposalQueueDenied,
  agentProposalQueueUnavailable as unavailable,
} from './agent-proposal-queue-unavailable.ts';

/** A read of one exact batch: its rows are selected by the batch alone, and every one of them must be authorized. */
const isExactBatchRead = (input: AgentProposalQueueInput): boolean =>
  input.mode === 'batch' || input.mode === 'batch-state' || input.mode === AGENT_PROPOSAL_COMMAND_RECOVERY_MODE;

/**
 * The Actions of `actions` the acting person may run. One gate question per Action over this request's own trusted
 * scope: no scalar identity is re-derived from client input (O66). The Action's answer is its module's: no retired
 * `module_access` relation is asked beside it.
 */
const executableActions = Effect.fn('AgentProposalQueueRead.executableActions')(function* executableActions(
  actions: readonly AgentProposalQueueAction[],
  scope: ReadPrepareContext['scope'],
) {
  if (actions.length === 0) {
    return [];
  }
  const decisions = yield* (yield* ActionAuthority)
    .checkActionAuthorities({ actionKeys: actions.map(({ actionKey }) => actionKey), scope })
    .pipe(Effect.mapError(unavailable));
  const executable = new Set(
    decisions.flatMap((decision) => (decision.execute === 'allowed' ? [decision.actionKey] : [])),
  );
  return actions.filter((action) => executable.has(action.actionKey));
});

/** The rounds a "may run at least one Action" question is asked in: small first, so a person with rights stops early. */
const ANY_ACTION_ROUNDS = [8, 32] as const;

/**
 * The rounds of `actions`, those of modules with an approval review (the ones agent proposals name) first: the sizes of
 * `ANY_ACTION_ROUNDS`, then everything left. The order only decides which question comes first, never the answer.
 */
const roundsOf = (actions: readonly AgentProposalQueueAction[]): readonly (readonly AgentProposalQueueAction[])[] => {
  const ordered = [
    ...actions.filter(({ review }) => review !== undefined),
    ...actions.filter(({ review }) => review === undefined),
  ];
  const rounds: (readonly AgentProposalQueueAction[])[] = [];
  let from = 0;
  for (const size of ANY_ACTION_ROUNDS) {
    rounds.push(ordered.slice(from, from + size));
    from += size;
  }
  rounds.push(ordered.slice(from));
  return rounds.filter((round) => round.length > 0);
};

/** What the rounds asked so far answered: whether one admitted an Action, and every asked Action's own answer. */
interface AnyActionAnswer {
  readonly answered: ReadonlyMap<string, boolean>;
  readonly found: boolean;
}

/** The rounds from `index` on, asking the next only while none admitted an Action. */
const anyRoundAdmits = (
  rounds: readonly (readonly AgentProposalQueueAction[])[],
  index: number,
  scope: ReadPrepareContext['scope'],
  answered: ReadonlyMap<string, boolean>,
): Effect.Effect<AnyActionAnswer, ReadHandlerUnavailable, ActionAuthority> => {
  const round = rounds[index];
  return round === undefined
    ? Effect.succeed({ answered, found: false })
    : executableActions(round, scope).pipe(
        Effect.flatMap((admitted) => {
          const runnable = new Set(admitted.map(({ actionKey }) => actionKey));
          const next = new Map([
            ...answered,
            ...round.map(({ actionKey }) => [actionKey, runnable.has(actionKey)] as const),
          ]);
          // The early stop: later rounds are never asked, so they can neither admit nor be unavailable.
          return admitted.length > 0
            ? Effect.succeed({ answered: next, found: true })
            : anyRoundAdmits(rounds, index + 1, scope, next);
        }),
      );
};

/**
 * Whether the acting person may run at least one of `actions`: asked in rounds of growing size and stopped at the first
 * round that admits one. Every Action's allow/deny answer is its own whatever else is asked with it, so this gives the
 * same allow/deny answer as one question over all of them; a person with no right at all is asked about every Action,
 * whatever they read. The asked Actions' answers come back too, for the read to apply to its rows as it always applied
 * `prepare`'s.
 *
 * The one known difference, accepted: an Action in a round that is never asked can no longer make the read
 * unavailable. When the authority cannot answer only for Actions of an unasked round, a missing or empty batch now
 * reads as 0 rows instead of "unavailable"; an outage in any round that is asked still makes the read unavailable.
 */
const holdsAnyExecutableAction = (actions: readonly AgentProposalQueueAction[], scope: ReadPrepareContext['scope']) =>
  anyRoundAdmits(roundsOf(actions), 0, scope, new Map()).pipe(
    Effect.withSpan('AgentProposalQueueRead.holdsAnyExecutableAction'),
  );

/** No Action answered yet: what every read but an exact batch carries from `prepare`. */
const NOTHING_ANSWERED: ReadonlyMap<string, boolean> = new Map();

const prepare = Effect.fn('AgentProposalQueueRead.prepare')(function* prepare(
  input: AgentProposalQueueInput,
  context: ReadPrepareContext,
) {
  if (context.scope.legalEntityId === undefined) {
    return yield* unavailable('An exact company context is required');
  }
  // A connected application reads back only its own proposals, never a person's queue or lifecycle batches.
  if (context.scope.authMethod === 'oauth_connection' && !isOwnProposalRead(input)) {
    return yield* agentProposalQueueDenied();
  }
  if (
    input.mode === 'withdrawal-batches' ||
    (input.mode === AGENT_PROPOSAL_COMMAND_RECOVERY_MODE && input.payload.operation === 'withdraw-pending-of-agent')
  ) {
    if (!(yield* proposalLifecycleAdministrator(context.scope).pipe(Effect.mapError(unavailable)))) {
      return yield* agentProposalQueueDenied();
    }
    const actions: readonly AgentProposalQueueAction[] = [];
    return { actions, answered: NOTHING_ANSWERED, revision: '' };
  }
  if (isOwnProposalRead(input)) {
    // Kind is checked against the current principal row in the owner transaction, not client input.
    const actions: readonly AgentProposalQueueAction[] = [];
    return { actions, answered: NOTHING_ANSWERED, revision: '' };
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
  const declared = catalog.contracts.flatMap(({ deployment, manifest }) => {
    const moduleKey = manifest.module.id;
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
  // An Action a row can name: one declared Action per app and slug, so a row never matches two.
  const unique = declared.filter(
    (action) =>
      declared.filter((other) => other.appId === action.appId && other.actionSlug === action.actionSlug).length === 1,
  );
  if (isExactBatchRead(input)) {
    // A person who may run no Action at all is refused here, before any row is loaded or locked, whatever the batch
    // (an existing or a missing one costs the same). Every row's own Action is authorized in `finish`: only the Actions
    // its rows name are asked there, never every Action of the release.
    const any = yield* holdsAnyExecutableAction(unique, context.scope);
    if (!any.found) {
      return yield* agentProposalQueueDenied();
    }
    return { actions: unique, answered: any.answered, revision };
  }
  const actions = yield* executableActions(unique, context.scope);
  if (actions.length === 0) {
    return yield* agentProposalQueueDenied();
  }
  return { actions, answered: NOTHING_ANSWERED, revision };
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
  // Operational transport is not part of the strict gateway principal contract.
  // Decode the admitted identity while retaining its verified provenance.
  const principal = yield* decodeTrustedPrincipalContext(context.scope).pipe(Effect.mapError(unavailable));
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
          principal,
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
  if (isOwnProposalRead(input)) {
    return { evidence: { resultCount: loaded.proposals.length }, result: loaded };
  }
  const batchState = input.mode === 'batch-state';
  const exactBatch = isExactBatchRead(input);
  // An exact batch asks exactly the Actions its rows name, after commit and never inside the scoped SQL transaction;
  // `prepare` already refused a person who may run no Action at all.
  const named = [
    ...new Set(loaded.proposals.map((row) => actionOf(row, prepared.actions)).filter((action) => action !== undefined)),
  ];
  // The rows' Actions `prepare` already asked keep its answer, as the read always applied `prepare`'s answers; only the
  // others are asked now.
  const unasked = named.filter(({ actionKey }) => !prepared.answered.has(actionKey));
  const actions = exactBatch
    ? [
        ...named.filter(({ actionKey }) => prepared.answered.get(actionKey) === true),
        ...(yield* executableActions(unasked, context.scope)),
      ]
    : prepared.actions;
  if (exactBatch && loaded.proposals.some((row) => actionOf(row, actions) === undefined)) {
    return yield* agentProposalQueueDenied();
  }
  const authorized = loaded.proposals.filter((row) => actionOf(row, actions) !== undefined);
  // Remote owner reads are after commit, never inside the scoped SQL transaction.
  const modules = [...new Map(actions.map((action) => [action.appId, action])).values()];
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
