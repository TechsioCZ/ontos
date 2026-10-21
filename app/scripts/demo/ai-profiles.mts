#!/usr/bin/env node
/**
 * AI agent levels A, B and C (specs AGENT.md): separate non-human principals with their own backend grants and
 * managed API keys, one pair per demo company. LOCAL ONLY, idempotent.
 *
 *   node scripts/demo/ai-profiles.mts             # principals + grants + API keys (keys only when the shell is up)
 *   node scripts/demo/ai-profiles.mts --skip-keys # principals + grants only
 *
 * `reset-permissions.mts` calls `setupAiProfiles` after the legacy `agent-bot`, so a full demo reset provisions
 * these principals too. Running this file alone is safe while the demo is up: SpiceDB writes are TOUCH-only.
 *
 * Level A: read-only. Module access + `read_all` context permissions; NO Action executor grant at all, so every
 *          apply-command (tasks, opportunities, tags, orders, …) is denied by Core with 403 and a denied audit.
 * Level B: the same reads + `siampark.work` write (tasks only): executor grants for `siampark.work.*` Actions and
 *          `siampark.work.write_all`. Every other module stays read-only, so pipeline/tagging/order writes fail.
 *
 * Level C: proposals that a person approves in the app, with a bulk revert.
 *          Hanák: the same reads + `demo.crm` apply-command/write_all; the CRM command guard restricts the key to
 *          `AiProposeChanges` (clients, contacts, order pairing) approved on /crm/schvalovani-ai.
 *          Obchodní firma: the same reads + executor grants for `demo.sales-pipeline.apply-command` and
 *          `demo.merchandise.apply-command` but NO write_all, so the modules accept only `AiProposeChanges`
 *          (opportunities, orders) approved on /prodej/schvalovani-ai; every direct change is refused.
 *
 * Keys land in `app/.env.demo.local` as `ONTOS_AGENT_<A|B|C>_<COMPANY>_API_KEY` (COMPANY = OBCHOD, HANAK).
 * The MCP server picks one with `ONTOS_AGENT_PROFILE=A|B|C` and `ONTOS_AGENT_COMPANY=obchod|hanak`.
 */
import { randomUUID } from 'node:crypto';

import { NodeServices } from '@effect/platform-node';
import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '@app/core-runtime';
import { toSpiceDbActionObjectId } from '@app/core-runtime/actions/runtime-wiring';
import { commercialDemoCompany, crmDemoCompany } from '@app/core-runtime/demo-company-profiles';
import { inArray } from 'drizzle-orm';
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
} from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { Cookies, FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import { DatabaseConfig, parseDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { principals } from '../../packages/core-runtime/src/db/schema.ts';
import { AuthDatabase, AuthDatabaseFromDatabaseConfigLive } from '../../apps/shell-super-app/api/auth/db/client.ts';
import { apikey } from '../../apps/shell-super-app/api/auth/db/schema.ts';
import { discoverCurrentActions } from '../provision-current-action-authorization.mts';
import { resetChildEnvironment, resetEnvironment, validateResetEnvironment } from '../siampark/reset-configuration.mts';
import type { DemoResetChildEnvironment } from '../siampark/reset-configuration.mts';
import { demoId, demoTenantId } from './fixture-ids.mts';

export type AiProfileLevel = 'A' | 'B' | 'C';
type Access = 'read' | 'write';

interface AiCompany {
  /** Upper-case suffix of the env variable, e.g. OBCHOD. */
  readonly envKey: string;
  readonly key: string;
  readonly label: string;
  readonly legalEntityId: string;
  /** Module the company needs before its AI principals are provisioned (undefined: always). */
  readonly requiresAction: string | undefined;
  /** Read surface of level A (and B). */
  readonly reads: readonly string[];
}

/** Companies with AI agents. Hanák (CRM) is provisioned once its `demo.crm` vertical publishes Actions. */
export const aiCompanies: readonly AiCompany[] = [
  {
    envKey: 'OBCHOD',
    key: 'obchod',
    label: commercialDemoCompany.legalName,
    legalEntityId: commercialDemoCompany.legalEntityId,
    reads: [
      'party.registry',
      'commerce.customer-context',
      'demo.merchandise',
      'demo.sales-pipeline',
      'demo.sales-insights',
      'demo.tagging',
      'demo.workforce',
      'siampark.work',
      // Invoices (list_invoices, revenue metrics). Billing has no business permissions: module access is the read.
      'siampark.billing-finance',
    ],
    requiresAction: undefined,
  },
  {
    envKey: 'HANAK',
    key: 'hanak',
    label: crmDemoCompany.legalName,
    legalEntityId: crmDemoCompany.legalEntityId,
    reads: ['party.registry', 'demo.crm', 'demo.workforce', 'demo.tagging', 'siampark.work'],
    requiresAction: 'demo.crm.apply-command',
  },
];

/** The only module level B may write. */
export const AI_TASKS_MODULE = 'siampark.work';
/**
 * Level C (Hanák CRM only): executor grant for `demo.crm.apply-command` + `demo.crm.write_all`. The CRM command guard
 * lets an API key run ONLY `AiProposeChanges` there, so every change lands as a proposal on /crm/schvalovani-ai
 * (every item requires a human decision). Everything outside demo.crm stays read-only.
 */
export const AI_PROPOSALS_MODULE = 'demo.crm';
/**
 * Level C in Obchodní firma: executor grants for exactly these Actions, context permissions stay read-only. Without
 * write_all the modules refuse every direct change and accept only `AiProposeChanges` (human approval on
 * /prodej/schvalovani-ai).
 */
export const AI_SALES_PROPOSAL_ACTIONS: readonly string[] = [
  'demo.sales-pipeline.apply-command',
  'demo.merchandise.apply-command',
];
const writableModuleOf = (level: AiProfileLevel, company: AiCompany): string | undefined =>
  level === 'B' ? AI_TASKS_MODULE : level === 'C' && company.key === 'hanak' ? AI_PROPOSALS_MODULE : undefined;
const proposalActionsOf = (level: AiProfileLevel, company: AiCompany): readonly string[] =>
  level === 'C' && company.key === 'obchod' ? AI_SALES_PROPOSAL_ACTIONS : [];
/** Every company has all three levels; level C always works through a human approval workflow. */
const levelsOf = (_company: AiCompany): readonly AiProfileLevel[] => ['A', 'B', 'C'];

/** Modules gated by generated `<module>.read_all` / `.write_all` context permissions (see permissions.mts). */
const contextPermissionModules: ReadonlySet<string> = new Set([
  'demo.crm',
  'demo.merchandise',
  'demo.sales-insights',
  'demo.sales-pipeline',
  'demo.tagging',
  'demo.workforce',
  'siampark.work',
]);
const contextPermissionKey = (moduleId: string, access: Access) =>
  `${moduleId.replaceAll('-', '_')}.${access === 'read' ? 'read_all' : 'write_all'}`;
const extraReadPermissions = (moduleId: string): readonly string[] =>
  moduleId === 'commerce.customer-context' ? ['customer.group.read'] : [];

export interface AiPrincipal {
  readonly apiKeyName: string;
  readonly company: AiCompany;
  readonly displayName: string;
  readonly envVar: string;
  readonly level: AiProfileLevel;
  readonly principalId: string;
}

const levelLabel = {
  A: 'A · jen čtení',
  B: 'B · čtení + úkoly',
  C: 'C · návrhy změn ke schválení',
} as const satisfies Record<AiProfileLevel, string>;

export const aiPrincipals: readonly AiPrincipal[] = aiCompanies.flatMap((company) =>
  levelsOf(company).map((level) => ({
    apiKeyName: `ai-agent-${level.toLowerCase()}-${company.key}`,
    company,
    displayName: `AI agent ${levelLabel[level]} (${company.label})`,
    envVar: `ONTOS_AGENT_${level}_${company.envKey}_API_KEY`,
    level,
    principalId: demoId('core.principal', `ai-agent-${level.toLowerCase()}-${company.key}`),
  })),
);

interface DiscoveredAction {
  readonly actionKey: string;
  readonly provisioning: 'explicit' | 'tenant_membership_default';
}

export interface AiRelationship {
  readonly relation: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly subjectId: string;
  readonly subjectType: string;
}

/** Principals whose company is available in the current Action set. */
export const activeAiPrincipals = (actions: readonly DiscoveredAction[]) =>
  aiPrincipals.filter(
    ({ company }) =>
      company.requiresAction === undefined || actions.some(({ actionKey }) => actionKey === company.requiresAction),
  );

/** Grants of one AI principal. Level A gets no executor grant; level B gets executor grants for tasks only. */
export const aiPrincipalRelationships = (
  principal: AiPrincipal,
  actions: readonly DiscoveredAction[],
): readonly AiRelationship[] => {
  const result: AiRelationship[] = [];
  const add = (resourceType: string, resourceId: string, relation: string, subjectType: string, subjectId: string) =>
    result.push({ relation, resourceId, resourceType, subjectId, subjectType });
  const { legalEntityId } = principal.company;
  const { principalId } = principal;
  const legal = toLegalEntityAccessObjectId(demoTenantId, legalEntityId) ?? '';
  const moduleAccess = (moduleId: string) => toModuleAccessObjectId(demoTenantId, legalEntityId, moduleId) ?? '';
  const grantContextPermission = (moduleId: string, permission: string) => {
    const objectId = toContextPermissionAccessObjectId(demoTenantId, legalEntityId, { moduleId, permission }) ?? '';
    add('context_permission', objectId, 'tenant', 'tenant', demoTenantId);
    add('context_permission', objectId, 'grantee', 'principal', principalId);
  };
  add('legal_entity', legal, 'tenant', 'tenant', demoTenantId);
  add('tenant', demoTenantId, 'member', 'principal', principalId);
  add('legal_entity', legal, 'member', 'principal', principalId);
  for (const moduleId of ['core.shell', ...principal.company.reads]) {
    const access: Access = writableModuleOf(principal.level, principal.company) === moduleId ? 'write' : 'read';
    add('module_access', moduleAccess(moduleId), 'legal_entity', 'legal_entity', legal);
    add('module_access', moduleAccess(moduleId), 'accessor', 'principal', principalId);
    if (contextPermissionModules.has(moduleId)) {
      for (const level of access === 'write' ? (['read', 'write'] as const) : (['read'] as const)) {
        grantContextPermission(moduleId, contextPermissionKey(moduleId, level));
      }
    }
    for (const permission of extraReadPermissions(moduleId)) {
      grantContextPermission(moduleId, permission);
    }
    if (moduleId === 'party.registry') {
      // Read-only party relations; never counterparty_manager / party_identity_manager.
      add('tenant', demoTenantId, 'party_identity_reader', 'principal', principalId);
      add('legal_entity', legal, 'counterparty_reader', 'principal', principalId);
    }
    if (principal.level === 'C' && moduleId === AI_PROPOSALS_MODULE) {
      grantContextPermission(moduleId, 'demo.crm.assign');
    }
    const proposalActions = proposalActionsOf(principal.level, principal.company);
    if (access === 'write' || proposalActions.some((actionKey) => actionKey.startsWith(`${moduleId}.`))) {
      for (const { actionKey, provisioning } of actions.filter(
        (action) =>
          action.actionKey.startsWith(`${moduleId}.`) &&
          (access === 'write' || proposalActions.includes(action.actionKey)),
      )) {
        const action = toSpiceDbActionObjectId(actionKey);
        if (provisioning === 'explicit') {
          add('action', action, 'restriction', 'action', action);
        }
        add('action', action, 'executor', 'principal', principalId);
      }
    }
  }
  return result;
};

const relationshipKey = (relationship: AiRelationship) =>
  [
    relationship.resourceType,
    relationship.resourceId,
    relationship.relation,
    relationship.subjectType,
    relationship.subjectId,
  ].join('|');

/** Deduplicated: SpiceDB rejects a relationship that appears twice in one WriteRelationships request. */
export const aiProfileRelationships = (actions: readonly DiscoveredAction[]): readonly AiRelationship[] => [
  ...new Map(
    activeAiPrincipals(actions)
      .flatMap((principal) => aiPrincipalRelationships(principal, actions))
      .map((relationship) => [relationshipKey(relationship), relationship]),
  ).values(),
];

class AiProfilesError extends Schema.TaggedError<AiProfilesError>()('AiProfilesError', { reason: Schema.String }) {}
const fail = (reason: string) => new AiProfilesError({ reason });

const ENV_FILE = '.env.demo.local';
const KEY_PROBE_AUDIENCE = 'siampark-work';
const SECURE_COOKIE_PREFIX = '__Secure-';
const readinessTimeout = '10 seconds';
const operatorEmail = 'obchod@demo.ontos';
const demoPassword = Config.Redacted('ONTOS_DEMO_PASSWORD').pipe(Config.withDefault(Redacted.make('password1234')));
const agentConfig = Config.all({
  compositionUrl: Config.String('ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL').pipe(
    Config.withDefault('http://127.0.0.1:3041/active'),
  ),
  shellUrl: Config.String('ONTOS_SHELL_URL').pipe(Config.withDefault('http://localhost:3020')),
});

/** Service principal rows (the row `core.identity.create-non-human-principal` inserts, with stable IDs). */
const upsertAiPrincipalRows = (selected: readonly AiPrincipal[]) =>
  Effect.gen(function* upsertAiPrincipalRows() {
    const { executor } = yield* AuthDatabase;
    for (const principal of selected) {
      yield* executor
        .insert(principals)
        .values({
          displayName: principal.displayName,
          kind: 'service',
          principalId: principal.principalId,
          status: 'active',
          tenantId: demoTenantId,
        })
        .onConflictDoUpdate({
          set: { displayName: principal.displayName, status: 'active' },
          target: principals.principalId,
        });
    }
  });

/** Writes the AI relationships through the core development bootstrap port (no accounts, TOUCH-only). */
export const writeAiRelationships = Effect.fn('AiProfiles.relationships')(function* writeAiRelationships(
  root: string,
  environment: DemoResetChildEnvironment,
  relationships: readonly AiRelationship[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fixture = JSON.stringify({
    accounts: [],
    legalEntity: {
      legalEntityId: commercialDemoCompany.legalEntityId,
      legalName: commercialDemoCompany.legalName,
      registrationCountry: 'CZ',
      registrationNumber: 'DEMO-SIAMPARK',
    },
    modules: [],
    relationships,
    tenant: { defaultLocale: 'cs', displayName: 'Siampark DEMO', slug: 'siampark-demo', tenantId: demoTenantId },
  });
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ai-profiles-' });
  const file = path.join(directory, 'context.json');
  yield* fs.writeFileString(file, fixture);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const code = yield* spawner.exitCode(
    ChildProcess.make(
      process.execPath,
      [path.join(root, 'packages/core-runtime/scripts/bootstrap-development-context.mts'), '--fixture', file],
      { cwd: root, env: { ...environment, MISE_ARGV0: '' }, stderr: 'inherit', stdin: 'ignore', stdout: 'inherit' },
    ),
  );
  if (code !== ChildProcessSpawner.ExitCode(0)) {
    return yield* fail('Core development bootstrap port failed for AI profiles');
  }
  return yield* Effect.void;
});

const post = (url: string, body: unknown, headers: Readonly<Record<string, string>>) =>
  Effect.gen(function* postJsonRequest() {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders({ 'x-correlation-id': randomUUID(), ...headers }),
      HttpClientRequest.bodyJsonUnsafe(body),
    );
    return yield* client.execute(request);
  }).pipe(Effect.timeout('20 seconds'));

const sessionCookieHeader = (cookies: Cookies.Cookies) => {
  const aliases = Object.entries(Cookies.toRecord(cookies)).flatMap(([name, value]) =>
    name.startsWith(SECURE_COOKIE_PREFIX) ? [[name.slice(SECURE_COOKIE_PREFIX.length), value] as const] : [],
  );
  return Cookies.toCookieHeader(Cookies.setAllUnsafe(cookies, aliases));
};

const CompositionSchema = Schema.Struct({ composition: Schema.Struct({ revision: Schema.String }) });
const IssuedKeySchema = Schema.Struct({ secret: Schema.String.check(Schema.isMinLength(1)) });

const keyWorks = (shellUrl: string, apiKey: string, revision: string, legalEntityId: string) =>
  post(
    `${shellUrl}/shell-super-app-api/auth/api-key/gateway-context`,
    { audience: KEY_PROBE_AUDIENCE, compositionRevision: revision, legalEntityId },
    { 'content-type': 'application/json', 'x-api-key': apiKey },
  ).pipe(
    Effect.map(({ status }) => status === 200),
    Effect.orElseSucceed(() => false),
  );

const envLinePattern = /^(?<key>[A-Z][A-Z0-9_]*)=(?<value>.*)$/u;
const readEnvFile = (text: string): ReadonlyMap<string, string> =>
  new Map(
    text.split('\n').flatMap((line) => {
      const groups = envLinePattern.exec(line.trim())?.groups;
      const key = groups?.key;
      return key === undefined ? [] : [[key, groups?.value ?? ''] as const];
    }),
  );

/** Issues (or reuses) one managed API key per AI principal and writes them to app/.env.demo.local. */
const ensureAiKeys = Effect.fn('AiProfiles.keys')(function* ensureAiKeys(
  root: string,
  selected: readonly AiPrincipal[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const { compositionUrl, shellUrl } = yield* agentConfig;
  const shellUp = yield* client.get(`${shellUrl}/.well-known/ontos-shell-runtime.json`).pipe(
    Effect.timeout(readinessTimeout),
    Effect.map(({ status }) => status === 200),
    Effect.orElseSucceed(() => false),
  );
  if (!shellUp) {
    return yield* Console.log(`ai-profiles: shell ${shellUrl} is not running; API keys skipped (rerun once it is up)`);
  }
  const revision = yield* client.get(compositionUrl).pipe(
    Effect.timeout(readinessTimeout),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(CompositionSchema)),
    Effect.map(({ composition }) => composition.revision),
    Effect.option,
  );
  const envFile = path.join(root, ENV_FILE);
  const existing = (yield* fs.exists(envFile))
    ? readEnvFile(yield* fs.readFileString(envFile))
    : new Map<string, string>();
  const values = new Map(existing);
  let cookie: string | undefined;
  const operatorCookie = Effect.gen(function* signInOperator() {
    if (cookie !== undefined) {
      return cookie;
    }
    const signIn = yield* post(
      `${shellUrl}/shell-super-app-api/auth/sign-in`,
      { email: operatorEmail, password: Redacted.value(yield* demoPassword) },
      { 'content-type': 'application/json', origin: shellUrl },
    );
    if (signIn.status !== 200) {
      return yield* fail(`Sign-in as ${operatorEmail} failed with HTTP ${signIn.status}`);
    }
    cookie = sessionCookieHeader(signIn.cookies);
    return cookie;
  });
  const outcomes: string[] = [];
  for (const principal of selected) {
    const previous = existing.get(principal.envVar);
    const reusable =
      previous !== undefined && previous.length > 0 && Option.isSome(revision)
        ? yield* keyWorks(shellUrl, previous, revision.value, principal.company.legalEntityId)
        : false;
    if (reusable && previous !== undefined) {
      outcomes.push(`${principal.apiKeyName}=reused`);
      continue;
    }
    const issued = yield* post(
      `${shellUrl}/shell-super-app-api/auth/identity/api-keys/managed`,
      { name: principal.apiKeyName, principalId: principal.principalId },
      {
        'content-type': 'application/json',
        cookie: yield* operatorCookie,
        'idempotency-key': `ai-profiles-${principal.apiKeyName}-${randomUUID()}`,
        origin: shellUrl,
      },
    );
    if (issued.status !== 200) {
      const detail = yield* issued.text;
      return yield* fail(
        `API key for ${principal.apiKeyName} failed with HTTP ${issued.status}: ${detail.slice(0, 300)}`,
      );
    }
    const { secret } = yield* HttpClientResponse.schemaBodyJson(IssuedKeySchema)(issued);
    values.set(principal.envVar, secret);
    outcomes.push(`${principal.apiKeyName}=issued`);
  }
  const text = [
    '# Sales demo agent (scripts/demo/reset-permissions.mts, scripts/demo/ai-profiles.mts). Local secrets; gitignored.',
    ...[...values.entries()].map(([key, value]) => `${key}=${value}`),
    '',
  ].join('\n');
  yield* fs.writeFileString(envFile, text, { mode: 0o600 });
  yield* fs.chmod(envFile, 0o600);
  return yield* Console.log(`ai-profiles: API keys ${outcomes.join(', ')} -> app/${ENV_FILE}`);
});

/** Gateway assertions are single-use; lift Better Auth's 10-per-24h key limit for the AI keys (as for agent-bot). */
const liftAiKeyRateLimit = (selected: readonly AiPrincipal[]) =>
  Effect.gen(function* liftAiKeyRateLimit() {
    if (selected.length === 0) {
      return;
    }
    const { executor } = yield* AuthDatabase;
    yield* executor
      .update(apikey)
      .set({ rateLimitEnabled: false, requestCount: 0 })
      .where(
        inArray(
          apikey.name,
          selected.map(({ apiKeyName }) => apiKeyName),
        ),
      );
  });

/** Principals, grants and (unless skipped) API keys for the AI agent levels A and B. */
export const setupAiProfiles = Effect.fn('AiProfiles.setup')(function* setupAiProfiles(
  root: string,
  environment: DemoResetChildEnvironment,
  options: { readonly skipKeys: boolean },
) {
  const actions = yield* discoverCurrentActions(root);
  const selected = activeAiPrincipals(actions);
  yield* upsertAiPrincipalRows(selected);
  const relationships = aiProfileRelationships(actions);
  yield* writeAiRelationships(root, environment, relationships);
  yield* Console.log(
    `ai-profiles: ${selected.length} AI principals (${selected.map(({ apiKeyName }) => apiKeyName).join(', ')}), ${relationships.length} relationships`,
  );
  if (!options.skipKeys) {
    yield* liftAiKeyRateLimit(selected);
    yield* ensureAiKeys(root, selected);
    yield* liftAiKeyRateLimit(selected);
  }
});

// Standalone entry point.

const workspaceRoot = new URL('../..', import.meta.url);
const environmentLive = ConfigProvider.layer(
  Effect.gen(function* loadOperatorConfiguration() {
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(workspaceRoot);
    const file = yield* ConfigProvider.fromDotEnv({ path: path.join(root, '.env') });
    return ConfigProvider.orElse(ConfigProvider.fromEnv(), file);
  }),
);
const adminDatabaseConfigLive = Layer.effect(
  DatabaseConfig,
  Config.Redacted('DATABASE_ADMIN_URL').pipe(
    Effect.flatMap((url) => parseDatabaseConfig({ DATABASE_URL: Redacted.value(url) })),
  ),
);
const servicesLive = Layer.mergeAll(
  AuthDatabaseFromDatabaseConfigLive.pipe(Layer.provide(adminDatabaseConfigLive)),
  FetchHttpClient.layer,
);

const main = (skipKeys: boolean) =>
  Effect.gen(function* runAiProfiles() {
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(workspaceRoot);
    const environment = resetChildEnvironment(yield* resetEnvironment);
    yield* validateResetEnvironment(environment);
    yield* setupAiProfiles(root, environment, { skipKeys });
  });

const command = Command.make(
  'ai-profiles',
  { skipKeys: Flag.Boolean('skip-keys').pipe(Flag.withDefault(false)) },
  ({ skipKeys }) =>
    Layer.build(Layer.effectDiscard(main(skipKeys).pipe(Effect.scoped)).pipe(Layer.provide(servicesLive))).pipe(
      Effect.scoped,
      Effect.asVoid,
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(AiProfilesError)(failure)
            ? `AI profiles failed: ${failure.reason}`
            : `AI profiles failed (${failure._tag})`,
        ),
      ),
    ),
);
if (import.meta.main) {
  const runtimeLive = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
    Layer.provide(environmentLive),
    Layer.provide(NodeServices.layer),
  );
  const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(runtimeLive)));
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
