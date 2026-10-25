import { Clock, Context, Effect, Layer, Match, Option, Predicate, Ref, Schema } from 'effect';

import { ActionPermissionCheckError } from '../actions/errors.ts';
import { computeCanonicalValueHash, recoverSqlTransactionError } from '../actions/repository.ts';
import { CoreDatabase } from '../db/client.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '../modules/active-application-composition.ts';
import { buildApplicationCompositionCatalog } from '../modules/application-composition-catalog.ts';
import type { OperationalScope } from '../operations/context.ts';
import { ActionAuthority } from '../permissions/action-authority.ts';
import { ContextAccess } from '../permissions/context-access.ts';
import { ActionAuthorizationPreflight } from '../permissions/action-authorization-preflight.ts';
import type {
  ActionAuthorizationPreflightInput,
  ActionAuthorizationPreflightService,
} from '../permissions/action-authorization-preflight.ts';
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
/** Live native administration authority, not module execution or a caller-supplied capability. */
export const proposalLifecycleAdministrator = Effect.fn('AgentProposalCommand.lifecycleAdministrator')(
  function* administrator(
    scope: Pick<OperationalScope, 'tenantId' | 'legalEntityId' | 'principalId'>,
    access: typeof ContextAccess.Service,
  ) {
    const { legalEntityId, principalId, tenantId } = scope;
    if (legalEntityId === undefined) {
      return false;
    }
    const [tenant, company] = yield* Effect.all(
      [
        access.tenants({ permission: 'manage_identity', principalId, tenantIds: [tenantId] }),
        access.legalEntities({ legalEntityIds: [legalEntityId], permission: 'manage_people', principalId, tenantId }),
      ],
      { concurrency: 2 },
    );
    const decisions = [
      ...tenant.filter(({ key }) => key === tenantId),
      ...company.filter(({ key }) => key === legalEntityId),
    ];
    if (decisions.some(({ decision }) => decision === 'allowed')) {
      return true;
    }
    if (decisions.some(({ decision }) => decision === 'unavailable')) {
      return yield* preflightUnavailable('Administrator authorization is unavailable');
    }
    return false;
  },
);

const humanOnlyCommands = new Set(['AiDecideChanges', 'AiRevertBatch']);
export const isProposableCommand = (actionSlug: string, command: Readonly<Record<string, Schema.Json>>) =>
  actionSlug === 'apply-command'
    ? Match.value(command['_tag']).pipe(
        Match.when(Match.nonEmptyString, (tag) => !humanOnlyCommands.has(tag)),
        Match.orElse(() => false),
      )
    : Predicate.isUndefined(command['_tag']);

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
  const resolved: { readonly actionKey: string; readonly moduleKey: string }[] = [];
  for (const target of targets) {
    const release = releases.get(target.appId);
    const contract = contracts.get(release?.moduleId ?? '');
    if (
      release?.moduleId !== target.moduleKey ||
      contract?.manifest.publicSurface.mcp?.approvals !== true ||
      !isProposableCommand(target.actionSlug, target.command)
    ) {
      return Option.none<readonly { readonly actionKey: string; readonly moduleKey: string }[]>();
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
      return Option.none<readonly { readonly actionKey: string; readonly moduleKey: string }[]>();
    }
    resolved.push({ actionKey: action.actionKey, moduleKey: target.moduleKey });
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
    const composition = yield* ActiveApplicationCompositionService;
    const authority = yield* ActionAuthority;
    const contextAccess = yield* ContextAccess;
    const prepared = yield* Ref.make<ReadonlyMap<string, PreparedCommand>>(new Map());
    const modulesAllowed = Effect.fn('AgentProposalCommand.modulesAllowed')(function* modulesAllowed(
      target: Parameters<(typeof ContextAccess)['Service']['modules']>[0],
    ) {
      const decisions = yield* contextAccess.modules(target);
      if (decisions.some((decision) => decision.decision === 'unavailable')) {
        return yield* preflightUnavailable('Module authorization is unavailable');
      }
      const allowed = new Set(decisions.flatMap((decision) => (decision.decision === 'allowed' ? [decision.key] : [])));
      return (
        decisions.length === target.moduleIds.length && target.moduleIds.every((moduleId) => allowed.has(moduleId))
      );
    });
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
              installOperationalScope(transaction, input.scope).pipe(
                Effect.flatMap((scoped) => loadProposalCommandSnapshot(scoped, input.scope, payload)),
              ),
            )
            .pipe(recoverSqlTransactionError, Effect.mapError(preflightUnavailable)),
        ],
        { concurrency: 2 },
      );
      if (payload.operation === 'withdraw-pending-of-agent') {
        if (!(yield* proposalLifecycleAdministrator(input.scope, contextAccess))) {
          return { outcome: 'denied' as const };
        }
      } else {
        const resolution = resolveActions(targetsOf(payload, snapshot), active, catalog);
        if (Option.isNone(resolution)) {
          return { outcome: 'denied' as const };
        }
        const resolved = resolution.value;
        const { legalEntityId, principalId, tenantId } = input.scope;
        const moduleIds = [...new Set(resolved.map((target) => target.moduleKey))];
        if (!(yield* modulesAllowed({ legalEntityId, moduleIds, principalId, tenantId }))) {
          return { outcome: 'denied' as const };
        }
        const actions = [...new Set(resolved.map((target) => target.actionKey))];
        const permissions = yield* authority
          .checkActionAuthorities(actions.map((actionKey) => ({ actionKey, legalEntityId, principalId, tenantId })))
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
          if (
            !(yield* modulesAllowed({ legalEntityId, moduleIds, principalId: snapshot.proposer.principalId, tenantId }))
          ) {
            return { outcome: 'denied' as const };
          }
          const proposer = yield* authority
            .checkActionAuthorities(
              actions.map((actionKey) => ({
                actionKey,
                legalEntityId,
                principalId: snapshot.proposer.principalId,
                tenantId,
              })),
            )
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
        live.set(input.actionInvocationId, {
          compositionRevision: active.composition.revision,
          expiresAt: now + 120_000,
          payloadHash: computeCanonicalValueHash(payload),
          scopeHash: computeCanonicalValueHash(input.scope),
          snapshot,
        });
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
