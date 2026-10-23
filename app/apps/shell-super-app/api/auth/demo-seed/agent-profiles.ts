// Explicit operator setup input only. Runtime authority never imports or falls back to this dataset.
import type { AgentModuleGrant, AgentWritePolicy } from '@app/shared-contracts/agent-access';

interface DemoAgentProfileInput {
  readonly displayName: string;
  readonly legalEntityId: string;
  readonly modules: readonly AgentModuleGrant[];
  readonly writePolicy: AgentWritePolicy;
}

const OBCHOD = '71000000-0000-4000-8000-000000000020';
const HANAK = '71000000-0000-4000-8000-000000000022';
const PARTIES = 'party.registry';
const TAGGING = 'demo.tagging';
const TASKS = 'work.tasks';
const WORKFORCE = 'demo.workforce';

const obchodReads = [
  'commerce.customer-context',
  'demo.merchandise',
  'demo.sales-insights',
  'demo.sales-pipeline',
  TAGGING,
  WORKFORCE,
  PARTIES,
  'finance.billing',
  TASKS,
];
const hanakReads = ['demo.crm', TAGGING, WORKFORCE, PARTIES, TASKS];

const withWrites = (reads: readonly string[], writes: readonly string[]): readonly AgentModuleGrant[] => {
  const written = new Set(writes);
  return reads.map((moduleId) => ({ access: written.has(moduleId) ? 'write' : 'read', moduleId }));
};

const profiles = {
  // ai-agent-a-obchod
  '35b748a0-d93a-520e-bd52-91433c8d15b8': {
    displayName: 'AI agent A · jen čtení (Obchodní firma)',
    legalEntityId: OBCHOD,
    modules: withWrites(obchodReads, []),
    writePolicy: 'read_only',
  },
  // ai-agent-b-obchod
  'e931e0fd-adba-56fd-9e17-e5f3adb3efa0': {
    displayName: 'AI agent B · čtení + úkoly (Obchodní firma)',
    legalEntityId: OBCHOD,
    modules: withWrites(obchodReads, [TASKS]),
    writePolicy: 'direct',
  },
  // ai-agent-c-obchod
  '3619acbd-a1bf-50f9-a8d5-d56df7096e0f': {
    displayName: 'AI agent C · návrhy změn ke schválení (Obchodní firma)',
    legalEntityId: OBCHOD,
    modules: withWrites(obchodReads, ['demo.merchandise', 'demo.sales-pipeline']),
    writePolicy: 'approval',
  },
  // ai-agent-a-hanak
  '40052c4b-ea18-5c8c-ae8d-5d80548cec33': {
    displayName: 'AI agent A · jen čtení (CRM)',
    legalEntityId: HANAK,
    modules: withWrites(hanakReads, []),
    writePolicy: 'read_only',
  },
  // ai-agent-b-hanak
  'c771c6f7-8d32-5ba7-af67-de4bd05eabc7': {
    displayName: 'AI agent B · čtení + úkoly (CRM)',
    legalEntityId: HANAK,
    modules: withWrites(hanakReads, [TASKS]),
    writePolicy: 'direct',
  },
  // ai-agent-c-hanak
  '6300a06d-e532-5f52-8f66-5f1d4752a75e': {
    displayName: 'AI agent C · návrhy změn ke schválení (CRM)',
    legalEntityId: HANAK,
    modules: withWrites(hanakReads, ['demo.crm']),
    writePolicy: 'approval',
  },
} as const satisfies Readonly<Record<string, DemoAgentProfileInput>>;

export const demoAgentProfileSetup = Object.entries(profiles).map(([principalId, profile]) => ({
  ...profile,
  description: null,
  ownerPrincipalId: null,
  principalId,
  tenantId: '70000000-0000-4000-8000-000000000020',
}));
