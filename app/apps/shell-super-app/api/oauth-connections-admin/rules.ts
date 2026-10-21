/**
 * Pure rules of "Připojené aplikace" management: what a connection may be narrowed to, how the admin list is
 * filtered, and the company tiles and filter choices. No Effect, no storage.
 */
import type {
  AgentWritePolicy,
  ConnectionAdminFilter,
  ConnectionAdminListResponse,
  ConnectionSummary,
  ConnectionUpdateRequest,
} from '@app/shared-contracts/agent-access';

/** Weakest to strongest. */
export const WRITE_POLICY_ORDER: readonly AgentWritePolicy[] = ['read_only', 'approval', 'direct'];

export const policyRank = (policy: AgentWritePolicy): number => WRITE_POLICY_ORDER.indexOf(policy);

export const writePolicyLabel: Readonly<Record<AgentWritePolicy, string>> = {
  approval: 'Ke schválení',
  direct: 'Přímo',
  read_only: 'Jen čtení',
};

/** Czech answer to an attempted widening. */
export const WIDEN_HINT = 'Přístup můžete jen zúžit. Pro větší přístup aplikaci odpojte a připojte znovu.';

/**
 * First problem with a requested change, as a Czech message; undefined when the update is allowed. An update may
 * only NARROW: it must stay within what the connection was approved for (`granted`, design §7.2 "only narrow, no
 * re-auth") and within the acting principal's live rights (`limits`).
 */
export const wideningProblem = (
  request: Pick<ConnectionUpdateRequest, 'allModules' | 'modules' | 'writePolicy'>,
  connection: Pick<ConnectionSummary, 'allModules' | 'granted' | 'limits'>,
): string | undefined => {
  const { granted, limits } = connection;
  if (request.allModules && request.modules.length > 0) {
    return 'Při volbě „Vše“ nevybírejte jednotlivé moduly.';
  }
  if (!request.allModules && request.modules.length === 0) {
    return 'Vyberte alespoň jeden modul.';
  }
  const moduleIds = request.modules.map((module) => module.moduleId);
  if (new Set(moduleIds).size !== moduleIds.length) {
    return 'Každý modul vyberte jen jednou.';
  }
  if (request.allModules && !connection.allModules) {
    return WIDEN_HINT;
  }
  for (const module of request.modules) {
    const limit = limits.modules.find((item) => item.moduleId === module.moduleId);
    if (limit === undefined || !limit.read) {
      return `Modul ${limit?.label ?? module.moduleId} nemáte k dispozici.`;
    }
    if (module.access === 'write' && !limit.write) {
      return `Do modulu ${limit.label} nesmíte zapisovat.`;
    }
    if (!connection.allModules) {
      const approved = granted.modules.find((item) => item.moduleId === module.moduleId);
      if (approved === undefined || (module.access === 'write' && approved.access !== 'write')) {
        return WIDEN_HINT;
      }
    }
  }
  if (policyRank(request.writePolicy) > policyRank(granted.writePolicy)) {
    return WIDEN_HINT;
  }
  if (policyRank(request.writePolicy) > policyRank(limits.maxWritePolicy)) {
    return `Nejvýš můžete zvolit režim „${writePolicyLabel[limits.maxWritePolicy]}“.`;
  }
  return undefined;
};

/** Every DEFINED filter field must match; undefined fields are ignored. */
export const matchesAdminFilter = (connection: ConnectionSummary, filter: ConnectionAdminFilter): boolean =>
  (filter.userPrincipalId === undefined || connection.user.principalId === filter.userPrincipalId) &&
  (filter.actingPrincipalId === undefined || connection.acting.principalId === filter.actingPrincipalId) &&
  (filter.clientId === undefined || connection.client.clientId === filter.clientId) &&
  (filter.status === undefined || connection.status === filter.status);

/** Tiles over ACTIVE connections only. */
export const adminStats = (connections: readonly ConnectionSummary[]): ConnectionAdminListResponse['stats'] => {
  const active = connections.filter((connection) => connection.status === 'active');
  return {
    active: active.length,
    agentsConnected: new Set(
      active
        .filter((connection) => connection.acting.kind === 'agent')
        .map((connection) => connection.acting.principalId),
    ).size,
    directWrite: active.filter((connection) => connection.writePolicy === 'direct').length,
  };
};

const distinctBy = <T>(items: readonly T[], key: (item: T) => string): T[] => {
  const seen = new Map<string, T>();
  for (const item of items) {
    if (!seen.has(key(item))) {
      seen.set(key(item), item);
    }
  }
  return [...seen.values()];
};

/** Filter choices from every connection of the company, each list sorted in Czech collation. */
export const adminFilterOptions = (
  connections: readonly ConnectionSummary[],
): ConnectionAdminListResponse['filterOptions'] => {
  const people = distinctBy(
    connections.map((connection) => ({
      displayName: connection.user.displayName,
      principalId: connection.user.principalId,
    })),
    (person) => person.principalId,
  ).sort((a, b) => a.displayName.localeCompare(b.displayName, 'cs'));
  const agents = distinctBy(
    connections
      .filter((connection) => connection.acting.kind === 'agent')
      .map((connection) => ({
        displayName: connection.acting.displayName,
        principalId: connection.acting.principalId,
      })),
    (agent) => agent.principalId,
  ).sort((a, b) => a.displayName.localeCompare(b.displayName, 'cs'));
  const clients = distinctBy(
    connections.map((connection) => ({ clientId: connection.client.clientId, name: connection.client.name })),
    (client) => client.clientId,
  ).sort((a, b) => a.name.localeCompare(b.name, 'cs'));
  return { agents, clients, people };
};

/** Keeps the first occurrence of every id, in order. */
export const uniqueIds = (ids: readonly string[]): readonly string[] => [...new Set(ids)];
