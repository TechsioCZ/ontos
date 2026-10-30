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
export const WRITE_POLICY_ORDER = ['read_only', 'approval', 'direct'] satisfies readonly AgentWritePolicy[];

export const policyRank = (policy: AgentWritePolicy): number => WRITE_POLICY_ORDER.indexOf(policy);

export const writePolicyLabel = {
  approval: 'Ke schválení',
  direct: 'Přímo',
  read_only: 'Jen čtení',
} satisfies Readonly<Record<AgentWritePolicy, string>>;

/** Czech answer to an attempted widening. */
export const WIDEN_HINT = 'Přístup můžete jen zúžit. Pro větší přístup aplikaci odpojte a připojte znovu.';

const moduleSelectionProblem = (
  request: Pick<ConnectionUpdateRequest, 'allModules' | 'modules'>,
): string | undefined => {
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
  return undefined;
};

const firstModuleEntries = <Entry extends { readonly moduleId: string }>(
  entries: readonly Entry[],
): ReadonlyMap<string, Entry> => {
  const first = new Map<string, Entry>();
  for (const entry of entries) {
    if (!first.has(entry.moduleId)) {
      first.set(entry.moduleId, entry);
    }
  }
  return first;
};

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
  const selectionProblem = moduleSelectionProblem(request);
  if (selectionProblem !== undefined) {
    return selectionProblem;
  }
  if (request.allModules && !connection.allModules) {
    return WIDEN_HINT;
  }
  const limitsByModule = firstModuleEntries(limits.modules);
  const grantsByModule = firstModuleEntries(granted.modules);
  for (const module of request.modules) {
    const limit = limitsByModule.get(module.moduleId);
    if (limit === undefined || !limit.read) {
      return `Modul ${limit?.label ?? module.moduleId} nemáte k dispozici.`;
    }
    if (module.access === 'write' && !limit.write) {
      return `Do modulu ${limit.label} nesmíte zapisovat.`;
    }
    if (!connection.allModules) {
      const approved = grantsByModule.get(module.moduleId);
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
      active.flatMap((connection) => (connection.acting.kind === 'agent' ? [connection.acting.principalId] : [])),
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
  ).toSorted((a, b) => a.displayName.localeCompare(b.displayName, 'cs'));
  const agents = distinctBy(
    connections.flatMap((connection) =>
      connection.acting.kind === 'agent'
        ? [
            {
              displayName: connection.acting.displayName,
              principalId: connection.acting.principalId,
            },
          ]
        : [],
    ),
    (agent) => agent.principalId,
  ).toSorted((a, b) => a.displayName.localeCompare(b.displayName, 'cs'));
  const clients = distinctBy(
    connections.map((connection) => ({ clientId: connection.client.clientId, name: connection.client.name })),
    (client) => client.clientId,
  ).toSorted((a, b) => a.name.localeCompare(b.name, 'cs'));
  return { agents, clients, people };
};

/** Keeps the first occurrence of every id, in order. */
export const uniqueIds = (ids: readonly string[]): readonly string[] => [...new Set(ids)];
