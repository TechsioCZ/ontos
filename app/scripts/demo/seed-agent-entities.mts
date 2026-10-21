#!/usr/bin/env node
/**
 * LOCAL ONLY. One presentable agent entity per demo company, created through the shell's own administrator endpoint
 * (Lidé a role › Agentní entity: POST /shell-super-app-api/auth/identity/agent-entities, Core Action
 * core.identity.manage-demo-account, full audit), exactly as a company administrator does it in the app.
 * Idempotent by agent name: an existing agent is kept and only missing operators are added back.
 * `--regrant` re-saves existing seeded agents (rewrites their SpiceDB grants after a SpiceDB reset; one audit row each).
 *
 *   node scripts/demo/seed-agent-entities.mts [--regrant]
 *
 * Environment: ONTOS_DEMO_SEED_URL (default http://localhost:3020), ONTOS_DEMO_PASSWORD (password1234).
 */
import { randomUUID } from 'node:crypto';
import { demoId, demoTenantId } from './fixture-ids.mts';

const USAGE = `Usage:
  node scripts/demo/seed-agent-entities.mts [--regrant]

Environment: ONTOS_DEMO_SEED_URL (default http://localhost:3020), ONTOS_DEMO_PASSWORD (password1234).`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const shellUrl = process.env.ONTOS_DEMO_SEED_URL ?? 'http://localhost:3020';
const origin = new URL(shellUrl).origin;
const password = process.env.ONTOS_DEMO_PASSWORD ?? 'password1234';
const regrant = process.argv.includes('--regrant');

const LIST = '/shell-super-app-api/auth/identity/agent-entities/list';
const MANAGE = '/shell-super-app-api/auth/identity/agent-entities';
const OPERATORS = '/shell-super-app-api/auth/identity/agent-entities/operators';
const SECURE_COOKIE_PREFIX = '__Secure-';

type Access = 'read' | 'write';
type WritePolicy = 'approval' | 'direct' | 'read_only';
interface ModuleGrant {
  access: Access;
  moduleId: string;
}
interface SeedAgent {
  adminEmail: string;
  legalEntityId: string;
  displayName: string;
  description: string;
  ownerPrincipalId: string;
  operatorPrincipalIds: readonly string[];
  modules: readonly ModuleGrant[];
  writePolicy: WritePolicy;
}
interface Overview {
  agents: {
    description: string | null;
    displayName: string;
    modules: ModuleGrant[];
    operators: { principalId: string }[];
    owner: { principalId: string } | null;
    principalId: string;
    writePolicy: WritePolicy;
  }[];
  members: { displayName: string; principalId: string }[];
  modules: { maxAccess: Access; moduleId: string }[];
}
interface Result {
  json: unknown;
  status: number;
  text: string;
}

const SEEDS: readonly SeedAgent[] = [
  {
    adminEmail: 'management@siampark.demo',
    legalEntityId: '71000000-0000-4000-8000-000000000021',
    displayName: 'Asistent provozu',
    description: 'Hlídá závady, revize a úkoly provozu areálu. Změny jen navrhuje, schvaluje je člověk.',
    ownerPrincipalId: '72000000-0000-4000-8000-000000000022',
    operatorPrincipalIds: ['72000000-0000-4000-8000-000000000021', '72000000-0000-4000-8000-000000000022'],
    modules: [
      { moduleId: 'property.portfolio', access: 'read' },
      { moduleId: 'property.leasing', access: 'read' },
      { moduleId: 'facility.operations', access: 'read' },
      { moduleId: 'legal.agreements', access: 'read' },
      { moduleId: 'work.tasks', access: 'write' },
    ],
    writePolicy: 'approval',
  },
  {
    adminEmail: 'spravce@hanak.demo',
    legalEntityId: '71000000-0000-4000-8000-000000000022',
    displayName: 'Obchodní asistent',
    description: 'Připravuje přehledy klientů a návštěv a zakládá obchodníkům úkoly.',
    ownerPrincipalId: demoId('core.principal', 'hanak-vedouci'),
    operatorPrincipalIds: [demoId('core.principal', 'hanak-spravce'), demoId('core.principal', 'hanak-vedouci')],
    modules: [
      { moduleId: 'demo.crm', access: 'read' },
      { moduleId: 'party.registry', access: 'read' },
      { moduleId: 'commerce.customer-context', access: 'read' },
      { moduleId: 'work.tasks', access: 'write' },
    ],
    writePolicy: 'direct',
  },
  {
    adminEmail: 'eshop@akros.demo',
    legalEntityId: '71000000-0000-4000-8000-000000000024',
    displayName: 'Asistent e-shopu',
    description: 'Odpovídá na dotazy k produktům, skladu a objednávkám e-shopu. Nic nemění.',
    ownerPrincipalId: demoId('core.principal', 'akros-eshop'),
    operatorPrincipalIds: [demoId('core.principal', 'akros-eshop')],
    modules: [
      { moduleId: 'demo.merchandise', access: 'read' },
      { moduleId: 'party.registry', access: 'read' },
      { moduleId: 'work.tasks', access: 'read' },
    ],
    writePolicy: 'read_only',
  },
];

class Session {
  private readonly cookies = new Map<string, string>();

  header(): string {
    const pairs = [...this.cookies].map(([name, value]) => `${name}=${value}`);
    const aliases = [...this.cookies]
      .filter(([name]) => name.startsWith(SECURE_COOKIE_PREFIX))
      .map(([name, value]) => `${name.slice(SECURE_COOKIE_PREFIX.length)}=${value}`);
    return [...pairs, ...aliases].join('; ');
  }

  async post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Result> {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      redirect: 'manual',
      body: JSON.stringify(body),
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        cookie: this.header(),
        origin,
        'x-correlation-id': randomUUID(),
        ...headers,
      },
    });
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { json, status: response.status, text };
  }
}

function expectOk<T>(result: Result, what: string): T {
  if (result.status !== 200) {
    throw new Error(`${what}: HTTP ${result.status} ${result.text.slice(0, 300)}`);
  }
  // Trusted local shell responses; the shapes are declared above, not validated.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return result.json as T;
}

const idempotencyHeaders = () => ({ 'idempotency-key': `seed-agent-entity-${randomUUID()}` });

async function seed(agent: SeedAgent): Promise<void> {
  const session = new Session();
  const name = agent.displayName;
  expectOk(
    await session.post('/shell-super-app-api/auth/sign-in', { email: agent.adminEmail, password }),
    `${name} sign-in`,
  );
  expectOk(await session.post('/shell-super-app-api/auth/tenant/switch', { tenantId: demoTenantId }), `${name} tenant`);
  expectOk(
    await session.post('/shell-super-app-api/auth/legal-entity/switch', { legalEntityId: agent.legalEntityId }),
    `${name} legal entity`,
  );
  const overview = expectOk<Overview>(await session.post(LIST, {}), `${name} overview`);

  const memberIds = new Set(overview.members.map((member) => member.principalId));
  const operators = agent.operatorPrincipalIds.filter((id) => {
    if (memberIds.has(id)) return true;
    console.log(`[seed-agent-entities] ${name}: operator ${id} is not an active member, skipped`);
    return false;
  });
  if (!memberIds.has(agent.ownerPrincipalId)) {
    throw new Error(`${name}: owner ${agent.ownerPrincipalId} is not an active member`);
  }

  const modules = agent.modules.flatMap((wanted): ModuleGrant[] => {
    const option = overview.modules.find((module) => module.moduleId === wanted.moduleId);
    if (option === undefined) {
      console.log(`[seed-agent-entities] ${name}: module ${wanted.moduleId} not available, skipped`);
      return [];
    }
    const access: Access = wanted.access === 'write' && option.maxAccess === 'write' ? 'write' : 'read';
    return [{ access, moduleId: wanted.moduleId }];
  });

  const existing = overview.agents.find((agentEntity) => agentEntity.displayName === name);
  if (existing === undefined) {
    const created = expectOk<{ principalId?: string; grantsGranted?: number }>(
      await session.post(
        MANAGE,
        {
          description: agent.description,
          displayName: name,
          modules,
          operation: 'create',
          operatorPrincipalIds: operators,
          ownerPrincipalId: agent.ownerPrincipalId,
          writePolicy: agent.writePolicy,
        },
        idempotencyHeaders(),
      ),
      `${name} create`,
    );
    console.log(
      `[seed-agent-entities] created ${name} (${created.principalId ?? '?'}, ${created.grantsGranted ?? '?'} grants)`,
    );
    return;
  }

  const current = existing.operators.map((operator) => operator.principalId);
  const missing = operators.filter((id) => !current.includes(id));
  if (missing.length > 0) {
    expectOk(
      await session.post(OPERATORS, {
        agentPrincipalId: existing.principalId,
        operatorPrincipalIds: [...current, ...missing],
      }),
      `${name} operators`,
    );
    console.log(`[seed-agent-entities] ${name}: added operators ${missing.join(', ')}`);
  }

  if (regrant) {
    expectOk(
      await session.post(
        MANAGE,
        {
          description: existing.description,
          displayName: existing.displayName,
          modules: existing.modules,
          operation: 'configure',
          ownerPrincipalId: existing.owner?.principalId ?? agent.ownerPrincipalId,
          principalId: existing.principalId,
          writePolicy: existing.writePolicy,
        },
        idempotencyHeaders(),
      ),
      `${name} regrant`,
    );
    console.log(`[seed-agent-entities] re-granted ${name} (${existing.principalId})`);
  } else {
    console.log(`[seed-agent-entities] kept ${name} (${existing.principalId})`);
  }
}

let failures = 0;
for (const agent of SEEDS) {
  try {
    await seed(agent);
  } catch (error) {
    console.error(`[seed-agent-entities] ${agent.displayName}: ${error instanceof Error ? error.message : String(error)}`);
    failures += 1;
  }
}
process.exitCode = failures === 0 ? 0 : 1;
