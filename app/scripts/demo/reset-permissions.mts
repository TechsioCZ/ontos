#!/usr/bin/env node
/**
 * Sales-demo accounts, grants and agent bot (plan 22). LOCAL ONLY, idempotent.
 *
 *   node scripts/demo/reset-permissions.mts            # accounts + grants, then the bot key when the shell is up
 *   node scripts/demo/reset-permissions.mts --skip-bot # accounts + grants only
 *
 * 1. Upserts the Better Auth users of the four @demo.ontos accounts (password `password1234`).
 * 2. Inserts the `agent-bot` service principal row (the row `core.identity.create-non-human-principal`
 *    inserts, but with a stable ID so grants survive a reset).
 * 3. Runs the core development bootstrap port with the accounts and the role matrix from `permissions.mts`.
 *    It writes principals, auth bindings and SpiceDB relationships. SpiceDB is in-memory, so rerun after a
 *    container restart. The Siampark accounts are not touched.
 * 4. When the shell answers, signs in as obchod@demo.ontos and issues a managed API key for the bot through
 *    `/auth/identity/api-keys/managed`, unless the key in `app/.env.demo.local` still works. Writes
 *    ONTOS_AGENT_API_KEY, ONTOS_SHELL_URL, ONTOS_COMPOSITION_REVISION and ONTOS_LEGAL_ENTITY_ID there.
 * 5. Lifts the Better Auth per-key rate limit of the agent-bot keys (plugin default: 10 verifications per 24 h).
 *    Gateway assertions are single-use, so the agent exchanges its key on every tool call and would be locked
 *    out after ten calls a day.
 */
import { randomUUID } from 'node:crypto';

import { NodeServices } from '@effect/platform-node';
import { hashPassword } from 'better-auth/crypto';
import {
  additionalDemoCompanies,
  commercialDemoCompany,
  demoCompanyTenantId,
  rentalDemoCompany,
} from '@app/core-runtime/demo-company-profiles';
import { eq, inArray } from 'drizzle-orm';
import {
  Config,
  ConfigProvider,
  Console,
  DateTime,
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
import { legalEntities, principals, tenants } from '../../packages/core-runtime/src/db/schema.ts';
import { AuthDatabase, AuthDatabaseFromDatabaseConfigLive } from '../../apps/shell-super-app/api/auth/db/client.ts';
import { account, apikey, user } from '../../apps/shell-super-app/api/auth/db/schema.ts';
import { discoverCurrentActions } from '../provision-current-action-authorization.mts';
import { resetChildEnvironment, resetEnvironment, validateResetEnvironment } from '../siampark/reset-configuration.mts';
import type { DemoResetChildEnvironment } from '../siampark/reset-configuration.mts';
import { setupAiProfiles } from './ai-profiles.mts';
import { setupCrmPartyIntake } from './crm-party-intake.mts';
import { demoLegalEntityId, demoTenantId, eshopDemoLegalEntityId } from './fixture-ids.mts';
import {
  akrosStorefrontPrincipal,
  agentBotPrincipal,
  companyHumanAccounts,
  demoHumanAccounts,
  demoPermissionRelationships,
  storefrontPrincipal,
} from './permissions.mts';

class DemoPermissionsError extends Schema.TaggedError<DemoPermissionsError>()('DemoPermissionsError', {
  reason: Schema.String,
}) {}
const fail = (reason: string) => new DemoPermissionsError({ reason });

const demoPassword = Config.Redacted('ONTOS_DEMO_PASSWORD').pipe(Config.withDefault(Redacted.make('password1234')));
const ENV_FILE = '.env.demo.local';
const readinessTimeout = '10 seconds';
const BOT_KEY_AUDIENCE = 'siampark-work';
/** The storefront BFF exchanges its key for merchandise gateway assertions in the e-shop company. */
const STOREFRONT_KEY_AUDIENCE = 'merchandise';
/** Every human account: the Obchodní firma / Siampark accounts plus the CRM and e-shop company personas. */
const allHumanAccounts = [...demoHumanAccounts, ...companyHumanAccounts] as const;
/** `demo.crm` is tenant-activated here so the CRM company works whatever the Siampark reset lists. */
const crmModuleState = { moduleId: 'demo.crm', stateId: '78000000-0000-4000-8000-000000000201' } as const;
const siamparkOpsModuleState = {
  moduleId: 'demo.siampark-ops',
  stateId: '78000000-0000-4000-8000-000000000202',
} as const;
/** Managed API keys that run unlimited (each request exchanges the key for a single-use gateway assertion). */
const unlimitedKeyNames = [agentBotPrincipal.displayName, storefrontPrincipal.displayName, akrosStorefrontPrincipal.displayName];
const SECURE_COOKIE_PREFIX = '__Secure-';
const [headOfSales] = demoHumanAccounts;

const workspaceRoot = new URL('../..', import.meta.url);

const demoAgentConfig = Config.all({
  compositionUrl: Config.String('ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL').pipe(
    Config.withDefault('http://127.0.0.1:3041/active'),
  ),
  shellUrl: Config.String('ONTOS_SHELL_URL').pipe(Config.withDefault('http://localhost:3020')),
});

/** Better Auth users + the bot principal row, through the admin connection. */
const upsertIdentityRows = Effect.gen(function* upsertIdentityRows() {
  const { executor } = yield* AuthDatabase;
  const now = yield* DateTime.nowAsDate;
  const credential = yield* demoPassword;
  const password = yield* Effect.tryPromise({
    catch: () => fail('Unable to hash the demo password'),
    try: async () => await hashPassword(Redacted.value(credential)),
  });
  yield* executor.transaction((transaction) =>
    Effect.gen(function* writeIdentityRows() {
      // One neutral tenant contains all four demo companies; never label Hanák or Kavárna as Siampark.
      yield* transaction
        .update(tenants)
        .set({ name: 'OntOS DEMO', updatedAt: now })
        .where(eq(tenants.tenantId, demoTenantId));
      // The CRM and e-shop companies exist before their personas' grants; the audited Core Action
      // (`core.identity.configure-demo-companies`) creates the same rows when the shell is newer than this script.
      for (const company of additionalDemoCompanies) {
        yield* transaction
          .insert(legalEntities)
          .values({
            legalEntityId: company.legalEntityId,
            legalName: company.legalName,
            registrationCountry: 'CZ',
            registrationNumber: company.registrationNumber,
            status: 'active',
            tenantId: demoCompanyTenantId,
          })
          .onConflictDoNothing();
      }
      for (const row of allHumanAccounts) {
        yield* transaction
          .insert(user)
          .values({ banned: false, email: row.email, emailVerified: true, id: row.authUserId, name: row.displayName })
          .onConflictDoUpdate({
            set: { banned: false, email: row.email, name: row.displayName, updatedAt: now },
            target: user.id,
          });
        yield* transaction
          .insert(account)
          .values({
            accountId: row.authUserId,
            id: `${row.authUserId}-credential`,
            password,
            providerId: 'credential',
            updatedAt: now,
            userId: row.authUserId,
          })
          .onConflictDoUpdate({ set: { password, updatedAt: now }, target: account.id });
      }
      yield* transaction
        .insert(principals)
        .values({
          displayName: agentBotPrincipal.displayName,
          kind: agentBotPrincipal.kind,
          principalId: agentBotPrincipal.principalId,
          status: 'active',
          tenantId: demoTenantId,
        })
        .onConflictDoUpdate({ set: { status: 'active' }, target: principals.principalId });
      yield* transaction
        .insert(principals)
        .values({
          displayName: storefrontPrincipal.displayName,
          kind: storefrontPrincipal.kind,
          principalId: storefrontPrincipal.principalId,
          status: 'active',
          tenantId: demoTenantId,
        })
        .onConflictDoUpdate({ set: { status: 'active' }, target: principals.principalId });
      yield* transaction
        .insert(principals)
        .values({
          displayName: akrosStorefrontPrincipal.displayName,
          kind: akrosStorefrontPrincipal.kind,
          principalId: akrosStorefrontPrincipal.principalId,
          status: 'active',
          tenantId: demoTenantId,
        })
        .onConflictDoUpdate({ set: { status: 'active' }, target: principals.principalId });
    }),
  );
});

/**
 * Better Auth's apiKey plugin stores `rateLimitMax: 10` per `rateLimitTimeWindow: 24 h` on every key it creates.
 * Every MCP tool call exchanges the key for a single-use gateway assertion, so the demo bot keys run unlimited.
 */
const liftBotKeyRateLimit = Effect.gen(function* liftBotKeyRateLimit() {
  const { executor } = yield* AuthDatabase;
  const lifted = yield* executor
    .update(apikey)
    .set({ rateLimitEnabled: false, requestCount: 0 })
    .where(inArray(apikey.name, unlimitedKeyNames))
    .returning({ id: apikey.id });
  return yield* Console.log(
    `sales-demo permissions: rate limit lifted on ${lifted.length} agent-bot/storefront API key(s)`,
  );
});

const Text = Schema.String;
const PrincipalIdSchema = Schema.toEncoded(Text.pipe(Schema.brand('DemoPrincipalId')));
const TenantIdSchema = Schema.toEncoded(Text.pipe(Schema.brand('DemoTenantId')));
const LegalEntityIdSchema = Schema.toEncoded(Text.pipe(Schema.brand('DemoLegalEntityId')));
/** Wire contract of `packages/core-runtime/scripts/bootstrap-development-context.mts --fixture`. */
const ContextFixtureSchema = Schema.Struct({
  accounts: Schema.Array(
    Schema.Struct({
      authBindingId: Schema.toEncoded(Text.pipe(Schema.brand('DemoAuthBindingId'))),
      authUserId: Schema.toEncoded(Text.pipe(Schema.brand('DemoAuthUserId'))),
      displayName: Text,
      principalId: PrincipalIdSchema,
    }),
  ),
  legalEntity: Schema.Struct({
    legalEntityId: LegalEntityIdSchema,
    legalName: Text,
    registrationCountry: Text,
    registrationNumber: Text,
  }),
  modules: Schema.Array(
    Schema.Struct({
      moduleId: Schema.toEncoded(Text.pipe(Schema.brand('DemoModuleId'))),
      stateId: Schema.toEncoded(Text.pipe(Schema.brand('DemoStateId'))),
    }),
  ),
  relationships: Schema.Array(
    Schema.Struct({
      relation: Text,
      resourceId: Schema.toEncoded(Text.pipe(Schema.brand('DemoResourceId'))),
      resourceType: Text,
      subjectId: Schema.toEncoded(Text.pipe(Schema.brand('DemoSubjectId'))),
      subjectType: Text,
    }),
  ),
  tenant: Schema.Struct({ defaultLocale: Text, displayName: Text, slug: Text, tenantId: TenantIdSchema }),
});

/** Principals, auth bindings and SpiceDB relationships through the core development bootstrap port. */
const runBootstrapPort = Effect.fn('DemoPermissions.bootstrap')(function* runBootstrapPort(
  root: string,
  environment: DemoResetChildEnvironment,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const actions = yield* discoverCurrentActions(root);
  const relationships = demoPermissionRelationships(actions);
  const fixture = yield* Schema.encodeEffect(Schema.fromJsonString(ContextFixtureSchema))({
    accounts: allHumanAccounts.map(({ authBindingId, authUserId, displayName, principalId }) => ({
      authBindingId,
      authUserId,
      displayName,
      principalId,
    })),
    legalEntity: {
      legalEntityId: demoLegalEntityId,
      legalName: 'Obchodní firma',
      registrationCountry: 'CZ',
      registrationNumber: 'DEMO-SIAMPARK',
    },
    modules: [crmModuleState, siamparkOpsModuleState],
    relationships,
    tenant: { defaultLocale: 'cs', displayName: 'OntOS DEMO', slug: 'siampark-demo', tenantId: demoTenantId },
  });
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'sales-demo-permissions-' });
  const file = path.join(directory, 'context.json');
  yield* fs.writeFileString(file, fixture);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const code = yield* spawner.exitCode(
    ChildProcess.make(
      process.execPath,
      [path.join(root, 'packages/core-runtime/scripts/bootstrap-development-context.mts'), '--fixture', file],
      {
        cwd: root,
        env: { ...environment, MISE_ARGV0: '' },
        stderr: 'inherit',
        stdin: 'ignore',
        stdout: 'inherit',
      },
    ),
  );
  if (code !== ChildProcessSpawner.ExitCode(0)) {
    return yield* fail('Core development bootstrap port failed');
  }
  return yield* Console.log(
    `sales-demo permissions: ${allHumanAccounts.length} accounts + agent-bot + storefront, ${relationships.length} relationships over ${actions.length} Actions`,
  );
});

// Bot API key through the running shell.

const SignInBodySchema = Schema.Struct({ email: Schema.String, password: Schema.Redacted(Schema.String) });
const IssueKeyBodySchema = Schema.Struct({ name: Schema.String, principalId: PrincipalIdSchema });
const GatewayBodySchema = Schema.Struct({
  audience: Schema.String,
  compositionRevision: Schema.String,
  legalEntityId: LegalEntityIdSchema,
});
const CompositionSchema = Schema.Struct({ composition: Schema.Struct({ revision: Schema.String }) });
const IssuedKeySchema = Schema.Struct({ secret: Schema.Redacted(Schema.String.check(Schema.isMinLength(1))) });
const DemoCompaniesPayload = Schema.Struct({ configuration: Schema.Literal('sales-rental-v1') });
const DemoCompaniesResult = Schema.Struct({
  companies: Schema.Array(Schema.Struct({ legalEntityId: LegalEntityIdSchema, legalName: Schema.String })),
});

const postJson = <S extends Schema.Top>(
  url: string,
  schema: S,
  body: S['Type'],
  headers: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* postJsonRequest() {
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.schemaBodyJson(schema)(
      HttpClientRequest.post(url).pipe(HttpClientRequest.setHeaders({ 'x-correlation-id': randomUUID(), ...headers })),
      body,
    );
    return yield* client.execute(request);
  }).pipe(Effect.timeout('20 seconds'));

const compositionRevision = (url: string) =>
  Effect.gen(function* readCompositionRevision() {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url).pipe(Effect.timeout(readinessTimeout));
    const { composition } = yield* HttpClientResponse.schemaBodyJson(CompositionSchema)(response);
    return composition.revision;
  }).pipe(Effect.option);

const keyWorks = (
  shellUrl: string,
  apiKey: Redacted.Redacted,
  revision: string,
  target: { readonly audience: string; readonly legalEntityId: string } = {
    audience: BOT_KEY_AUDIENCE,
    legalEntityId: demoLegalEntityId,
  },
) =>
  postJson(
    `${shellUrl}/shell-super-app-api/auth/api-key/gateway-context`,
    GatewayBodySchema,
    { audience: target.audience, compositionRevision: revision, legalEntityId: target.legalEntityId },
    { 'x-api-key': Redacted.value(apiKey) },
  ).pipe(
    Effect.map(({ status }) => status === 200),
    Effect.orElseSucceed(() => false),
  );

/**
 * The shell signs sessions into `__Secure-better-auth.session_token`, but the API-key Better Auth instance
 * (`apps/shell-super-app/api/auth/api-key-service.ts`) is built from the plain http base URL and reads
 * `better-auth.session_token`. On the local http stack the same signed value is sent under both names.
 */
const sessionCookieHeader = (cookies: Cookies.Cookies) => {
  const aliases = Object.entries(Cookies.toRecord(cookies)).flatMap(([name, value]) =>
    name.startsWith(SECURE_COOKIE_PREFIX) ? [[name.slice(SECURE_COOKIE_PREFIX.length), value] as const] : [],
  );
  return Cookies.toCookieHeader(Cookies.setAllUnsafe(cookies, aliases));
};

/** Operator-invoked demo setup uses the normal audited Core Action after its grants exist. */
export const ensureDemoCompanies = Effect.fn('DemoPermissions.ensureCompanies')(function* ensureDemoCompanies(
  shellUrl: string,
) {
  const client = yield* HttpClient.HttpClient;
  const available = yield* client.get(`${shellUrl}/.well-known/ontos-shell-runtime.json`).pipe(
    Effect.timeout(readinessTimeout),
    Effect.map(({ status }) => status === 200),
    Effect.orElseSucceed(() => false),
  );
  if (!available) {
    return yield* Console.log(
      'sales-demo companies: shell is not running; configuration will run after server startup',
    );
  }
  const signIn = yield* postJson(
    `${shellUrl}/shell-super-app-api/auth/sign-in`,
    SignInBodySchema,
    { email: headOfSales.email, password: yield* demoPassword },
    { origin: shellUrl },
  );
  if (signIn.status !== 200) {
    return yield* fail(`Company operator sign-in failed with HTTP ${signIn.status}`);
  }
  const response = yield* postJson(
    `${shellUrl}/shell-super-app-api/auth/identity/demo-companies`,
    DemoCompaniesPayload,
    { configuration: 'sales-rental-v1' },
    {
      cookie: sessionCookieHeader(signIn.cookies),
      'idempotency-key': `sales-demo-companies-${randomUUID()}`,
      origin: shellUrl,
    },
  );
  if (response.status !== 200) {
    return yield* fail(`Company configuration Action failed with HTTP ${response.status}`);
  }
  const { companies } = yield* HttpClientResponse.schemaBodyJson(DemoCompaniesResult)(response);
  for (const expected of [commercialDemoCompany, rentalDemoCompany]) {
    if (
      !companies.some(
        (company) => company.legalEntityId === expected.legalEntityId && company.legalName === expected.legalName,
      )
    ) {
      return yield* fail('Company configuration did not return the fixed demo companies');
    }
  }
  const names = companies.map((company) => company.legalName).join(', ');
  return yield* Console.log(`sales-demo companies: ${names} configured through audited Core Action`);
});

const issueBotKey = Effect.fn('DemoPermissions.issueBotKey')(function* issueBotKey(
  shellUrl: string,
  key: { readonly name: string; readonly principalId: string } = {
    name: 'agent-bot',
    principalId: agentBotPrincipal.principalId,
  },
) {
  const signIn = yield* postJson(
    `${shellUrl}/shell-super-app-api/auth/sign-in`,
    SignInBodySchema,
    { email: headOfSales.email, password: yield* demoPassword },
    { origin: shellUrl },
  );
  if (signIn.status !== 200) {
    return yield* fail(`Sign-in as ${headOfSales.email} failed with HTTP ${signIn.status}`);
  }
  const issued = yield* postJson(
    `${shellUrl}/shell-super-app-api/auth/identity/api-keys/managed`,
    IssueKeyBodySchema,
    { name: key.name, principalId: key.principalId },
    {
      cookie: sessionCookieHeader(signIn.cookies),
      'idempotency-key': `sales-demo-${key.name}-${randomUUID()}`,
      origin: shellUrl,
    },
  );
  if (issued.status !== 200) {
    const detail = yield* issued.text;
    return yield* fail(`Managed API key issuance failed with HTTP ${issued.status}: ${detail.slice(0, 300)}`);
  }
  const { secret } = yield* HttpClientResponse.schemaBodyJson(IssuedKeySchema)(issued);
  return secret;
});

const envLinePattern = /^(?<key>[A-Z][A-Z0-9_]*)=(?<value>.*)$/u;
const readEnvFile = (text: string): ReadonlyMap<string, string> =>
  new Map(
    text.split('\n').flatMap((line) => {
      const groups = envLinePattern.exec(line.trim())?.groups;
      const key = groups?.key;
      return key === undefined ? [] : [[key, groups?.value ?? ''] as const];
    }),
  );

const ensureBotKey = Effect.fn('DemoPermissions.ensureBotKey')(function* ensureBotKey(root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const { compositionUrl, shellUrl } = yield* demoAgentConfig;
  const envFile = path.join(root, ENV_FILE);
  const existing = (yield* fs.exists(envFile))
    ? readEnvFile(yield* fs.readFileString(envFile))
    : new Map<string, string>();
  const shellUp = yield* client.get(`${shellUrl}/.well-known/ontos-shell-runtime.json`).pipe(
    Effect.timeout(readinessTimeout),
    Effect.map(({ status }) => status === 200),
    Effect.orElseSucceed(() => false),
  );
  if (!shellUp) {
    return yield* Console.log(
      `sales-demo permissions: shell ${shellUrl} is not running; bot API key skipped (rerun once it is up)`,
    );
  }
  const revision = yield* compositionRevision(compositionUrl);
  const previous = Option.fromNullishOr(existing.get('ONTOS_AGENT_API_KEY')).pipe(
    Option.filter((value) => value.length > 0),
    Option.map((value) => Redacted.make(value)),
  );
  const reusable = yield* Option.match(Option.all([previous, revision]), {
    onNone: () => Effect.succeed(Option.none<Redacted.Redacted>()),
    onSome: ([key, current]) =>
      keyWorks(shellUrl, key, current).pipe(Effect.map((works) => (works ? Option.some(key) : Option.none()))),
  });
  const apiKey = yield* Option.match(reusable, { onNone: () => issueBotKey(shellUrl), onSome: Effect.succeed });
  const storefrontTarget = { audience: STOREFRONT_KEY_AUDIENCE, legalEntityId: eshopDemoLegalEntityId };
  const previousStorefront = Option.fromNullishOr(existing.get('ONTOS_STOREFRONT_API_KEY')).pipe(
    Option.filter((value) => value.length > 0),
    Option.map((value) => Redacted.make(value)),
  );
  const reusableStorefront = yield* Option.match(Option.all([previousStorefront, revision]), {
    onNone: () => Effect.succeed(Option.none<Redacted.Redacted>()),
    onSome: ([key, current]) =>
      keyWorks(shellUrl, key, current, storefrontTarget).pipe(
        Effect.map((works) => (works ? Option.some(key) : Option.none())),
      ),
  });
  const storefrontKey = yield* Option.match(reusableStorefront, {
    onNone: () =>
      issueBotKey(shellUrl, { name: storefrontPrincipal.displayName, principalId: storefrontPrincipal.principalId }),
    onSome: Effect.succeed,
  });
  const akrosTarget = { audience: STOREFRONT_KEY_AUDIENCE, legalEntityId: akrosStorefrontPrincipal.legalEntityId };
  const oldAkrosKey = existing.get('ONTOS_AKROS_STOREFRONT_API_KEY');
  const akrosReusable = oldAkrosKey === undefined ? false : yield* Option.match(revision, {
    onNone: () => Effect.succeed(false),
    onSome: (current) => keyWorks(shellUrl, Redacted.make(oldAkrosKey), current, akrosTarget),
  });
  const akrosKey = akrosReusable && oldAkrosKey !== undefined ? Redacted.make(oldAkrosKey) : yield* issueBotKey(shellUrl, {
    name: akrosStorefrontPrincipal.displayName, principalId: akrosStorefrontPrincipal.principalId,
  });
  const values = new Map([
    ...existing,
    ['ONTOS_AKROS_STOREFRONT_API_KEY', Redacted.value(akrosKey)],
    ['ONTOS_AKROS_STOREFRONT_PRINCIPAL_ID', akrosStorefrontPrincipal.principalId],
    ['ONTOS_AKROS_STOREFRONT_LEGAL_ENTITY_ID', akrosStorefrontPrincipal.legalEntityId],
    ['ONTOS_STOREFRONT_API_KEY', Redacted.value(storefrontKey)],
    ['ONTOS_STOREFRONT_PRINCIPAL_ID', storefrontPrincipal.principalId],
    ['ONTOS_STOREFRONT_LEGAL_ENTITY_ID', eshopDemoLegalEntityId],
    ['ONTOS_AGENT_API_KEY', Redacted.value(apiKey)],
    ['ONTOS_SHELL_URL', shellUrl],
    ['ONTOS_LEGAL_ENTITY_ID', demoLegalEntityId],
    ...Option.toArray(revision).map((current) => ['ONTOS_COMPOSITION_REVISION', current] as const),
  ]);
  const text = [
    '# Sales demo agent (scripts/demo/reset-permissions.mts). Local secrets; gitignored. Never commit.',
    ...[...values.entries()].map(([key, value]) => `${key}=${value}`),
    '',
  ].join('\n');
  yield* fs.writeFileString(envFile, text, { mode: 0o600 });
  yield* fs.chmod(envFile, 0o600);
  const verified = yield* Option.match(revision, {
    onNone: () => Effect.succeed('no composition revision'),
    onSome: (current) =>
      keyWorks(shellUrl, apiKey, current).pipe(
        Effect.map((works) => `gateway assertion for ${BOT_KEY_AUDIENCE}: ${works ? 'ok' : 'FAILED'}`),
      ),
  });
  const outcome = Option.match(reusable, { onNone: () => 'issued', onSome: () => 'reused' });
  yield* Console.log(`sales-demo permissions: agent-bot API key ${outcome} -> app/${ENV_FILE} (${verified})`);
  const storefrontVerified = yield* Option.match(revision, {
    onNone: () => Effect.succeed('no composition revision'),
    onSome: (current) =>
      keyWorks(shellUrl, storefrontKey, current, storefrontTarget).pipe(
        Effect.map((works) => `gateway assertion for ${STOREFRONT_KEY_AUDIENCE}: ${works ? 'ok' : 'FAILED'}`),
      ),
  });
  const storefrontOutcome = Option.match(reusableStorefront, { onNone: () => 'issued', onSome: () => 'reused' });
  return yield* Console.log(
    `sales-demo permissions: storefront API key ${storefrontOutcome} -> app/${ENV_FILE} ONTOS_STOREFRONT_API_KEY (${storefrontVerified})`,
  );
});

const main = (skipBot: boolean) =>
  Effect.gen(function* resetSalesDemoPermissions() {
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(workspaceRoot);
    const environment = resetChildEnvironment(yield* resetEnvironment);
    yield* validateResetEnvironment(environment);
    yield* upsertIdentityRows;
    yield* runBootstrapPort(root, environment);
    const { shellUrl } = yield* demoAgentConfig;
    yield* ensureDemoCompanies(shellUrl);
    if (!skipBot) {
      yield* liftBotKeyRateLimit;
      yield* ensureBotKey(root);
      yield* liftBotKeyRateLimit;
    }
    // AI principals A/B (ai-ab lane); a failure there must not hide the company and persona setup above.
    yield* setupAiProfiles(root, environment, { skipKeys: skipBot }).pipe(
      Effect.catch((failure) => Console.error(`ai-profiles failed (${String(failure)}); companies are configured`)),
    );
    // CRM.md §3: the CRM server's governed Party Registry intake principal (salespeople's new clients get an identity).
    yield* setupCrmPartyIntake(root, environment, { skipKeys: skipBot }).pipe(
      Effect.catch((failure) => Console.error(`crm-party-intake failed (${String(failure)}); companies are configured`)),
    );
  });

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

const command = Command.make(
  'sales-demo-permissions',
  { skipBot: Flag.Boolean('skip-bot').pipe(Flag.withDefault(false)) },
  ({ skipBot }) =>
    Layer.build(Layer.effectDiscard(main(skipBot).pipe(Effect.scoped)).pipe(Layer.provide(servicesLive))).pipe(
      Effect.scoped,
      Effect.asVoid,
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(DemoPermissionsError)(failure)
            ? `Sales demo permissions failed: ${failure.reason}`
            : `Sales demo permissions failed (${failure._tag})`,
        ),
      ),
    ),
);
const runtimeLive = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(environmentLive),
  Layer.provide(NodeServices.layer),
);
if (import.meta.main) {
  const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(runtimeLive)));
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
