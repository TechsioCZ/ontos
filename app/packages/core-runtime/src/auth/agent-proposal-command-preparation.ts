import { Clock, Context, DateTime, Effect, Layer, Option, Ref, Schema } from 'effect';

import { ActionPermissionCheckError } from '../actions/errors.ts';
import { computeCanonicalValueHash, recoverSqlTransactionError } from '../actions/repository.ts';
import { CoreDatabase } from '../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../db/database-identities.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '../modules/active-application-composition.ts';
import { buildApplicationCompositionCatalog } from '../modules/application-composition-catalog.ts';
import { isProposableModuleCommand } from '../modules/mcp-contribution.ts';
import type { OperationalScope } from '../operations/context.ts';
// The pure tag, not the catalog-backed implementation: this module is reached from the Core Action
// catalog (via `mutate-agent-proposals.action.ts`), so importing the implementation would cycle.
import { ActionAuthority } from '../permissions/action-authority-contract.ts';
import { AccessDecisionGate } from '../access/enforcement/contract.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { PreparedAccessDecision } from '../operations/access-gate.ts';
import { AgentLifecycleAuthority } from './agent-lifecycle-authority.ts';
import type { GateInput } from '../access/enforcement/contract.ts';
import type { AccessDecision } from '../access/decision/contract.ts';
import { manageAgentStatusAction } from '../modules/actions/manage-agent-status.action.ts';
import { ActionAuthorizationPreflight } from '../actions/owner-proof-preflight.ts';
import type {
  ActionAuthorizationPreflightInput,
  ActionAuthorizationPreflightService,
} from '../actions/owner-proof-preflight.ts';
import {
  agentProposalCommandActionKey,
  AgentProposalCommandPayloadSchema,
  proposalCommandTargetId,
} from './agent-proposal-command-contract.ts';
import type { AgentProposalCommandPayload } from './agent-proposal-command-contract.ts';
import type { AgentProposalCommandError } from './agent-proposal-command-error.ts';
import { proposalCommandUnavailable } from './agent-proposal-command-error.ts';
import { loadProposalCommandSnapshot } from './agent-proposal-command-persistence.ts';
import type { AgentProposalCommandSnapshot } from './agent-proposal-command-persistence.ts';

interface PreparedCommand {
  readonly compositionRevision: string;
  readonly expiresAt: number;
  /**
   * The lifecycle question of a withdrawal, prepared before the transaction; the execute step re-asks it from the
   * Action transaction's own snapshot, so a right revoked after preparation withdraws nothing (F3).
   */
  readonly lifecycle?: PreparedAccessDecision;
  readonly payloadHash: string;
  readonly scopeHash: string;
  readonly snapshot: AgentProposalCommandSnapshot;
}
interface PreparationService {
  readonly consume: (input: {
    readonly actionInvocationId: string;
    readonly compositionRevision: string;
    readonly payload: AgentProposalCommandPayload;
    readonly scope: OperationalScope;
    /** The Action's own owner transaction: a prepared lifecycle question is re-asked inside it. */
    readonly transaction: ScopedTransactionExecutor;
  }) => Effect.Effect<AgentProposalCommandSnapshot, AgentProposalCommandError>;
  readonly prepare: ActionAuthorizationPreflightService['prepare'];
}

/** Private invocation-bound preparation, not a permission grant or a public persistence capability. */
export class AgentProposalCommandPreparation extends Context.Service<
  AgentProposalCommandPreparation,
  PreparationService
>()('@app/core-runtime/auth/agent-proposal-command-preparation/AgentProposalCommandPreparation') {}

const preflightUnavailable = (cause: unknown) =>
  Object.defineProperty(
    new ActionPermissionCheckError({
      code: 'action_permission_check_failed',
      reason: 'Proposal command preparation failed',
    }),
    'cause',
    { value: cause },
  );
/**
 * Withdrawing every pending proposal of an agent is agent lifecycle administration: it is decided by the
 * very right the same person uses to disable or archive that agent, `core.identity.agent-status.manage`,
 * asked by the one gate in the request's own company (O81). It is not a new right, never a module's
 * execution right and never a caller-supplied capability.
 */
export const lifecycleQuestionOf = (scope: OperationalScope, now: Date): GateInput => ({
  carrier: { accessDeclaration: manageAgentStatusAction.descriptor.accessDeclaration },
  legalEntityScope: 'required',
  now,
  scope,
});

/** The gate's answer as the lifecycle check acts on it: allowed, refused, or an unreadable authority. */
const lifecycleAnswerOf = (decision: AccessDecision) =>
  decision.outcome === 'UNAVAILABLE'
    ? Effect.fail(preflightUnavailable('Agent administration authority is unavailable'))
    : Effect.succeed(decision.outcome === 'ALLOWED');

export const proposalLifecycleAdministrator = Effect.fn('AgentProposalCommand.lifecycleAdministrator')(
  function* administrator(scope: OperationalScope) {
    if (scope.legalEntityId === undefined) {
      return false;
    }
    const gate = yield* AccessDecisionGate;
    const decision = yield* gate.decide(lifecycleQuestionOf(scope, DateTime.toDateUtc(yield* DateTime.now)));
    return yield* lifecycleAnswerOf(decision);
  },
);

const targetsOf = (payload: AgentProposalCommandPayload, snapshot: AgentProposalCommandSnapshot) => {
  const targetId = proposalCommandTargetId(payload);
  const rows = Option.isSome(targetId)
    ? snapshot.rows.filter((row) => row.proposalId === targetId.value)
    : snapshot.rows;
  const stored = rows.map((row) => ({
    actionSlug: row.actionSlug,
    appId: row.appId,
    command: row.commandJson,
    moduleKey: row.moduleKey,
  }));
  return payload.operation === 'insert' ? [...payload.proposals, ...stored] : stored;
};
type ActiveSnapshot = Effect.Success<(typeof ActiveApplicationCompositionService)['Service']['load']>;
type Catalog = Effect.Success<ReturnType<typeof buildApplicationCompositionCatalog>>;
const resolveActions = (targets: ReturnType<typeof targetsOf>, active: ActiveSnapshot, catalog: Catalog) => {
  const releases = new Map(active.composition.modules.map((release) => [release.deployment.appId, release]));
  const contracts = new Map(catalog.contracts.map((contract) => [contract.manifest.module.id, contract]));
  const resolved: string[] = [];
  for (const target of targets) {
    const release = releases.get(target.appId);
    const contract = contracts.get(release?.moduleId ?? '');
    if (
      release?.moduleId !== target.moduleKey ||
      contract?.manifest.publicSurface.mcp?.approvals !== true ||
      // The command must belong to the exact Action it is authorized and later executed as.
      !isProposableModuleCommand(contract.manifest.publicSurface.mcp.commandActions, target.actionSlug, target.command)
    ) {
      return Option.none<readonly string[]>();
    }
    const matching = contract.manifest.publicSurface.actions.filter((action) => {
      const prefix = `${action.owningModuleId}.`;
      const slug = action.actionKey.startsWith(prefix) ? action.actionKey.slice(prefix.length) : action.actionKey;
      return (
        action.owningModuleId === release.moduleId &&
        action.legalEntityScope !== 'forbidden' &&
        slug === target.actionSlug
      );
    });
    const [action] = matching;
    if (matching.length !== 1 || action === undefined) {
      return Option.none<readonly string[]>();
    }
    resolved.push(action.actionKey);
  }
  return Option.some(resolved);
};

/**
 * Native authorization preflight reads with Core's already admitted scope and keeps the original ingress carrier.
 * SQL closes before any composition/SpiceDB checks. An allowed preparation returns NOT_APPLICABLE so Core still
 * requires the lifecycle Action's own explicit executor relation; no proof permit bypasses it.
 */
export const AgentProposalCommandPreparationLive = Layer.effect(
  AgentProposalCommandPreparation,
  Effect.gen(function* makeProposalPreparation() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    const composition = yield* ActiveApplicationCompositionService;
    const authority = yield* ActionAuthority;
    // Prepares the lifecycle question outside SQL and re-checks it inside the Action transaction (F3).
    const lifecycleAuthority = yield* AgentLifecycleAuthority;
    const prepared = yield* Ref.make<ReadonlyMap<string, PreparedCommand>>(new Map());
    const prepare = Effect.fn('AgentProposalCommand.prepare')(function* prepare(
      input: ActionAuthorizationPreflightInput,
    ) {
      if (input.actionKey !== agentProposalCommandActionKey) {
        return { outcome: 'not_applicable' as const };
      }
      const payload = yield* Schema.decodeUnknownEffect(AgentProposalCommandPayloadSchema, {
        onExcessProperty: 'error',
      })(input.payload).pipe(Effect.mapError(preflightUnavailable));
      if (
        input.scope.legalEntityId === undefined ||
        input.principal.principalId !== input.scope.principalId ||
        input.principal.tenantId !== input.scope.tenantId ||
        input.principal.legalEntityId !== input.scope.legalEntityId
      ) {
        return { outcome: 'denied' as const };
      }
      const active = yield* composition.load.pipe(
        Effect.flatMap(validateActiveApplicationCompositionSnapshot),
        Effect.mapError(preflightUnavailable),
      );
      const [catalog, snapshot] = yield* Effect.all(
        [
          buildApplicationCompositionCatalog(active.composition).pipe(Effect.mapError(preflightUnavailable)),
          database.executor
            .transaction((transaction) =>
              installOperationalScope(transaction, input.scope, enrollment).pipe(
                Effect.flatMap((scoped) => loadProposalCommandSnapshot(scoped, input.scope, payload)),
              ),
            )
            .pipe(recoverSqlTransactionError, Effect.mapError(preflightUnavailable)),
        ],
        { concurrency: 2 },
      );
      let lifecycle: PreparedAccessDecision | undefined;
      if (payload.operation === 'withdraw-pending-of-agent') {
        lifecycle = yield* lifecycleAuthority
          .prepare(lifecycleQuestionOf(input.scope, DateTime.toDateUtc(yield* DateTime.now)))
          .pipe(Effect.mapError(preflightUnavailable));
        if (input.scope.legalEntityId === undefined || !(yield* lifecycleAnswerOf(lifecycle.decision))) {
          return { outcome: 'denied' as const };
        }
      } else {
        const resolution = resolveActions(targetsOf(payload, snapshot), active, catalog);
        if (Option.isNone(resolution)) {
          return { outcome: 'denied' as const };
        }
        const actions = [...new Set(resolution.value)];
        // One gate question per proposed Action in the acting request's own scope (O66): `insert` needs
        // the Action's own propose answer, every other operation its execute answer. The Action's answer is
        // its module's: no retired `module_access` relation is asked beside it.
        const permissions = yield* authority
          .checkActionAuthorities({ actionKeys: actions, scope: input.scope })
          .pipe(Effect.mapError(preflightUnavailable));
        if (
          permissions.length !== actions.length ||
          permissions.some(
            (decision) => (payload.operation === 'insert' ? decision.propose : decision.execute) !== 'allowed',
          )
        ) {
          return { outcome: 'denied' as const };
        }
        if (payload.operation === 'claim-approval') {
          // The same question asked of the proposer: the recorded proposal is only claimable when its
          // proposer could still propose it, decided in the proposer's own identity within this tenant.
          const proposer = yield* authority
            .checkActionAuthorities({
              actionKeys: actions,
              scope: { ...input.scope, principalId: snapshot.proposer.principalId },
            })
            .pipe(Effect.mapError(preflightUnavailable));
          if (proposer.length !== actions.length || proposer.some((decision) => decision.propose !== 'allowed')) {
            return { outcome: 'denied' as const };
          }
        }
      }
      const now = yield* Clock.currentTimeMillis;
      const inserted = yield* Ref.modify(prepared, (entries) => {
        const live = new Map([...entries].filter(([, entry]) => entry.expiresAt > now));
        if (live.size >= 1024 && !live.has(input.actionInvocationId)) {
          return [false, live] as const;
        }
        const entry: PreparedCommand = {
          compositionRevision: active.composition.revision,
          expiresAt: now + 120_000,
          payloadHash: computeCanonicalValueHash(payload),
          scopeHash: computeCanonicalValueHash(input.scope),
          snapshot,
        };
        live.set(input.actionInvocationId, lifecycle === undefined ? entry : { ...entry, lifecycle });
        return [true, live] as const;
      });
      if (!inserted) {
        return yield* preflightUnavailable('Proposal preparation capacity is exhausted');
      }
      return { outcome: 'not_applicable' as const };
    });
    return {
      consume: Effect.fn('AgentProposalCommand.consumePreparation')(function* consume(input) {
        const now = yield* Clock.currentTimeMillis;
        const proof = yield* Ref.modify(prepared, (entries) => {
          const entry = entries.get(input.actionInvocationId);
          const next = new Map(entries);
          next.delete(input.actionInvocationId);
          return [entry, next] as const;
        });
        if (
          proof === undefined ||
          proof.expiresAt <= now ||
          proof.compositionRevision !== input.compositionRevision ||
          proof.payloadHash !== computeCanonicalValueHash(input.payload) ||
          proof.scopeHash !== computeCanonicalValueHash(input.scope)
        ) {
          return yield* proposalCommandUnavailable('An exact native invocation preparation is required');
        }
        if (proof.lifecycle !== undefined) {
          // Re-asked from this transaction's snapshot under the authority fence: a revoked right is refused here.
          const current = yield* lifecycleAuthority
            .recheck(proof.lifecycle, DateTime.toDateUtc(yield* DateTime.now), input.transaction)
            .pipe(Effect.mapError(proposalCommandUnavailable));
          if (current.outcome !== 'ALLOWED') {
            return yield* proposalCommandUnavailable('Agent administration authority is no longer current');
          }
        }
        return proof.snapshot;
      }),
      prepare,
    } satisfies PreparationService;
  }),
);

/** Compose this native preflight with any existing owner preflight at the runtime root. */
export const AgentProposalCommandAuthorizationPreflightLive = Layer.effect(
  ActionAuthorizationPreflight,
  Effect.gen(function* proposalAuthorizationPreflight() {
    return { prepare: (yield* AgentProposalCommandPreparation).prepare };
  }),
);
