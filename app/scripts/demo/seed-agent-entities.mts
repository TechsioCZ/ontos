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
import type {
  AgentModuleAccess,
  AgentModuleGrant,
  AgentModuleGrantSchema,
  AgentWritePolicy,
} from '@app/shared-contracts/agent-access';
import { demoId, demoTenantId } from './fixture-ids.mts';

const USAGE = `Usage:
  node scripts/demo/seed-agent-entities.mts [--regrant]

Environment: ONTOS_DEMO_SEED_URL (default http://localhost:3020), ONTOS_DEMO_PASSWORD (password1234).`;

const LIST = '/shell-super-app-api/auth/identity/agent-entities/list';
const MANAGE = '/shell-super-app-api/auth/identity/agent-entities';
const OPERATORS = '/shell-super-app-api/auth/identity/agent-entities/operators';
const SECURE_COOKIE_PREFIX = '__Secure-';
const principalNamespace = 'core.principal';
const tasksModule = 'work.tasks';
const grantRead = 'read';

type Access = AgentModuleAccess;
type ModuleGrant = AgentModuleGrant;
interface SeedAgent {
  adminEmail: string;
  description: string;
  displayName: string;
  legalEntityId: string;
  modules: readonly Schema.Codec.Encoded<typeof AgentModuleGrantSchema>[];
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
    modules: [
      { access: grantRead, moduleId: 'property.portfolio' },
      { access: grantRead, moduleId: 'property.leasing' },
      { access: grantRead, moduleId: 'facility.operations' },
      { access: grantRead, moduleId: 'legal.agreements' },
      { access: 'write', moduleId: tasksModule },
    ],
    operatorPrincipalIds: ['72000000-0000-4000-8000-000000000021', '72000000-0000-4000-8000-000000000022'],
    ownerPrincipalId: '72000000-0000-4000-8000-000000000022',
    writePolicy: 'approval',
  },
  {
    adminEmail: 'spravce@hanak.demo',
    description: 'Připravuje přehledy klientů a návštěv a zakládá obchodníkům úkoly.',
    displayName: 'Obchodní asistent',
    legalEntityId: '71000000-0000-4000-8000-000000000022',
    modules: [
      { access: grantRead, moduleId: 'demo.crm' },
      { access: grantRead, moduleId: 'party.registry' },
      { access: grantRead, moduleId: 'commerce.customer-context' },
      { access: 'write', moduleId: tasksModule },
    ],
    operatorPrincipalIds: [demoId(principalNamespace, 'hanak-spravce'), demoId(principalNamespace, 'hanak-vedouci')],
    ownerPrincipalId: demoId(principalNamespace, 'hanak-vedouci'),
    writePolicy: 'direct',
  },
  {
    adminEmail: 'eshop@akros.demo',
    description: 'Odpovídá na dotazy k produktům, skladu a objednávkám e-shopu. Nic nemění.',
    displayName: 'Asistent e-shopu',
    legalEntityId: '71000000-0000-4000-8000-000000000024',
    modules: [
      { access: grantRead, moduleId: 'demo.merchandise' },
      { access: grantRead, moduleId: 'party.registry' },
      { access: grantRead, moduleId: tasksModule },
    ],
    operatorPrincipalIds: [demoId(principalNamespace, 'akros-eshop')],
    ownerPrincipalId: demoId(principalNamespace, 'akros-eshop'),
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

const seed = (agent: SeedAgent, origin: string, password: Redacted.Redacted, regrant: boolean) =>
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
    const modules: ModuleGrant[] = [];
    for (const wanted of agent.modules) {
      const option = overview.modules.find((module) => module.moduleId === wanted.moduleId);
      if (option === undefined) {
        yield* Console.log(`[seed-agent-entities] ${name}: module ${wanted.moduleId} not available, skipped`);
        continue;
      }
      const access: Access = wanted.access === 'write' && option.maxAccess === 'write' ? 'write' : 'read';
      modules.push({ access, moduleId: option.moduleId });
    }
    const existing = overview.agents.find((agentEntity) => agentEntity.displayName === name);
    if (existing === undefined) {
      const request = yield* Schema.decodeUnknownEffect(ManageAgentEntityRequestSchema)({
        description: agent.description,
        displayName: name,
        modules,
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
    if (regrant) {
      const request = yield* Schema.decodeUnknownEffect(ManageAgentEntityRequestSchema)({
        description: Option.getOrNull(existing.description),
        displayName: existing.displayName,
        modules: existing.modules,
        operation: 'configure',
        ownerPrincipalId: Option.match(existing.owner, {
          onNone: () => ownerPrincipalId,
          onSome: (owner) => owner.principalId,
        }),
        principalId: existing.principalId,
        writePolicy: existing.writePolicy,
      });
      yield* session
        .post(MANAGE, ManageAgentEntityRequestSchema, request, `${name} regrant`, idempotencyHeaders())
        .pipe(
          Effect.flatMap((response) => response.text),
          Effect.asVoid,
        );
      yield* Console.log(`[seed-agent-entities] re-granted ${name} (${existing.principalId})`);
    } else {
      yield* Console.log(`[seed-agent-entities] kept ${name} (${existing.principalId})`);
    }
    return yield* Effect.void;
  });

let commandExitCode = 0;
const command = Command.make(
  'seed-agent-entities',
  {
    help: Flag.Boolean('help').pipe(Flag.withAlias('h')),
    regrant: Flag.Boolean('regrant'),
  },
  ({ help, regrant }) =>
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
          seed(agent, origin, password, regrant).pipe(
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
