#!/usr/bin/env node
/**
 * LOCAL ONLY. One presentable agent entity per demo company, created through the shell's own administrator endpoint
 * (Lidé a role › Agentní entity: POST /shell-super-app-api/auth/identity/agent-entities, Core Action
 * core.identity.manage-demo-account, full audit), exactly as a company administrator does it in the app.
 * Idempotent by agent name: an existing agent is kept and only missing operators are added back.
 * An agent is created with no rights: rights come only from roles. `--role` gives an existing company role to an
 * existing agent through the same endpoint the agents page uses (People rules, audit); it never creates a role.
 *
 *   node scripts/demo/seed-agent-entities.mts
 *   node scripts/demo/seed-agent-entities.mts --roles-admin obchod@demo.ontos \
 *     --roles-company 71000000-0000-4000-8000-000000000020 --role 'AI agent B · čtení + úkoly (Obchodní firma)=<role>'
 *
 * Environment: ONTOS_DEMO_SEED_URL (default http://localhost:3020), ONTOS_DEMO_PASSWORD (password1234).
 */
import { randomUUID } from 'node:crypto';
import { NodeServices } from '@effect/platform-node';
import { Cause, Config, Console, Effect, Exit, Option, Predicate, Redacted, Runtime, Schema } from 'effect';
import { CliConfig, Command, Flag } from 'effect/cli';
import { Cookies, FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import {
  AgentEntityOverviewSchema,
  AgentOperatorsRequestSchema,
  ManageAgentEntityRequestSchema,
  ManageAgentEntityResponseSchema,
} from '@app/shared-contracts/agent-access';
import type { AgentWritePolicy } from '@app/shared-contracts/agent-access';
import { demoId, demoTenantId } from './fixture-ids.mts';

const USAGE = `Usage:
  node scripts/demo/seed-agent-entities.mts
  node scripts/demo/seed-agent-entities.mts --roles-admin <email> --roles-company <company id> --role '<agent>=<role>'...

Environment: ONTOS_DEMO_SEED_URL (default http://localhost:3020), ONTOS_DEMO_PASSWORD (password1234).`;

const LIST = '/shell-super-app-api/auth/identity/agent-entities/list';
const MANAGE = '/shell-super-app-api/auth/identity/agent-entities';
const OPERATORS = '/shell-super-app-api/auth/identity/agent-entities/operators';
const SECURE_COOKIE_PREFIX = '__Secure-';
const principalNamespace = 'core.principal';

interface SeedAgent {
  adminEmail: string;
  description: string;
  displayName: string;
  legalEntityId: string;
  operatorPrincipalIds: readonly string[];
  ownerPrincipalId: string;
  writePolicy: AgentWritePolicy;
}
const SEEDS: readonly SeedAgent[] = [
  {
    adminEmail: 'management@najempark.demo',
    description: 'Hlídá závady, revize a úkoly provozu areálu. Změny jen navrhuje, schvaluje je člověk.',
    displayName: 'Asistent provozu',
    legalEntityId: '71000000-0000-4000-8000-000000000021',
    operatorPrincipalIds: ['72000000-0000-4000-8000-000000000021', '72000000-0000-4000-8000-000000000022'],
    ownerPrincipalId: '72000000-0000-4000-8000-000000000022',
    writePolicy: 'approval',
  },
  {
    adminEmail: 'spravce@hanak.demo',
    description: 'Připravuje přehledy klientů a návštěv a zakládá obchodníkům úkoly.',
    displayName: 'Obchodní asistent',
    legalEntityId: '71000000-0000-4000-8000-000000000022',
    operatorPrincipalIds: [demoId(principalNamespace, 'hanak-spravce'), demoId(principalNamespace, 'hanak-vedouci')],
    ownerPrincipalId: demoId(principalNamespace, 'hanak-vedouci'),
    writePolicy: 'direct',
  },
  {
    adminEmail: 'eshop@sroubarna.demo',
    description: 'Odpovídá na dotazy k produktům, skladu a objednávkám e-shopu. Nic nemění.',
    displayName: 'Asistent e-shopu',
    legalEntityId: '71000000-0000-4000-8000-000000000024',
    operatorPrincipalIds: [demoId(principalNamespace, 'sroubarna-eshop')],
    ownerPrincipalId: demoId(principalNamespace, 'sroubarna-eshop'),
    writePolicy: 'read_only',
  },
];

class AgentSeedFailure extends Schema.TaggedError<AgentSeedFailure>()('AgentSeedFailure', { message: Schema.String }) {}
const SignInSchema = Schema.Struct({ email: Schema.String, password: Schema.Redacted(Schema.String) });
const TenantSchema = Schema.Struct({ tenantId: Schema.toEncoded(Schema.String.pipe(Schema.brand('TenantId'))) });
const CompanySchema = Schema.Struct({
  legalEntityId: Schema.toEncoded(Schema.String.pipe(Schema.brand('LegalEntityId'))),
});
const EmptySchema = Schema.Struct({});
const SeedPrincipalsSchema = Schema.Struct({
  operatorPrincipalIds: AgentOperatorsRequestSchema.fields.operatorPrincipalIds,
  ownerPrincipalId: AgentOperatorsRequestSchema.fields.agentPrincipalId,
});

const makeSession = (origin: string) =>
  Effect.gen(function* createSession() {
    const client = yield* HttpClient.HttpClient;
    let cookies = Cookies.empty;
    const header = () => {
      const entries = Object.entries(Cookies.toRecord(cookies));
      const pairs = entries.map(([name, value]) => `${name}=${value}`);
      const aliases = entries
        .filter(([name]) => name.startsWith(SECURE_COOKIE_PREFIX))
        .map(([name, value]) => `${name.slice(SECURE_COOKIE_PREFIX.length)}=${value}`);
      return [...pairs, ...aliases].join('; ');
    };
    const post = <P extends Schema.Top>(
      path: string,
      schema: P,
      body: P['Type'],
      what: string,
      headers: Record<string, string> = {},
    ) =>
      Effect.gen(function* postSessionRequest() {
        const request = yield* HttpClientRequest.schemaBodyJson(schema)(
          HttpClientRequest.post(`${origin}${path}`).pipe(
            HttpClientRequest.setHeaders({
              accept: 'application/json',
              cookie: header(),
              origin,
              'x-correlation-id': randomUUID(),
              ...headers,
            }),
          ),
          body,
        );
        const response = yield* client.execute(request);
        cookies = Cookies.merge(cookies, response.cookies);
        if (response.status !== 200) {
          const text = yield* response.text;
          return yield* new AgentSeedFailure({ message: `${what}: HTTP ${response.status} ${text.slice(0, 300)}` });
        }
        return response;
      });
    return { post };
  });
const idempotencyHeaders = () => ({ 'idempotency-key': `seed-agent-entity-${randomUUID()}` });

/** Signs the company administrator in and selects the demo tenant and the company. */
const adminSession = (origin: string, password: Redacted.Redacted, email: string, legalEntityId: string) =>
  Effect.gen(function* openAdminSession() {
    const session = yield* makeSession(origin);
    const done = Effect.flatMap((response: HttpClientResponse.HttpClientResponse) => response.text);
    yield* session
      .post('/shell-super-app-api/auth/sign-in', SignInSchema, { email, password }, 'roles sign-in')
      .pipe(done, Effect.asVoid);
    yield* session
      .post('/shell-super-app-api/auth/tenant/switch', TenantSchema, { tenantId: demoTenantId }, 'roles tenant')
      .pipe(done, Effect.asVoid);
    yield* session
      .post('/shell-super-app-api/auth/legal-entity/switch', CompanySchema, { legalEntityId }, 'roles company')
      .pipe(done, Effect.asVoid);
    return session;
  });

/**
 * Gives each named agent the named EXISTING role of the company, idempotently (a held role is kept). A role or agent
 * that does not exist fails and lists what does: the seed never invents a role or an agent.
 */
const assignRoles = (
  origin: string,
  password: Redacted.Redacted,
  input: { readonly adminEmail: string; readonly legalEntityId: string; readonly pairs: readonly string[] },
) =>
  Effect.gen(function* assignSeedRoles() {
    const session = yield* adminSession(origin, password, input.adminEmail, input.legalEntityId);
    for (const pair of input.pairs) {
      const [agentName = '', roleName = ''] = pair.split('=', 2).map((part) => part.trim());
      const overview = yield* session
        .post(LIST, EmptySchema, {}, `${pair} overview`)
        .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(AgentEntityOverviewSchema)));
      const agent = overview.agents.find((candidate) => candidate.displayName === agentName);
      const role = overview.roles.find((candidate) => candidate.name === roleName);
      if (agent === undefined || role === undefined) {
        const known = overview.roles.map((candidate) => candidate.name).join(', ');
        return yield* new AgentSeedFailure({
          message: `${pair}: ${agent === undefined ? 'no such agent' : 'no such role'}; roles: ${known}`,
        });
      }
      if (agent.roles.some((held) => held.roleId === role.roleId)) {
        yield* Console.log(`[seed-agent-entities] ${agentName} already has ${roleName}`);
        continue;
      }
      const request = yield* Schema.decodeUnknownEffect(ManageAgentEntityRequestSchema)({
        expectedRevision: overview.rolesRevision,
        expectedRoleRevisionId: role.roleRevisionId,
        operation: 'assign-role',
        principalId: agent.principalId,
        roleId: role.roleId,
      });
      yield* session.post(MANAGE, ManageAgentEntityRequestSchema, request, `${pair} assign`, idempotencyHeaders()).pipe(
        Effect.flatMap((response) => response.text),
        Effect.asVoid,
      );
      yield* Console.log(`[seed-agent-entities] ${agentName} now has ${roleName}`);
    }
    return yield* Effect.void;
  });

const seed = (agent: SeedAgent, origin: string, password: Redacted.Redacted) =>
  Effect.gen(function* seedAgent() {
    const session = yield* makeSession(origin);
    const name = agent.displayName;
    yield* session
      .post('/shell-super-app-api/auth/sign-in', SignInSchema, { email: agent.adminEmail, password }, `${name} sign-in`)
      .pipe(
        Effect.flatMap((response) => response.text),
        Effect.asVoid,
      );
    yield* session
      .post('/shell-super-app-api/auth/tenant/switch', TenantSchema, { tenantId: demoTenantId }, `${name} tenant`)
      .pipe(
        Effect.flatMap((response) => response.text),
        Effect.asVoid,
      );
    yield* session
      .post(
        '/shell-super-app-api/auth/legal-entity/switch',
        CompanySchema,
        { legalEntityId: agent.legalEntityId },
        `${name} legal entity`,
      )
      .pipe(
        Effect.flatMap((response) => response.text),
        Effect.asVoid,
      );
    const overview = yield* session
      .post(LIST, EmptySchema, {}, `${name} overview`)
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(AgentEntityOverviewSchema)));
    const memberIds = new Set(overview.members.map((member) => member.principalId));
    const { operatorPrincipalIds, ownerPrincipalId } = yield* Schema.decodeUnknownEffect(SeedPrincipalsSchema)(agent);
    const operators: (typeof AgentOperatorsRequestSchema.Type)['operatorPrincipalIds'][number][] = [];
    for (const id of operatorPrincipalIds) {
      if (memberIds.has(id)) {
        operators.push(id);
      } else {
        yield* Console.log(`[seed-agent-entities] ${name}: operator ${id} is not an active member, skipped`);
      }
    }
    if (!memberIds.has(ownerPrincipalId)) {
      return yield* new AgentSeedFailure({
        message: `${name}: owner ${agent.ownerPrincipalId} is not an active member`,
      });
    }
    const existing = overview.agents.find((agentEntity) => agentEntity.displayName === name);
    if (existing === undefined) {
      const request = yield* Schema.decodeUnknownEffect(ManageAgentEntityRequestSchema)({
        description: agent.description,
        displayName: name,
        operation: 'create',
        operatorPrincipalIds: operators,
        ownerPrincipalId,
        writePolicy: agent.writePolicy,
      });
      const created = yield* session
        .post(MANAGE, ManageAgentEntityRequestSchema, request, `${name} create`, idempotencyHeaders())
        .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ManageAgentEntityResponseSchema)));
      yield* Console.log(
        `[seed-agent-entities] created ${name} (${created.principalId ?? '?'}, ${created.grantsGranted ?? '?'} grants)`,
      );
      return yield* Effect.void;
    }
    const current = existing.operators.map((operator) => operator.principalId);
    const missing = operators.filter((id) => !current.includes(id));
    if (missing.length > 0) {
      const request = yield* Schema.decodeUnknownEffect(AgentOperatorsRequestSchema)({
        agentPrincipalId: existing.principalId,
        operatorPrincipalIds: [...current, ...missing],
      });
      yield* session.post(OPERATORS, AgentOperatorsRequestSchema, request, `${name} operators`).pipe(
        Effect.flatMap((response) => response.text),
        Effect.asVoid,
      );
      yield* Console.log(`[seed-agent-entities] ${name}: added operators ${missing.join(', ')}`);
    }
    yield* Console.log(`[seed-agent-entities] kept ${name} (${existing.principalId})`);
    return yield* Effect.void;
  });

let commandExitCode = 0;
const command = Command.make(
  'seed-agent-entities',
  {
    help: Flag.Boolean('help').pipe(Flag.withAlias('h')),
    role: Flag.String('role').pipe(Flag.atLeast(0)),
    rolesAdmin: Flag.String('roles-admin').pipe(Flag.optional),
    rolesCompany: Flag.String('roles-company').pipe(Flag.optional),
  },
  ({ help, role, rolesAdmin, rolesCompany }) =>
    Effect.gen(function* seedDemoAgents() {
      if (help) {
        yield* Console.log(USAGE);
        return;
      }
      const shellUrl = yield* Config.String('ONTOS_DEMO_SEED_URL').pipe(Config.withDefault('http://localhost:3020'));
      const { origin } = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(shellUrl);
      const password = yield* Config.Redacted('ONTOS_DEMO_PASSWORD').pipe(
        Config.withDefault(Redacted.make('password1234')),
      );
      const failures = yield* Effect.forEach(
        SEEDS,
        (agent) =>
          seed(agent, origin, password).pipe(
            Effect.as(false),
            Effect.catchCause((cause) => {
              if (Cause.hasInterrupts(cause)) {
                return Effect.failCause(cause);
              }
              const error = Cause.squash(cause);
              return Console.error(
                `[seed-agent-entities] ${agent.displayName}: ${Predicate.isError(error) ? error.message : String(error)}`,
              ).pipe(Effect.as(true));
            }),
          ),
        { concurrency: 1 },
      );
      commandExitCode = failures.some(Boolean) ? 1 : 0;
      if (role.length > 0) {
        if (Option.isNone(rolesAdmin) || Option.isNone(rolesCompany)) {
          yield* new AgentSeedFailure({ message: '--role needs --roles-admin and --roles-company' });
          return;
        }
        yield* assignRoles(origin, password, {
          adminEmail: rolesAdmin.value,
          legalEntityId: rolesCompany.value,
          pairs: role,
        });
      }
    }),
);
const abort = new AbortController();
const interrupt = (): void => {
  abort.abort();
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const exit = await Effect.runPromiseExit(
  Command.run(command, { version: '1.0.0' }).pipe(
    Effect.provideService(CliConfig.CliConfig, CliConfig.make({ builtIns: [] })),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'manual' }),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(NodeServices.layer),
    Effect.tapCause((cause) =>
      Runtime.getErrorReported(Cause.squash(cause)) ? Console.error(Cause.pretty(cause)) : Effect.void,
    ),
  ),
  { signal: abort.signal },
);
process.off('SIGINT', interrupt);
process.off('SIGTERM', interrupt);
const outcomeCode = Exit.match(exit, {
  onFailure: (cause) => (Cause.hasInterruptsOnly(cause) ? 130 : Runtime.getErrorExitCode(Cause.squash(cause))),
  onSuccess: () => 0,
});
process.exitCode = outcomeCode === 0 ? commandExitCode : outcomeCode;
