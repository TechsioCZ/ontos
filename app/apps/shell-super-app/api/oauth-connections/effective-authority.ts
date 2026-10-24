// Effective authority for an agent connection pure module: no database or SpiceDB imports.
import type { AgentModuleGrant } from '@app/shared-contracts/agent-access';
import type {
  ConnectionModule,
  ConnectionModulesRequest,
  ConnectionWritePolicy,
} from '@app/shared-contracts/oauth-connections';

export const WRITE_POLICY_RANK: Readonly<Record<ConnectionWritePolicy, number>> = {
  approval: 1,
  direct: 2,
  read_only: 0,
};
export const minWritePolicy = (a: ConnectionWritePolicy, b: ConnectionWritePolicy): ConnectionWritePolicy =>
  WRITE_POLICY_RANK[a] <= WRITE_POLICY_RANK[b] ? a : b;
export const isPolicyWithin = (requested: ConnectionWritePolicy, cap: ConnectionWritePolicy): boolean =>
  WRITE_POLICY_RANK[requested] <= WRITE_POLICY_RANK[cap];

/** Module keys the acting principal may open (`read`) and change or propose (`write`) right now. */
export interface LiveRights {
  readonly read: ReadonlySet<string>;
  readonly write: ReadonlySet<string>;
}

export interface EffectiveAuthority {
  readonly modules: readonly ConnectionModule[];
  readonly writePolicy: ConnectionWritePolicy;
}

/** Czech label of a module key, from the composed modules' own contributions. */
export type ModuleLabelOf = (moduleId: string) => string;

export const effectiveAuthority = (input: {
  readonly labelOf: ModuleLabelOf;
  readonly live: LiveRights;
  readonly policyCap: ConnectionWritePolicy;
  readonly requested: ConnectionModulesRequest;
  readonly requestedPolicy: ConnectionWritePolicy;
}): EffectiveAuthority => {
  const writePolicy = minWritePolicy(input.requestedPolicy, input.policyCap);
  const canWrite = writePolicy !== 'read_only';
  const { live, requested } = input;
  const entries =
    requested === 'all'
      ? [...live.read].map((moduleId) => ({ moduleId, write: canWrite && live.write.has(moduleId) }))
      : requested
          .filter((grant) => live.read.has(grant.moduleId))
          .map((grant) => ({
            moduleId: grant.moduleId,
            write: canWrite && grant.access === 'write' && live.write.has(grant.moduleId),
          }));
  const seen = new Set<string>();
  const modules = entries
    .filter((entry) => {
      if (seen.has(entry.moduleId)) {
        return false;
      }
      seen.add(entry.moduleId);
      return true;
    })
    .map((entry) => ({
      label: input.labelOf(entry.moduleId),
      moduleId: entry.moduleId,
      read: true,
      write: entry.write,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'cs'));
  return { modules, writePolicy };
};

export const offeredModules = (
  live: LiveRights,
  policyCap: ConnectionWritePolicy,
  labelOf: ModuleLabelOf,
): readonly ConnectionModule[] =>
  effectiveAuthority({ labelOf, live, policyCap, requested: 'all', requestedPolicy: policyCap }).modules;

export const isModulesRequestWithin = (
  requested: ConnectionModulesRequest,
  offered: readonly ConnectionModule[],
): boolean =>
  requested === 'all' ||
  (requested.length > 0 &&
    requested.every((grant) => {
      const module = offered.find((entry) => entry.moduleId === grant.moduleId);
      return module !== undefined && (grant.access === 'read' || module.write);
    }));

export const contextModulesOf = (modules: readonly ConnectionModule[]): readonly AgentModuleGrant[] =>
  modules.map((module) => ({ access: module.write ? 'write' : 'read', moduleId: module.moduleId }));
