#!/usr/bin/env node
/**
 * The CRM's governed Party Registry intake principal (CRM.md §3/§4). LOCAL ONLY, idempotent.
 *
 *   node scripts/demo/crm-party-intake.mts               # principal + grants + managed API key
 *   node scripts/demo/crm-party-intake.mts --skip-keys   # principal + grants only
 *
 * Every active CRM client needs a Party Registry identity, but salespeople must not get registry access (its
 * customer list is company-wide). The CRM server therefore creates/reuses the registry Party + CUSTOMER
 * Counterparty itself, after checking the salesperson's CRM rights, authenticated as this non-human principal:
 *
 *   - member of every company that runs the CRM (Siampark 0021, Velkoobchod Hanák 0022);
 *   - party.registry module access + counterparty_manager/reader and party_identity_manager/reader/reviewer;
 *   - executor grants for exactly create-party, resolve-duplicate-candidate-create, counterparty-customer-onboard
 *     and add-contact-point. No archive/merge/update of Parties;
 *   - demo.crm read_all/write_all + apply-command, of which the CRM command guard allows it only LinkClientParty
 *     (the CRM re-reads the Counterparty it forwards before storing the link).
 *
 * The managed key lands in `app/.env.demo.local` as ONTOS_CRM_PARTY_INTAKE_API_KEY (with the principal id as
 * ONTOS_CRM_PARTY_INTAKE_PRINCIPAL_ID); the CRM server reads both there (or from its environment) on each intake, so
 * no CRM restart is needed after (re)issuing the key.
 */
import { randomUUID } from 'node:crypto';

import { toLegalEntityAccessObjectId } from '@app/core-runtime';
import { NodeServices } from '@effect/platform-node';
import { eq } from 'drizzle-orm';
import { Config, ConfigProvider, Console, Effect, Exit, FileSystem, Layer, Path, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { Cookies, FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http';

import { DatabaseConfig, parseDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { principals } from '../../packages/core-runtime/src/db/schema.ts';
import { AuthDatabase, AuthDatabaseFromDatabaseConfigLive } from '../../apps/shell-super-app/api/auth/db/client.ts';
import { apikey } from '../../apps/shell-super-app/api/auth/db/schema.ts';
import { discoverCurrentActions } from '../provision-current-action-authorization.mts';
import { resetChildEnvironment, resetEnvironment, validateResetEnvironment } from '../siampark/reset-configuration.mts';
import type { DemoResetChildEnvironment } from '../siampark/reset-configuration.mts';
import { writeBootstrapRelationships } from './bootstrap-relationships.mts';
import type { BootstrapRelationship } from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import { toScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
} from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionSourceLive } from '../../packages/core-runtime/src/modules/active-application-composition-source.node.ts';
import {
  principalRelationships,
  roleRelationship,
  demoPrincipalRoleKey,
  scopedDemoActionRelationships,
} from './permissions.mts';
import type { DemoAction } from './permissions.mts';
import { crmDemoLegalEntityId, demoId, demoTenantId, rentalDemoLegalEntityId } from './fixture-ids.mts';

const intakeName = 'crm-party-intake';

export const crmPartyIntakePrincipal = {
  apiKeyName: intakeName,
  displayName: 'CRM · zakládání klientů v Party Registry',
  envVar: 'ONTOS_CRM_PARTY_INTAKE_API_KEY',
  principalId: demoId('core.principal', intakeName),
} as const;

/** Companies whose CRM writes clients into the registry. */
export const crmIntakeLegalEntityIds: readonly string[] = [rentalDemoLegalEntityId, crmDemoLegalEntityId];

/**
 * The only Actions the intake runs: four registry Actions and the CRM apply-command, where the CRM command guard
 * lets this principal run `LinkClientParty` only (it reads the clients through demo.crm.read_all).
 */
export const crmIntakeActionKeys: readonly string[] = [
  'party.registry.create-party',
  'party.registry.resolve-duplicate-candidate-create',
  'party.registry.counterparty-customer-onboard',
  'party.registry.add-contact-point',
  'demo.crm.apply-command',
];
const crmIntakePermissions = ['demo.crm.read_all', 'demo.crm.write_all'] as const;

export const crmIntakeRelationships = (actions: readonly DemoAction[]): readonly BootstrapRelationship[] => {
  const { principalId } = crmPartyIntakePrincipal;
  const relationships = crmIntakeLegalEntityIds.flatMap((legalEntityId) => {
    const roleId = toScopedRoleObjectId({
      legalEntityId,
      roleKey: demoPrincipalRoleKey(principalId),
      tenantId: demoTenantId,
    });
    return [
      ...principalRelationships(
        principalId,
        {
          contextPermissions: { 'demo.crm': crmIntakePermissions },
          label: 'CRM Party intake',
          modules: { 'demo.crm': 'read', 'party.registry': 'read' },
        },
        actions,
        legalEntityId,
      ),
      ...['party_identity_manager', 'party_identity_reviewer'].map((relation) =>
        roleRelationship('tenant', demoTenantId, relation, roleId),
      ),
      roleRelationship(
        'legal_entity',
        toLegalEntityAccessObjectId(demoTenantId, legalEntityId) ?? '',
        'counterparty_manager',
        roleId,
      ),
      ...actions
        .filter(({ actionKey }) => crmIntakeActionKeys.includes(actionKey))
        .flatMap((action) => scopedDemoActionRelationships(principalId, action, legalEntityId)),
    ];
  });
  return [
    ...new Map(
      relationships.map((row) => [
        [
          row.resourceType,
          row.resourceId,
          row.relation,
          row.subjectType,
          row.subjectId,
          row.subjectRelation ?? '',
        ].join('|'),
        row,
      ]),
    ).values(),
  ];
};

class CrmIntakeError extends Schema.TaggedError<CrmIntakeError>()('CrmIntakeError', { reason: Schema.String }) {}
const fail = (reason: string) => new CrmIntakeError({ reason });

const ENV_FILE = '.env.demo.local';
const operatorEmail = 'obchod@demo.ontos';
const demoPassword = Config.Redacted('ONTOS_DEMO_PASSWORD').pipe(Config.withDefault(Redacted.make('password1234')));
const shellConfig = Config.all({
  compositionUrl: Config.String('ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL').pipe(
    Config.withDefault('http://127.0.0.1:3041/active'),
  ),
  shellUrl: Config.String('ONTOS_SHELL_URL').pipe(Config.withDefault('http://localhost:3020')),
});

const post = (url: string, body: Schema.Json, headers: Readonly<Record<string, string>>) =>
  Effect.gen(function* postJson() {
    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeaders({ 'x-correlation-id': randomUUID(), ...headers }),
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    );
  }).pipe(Effect.timeout('20 seconds'));

const CompositionSchema = Schema.Struct({ composition: Schema.Struct({ revision: Schema.String }) });
const IssuedKeySchema = Schema.Struct({ secret: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(1))) });
const SECURE_COOKIE_PREFIX = '__Secure-';

/** Issues (or reuses a working) managed API key and stores it in app/.env.demo.local (other lines kept). */
const ensureKey = Effect.fn('CrmPartyIntake.key')(function* ensureKey(root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const { compositionUrl, shellUrl } = yield* shellConfig;
  const revision = yield* client.get(compositionUrl).pipe(
    Effect.timeout('10 seconds'),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(CompositionSchema)),
    Effect.map(({ composition }) => composition.revision),
    Effect.mapError(() => fail(`composition ${compositionUrl} is not available; start the demo first`)),
  );
  const envFile = path.join(root, ENV_FILE);
  const text = (yield* fs.exists(envFile)) ? yield* fs.readFileString(envFile) : '';
  const lines = text.split('\n').filter((line) => line !== '');
  const previous = lines
    .find((line) => line.startsWith(`${crmPartyIntakePrincipal.envVar}=`))
    ?.slice(crmPartyIntakePrincipal.envVar.length + 1);
  const principalLine = `ONTOS_CRM_PARTY_INTAKE_PRINCIPAL_ID=${crmPartyIntakePrincipal.principalId}`;
  if (!lines.includes(principalLine)) {
    const kept = lines.filter((line) => !line.startsWith('ONTOS_CRM_PARTY_INTAKE_PRINCIPAL_ID='));
    yield* fs.writeFileString(envFile, [...kept, principalLine, ''].join('\n'), { mode: 0o600 });
    lines.splice(0, lines.length, ...kept, principalLine);
  }
  if (previous !== undefined && previous.length > 0) {
    const probe = yield* post(
      `${shellUrl}/shell-super-app-api/auth/api-key/gateway-context`,
      { audience: 'party-registry', compositionRevision: revision, legalEntityId: crmDemoLegalEntityId },
      { 'content-type': 'application/json', 'x-api-key': previous },
    ).pipe(
      Effect.map(({ status }) => status === 200),
      Effect.orElseSucceed(() => false),
    );
    if (probe) {
      return yield* Console.log(`crm-party-intake: API key reused (${crmPartyIntakePrincipal.envVar})`);
    }
  }
  const signIn = yield* post(
    `${shellUrl}/shell-super-app-api/auth/sign-in`,
    { email: operatorEmail, password: Redacted.value(yield* demoPassword) },
    { 'content-type': 'application/json', origin: shellUrl },
  );
  if (signIn.status !== 200) {
    return yield* fail(`Sign-in as ${operatorEmail} failed with HTTP ${signIn.status}`);
  }
  const aliases = Object.entries(Cookies.toRecord(signIn.cookies)).flatMap(([name, value]) =>
    name.startsWith(SECURE_COOKIE_PREFIX) ? [[name.slice(SECURE_COOKIE_PREFIX.length), value] as const] : [],
  );
  const cookie = Cookies.toCookieHeader(Cookies.setAllUnsafe(signIn.cookies, aliases));
  const issued = yield* post(
    `${shellUrl}/shell-super-app-api/auth/identity/api-keys/managed`,
    {
      name: crmPartyIntakePrincipal.apiKeyName,
      principalId: crmPartyIntakePrincipal.principalId,
      scope: 'tenant-managed',
    },
    {
      'content-type': 'application/json',
      cookie,
      'idempotency-key': `crm-party-intake-${randomUUID()}`,
      origin: shellUrl,
    },
  );
  if (issued.status !== 200) {
    const detail = yield* issued.text;
    return yield* fail(`API key issue failed with HTTP ${issued.status}: ${detail.slice(0, 300)}`);
  }
  const { secret } = yield* HttpClientResponse.schemaBodyJson(IssuedKeySchema)(issued);
  const next = [
    ...lines.filter((line) => !line.startsWith(`${crmPartyIntakePrincipal.envVar}=`)),
    `${crmPartyIntakePrincipal.envVar}=${Redacted.value(secret)}`,
    '',
  ].join('\n');
  yield* fs.writeFileString(envFile, next, { mode: 0o600 });
  yield* fs.chmod(envFile, 0o600);
  return yield* Console.log(`crm-party-intake: API key issued -> app/${ENV_FILE} (${crmPartyIntakePrincipal.envVar})`);
});

/** Gateway assertions are single-use; lift Better Auth's per-key request limit (as for the AI keys). */
const liftKeyRateLimit = Effect.gen(function* liftKeyRateLimit() {
  const { executor } = yield* AuthDatabase;
  yield* executor
    .update(apikey)
    .set({ rateLimitEnabled: false, requestCount: 0 })
    .where(eq(apikey.name, crmPartyIntakePrincipal.apiKeyName));
});

export const setupCrmPartyIntake = Effect.fn('CrmPartyIntake.setup')(function* setupCrmPartyIntake(
  root: string,
  environment: DemoResetChildEnvironment,
  options: { readonly skipKeys: boolean },
) {
  const { executor } = yield* AuthDatabase;
  yield* executor
    .insert(principals)
    .values({
      displayName: crmPartyIntakePrincipal.displayName,
      kind: 'service',
      principalId: crmPartyIntakePrincipal.principalId,
      status: 'active',
      tenantId: demoTenantId,
    })
    .onConflictDoUpdate({
      set: { displayName: crmPartyIntakePrincipal.displayName, status: 'active' },
      target: principals.principalId,
    });
  const source = yield* ActiveApplicationCompositionService;
  const actions = yield* discoverCurrentActions(yield* source.load);
  const relationships = yield* Effect.try(() => crmIntakeRelationships(actions));
  const granted = actions.filter((action) => crmIntakeActionKeys.includes(action.actionKey)).length;
  if (granted !== crmIntakeActionKeys.length) {
    return yield* fail(`expected ${crmIntakeActionKeys.length} party.registry Actions, discovered ${granted}`);
  }
  yield* writeBootstrapRelationships(root, environment, relationships);
  yield* Console.log(
    `crm-party-intake: principal ${crmPartyIntakePrincipal.principalId}, ${relationships.length} relationships`,
  );
  if (!options.skipKeys) {
    yield* liftKeyRateLimit;
    yield* ensureKey(root);
    yield* liftKeyRateLimit;
  }
  return yield* Effect.void;
});

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
  ActiveApplicationCompositionConfigLive.pipe(
    Layer.provide(ActiveApplicationCompositionSourceLive),
    Layer.provide(FetchHttpClient.layer),
  ),
);

const main = (skipKeys: boolean) =>
  Effect.gen(function* runCrmPartyIntake() {
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(workspaceRoot);
    const environment = resetChildEnvironment(yield* resetEnvironment);
    yield* validateResetEnvironment(environment);
    yield* setupCrmPartyIntake(root, environment, { skipKeys });
  });

const command = Command.make(
  intakeName,
  { skipKeys: Flag.Boolean('skip-keys').pipe(Flag.withDefault(false)) },
  ({ skipKeys }) =>
    Layer.build(Layer.effectDiscard(main(skipKeys).pipe(Effect.scoped)).pipe(Layer.provide(servicesLive))).pipe(
      Effect.scoped,
      Effect.asVoid,
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(CrmIntakeError)(failure)
            ? `CRM party intake failed: ${failure.reason}`
            : 'CRM party intake failed; inspect the typed cause',
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
