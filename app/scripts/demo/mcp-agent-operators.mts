#!/usr/bin/env node
/**
 * MCP agent operators: makes the company administrator the operator of each seeded agent principal, so that
 * `principal:{agent}#operate` holds for them. LOCAL ONLY, idempotent; SPICEDB_* env must be loaded.
 *
 *   node scripts/demo/mcp-agent-operators.mts [--agent <agentPrincipalId>:<legalEntityId> ...]
 *
 * Each agent keeps its current operators; the company administrator is added. The tenant relation is written
 * to the demo tenant. Seeded agents are listed in apps/shell-super-app/api/auth/agent-store-model.ts.
 */
import { openPrincipalOperators } from '@app/core-runtime';
import { Effect } from 'effect';

import { demoId, demoTenantId } from './fixture-ids.mts';

const administratorByLegalEntity: Readonly<Record<string, string>> = {
  '71000000-0000-4000-8000-000000000020': demoId('core.principal', 'obchod'),
  '71000000-0000-4000-8000-000000000021': '72000000-0000-4000-8000-000000000021',
  '71000000-0000-4000-8000-000000000022': demoId('core.principal', 'hanak-spravce'),
  '71000000-0000-4000-8000-000000000023': demoId('core.principal', 'kavarna-eshop'),
  '71000000-0000-4000-8000-000000000024': demoId('core.principal', 'akros-eshop'),
};

const seededAgents: readonly { readonly agentPrincipalId: string; readonly legalEntityId: string }[] = [
  { agentPrincipalId: '35b748a0-d93a-520e-bd52-91433c8d15b8', legalEntityId: '71000000-0000-4000-8000-000000000020' },
  { agentPrincipalId: 'e931e0fd-adba-56fd-9e17-e5f3adb3efa0', legalEntityId: '71000000-0000-4000-8000-000000000020' },
  { agentPrincipalId: '3619acbd-a1bf-50f9-a8d5-d56df7096e0f', legalEntityId: '71000000-0000-4000-8000-000000000020' },
  { agentPrincipalId: '40052c4b-ea18-5c8c-ae8d-5d80548cec33', legalEntityId: '71000000-0000-4000-8000-000000000022' },
  { agentPrincipalId: 'c771c6f7-8d32-5ba7-af67-de4bd05eabc7', legalEntityId: '71000000-0000-4000-8000-000000000022' },
  { agentPrincipalId: '6300a06d-e532-5f52-8f66-5f1d4752a75e', legalEntityId: '71000000-0000-4000-8000-000000000022' },
];

const requestedAgents = (argv: readonly string[]) => {
  const pairs: { agentPrincipalId: string; legalEntityId: string }[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--agent' && argv[index + 1] !== undefined) {
      const [agentPrincipalId = '', legalEntityId = ''] = argv[index + 1]!.split(':');
      pairs.push({ agentPrincipalId, legalEntityId });
      index += 1;
    }
  }
  return pairs.length > 0 ? pairs : seededAgents;
};

const program = Effect.scoped(
  Effect.gen(function* () {
    const operators = yield* openPrincipalOperators;
    for (const { agentPrincipalId, legalEntityId } of requestedAgents(process.argv.slice(2))) {
      const admin = administratorByLegalEntity[legalEntityId];
      if (admin === undefined) {
        console.log(`[mcp-agent-operators] skip ${agentPrincipalId}: no administrator for ${legalEntityId}`);
        continue;
      }
      const current = yield* operators.operatorsOf(agentPrincipalId);
      const result = yield* operators.replaceOperators({
        agentPrincipalId,
        operatorPrincipalIds: [...new Set([...current, admin])],
        tenantId: demoTenantId,
      });
      console.log(`[mcp-agent-operators] ${agentPrincipalId} -> operator ${admin} (+${result.added})`);
    }
  }),
);

Effect.runPromise(program).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
