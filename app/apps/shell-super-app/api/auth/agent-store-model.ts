// Agent profiles, pure part (lane agent-entities). No database imports; the DB side lives in agent-store.ts.
// Seeded AI principals match scripts/demo/ai-profiles.mts; administrator edits are audit evidence.
import { AgentModuleGrantSchema, AgentWritePolicySchema } from '@app/shared-contracts/agent-access';
import type { AgentModuleGrant, AgentWritePolicy } from '@app/shared-contracts/agent-access';
import { Option, Schema } from 'effect';

export interface AgentProfile {
  readonly modules: readonly AgentModuleGrant[];
  readonly seeded: boolean;
  readonly writePolicy: AgentWritePolicy;
}

export const DEFAULT_AGENT_PROFILE: AgentProfile = { modules: [], seeded: false, writePolicy: 'read_only' };

const OBCHOD = '71000000-0000-4000-8000-000000000020';
const HANAK = '71000000-0000-4000-8000-000000000022';

const obchodReads = [
  'commerce.customer-context',
  'demo.merchandise',
  'demo.sales-insights',
  'demo.sales-pipeline',
  'demo.tagging',
  'demo.workforce',
  'party.registry',
  'finance.billing',
  'work.tasks',
];
const hanakReads = ['demo.crm', 'demo.tagging', 'demo.workforce', 'party.registry', 'work.tasks'];

const withWrites = (reads: readonly string[], writes: readonly string[]): readonly AgentModuleGrant[] =>
  reads.map((moduleId) => ({ access: writes.includes(moduleId) ? 'write' : 'read', moduleId }));

export const seededAgentProfiles: Readonly<
  Record<
    string,
    {
      readonly legalEntityId: string;
      readonly modules: readonly AgentModuleGrant[];
      readonly writePolicy: AgentWritePolicy;
    }
  >
> = {
  // ai-agent-a-obchod
  '35b748a0-d93a-520e-bd52-91433c8d15b8': {
    legalEntityId: OBCHOD,
    modules: withWrites(obchodReads, []),
    writePolicy: 'read_only',
  },
  // ai-agent-b-obchod
  'e931e0fd-adba-56fd-9e17-e5f3adb3efa0': {
    legalEntityId: OBCHOD,
    modules: withWrites(obchodReads, ['work.tasks']),
    writePolicy: 'direct',
  },
  // ai-agent-c-obchod
  '3619acbd-a1bf-50f9-a8d5-d56df7096e0f': {
    legalEntityId: OBCHOD,
    modules: withWrites(obchodReads, ['demo.merchandise', 'demo.sales-pipeline']),
    writePolicy: 'approval',
  },
  // ai-agent-a-hanak
  '40052c4b-ea18-5c8c-ae8d-5d80548cec33': {
    legalEntityId: HANAK,
    modules: withWrites(hanakReads, []),
    writePolicy: 'read_only',
  },
  // ai-agent-b-hanak
  'c771c6f7-8d32-5ba7-af67-de4bd05eabc7': {
    legalEntityId: HANAK,
    modules: withWrites(hanakReads, ['work.tasks']),
    writePolicy: 'direct',
  },
  // ai-agent-c-hanak
  '6300a06d-e532-5f52-8f66-5f1d4752a75e': {
    legalEntityId: HANAK,
    modules: withWrites(hanakReads, ['demo.crm']),
    writePolicy: 'approval',
  },
};

/** Czech module labels for the agent editor; unknown modules show their id. */
export const agentModuleLabels: Readonly<Record<string, string>> = {
  'party.registry': 'Adresář firem a osob',
  'commerce.customer-context': 'Zákaznické skupiny',
  'demo.merchandise': 'Produkty, sklad a objednávky',
  'demo.sales-pipeline': 'Obchodní případy',
  'demo.sales-insights': 'Přehledy a statistiky',
  'demo.tagging': 'Štítky',
  'demo.workforce': 'Zaměstnanci a správa lidí',
  'demo.crm': 'CRM – klienti a návštěvy',
  'work.tasks': 'Úkoly a projekty',
  'finance.billing': 'Faktury a finance',
  'property.portfolio': 'Majetek a prostory',
  'property.leasing': 'Obsazenost a pronájmy',
  'legal.agreements': 'Smlouvy',
  'facility.operations': 'Provoz',
  'crm.activities': 'Nájemci a vztahy',
  'commerce.catalog': 'Katalog',
  'commerce.inventory': 'Zásoby',
  'commerce.pricing': 'Ceny',
  'commerce.assortment': 'Sortiment',
  'commerce.availability': 'Dostupnost',
  'commerce.market-catalog': 'Tržní katalog',
  'commerce.storefront-registry': 'E-shopy',
  'commerce.tax': 'Daně',
  'payment.term-catalog': 'Platební podmínky',
  'pricing.price-group-catalog': 'Cenové skupiny',
  'privacy.core': 'Ochrana osobních údajů',
};

export const moduleLabel = (moduleId: string): string => agentModuleLabels[moduleId] ?? moduleId;

const ModulesJson = Schema.fromJsonString(Schema.Array(AgentModuleGrantSchema));

const seedOf = (principalId: string): AgentProfile | undefined => {
  const seed = Object.hasOwn(seededAgentProfiles, principalId) ? seededAgentProfiles[principalId] : undefined;
  return seed === undefined ? undefined : { modules: seed.modules, seeded: true, writePolicy: seed.writePolicy };
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
      profiles.set(target, { modules: modules.value, seeded: false, writePolicy: writePolicy.value });
    }
  }
  return profiles;
};
