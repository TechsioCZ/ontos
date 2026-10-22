// Agent profiles, pure part (lane agent-entities). No database imports; the DB side lives in agent-store.ts.
// Seeded AI principals and their profiles are demo seed data (demo-seed/agent-profiles.ts, matching
// scripts/demo/ai-profiles.mts); administrator edits are audit evidence.
// Profiles also carry the administrator's description and the responsible person (owner).
import { AgentModuleGrantSchema, AgentWritePolicySchema } from '@app/shared-contracts/agent-access';
import type { AgentModuleGrant, AgentWritePolicy } from '@app/shared-contracts/agent-access';
import { Option, Schema } from 'effect';

import { seededAgentProfiles } from './demo-seed/agent-profiles.ts';

export interface AgentProfile {
  readonly description: string | null;
  readonly modules: readonly AgentModuleGrant[];
  readonly ownerPrincipalId: string | null;
  readonly seeded: boolean;
  readonly writePolicy: AgentWritePolicy;
}

export const DEFAULT_AGENT_PROFILE: AgentProfile = {
  description: null,
  modules: [],
  ownerPrincipalId: null,
  seeded: false,
  writePolicy: 'read_only',
};

const ModulesJson = Schema.fromJsonString(Schema.Array(AgentModuleGrantSchema));

const seeds = new Map(Object.entries(seededAgentProfiles));

const seedOf = (principalId: string): AgentProfile | undefined => {
  const seed = seeds.get(principalId);
  return seed === undefined
    ? undefined
    : { description: null, modules: seed.modules, ownerPrincipalId: null, seeded: true, writePolicy: seed.writePolicy };
};

/**
 * Folds administrator evidence (`core.identity.manage-demo-account` create/configure rows, oldest first) over the
 * seeded profiles. Rows with an invalid policy or module list are ignored; later valid rows win.
 */
export const foldAgentProfiles = (
  principalIds: readonly string[],
  evidenceOldestFirst: readonly Readonly<Record<string, unknown>>[],
): ReadonlyMap<string, AgentProfile> => {
  const wanted = new Set(principalIds);
  const profiles = new Map<string, AgentProfile>(
    principalIds.map((principalId) => [principalId, seedOf(principalId) ?? DEFAULT_AGENT_PROFILE]),
  );
  for (const evidence of evidenceOldestFirst) {
    const target = evidence['targetPrincipalId'];
    if (typeof target !== 'string' || !wanted.has(target)) {
      continue;
    }
    const operation = evidence['operation'];
    if (operation !== 'create-agent' && operation !== 'configure-agent') {
      continue;
    }
    const writePolicy = Schema.decodeUnknownOption(AgentWritePolicySchema)(evidence['writePolicy']);
    const modules = Schema.decodeUnknownOption(ModulesJson)(evidence['modulesJson']);
    if (Option.isSome(writePolicy) && Option.isSome(modules)) {
      const description = typeof evidence['description'] === 'string' ? evidence['description'] : null;
      const ownerPrincipalId = typeof evidence['ownerPrincipalId'] === 'string' ? evidence['ownerPrincipalId'] : null;
      profiles.set(target, {
        description,
        modules: modules.value,
        ownerPrincipalId,
        seeded: false,
        writePolicy: writePolicy.value,
      });
    }
  }
  return profiles;
};
