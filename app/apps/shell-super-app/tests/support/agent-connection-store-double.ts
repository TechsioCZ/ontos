import { AgentConnectionStore } from '@app/core-runtime/access/intent/agent-connections';
import { AccessPeopleCommands } from '@app/core-runtime/access/lifecycle/people-service';
import type {
  AgentConnectionLiveFacts,
  AgentConnectionStoreService,
  OperableAgent,
} from '@app/core-runtime/access/intent/agent-connections';
import { Effect, Layer, Option } from 'effect';

/** What the double answers, and what it was asked to end; the suites assert on `revoked`. */
export interface AgentConnectionStoreDouble {
  readonly layer: Layer.Layer<AgentConnectionStore>;
  readonly revoked: string[];
  readonly service: AgentConnectionStoreService;
}

/** An in-memory store: no agent is operable and no connection exists unless a suite says so. */
export const agentConnectionStoreDouble = (
  options: {
    readonly liveFacts?: AgentConnectionLiveFacts;
    readonly operable?: readonly OperableAgent[];
  } = {},
): AgentConnectionStoreDouble => {
  const revoked: string[] = [];
  const service: AgentConnectionStoreService = {
    liveFacts: () =>
      Effect.succeed(
        options.liveFacts ?? {
          agentInCompany: false,
          connection: Option.none(),
          operatorHolds: false,
          writePolicy: 'read_only',
        },
      ),
    open: () => Effect.die('the double opens no connection'),
    operableAgents: () => Effect.succeed(options.operable ?? []),
    read: () => Effect.succeed(Option.none()),
    revoke: (_scope, connectionId) =>
      Effect.sync(() => {
        revoked.push(connectionId);
      }),
  };
  return { layer: Layer.succeed(AgentConnectionStore, service), revoked, service };
};

const unused = (name: string) => () => Effect.die(`${name} is not asked in this suite`);

/** The People commands a suite never reaches: an agent consent with no operable agent reads no role. */
export const unusedPeopleCommandsLayer = Layer.succeed(AccessPeopleCommands, {
  admitMember: unused('admitMember'),
  assignRole: unused('assignRole'),
  endMembership: unused('endMembership'),
  grantDelegation: unused('grantDelegation'),
  read: unused('read'),
  readCatalog: unused('readCatalog'),
  reconcile: unused('reconcile'),
  revokeDelegation: unused('revokeDelegation'),
  setTeamMembership: unused('setTeamMembership'),
  transferOwnership: unused('transferOwnership'),
  unassignRole: unused('unassignRole'),
});
