#!/usr/bin/env node
/**
 * The Commerce portal's service identity. Idempotent; runs against the local demo or, through the stage forwarders,
 * against stage (`ONTOS_SHELL_URL`, `DATABASE_ADMIN_URL`, SpiceDB from the environment).
 *
 *   node scripts/demo/commerce-portal.mts                          # principal + grants + managed key + Shell data
 *   node scripts/demo/commerce-portal.mts --env-file <path>        # write the values to another env file
 *
 * Stage, per Tenant workload (principal and grants come from that Tenant's provisioning, e.g. akros-playground-provision):
 *
 *   node scripts/demo/commerce-portal.mts --workload akros-playground --key-file <owner-only path>
 *       # issue (or reuse) the workload's managed key into the file; the key is never printed
 *   node scripts/demo/commerce-portal.mts --workload akros-playground --key-file <path> --bundle <in> --bundle-out <out>
 *       # add the Tenant's COMMERCE_TENANT_CREDENTIALS entry and its Shell and Commerce verification grants
 *
 * One non-human principal per Tenant; in the demo Tenant `commerce-portal`, member of the AKROS company only:
 *
 *   - its managed API key is both the Core identity transport credential and the vertical's gateway credential for
 *     owner calls: the Tenant's entry of `COMMERCE_TENANT_CREDENTIALS` (`coreIdentityApiKey`, `gatewayApiKey`);
 *   - module read access, tenant Party identity management for match/create, and counterparty management only in
 *     the selling company, plus executor grants for exactly the Actions the enrollment owners run;
 *   - the Shell's `ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT` names it as the attester of the portal namespace and
 *     grants it the reserve/activate/status/read/resolve/gateway-context workload operations.
 *
 * Every value lands in the env file (default `app/.env`, mode 600) so the next start of the Shell and the vertical
 * reads it; the key is never printed.
 */
import { randomUUID } from 'node:crypto';

import { NodeServices } from '@effect/platform-node';
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
import { Command, Flag } from 'effect/cli';
import { Cookies, FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import { DatabaseConfig, parseDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { principals } from '../../packages/core-runtime/src/db/schema.ts';
import { AuthDatabase, AuthDatabaseFromDatabaseConfigLive } from '../../apps/shell-super-app/api/auth/db/client.ts';
import { apikey } from '../../apps/shell-super-app/api/auth/db/schema.ts';
import { ExternalIdentityProviderConfigurationSchema } from '../../apps/shell-super-app/api/auth/external-identity-provider.ts';
import { CommercePortalAuthVerificationWorkloadGrantsSchema } from '../../verticals/commerce-customer-context/api/portal-auth/verification-http/workload-grants.ts';
import { discoverCurrentActions } from '../provision-current-action-authorization.mts';
import { resetChildEnvironment, resetEnvironment, validateResetEnvironment } from '../siampark/reset-configuration.mts';
import { writeBootstrapRelationships } from './bootstrap-relationships.mts';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
} from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionSourceLive } from '../../packages/core-runtime/src/modules/active-application-composition-source.node.ts';
import { demoTenantId } from './fixture-ids.mts';
import {
  COMMERCE_PORTAL_NAMESPACE,
  commercePortalActionKeys,
  commercePortalPrincipal,
  commercePortalRelationships,
  demoCommercePortalWorkload,
  privacyConsentAuthorityRelationships,
  privacyConsentPrincipal,
} from './permissions.mts';
import type { CommercePortalWorkload } from './permissions.mts';
import { akrosPlaygroundCommercePortal } from './akros-playground-policy.mts';

const STAFF_NAMESPACE = 'ontos.staff.better-auth.v1';
const SHELL_AUDIENCE = 'shell-super-app';
const PARTY_REGISTRY_AUDIENCE = 'party-registry';
const GATEWAY_CONTEXT_AUDIENCES = ['commerce-customer-context', PARTY_REGISTRY_AUDIENCE, 'privacy'] as const;
const BINDING_OPERATIONS = ['activate', 'read', 'reserve', 'resolve', 'status'] as const;

/** Every Tenant workload this repository provisions, by the name operators pass as `--workload`. */
export const commercePortalWorkloads = {
  'akros-playground': { operatorEmail: 'admin@akros.playground', workload: akrosPlaygroundCommercePortal },
  demo: { operatorEmail: 'obchod@demo.ontos', workload: demoCommercePortalWorkload },
} as const satisfies Readonly<
  Record<string, { readonly operatorEmail: string; readonly workload: CommercePortalWorkload }>
>;
type WorkloadName = keyof typeof commercePortalWorkloads;
/** The demo workload stays first: it is the provider deployment's attester. */
const workloadNames: readonly WorkloadName[] = ['demo', 'akros-playground'];

/**
 * The Shell's external identity provider deployment data for the portal namespace: per Tenant, its own workload
 * Principal holds exactly the binding operations and gateway-context audiences, in that Tenant only.
 */
export const commercePortalExternalIdentityDeployment = (
  workloads: readonly [CommercePortalWorkload, ...CommercePortalWorkload[]] = [demoCommercePortalWorkload],
) => {
  const [attester] = workloads;
  return {
    attesterPrincipalId: attester.principalId,
    authenticationNamespaceId: COMMERCE_PORTAL_NAMESPACE,
    grants: workloads.flatMap(({ principalId, tenantId }) => {
      const workload = {
        receivingAudience: SHELL_AUDIENCE,
        targetAuthenticationNamespaceId: COMMERCE_PORTAL_NAMESPACE,
        tenantId,
        workloadAuthenticationNamespaceId: STAFF_NAMESPACE,
        workloadPrincipalId: principalId,
      };
      return [
        ...BINDING_OPERATIONS.map((operation) => ({ ...workload, operation })),
        ...GATEWAY_CONTEXT_AUDIENCES.map((targetAudience) => ({
          ...workload,
          operation: 'gateway-context' as const,
          targetAudience,
        })),
      ];
    }),
    providerEndpointAudience: SHELL_AUDIENCE,
  };
};

export const commercePortalVerificationWorkloadGrants = (
  deployment: Pick<
    Schema.Codec.Encoded<typeof ExternalIdentityProviderConfigurationSchema>,
    'authenticationNamespaceId' | 'grants' | 'providerEndpointAudience'
  > = commercePortalExternalIdentityDeployment(),
) => ({
  grants: deployment.grants
    .filter(
      (grant) =>
        grant.receivingAudience === deployment.providerEndpointAudience &&
        grant.targetAuthenticationNamespaceId === deployment.authenticationNamespaceId,
    )
    .filter(
      (grant, index, candidates) =>
        candidates.findIndex(
          (candidate) =>
            candidate.tenantId === grant.tenantId &&
            candidate.workloadPrincipalId === grant.workloadPrincipalId &&
            candidate.workloadAuthenticationNamespaceId === grant.workloadAuthenticationNamespaceId,
        ) === index,
    )
    .map((grant) => ({
      commerceAuthenticationNamespaceId: deployment.authenticationNamespaceId,
      operation: 'commerce-portal-authentication.verify-external-authentication.v1' as const,
      receivingAudience: grant.receivingAudience,
      tenantId: grant.tenantId,
      workloadAuthenticationNamespaceId: grant.workloadAuthenticationNamespaceId,
      workloadPrincipalId: grant.workloadPrincipalId,
    })),
  providerEndpointAudience: GATEWAY_CONTEXT_AUDIENCES[0],
});

class CommercePortalError extends Schema.TaggedError<CommercePortalError>()('CommercePortalError', {
  reason: Schema.String,
}) {}
const fail = (reason: string) => new CommercePortalError({ reason });
const metadataUnavailable = () => fail('Commerce release secrets require valid Shell provider workload metadata');

/** Run on the assembled bundle before upload; the receiving owner grant is never a manual extra. */
export const commercePortalReleaseSecrets = Effect.fn('CommercePortal.releaseSecrets')(function* releaseSecrets(
  bundle: Readonly<Record<string, Readonly<Record<string, string>>>>,
): Effect.fn.Return<Readonly<Record<string, Readonly<Record<string, string>>>>, CommercePortalError> {
  const commerce = bundle['commerce-customer-context'];
  const shell = bundle['shell-super-app'];
  if (commerce === undefined || shell === undefined) {
    return yield* fail('Commerce release secrets require the Commerce and Shell units');
  }
  const deployment = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(ExternalIdentityProviderConfigurationSchema),
    {
      onExcessProperty: 'error',
    },
  )(shell.ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT).pipe(Effect.mapError(metadataUnavailable));
  const grants = commercePortalVerificationWorkloadGrants(deployment);
  if (deployment.authenticationNamespaceId !== COMMERCE_PORTAL_NAMESPACE || grants.grants.length === 0) {
    return yield* metadataUnavailable();
  }
  const verification = yield* Schema.decodeEffect(CommercePortalAuthVerificationWorkloadGrantsSchema)(grants).pipe(
    Effect.mapError(metadataUnavailable),
  );
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(CommercePortalAuthVerificationWorkloadGrantsSchema))(
    verification,
  ).pipe(Effect.mapError(metadataUnavailable));
  return {
    ...bundle,
    'commerce-customer-context': {
      ...commerce,
      COMMERCE_PORTAL_AUTH_VERIFICATION_WORKLOAD_GRANTS: encoded,
    },
  };
});

const operatorPasswords = {
  'akros-playground': Config.Redacted('ONTOS_AKROS_PLAYGROUND_PASSWORD').pipe(
    Config.withDefault(Redacted.make('password1234')),
  ),
  demo: Config.Redacted('ONTOS_DEMO_PASSWORD').pipe(Config.withDefault(Redacted.make('password1234'))),
} satisfies Readonly<Record<WorkloadName, Config.Config<Redacted.Redacted>>>;
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
const CREDENTIALS_VARIABLE = 'COMMERCE_TENANT_CREDENTIALS';
const TenantCredentialsSchema = Schema.Record(
  Schema.String,
  Schema.Struct({
    coreIdentityApiKey: Schema.RedactedFromValue(Schema.String),
    gatewayApiKey: Schema.RedactedFromValue(Schema.String),
  }),
);
const TenantCredentialsJson = Schema.fromJsonString(TenantCredentialsSchema);

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
  operator: WorkloadName = 'demo',
) {
  const { operatorEmail } = commercePortalWorkloads[operator];
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
    { email: operatorEmail, password: Redacted.value(yield* operatorPasswords[operator]) },
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
    { name: identity.apiKeyName, principalId: identity.principalId, scope: 'tenant-managed' },
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

const main = (existing: ReadonlyMap<string, string>, configuration?: Readonly<Record<string, string>>) =>
  Effect.gen(function* runCommercePortal() {
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(workspaceRoot);
    const environment = { ...configuration, ...resetChildEnvironment(yield* resetEnvironment) };
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
    const source = yield* ActiveApplicationCompositionService;
    const actions = yield* discoverCurrentActions(yield* source.load);
    const missing = commercePortalActionKeys.filter((key) => !actions.some(({ actionKey }) => actionKey === key));
    if (missing.length > 0) {
      return yield* fail(`Published Commerce enrollment Actions missing: ${missing.join(', ')}`);
    }
    const relationships = yield* Effect.try(() => commercePortalRelationships(actions));
    yield* writeBootstrapRelationships(root, environment, relationships);
    yield* Console.log(
      `commerce-portal: principal ${commercePortalPrincipal.principalId}, ${relationships.length} relationships`,
    );
    yield* liftKeyRateLimit(commercePortalPrincipal.apiKeyName);
    const previous = Option.getOrUndefined(
      Option.flatMapNullishOr(
        Schema.decodeUnknownOption(TenantCredentialsJson)(existing.get(CREDENTIALS_VARIABLE) ?? ''),
        (credentials) => credentials[demoTenantId]?.coreIdentityApiKey,
      ),
    );
    const key = yield* ensureKey(previous, commercePortalPrincipal, PARTY_REGISTRY_AUDIENCE);
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
    const privacyRelationships = yield* Effect.try(() => privacyConsentAuthorityRelationships(actions));
    yield* writeBootstrapRelationships(root, environment, privacyRelationships);
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
    const credentials = yield* Schema.encodeEffect(TenantCredentialsJson)({
      [demoTenantId]: { coreIdentityApiKey: key, gatewayApiKey: key },
    });
    return new Map([
      ['COMMERCE_CORE_IDENTITY_BASE_URL', `${shellUrl}/shell-super-app-api`],
      [CREDENTIALS_VARIABLE, credentials],
      ['ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT', deployment],
      ['COMMERCE_PORTAL_AUTH_VERIFICATION_WORKLOAD_GRANTS', verificationGrants],
      ['ONTOS_PRIVACY_GATEWAY_API_KEY', privacyKey],
      ['COMMERCE_MARKETING_ACTOR_PRINCIPAL_ID', commercePortalPrincipal.principalId],
    ]);
  });

type OwnerBundle = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * Adds one Tenant's workload key to `COMMERCE_TENANT_CREDENTIALS` and derives, from every Tenant in that map, the
 * Shell's per-Tenant workload grants and Commerce's verification grants. A map entry for a Tenant this repository does
 * not provision is refused rather than granted.
 */
export const commercePortalTenantBundle = Effect.fn('CommercePortal.tenantBundle')(function* tenantBundle(
  bundle: OwnerBundle,
  name: WorkloadName,
  key: Redacted.Redacted,
): Effect.fn.Return<OwnerBundle, CommercePortalError> {
  const commerce = bundle['commerce-customer-context'];
  const shell = bundle['shell-super-app'];
  if (commerce === undefined || shell === undefined) {
    return yield* fail('The owner bundle requires the Commerce and Shell units');
  }
  const current = commerce[CREDENTIALS_VARIABLE];
  const existing =
    current === undefined
      ? {}
      : yield* Schema.decodeUnknownEffect(TenantCredentialsJson)(current).pipe(
          Effect.mapError(() => fail(`${CREDENTIALS_VARIABLE} in the owner bundle is malformed`)),
        );
  const { workload } = commercePortalWorkloads[name];
  const credentials = {
    ...existing,
    [workload.tenantId]: { coreIdentityApiKey: key, gatewayApiKey: key },
  };
  const known = workloadNames.map((candidate) => commercePortalWorkloads[candidate].workload);
  const unknown = Object.keys(credentials).filter((tenantId) => !known.some((row) => row.tenantId === tenantId));
  if (unknown.length > 0) {
    return yield* fail(`${CREDENTIALS_VARIABLE} names Tenants without a provisioned workload: ${unknown.join(', ')}`);
  }
  const [first, ...rest] = known.filter(({ tenantId }) => tenantId in credentials);
  if (first === undefined) {
    return yield* fail('No Tenant workload is configured');
  }
  const deployment = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
    commercePortalExternalIdentityDeployment([first, ...rest]),
  ).pipe(Effect.mapError(() => fail('The Shell provider deployment could not be encoded')));
  const encoded = yield* Schema.encodeEffect(TenantCredentialsJson)(credentials).pipe(
    Effect.mapError(() => fail(`${CREDENTIALS_VARIABLE} could not be encoded`)),
  );
  return yield* commercePortalReleaseSecrets({
    ...bundle,
    'commerce-customer-context': { ...commerce, [CREDENTIALS_VARIABLE]: encoded },
    'shell-super-app': { ...shell, ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT: deployment },
  });
});

const OwnerBundleJson = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
);

/** Stage: issue or reuse one Tenant workload's managed key, kept only in an owner-only file. */
const persistWorkloadKey = (name: WorkloadName, keyFile: string) =>
  Effect.gen(function* writeWorkloadKey() {
    const fs = yield* FileSystem.FileSystem;
    const { workload } = commercePortalWorkloads[name];
    const previous = (yield* fs.exists(keyFile)) ? (yield* fs.readFileString(keyFile)).trim() : '';
    yield* liftKeyRateLimit(workload.apiKeyName);
    const key = yield* ensureKey(
      previous === '' ? undefined : Redacted.make(previous),
      workload,
      PARTY_REGISTRY_AUDIENCE,
      name,
    );
    yield* liftKeyRateLimit(workload.apiKeyName);
    yield* fs.writeFileString(keyFile, `${Redacted.value(key)}\n`, { mode: 0o600 });
    yield* fs.chmod(keyFile, 0o600);
    yield* Console.log(`commerce-portal: ${name} workload key -> ${keyFile}`);
  });

/** Stage: write the owner bundle with the Tenant's credential entry and grants; the values are never printed. */
const persistTenantBundle = (name: WorkloadName, keyFile: string, input: string, output: string) =>
  Effect.gen(function* writeTenantBundle() {
    const fs = yield* FileSystem.FileSystem;
    const key = (yield* fs.readFileString(keyFile)).trim();
    if (key.length < 16) {
      return yield* fail(`The ${name} workload key file is empty`);
    }
    const bundle = yield* Schema.decodeUnknownEffect(OwnerBundleJson)(yield* fs.readFileString(input)).pipe(
      Effect.mapError(() => fail('The owner bundle must be a JSON record of owner units')),
    );
    const updated = yield* commercePortalTenantBundle(bundle, name, Redacted.make(key));
    const text = yield* Schema.encodeEffect(OwnerBundleJson)(updated).pipe(
      Effect.mapError(() => fail('The owner bundle could not be encoded')),
    );
    yield* fs.writeFileString(output, text, { flag: 'wx', mode: 0o600 });
    return yield* Console.log(`commerce-portal: ${name} workload added; owner bundle -> ${output}`);
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
export const commercePortalServicesLive = Layer.mergeAll(
  AuthDatabaseFromDatabaseConfigLive.pipe(Layer.provide(adminDatabaseConfigLive)),
  FetchHttpClient.layer,
  ActiveApplicationCompositionConfigLive.pipe(
    Layer.provide(ActiveApplicationCompositionSourceLive),
    Layer.provide(FetchHttpClient.layer),
  ),
);

/** Compose once at the caller's executable root; both services and the program share the explicit configuration. */
export const commercePortalProvisionLive = (environment: Readonly<Record<string, string>>) =>
  commercePortalServicesLive.pipe(Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))));

/** Provision without dotenv I/O; callers supply commercePortalProvisionLive(environment) at their executable root. */
export const provisionCommercePortal = (
  environment: Readonly<Record<string, string>>,
  existing: ReadonlyMap<string, string> = new Map(),
) => main(existing, environment).pipe(Effect.scoped);

const persistConfiguration = (envFileOption: string | undefined) =>
  Effect.gen(function* writePortalConfiguration() {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const root = yield* path.fromFileUrl(workspaceRoot);
    const envFile = envFileOption ?? path.join(root, '.env');
    const existing = (yield* fs.exists(envFile))
      ? readEnv(yield* fs.readFileString(envFile))
      : new Map<string, string>();
    yield* writeEnv(envFile, yield* main(existing));
    yield* Console.log(`commerce-portal: Core identity transport and Shell provider data -> ${envFile}`);
  });

const selectedRun = (flags: {
  readonly bundle: Option.Option<string>;
  readonly bundleOut: Option.Option<string>;
  readonly envFile: Option.Option<string>;
  readonly keyFile: Option.Option<string>;
  readonly workload: Option.Option<WorkloadName>;
}) => {
  if (Option.isNone(flags.workload)) {
    return persistConfiguration(Option.getOrUndefined(flags.envFile));
  }
  const name = flags.workload.value;
  if (Option.isNone(flags.keyFile)) {
    return Effect.fail(fail('--workload requires --key-file'));
  }
  return Option.isNone(flags.bundle) && Option.isNone(flags.bundleOut)
    ? persistWorkloadKey(name, flags.keyFile.value)
    : Effect.fail(fail('--bundle and --bundle-out go together'));
};

const failureReport = (failure: { readonly _tag: string }) =>
  Console.error(
    Schema.is(CommercePortalError)(failure)
      ? `Commerce portal identity failed: ${failure.reason}`
      : `Commerce portal identity failed (${failure._tag}); secrets withheld`,
  );

const command = Command.make(
  commercePortalPrincipal.apiKeyName,
  {
    bundle: Flag.String('bundle').pipe(Flag.optional),
    bundleOut: Flag.String('bundle-out').pipe(Flag.optional),
    envFile: Flag.String('env-file').pipe(Flag.optional),
    keyFile: Flag.String('key-file').pipe(Flag.optional),
    workload: Flag.Literals('workload', workloadNames).pipe(Flag.optional),
  },
  (flags) =>
    // The bundle step is file-only: it runs on the operator's machine without the database or the Shell.
    Option.isSome(flags.workload) &&
    Option.isSome(flags.keyFile) &&
    Option.isSome(flags.bundle) &&
    Option.isSome(flags.bundleOut)
      ? persistTenantBundle(flags.workload.value, flags.keyFile.value, flags.bundle.value, flags.bundleOut.value).pipe(
          Effect.asVoid,
          Effect.tapError(failureReport),
        )
      : Layer.build(
          Layer.effectDiscard(selectedRun(flags).pipe(Effect.scoped)).pipe(Layer.provide(commercePortalServicesLive)),
        ).pipe(Effect.scoped, Effect.asVoid, Effect.tapError(failureReport)),
);
if (import.meta.main) {
  const runtimeLive = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
    Layer.provide(environmentLive),
    Layer.provide(NodeServices.layer),
  );
  const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(runtimeLive)));
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
