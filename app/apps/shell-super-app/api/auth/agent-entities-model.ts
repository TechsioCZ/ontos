// Agent entities, pure part (lane agent-entities): the module choices and role presets the Agents page offers. No
// database or Effect imports.
import type {
  AgentModuleAccess,
  AgentModuleGrant,
  AgentModuleOption,
  AgentRolePreset,
} from '@app/shared-contracts/agent-access';
import { AgentModuleKeySchema } from '@app/shared-contracts/agent-proposals';

/** One capability of the tenant's published release, as much of it as the agent catalogue reads. */
export interface AgentCatalogCapability {
  readonly key: string;
  readonly kind: string;
  readonly moduleKey: string;
}

/** One v2 role of the tenant with the capability keys its current revision pins. */
export interface AgentCatalogRole {
  readonly capabilityKeys: readonly string[];
  readonly id: string;
  /** Set for a company-local role, which is offered only in its own company. */
  readonly legalEntityId: string | null;
  readonly name: string;
}

/**
 * What an agent could use of one capability kind: reading, writing, or nothing. Administration is never an agent's,
 * so an `admin` capability adds no module access.
 */
const AGENT_ACCESS_BY_KIND: ReadonlyMap<string, AgentModuleAccess> = new Map([
  ['action', 'write'],
  ['export', 'read'],
  ['field_read', 'read'],
  ['field_write', 'write'],
  ['read', 'read'],
]);

/** Module access per module, the highest any of these capabilities gives, only in the modules offered. */
const moduleAccessOf = (
  capabilities: readonly AgentCatalogCapability[],
  offered: ReadonlySet<string>,
): readonly AgentModuleGrant[] => {
  const access = new Map<string, AgentModuleAccess>();
  for (const capability of capabilities) {
    const granted = AGENT_ACCESS_BY_KIND.get(capability.kind);
    if (granted !== undefined && offered.has(capability.moduleKey) && access.get(capability.moduleKey) !== 'write') {
      access.set(capability.moduleKey, granted);
    }
  }
  return [...access]
    .map(([moduleId, moduleAccess]) => ({ access: moduleAccess, moduleId: AgentModuleKeySchema.make(moduleId) }))
    .toSorted((left, right) => left.moduleId.localeCompare(right.moduleId));
};

/** Module choices for agents of a company: highest access the release offers, sorted by Czech label. */
export const agentModuleOptions = (
  access: readonly AgentModuleGrant[],
  labelOf: (moduleId: string) => string,
): readonly AgentModuleOption[] =>
  access
    .map(({ access: maxAccess, moduleId }) => ({ label: labelOf(moduleId), maxAccess, moduleId }))
    .toSorted((left, right) => left.label.localeCompare(right.label, 'cs'));

/** The module choices and role presets the Agents page offers. */
export interface AgentCatalog {
  readonly options: readonly AgentModuleOption[];
  readonly presets: readonly AgentRolePreset[];
}

/**
 * The Agents page catalogue from the tenant's v2 intent: the modules an agent of this company could be offered (active
 * in the tenant, composed in the release, with at least one capability an agent could use) and the company's roles as
 * module presets (tenant-wide roles and this company's own, in name order).
 */
export const agentCatalogOf = (input: {
  readonly activeModuleKeys: readonly string[];
  readonly capabilities: readonly AgentCatalogCapability[];
  readonly composedModuleKeys: readonly string[];
  readonly labelOf: (moduleId: string) => string;
  readonly legalEntityId: string;
  readonly roles: readonly AgentCatalogRole[];
}): AgentCatalog => {
  const composed = new Set(input.composedModuleKeys);
  const offered = new Set(input.activeModuleKeys.filter((moduleKey) => composed.has(moduleKey)));
  const byKey = new Map(input.capabilities.map((capability) => [capability.key, capability] as const));
  const presets = input.roles
    .filter((role) => role.legalEntityId === null || role.legalEntityId === input.legalEntityId)
    .toSorted((left, right) => left.name.localeCompare(right.name, 'cs') || left.id.localeCompare(right.id))
    .map((role): AgentRolePreset => ({
      key: role.id,
      label: role.name,
      modules: moduleAccessOf(
        role.capabilityKeys.flatMap((key) => {
          const capability = byKey.get(key);
          return capability === undefined ? [] : [capability];
        }),
        offered,
      ),
    }));
  return { options: agentModuleOptions(moduleAccessOf(input.capabilities, offered), input.labelOf), presets };
};
