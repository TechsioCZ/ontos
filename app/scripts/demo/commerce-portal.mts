#!/usr/bin/env node
/**
 * The Commerce portal's service identity. Idempotent; runs against the local demo or, through the stage forwarders,
 * against stage (`ONTOS_SHELL_URL`, `DATABASE_ADMIN_URL`, SpiceDB from the environment).
 *
 *   node scripts/demo/commerce-portal.mts                          # principal + grants + managed key + Shell data
 *   node scripts/demo/commerce-portal.mts --env-file <path>        # write the values to another env file
 *
 * One non-human principal, `commerce-portal`, member of the AKROS company only:
 *
 *   - its managed API key is both the Core identity transport credential (`COMMERCE_CORE_IDENTITY_API_KEY`) and the
 *     vertical's gateway credential for owner calls (`ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY`);
 *   - read access to party.registry (party matching is `module.access`) and commerce.customer-context, plus executor
 *     grants for exactly the Actions the enrollment owners run;
 *   - the Shell's `ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT` names it as the attester of the portal namespace and
 *     grants it the reserve/activate/status/read/resolve/gateway-context workload operations.
 *
 * Every value lands in the env file (default `app/.env`, mode 600) so the next start of the Shell and the vertical
 * reads it; the key is never printed.
 */
import { randomUUID } from 'node:crypto';

import { NodeServices } from '@effect/platform-node';
import { toSpiceDbActionObjectId } from '@app/core-runtime/actions/runtime-wiring';
import { eq } from 'drizzle-orm';
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
import { DatabaseConfig, parseDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { toIdentityNamespaceAccessObjectId } from '../../packages/core-runtime/src/permissions/context-access.ts';
import { principals } from '../../packages/core-runtime/src/db/schema.ts';
import { AuthDatabase, AuthDatabaseFromDatabaseConfigLive } from '../../apps/shell-super-app/api/auth/db/client.ts';
import { apikey } from '../../apps/shell-super-app/api/auth/db/schema.ts';
import { discoverCurrentActions } from '../provision-current-action-authorization.mts';
import { resetChildEnvironment, resetEnvironment, validateResetEnvironment } from '../siampark/reset-configuration.mts';
import { writeAiRelationships } from './ai-profiles.mts';
import type { AiRelationship } from './ai-profiles.mts';
import { akrosDemoLegalEntityId, demoId, demoTenantId } from './fixture-ids.mts';
import { principalRelationships } from './permissions.mts';
import type { DemoRole } from './permissions.mts';

const COMMERCE_PORTAL = 'commerce-portal';

export const commercePortalPrincipal = {
  apiKeyName: COMMERCE_PORTAL,
  displayName: 'Commerce · zákaznický portál',
  legalEntityId: akrosDemoLegalEntityId,
  principalId: demoId('core.principal', COMMERCE_PORTAL),
} as const;

export const privacyConsentPrincipal = {
  apiKeyName: 'privacy-consent-authority',
  displayName: 'Privacy · Commerce consent authority reader',
  legalEntityId: akrosDemoLegalEntityId,
  principalId: demoId('core.principal', 'privacy-consent-authority'),
} as const;

const COMMERCE_PORTAL_NAMESPACE = 'ontos.commerce.portal.better-auth.v1';
const STAFF_NAMESPACE = 'ontos.staff.better-auth.v1';
const SHELL_AUDIENCE = 'shell-super-app';
const GATEWAY_CONTEXT_AUDIENCES = ['commerce-customer-context', 'party-registry', 'privacy'] as const;
const BINDING_OPERATIONS = ['activate', 'read', 'reserve', 'resolve', 'status'] as const;

/** Module access only; the Actions below are granted one by one. */
const commercePortalRole: DemoRole = {
  identityAdmin: false,
  label: 'Commerce portal (service)',
  modules: { 'commerce.customer-context': 'read', 'party.registry': 'read', 'privacy.core': 'read' },
};

/** The Actions the enrollment owners run on behalf of a customer. */
export const commercePortalActionKeys: readonly string[] = [
  'core.identity.reserve-principal-binding',
  'core.identity.activate-principal-binding',
  'core.identity.change-principal-binding-status',
  'privacy.core.create-privacy-subject',
  'privacy.core.create-notice-version',
  'privacy.core.record-notice-provision',
  'privacy.core.consent-self-service',
  'party.registry.create-party',
  'party.registry.counterparty-customer-onboard',
  'party.registry.add-contact-point',
  // Customer self-service: the owner bridge edits the customer's own Party and contact points.
  'party.registry.update-party',
  'party.registry.update-contact-point',
  'commerce.customer-context.ensure-retail-customer-profile',
  'commerce.customer-context.bind-retail-portal-profile',
  'commerce.customer-context.claim-portal-enrollment-transition',
  'commerce.customer-context.record-portal-enrollment-outcome',
];

interface DiscoveredAction {
  readonly actionKey: string;
  readonly provisioning: 'explicit' | 'tenant_membership_default';
}

const relationshipKey = (relationship: AiRelationship) =>
  [
    relationship.resourceType,
    relationship.resourceId,
    relationship.relation,
    relationship.subjectType,
    relationship.subjectId,
  ].join('|');

export const commercePortalRelationships = (actions: readonly DiscoveredAction[]): readonly AiRelationship[] => {
  const { legalEntityId, principalId } = commercePortalPrincipal;
  const namespace = toIdentityNamespaceAccessObjectId(demoTenantId, COMMERCE_PORTAL_NAMESPACE) ?? '';
  const relationships: AiRelationship[] = [
    {
      relation: 'tenant',
      resourceId: namespace,
      resourceType: 'identity_namespace',
      subjectId: demoTenantId,
      subjectType: 'tenant',
    },
    {
      relation: 'provisioner',
      resourceId: namespace,
      resourceType: 'identity_namespace',
      subjectId: principalId,
      subjectType: 'principal',
    },
    ...principalRelationships(principalId, commercePortalRole, actions, legalEntityId),
  ];
  for (const { actionKey, provisioning } of actions.filter((action) =>
    commercePortalActionKeys.includes(action.actionKey),
  )) {
    const action = toSpiceDbActionObjectId(actionKey);
    if (provisioning === 'explicit') {
      relationships.push({
        relation: 'restriction',
        resourceId: action,
        resourceType: 'action',
        subjectId: action,
        subjectType: 'action',
      });
    }
    relationships.push({
      relation: 'executor',
      resourceId: action,
      resourceType: 'action',
      subjectId: principalId,
      subjectType: 'principal',
    });
  }
  return [...new Map(relationships.map((relationship) => [relationshipKey(relationship), relationship])).values()];
};

/** Privacy can resolve only the two Commerce authority facts, not read customer groups or execute Actions. */
export const privacyConsentAuthorityRelationships = (actions: readonly DiscoveredAction[]): readonly AiRelationship[] =>
  principalRelationships(
    privacyConsentPrincipal.principalId,
    {
      contextPermissions: {
        'commerce.customer-context': ['customer.consent.resolve_authority', 'customer.notice.resolve_authority'],
      },
      identityAdmin: false,
      label: 'Privacy consent authority reader',
      modules: { 'commerce.customer-context': 'read' },
      restrictedModules: ['commerce.customer-context'],
    },
    actions,
    privacyConsentPrincipal.legalEntityId,
  );

/** The Shell's external identity provider deployment data for the portal namespace. */
export const commercePortalExternalIdentityDeployment = () => {
  const workload = {
    receivingAudience: SHELL_AUDIENCE,
    targetAuthenticationNamespaceId: COMMERCE_PORTAL_NAMESPACE,
    tenantId: demoTenantId,
    workloadAuthenticationNamespaceId: STAFF_NAMESPACE,
    workloadPrincipalId: commercePortalPrincipal.principalId,
  };
  return {
    attesterPrincipalId: commercePortalPrincipal.principalId,
    authenticationNamespaceId: COMMERCE_PORTAL_NAMESPACE,
    grants: [
      ...BINDING_OPERATIONS.map((operation) => ({ ...workload, operation })),
      ...GATEWAY_CONTEXT_AUDIENCES.map((targetAudience) => ({
        ...workload,
        operation: 'gateway-context',
        targetAudience,
      })),
    ],
    providerEndpointAudience: SHELL_AUDIENCE,
  };
};

export const commercePortalVerificationWorkloadGrants = () => ({
  grants: [
    {
      commerceAuthenticationNamespaceId: COMMERCE_PORTAL_NAMESPACE,
      operation: 'commerce-portal-authentication.verify-external-authentication.v1',
      receivingAudience: SHELL_AUDIENCE,
      tenantId: demoTenantId,
      workloadAuthenticationNamespaceId: STAFF_NAMESPACE,
      workloadPrincipalId: commercePortalPrincipal.principalId,
    },
  ],
  providerEndpointAudience: GATEWAY_CONTEXT_AUDIENCES[0],
});

class CommercePortalError extends Schema.TaggedError<CommercePortalError>()('CommercePortalError', {
  reason: Schema.String,
}) {}
const fail = (reason: string) => new CommercePortalError({ reason });

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
const KEY_VARIABLE = 'COMMERCE_CORE_IDENTITY_API_KEY';

const envLine = /^(?<key>[A-Z][A-Z0-9_]*)=(?<value>.*)$/u;
const readEnv = (text: string): ReadonlyMap<string, string> =>
  new Map(
    text.split('\n').flatMap((line) => {
      const groups = envLine.exec(line)?.groups;
      return groups?.key === undefined ? [] : [[groups.key, groups.value ?? ''] as const];
    }),
  );

/** Replaces or appends exactly the given keys; every other line stays as it was. */
const writeEnv = Effect.fn('CommercePortal.writeEnv')(function* writeEnv(
  envFile: string,
  values: ReadonlyMap<string, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = (yield* fs.exists(envFile)) ? yield* fs.readFileString(envFile) : '';
  const kept = text
    .split('\n')
    .filter((line) => !values.has(envLine.exec(line)?.groups?.key ?? ''))
    .join('\n')
    .replace(/\n+$/u, '');
  const appended = [...values.entries()].map(([key, value]) => `${key}=${value}`).join('\n');
  yield* fs.writeFileString(envFile, `${kept}\n${appended}\n`, { mode: 0o600 });
  yield* fs.chmod(envFile, 0o600);
});

/** Reuses a key that still mints a gateway assertion, otherwise issues one through the Shell. */
const ensureKey = Effect.fn('CommercePortal.key')(function* ensureKey(
  previous: Redacted.Redacted | undefined,
  identity: { readonly apiKeyName: string; readonly legalEntityId: string; readonly principalId: string },
  audience: 'party-registry' | 'commerce-customer-context',
) {
  const client = yield* HttpClient.HttpClient;
  const { compositionUrl, shellUrl } = yield* shellConfig;
  const revision = yield* client.get(compositionUrl).pipe(
    Effect.timeout('10 seconds'),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(CompositionSchema)),
    Effect.map(({ composition }) => composition.revision),
    Effect.mapError(() => fail(`composition ${compositionUrl} is not available; start the demo first`)),
  );
  if (previous !== undefined) {
    const works = yield* post(
      `${shellUrl}/shell-super-app-api/auth/api-key/gateway-context`,
      {
        audience,
        compositionRevision: revision,
        legalEntityId: identity.legalEntityId,
      },
      { 'content-type': 'application/json', 'x-api-key': Redacted.value(previous) },
    ).pipe(
      Effect.map(({ status }) => status === 200),
      Effect.orElseSucceed(() => false),
    );
    if (works) {
      yield* Console.log('commerce-portal: API key reused');
      return previous;
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
    { name: identity.apiKeyName, principalId: identity.principalId },
    {
      'content-type': 'application/json',
      cookie,
      'idempotency-key': `commerce-portal-${randomUUID()}`,
      origin: shellUrl,
    },
  );
  if (issued.status !== 200) {
    const detail = yield* issued.text;
    return yield* fail(`API key issue failed with HTTP ${issued.status}: ${detail.slice(0, 300)}`);
  }
  const { secret } = yield* HttpClientResponse.schemaBodyJson(IssuedKeySchema)(issued);
  yield* Console.log('commerce-portal: API key issued');
  return secret;
});

/** Gateway assertions are single-use; lift Better Auth's per-key request limit (as for the other service keys). */
const liftKeyRateLimit = (apiKeyName: string) =>
  Effect.gen(function* updateServiceKeyRateLimit() {
    const { executor } = yield* AuthDatabase;
    yield* executor.update(apikey).set({ rateLimitEnabled: false, requestCount: 0 }).where(eq(apikey.name, apiKeyName));
  });

const workspaceRoot = new URL('../..', import.meta.url);

const main = (envFileOption: string | undefined) =>
  Effect.gen(function* runCommercePortal() {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const root = yield* path.fromFileUrl(workspaceRoot);
    const environment = resetChildEnvironment(yield* resetEnvironment);
    yield* validateResetEnvironment(environment);
    const { executor } = yield* AuthDatabase;
    yield* executor
      .insert(principals)
      .values({
        displayName: commercePortalPrincipal.displayName,
        kind: 'service',
        principalId: commercePortalPrincipal.principalId,
        status: 'active',
        tenantId: demoTenantId,
      })
      .onConflictDoUpdate({
        set: { displayName: commercePortalPrincipal.displayName, status: 'active' },
        target: principals.principalId,
      });
    const actions = yield* discoverCurrentActions(root);
    const missing = commercePortalActionKeys.filter((key) => !actions.some(({ actionKey }) => actionKey === key));
    if (missing.length > 0) {
      // A newer owner may not be deployed yet; its grants follow on the next run.
      yield* Console.warn(`commerce-portal: not in the current module contracts yet: ${missing.join(', ')}`);
    }
    const relationships = commercePortalRelationships(actions);
    yield* writeAiRelationships(root, environment, relationships);
    yield* Console.log(
      `commerce-portal: principal ${commercePortalPrincipal.principalId}, ${relationships.length} relationships`,
    );
    const envFile = envFileOption ?? path.join(root, '.env');
    const existing = (yield* fs.exists(envFile))
      ? readEnv(yield* fs.readFileString(envFile))
      : new Map<string, string>();
    yield* liftKeyRateLimit(commercePortalPrincipal.apiKeyName);
    const previous = existing.get(KEY_VARIABLE);
    const key = Redacted.value(
      yield* ensureKey(
        previous === undefined || previous === '' ? undefined : Redacted.make(previous),
        commercePortalPrincipal,
        'party-registry',
      ),
    );
    yield* liftKeyRateLimit(commercePortalPrincipal.apiKeyName);
    const { shellUrl } = yield* shellConfig;
    yield* executor
      .insert(principals)
      .values({
        displayName: privacyConsentPrincipal.displayName,
        kind: 'service',
        principalId: privacyConsentPrincipal.principalId,
        status: 'active',
        tenantId: demoTenantId,
      })
      .onConflictDoUpdate({
        set: { displayName: privacyConsentPrincipal.displayName, status: 'active' },
        target: principals.principalId,
      });
    const privacyRelationships = privacyConsentAuthorityRelationships(actions);
    yield* writeAiRelationships(root, environment, privacyRelationships);
    const previousPrivacyKey = existing.get('ONTOS_PRIVACY_GATEWAY_API_KEY');
    const privacyKey = Redacted.value(
      yield* ensureKey(
        previousPrivacyKey === undefined || previousPrivacyKey === '' ? undefined : Redacted.make(previousPrivacyKey),
        privacyConsentPrincipal,
        'commerce-customer-context',
      ),
    );
    yield* liftKeyRateLimit(privacyConsentPrincipal.apiKeyName);
    const deployment = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
      commercePortalExternalIdentityDeployment(),
    );
    const verificationGrants = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
      commercePortalVerificationWorkloadGrants(),
    );
    yield* writeEnv(
      envFile,
      new Map([
        ['COMMERCE_CORE_IDENTITY_BASE_URL', `${shellUrl}/shell-super-app-api`],
        [KEY_VARIABLE, key],
        ['ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY', key],
        ['ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT', deployment],
        ['COMMERCE_PORTAL_AUTH_VERIFICATION_WORKLOAD_GRANTS', verificationGrants],
        ['ONTOS_PRIVACY_GATEWAY_API_KEY', privacyKey],
        ['COMMERCE_MARKETING_ACTOR_PRINCIPAL_ID', commercePortalPrincipal.principalId],
      ]),
    );
    yield* Console.log(`commerce-portal: Core identity transport and Shell provider data -> ${envFile}`);
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

const command = Command.make(COMMERCE_PORTAL, { envFile: Flag.String('env-file').pipe(Flag.optional) }, ({ envFile }) =>
  Layer.build(
    Layer.effectDiscard(main(Option.getOrUndefined(envFile)).pipe(Effect.scoped)).pipe(Layer.provide(servicesLive)),
  ).pipe(
    Effect.scoped,
    Effect.asVoid,
    Effect.tapError((failure) =>
      Console.error(
        Schema.is(CommercePortalError)(failure)
          ? `Commerce portal identity failed: ${failure.reason}`
          : 'Commerce portal identity failed; see the error above',
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
