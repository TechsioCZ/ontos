/**
 * What an operator may connect "Za agenta" (design §3.3): the agents that name the session person as an operator in
 * the session's company, each with what it can actually use of its roles there. Before a connection exists the gate
 * cannot decide the agent (it decides an agent only on its credential-bound connection), so the offer is read from
 * intent with the engine's own agent rule (`agentUsableCapabilities`), narrowed to the operator's own live rights (the
 * engine decides an agent on both sides) and to the administrator's write policy for the agent. Once connected, every
 * request is decided by the gate as the agent; nothing here admits anything.
 */
import type { OperationalScope } from '@app/core-runtime';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { AgentConnectionStore } from '@app/core-runtime/access/intent/agent-connections';
import type { OperableAgent } from '@app/core-runtime/access/intent/agent-connections';
import { agentRoleCells, agentUsableCapabilities } from '@app/core-runtime/access/lifecycle/agent-authority';
import { AccessPeopleCommands } from '@app/core-runtime/access/lifecycle/people-service';
import type { CatalogSnapshotEntry, Cell } from '@app/core-runtime/access/lifecycle/agent-authority';
import type { ConnectionWritePolicy } from '@app/shared-contracts/oauth-connections';
import { Effect, Option, Schema } from 'effect';

import { minWritePolicy, offeredModules } from './effective-authority.ts';
import type { LiveRights, ModuleLabelOf } from './effective-authority.ts';
import { ConnectionUnavailable } from './errors.ts';

const toUnavailable = (cause: unknown): ConnectionUnavailable =>
  Schema.is(Schema.instanceOf(ConnectionUnavailable))(cause) ? cause : new ConnectionUnavailable({ cause });

const READ_KINDS: ReadonlySet<CatalogSnapshotEntry['kind']> = new Set(['export', 'field_read', 'read']);

/** The operator's own authority in the company, as `loadActingAuthority` reads it for a person. */
export interface OperatorAuthority {
  readonly labelOf: ModuleLabelOf;
  readonly live: LiveRights;
}

export interface AgentConsentAuthority {
  readonly agent: OperableAgent;
  /** The release the agent's cells are read against; the consent ceiling is built from both. */
  readonly catalog: readonly CatalogSnapshotEntry[];
  readonly cells: readonly Cell[];
  readonly labelOf: ModuleLabelOf;
  readonly live: LiveRights;
  readonly offered: ReturnType<typeof offeredModules>;
  readonly policyCap: ConnectionWritePolicy;
}

/** The agents the session person operates in the session's company. */
export const operableAgents = Effect.fn('AgentConsent.operableAgents')(function* operableAgents(
  scope: OperationalScope,
) {
  return yield* (yield* AgentConnectionStore).operableAgents(scope).pipe(Effect.mapError(toUnavailable));
});

/**
 * One operable agent's offer: the modules where its roles give it something an agent can use, and where the operator
 * holds that kind of access too; written to only where it may write or propose, never beyond its write policy.
 */
export const agentConsentAuthority = Effect.fn('AgentConsent.authority')(function* agentConsentAuthority(
  scope: OperationalScope,
  agent: OperableAgent,
  operator: OperatorAuthority,
) {
  const commands = yield* AccessPeopleCommands;
  const [view, catalog] = yield* Effect.all([commands.read(scope), commands.readCatalog(scope)], {
    concurrency: 1,
  }).pipe(Effect.mapError(toUnavailable));
  const company = Option.fromUndefinedOr(
    view.scopes.find(
      (candidate) =>
        scope.legalEntityId !== undefined && candidate.legalEntityId === LegalEntityIdSchema.make(scope.legalEntityId),
    ),
  );
  const cells = Option.match(company, {
    onNone: () => [],
    onSome: ({ scopeId }) =>
      agentRoleCells({
        agentId: agent.agentId,
        assignments: view.assignments,
        at: view.at,
        roles: view.roles,
        scopeId,
      }),
  });
  const usable = agentUsableCapabilities(cells, catalog);
  const read = new Set<string>();
  const direct = new Set<string>();
  const proposed = new Set<string>();
  for (const { entry, use } of usable) {
    read.add(entry.moduleKey);
    if (!READ_KINDS.has(entry.kind)) {
      (use === 'direct' ? direct : proposed).add(entry.moduleKey);
    }
  }
  const live: LiveRights = {
    read: new Set([...read].filter((moduleId) => operator.live.read.has(moduleId))),
    write: new Set([...direct, ...proposed].filter((moduleId) => operator.live.write.has(moduleId))),
  };
  // A module the agent may only propose to cannot take a direct write, so while one exists the ceiling is approval.
  const proposeOnly = [...live.write].some((moduleId) => !direct.has(moduleId));
  const policyCap = minWritePolicy(proposeOnly ? 'approval' : 'direct', agent.writePolicy);
  return {
    agent,
    catalog,
    cells,
    labelOf: operator.labelOf,
    live,
    offered: offeredModules(live, policyCap, operator.labelOf),
    policyCap,
  } satisfies AgentConsentAuthority;
});
