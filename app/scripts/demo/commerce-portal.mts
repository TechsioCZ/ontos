#!/usr/bin/env node
/**
 * The Commerce portal's service identity and the demo stack's portal transport configuration. LOCAL ONLY,
 * idempotent. Runs against the local demo (`ONTOS_SHELL_URL`, `DATABASE_ADMIN_URL`).
 *
 *   node scripts/demo/commerce-portal.mts                       # identities + managed keys + app/.env values
 *   node scripts/demo/commerce-portal.mts --env-file <path>     # write the values to another env file
 *
 * Authorization v2 (ADR-0030) separated identity from authority: a principal row is identity, a managed key is
 * transport, and authority is either a Role Assignment (people) or a registered workload binding (a machine a
 * carrier admits). This script writes only the first two plus the demo stack's gateway *configuration* — it
 * writes no SpiceDB relationship and names no Role.
 *
 * The portal principal's authority is the reviewed workload binding the canonical seed writes
 * (`pnpm demo:reset-permissions`): its enrollment journey runs as `commerce.storefront-client`, and its
 * binding reserve/activate path runs as `core.identity-provider`. The service principals whose carriers declare
 * no workload key are reported as blockers, never granted a Role (a service cast as a person).
 *
 * Values written to `app/.env` (consumed by `scripts/demo/up.sh`):
 *   COMMERCE_CORE_IDENTITY_BASE_URL, COMMERCE_TENANT_CREDENTIALS, ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT,
 *   COMMERCE_PORTAL_AUTH_VERIFICATION_WORKLOAD_GRANTS, ONTOS_PRIVACY_GATEWAY_API_KEY,
 *   COMMERCE_MARKETING_ACTOR_PRINCIPAL_ID. Secrets stay in the file; the key is never printed.
 */
import { randomUUID } from 'node:crypto';

import { NodeServices } from '@effect/platform-node';
import { eq } from 'drizzle-orm';
import { Config, Console, Effect, Exit, FileSystem, Layer, Option, Path, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { Cookies, FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';

import { DatabaseConfig, parseDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { AuthDatabase, AuthDatabaseFromDatabaseConfigLive } from '../../apps/shell-super-app/api/auth/db/client.ts';
import { apikey } from '../../apps/shell-super-app/api/auth/db/schema.ts';
import { demoTenantId } from './fixture-ids.mts';
import {
  ensureMachinePrincipals,
  MachineIdentityError,
  machineIdentityEnvironment,
  shellIsServing,
  workspaceRootOf,
} from './machine-identity.mts';
import {
  COMMERCE_PORTAL_NAMESPACE,
  commercePortalPrincipal,
  kavarnaMarketAuthorityPrincipal,
  marketRetirementPrincipal,
  privacyConsentPrincipal,
  STOREFRONT_CLIENT_WORKLOAD,
  unmappedServicePrincipals,
} from './permissions.mts';

const SHELL_AUDIENCE = 'shell-super-app';
const PARTY_REGISTRY_AUDIENCE = 'party-registry';
const COMMERCE_AUDIENCE = 'commerce-customer-context';
const GATEWAY_CONTEXT_AUDIENCES = [COMMERCE_AUDIENCE, PARTY_REGISTRY_AUDIENCE, 'privacy'] as const;
const BINDING_OPERATIONS = ['activate', 'read', 'reserve', 'resolve', 'status'] as const;
const STAFF_NAMESPACE = 'ontos.staff.better-auth.v1';
const CREDENTIALS_VARIABLE = 'COMMERCE_TENANT_CREDENTIALS';
const ENV_FILE = '.env';
const OPERATOR_EMAIL = 'obchod@demo.ontos';

/** One Tenant's Commerce portal workload: a principal of the tenant and the key it transports (O73). */
export interface CommercePortalWorkload {
  readonly apiKeyName: string;
  readonly displayName: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/** The demo tenant's portal workload. Its authority is the registered binding, never this row. */
export const demoCommercePortalWorkload: CommercePortalWorkload = {
  apiKeyName: commercePortalPrincipal.apiKeyName,
  displayName: commercePortalPrincipal.displayName,
  legalEntityId: commercePortalPrincipal.legalEntityId,
  principalId: commercePortalPrincipal.principalId,
  tenantId: demoTenantId,
};

/**
 * The Shell's external identity provider deployment for the portal namespace: per Tenant, its own workload
 * Principal holds exactly the binding operations and gateway-context audiences, in that Tenant only. This is
 * the provider's workload-grant configuration (a canonical v2 boundary), not a SpiceDB relationship.
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

/** Commerce's verification grants: the provider workload each Tenant's portal authenticates as. */
export const commercePortalVerificationWorkloadGrants = (deployment = commercePortalExternalIdentityDeployment()) => ({
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
  providerEndpointAudience: COMMERCE_AUDIENCE,
});

const TenantCredentialsSchema = Schema.Record(
  Schema.String,
  Schema.Struct({
    coreIdentityApiKey: Schema.RedactedFromValue(Schema.String),
    gatewayApiKey: Schema.RedactedFromValue(Schema.String),
  }),
);
const TenantCredentialsJson = Schema.fromJsonString(TenantCredentialsSchema);
const SignInBodySchema = Schema.Struct({ email: Schema.String, password: Schema.Redacted(Schema.String) });
const IssueKeyBodySchema = Schema.Struct({
  name: Schema.String,
  principalId: Schema.toEncoded(Schema.String.pipe(Schema.brand('MachinePrincipalId'))),
  scope: Schema.Literal('tenant-managed'),
});
const CompositionSchema = Schema.Struct({ composition: Schema.Struct({ revision: Schema.String }) });
const IssuedKeySchema = Schema.Struct({ secret: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(1))) });
const GatewayBodySchema = Schema.Struct({
  audience: Schema.String,
  compositionRevision: Schema.String,
  legalEntityId: Schema.toEncoded(Schema.String.pipe(Schema.brand('LegalEntityId'))),
});
const SECURE_COOKIE_PREFIX = '__Secure-';
const shellConfig = Config.all({
  compositionUrl: Config.String('ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL').pipe(
    Config.withDefault('http://127.0.0.1:3041/active'),
  ),
  shellUrl: Config.String('ONTOS_SHELL_URL').pipe(Config.withDefault('http://localhost:3020')),
});

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

/** The Shell signs sessions into a `__Secure-` cookie the API-key instance reads without the prefix. */
const sessionCookieHeader = (cookies: Cookies.Cookies) => {
  const aliases = Object.entries(Cookies.toRecord(cookies)).flatMap(([name, value]) =>
    name.startsWith(SECURE_COOKIE_PREFIX) ? [[name.slice(SECURE_COOKIE_PREFIX.length), value] as const] : [],
  );
  return Cookies.toCookieHeader(Cookies.setAllUnsafe(cookies, aliases));
};

const compositionRevision = (compositionUrl: string) =>
  Effect.gen(function* readCompositionRevision() {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(compositionUrl).pipe(Effect.timeout('10 seconds'));
    const { composition } = yield* HttpClientResponse.schemaBodyJson(CompositionSchema)(response);
    return composition.revision;
  }).pipe(
    Effect.mapError(
      () =>
        new MachineIdentityError({
          reason: 'The active composition is not available; start the demo before issuing portal keys',
        }),
    ),
  );

const keyWorks = (
  shellUrl: string,
  apiKey: Redacted.Redacted,
  revision: string,
  target: { readonly audience: string; readonly legalEntityId: string },
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

/** Gateway assertions are single-use; lift Better Auth's per-key request limit (as for the other service keys). */
const liftKeyRateLimit = (apiKeyName: string) =>
  Effect.gen(function* updateServiceKeyRateLimit() {
    const { executor } = yield* AuthDatabase;
    yield* executor.update(apikey).set({ rateLimitEnabled: false, requestCount: 0 }).where(eq(apikey.name, apiKeyName));
  });

/** Reuses a key that still mints a gateway assertion, otherwise issues one through the Shell. */
const ensureKey = (input: {
  readonly audience: string;
  readonly existing: ReadonlyMap<string, string>;
  readonly identity: { readonly apiKeyName: string; readonly legalEntityId: string; readonly principalId: string };
  readonly password: Redacted.Redacted;
  readonly shellUrl: string;
  readonly variable: string;
}) =>
  Effect.gen(function* ensurePortalKey() {
    const { compositionUrl, shellUrl } = yield* shellConfig;
    const revision = yield* compositionRevision(compositionUrl);
    const previous = input.existing.get(input.variable);
    if (previous !== undefined && previous.length > 0) {
      const works = yield* keyWorks(shellUrl, Redacted.make(previous), revision, {
        audience: input.audience,
        legalEntityId: input.identity.legalEntityId,
      });
      if (works) {
        return Redacted.make(previous);
      }
    }
    const signIn = yield* postJson(
      `${shellUrl}/shell-super-app-api/auth/sign-in`,
      SignInBodySchema,
      { email: OPERATOR_EMAIL, password: input.password },
      { origin: shellUrl },
    );
    if (signIn.status !== 200) {
      return yield* new MachineIdentityError({
        reason: `Sign-in as ${OPERATOR_EMAIL} failed with HTTP ${String(signIn.status)}`,
      });
    }
    const issued = yield* postJson(
      `${shellUrl}/shell-super-app-api/auth/identity/api-keys/managed`,
      IssueKeyBodySchema,
      { name: input.identity.apiKeyName, principalId: input.identity.principalId, scope: 'tenant-managed' },
      {
        cookie: sessionCookieHeader(signIn.cookies),
        'idempotency-key': `commerce-portal-${input.identity.apiKeyName}-${randomUUID()}`,
        origin: shellUrl,
      },
    );
    if (issued.status !== 200) {
      const detail = yield* issued.text;
      return yield* new MachineIdentityError({
        reason: `API key issuance failed with HTTP ${String(issued.status)}: ${detail.slice(0, 300)}`,
      });
    }
    const { secret } = yield* HttpClientResponse.schemaBodyJson(IssuedKeySchema)(issued);
    return secret;
  });

const adminDatabaseConfigLive = Layer.effect(
  DatabaseConfig,
  Config.Redacted('DATABASE_ADMIN_URL').pipe(
    Effect.flatMap((url) => parseDatabaseConfig({ DATABASE_URL: Redacted.value(url) })),
    Effect.mapError(() => new MachineIdentityError({ reason: 'DATABASE_ADMIN_URL is not a local PostgreSQL URL' })),
  ),
);

/** Identity, transport and gateway configuration for the demo portal. Writes no relationship and no Role. */
export const provisionCommercePortal = (existing: ReadonlyMap<string, string> = new Map()) =>
  Effect.gen(function* runCommercePortal() {
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(workspaceRootOf(import.meta.url));
    const { password, shellUrl } = yield* machineIdentityEnvironment(root);
    yield* ensureMachinePrincipals([
      {
        displayName: commercePortalPrincipal.displayName,
        kind: 'service' as const,
        legalEntityId: commercePortalPrincipal.legalEntityId,
        principalId: commercePortalPrincipal.principalId,
        tenantId: demoTenantId,
      },
      {
        displayName: privacyConsentPrincipal.displayName,
        kind: 'service' as const,
        legalEntityId: privacyConsentPrincipal.legalEntityId,
        principalId: privacyConsentPrincipal.principalId,
        tenantId: demoTenantId,
      },
      {
        displayName: marketRetirementPrincipal.displayName,
        kind: 'service' as const,
        legalEntityId: marketRetirementPrincipal.legalEntityId,
        principalId: marketRetirementPrincipal.principalId,
        tenantId: demoTenantId,
      },
      {
        displayName: kavarnaMarketAuthorityPrincipal.displayName,
        kind: 'service' as const,
        legalEntityId: kavarnaMarketAuthorityPrincipal.legalEntityId,
        principalId: kavarnaMarketAuthorityPrincipal.principalId,
        tenantId: demoTenantId,
      },
    ]);
    if (!(yield* shellIsServing(shellUrl))) {
      return yield* new MachineIdentityError({
        reason: `The Shell at ${shellUrl} is not serving; its managed-key endpoint is how these identities are issued. Start the stack and re-run.`,
      });
    }
    yield* liftKeyRateLimit(commercePortalPrincipal.apiKeyName);
    const portalKey = yield* ensureKey({
      audience: PARTY_REGISTRY_AUDIENCE,
      existing,
      identity: commercePortalPrincipal,
      password,
      shellUrl,
      variable: CREDENTIALS_VARIABLE,
    });
    yield* liftKeyRateLimit(commercePortalPrincipal.apiKeyName);
    yield* liftKeyRateLimit(privacyConsentPrincipal.apiKeyName);
    const privacyKey = yield* ensureKey({
      audience: COMMERCE_AUDIENCE,
      existing,
      identity: privacyConsentPrincipal,
      password,
      shellUrl,
      variable: 'ONTOS_PRIVACY_GATEWAY_API_KEY',
    });
    yield* liftKeyRateLimit(privacyConsentPrincipal.apiKeyName);
    const credentials = yield* Schema.encodeEffect(TenantCredentialsJson)({
      [demoTenantId]: { coreIdentityApiKey: portalKey, gatewayApiKey: portalKey },
    });
    const deployment = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
      commercePortalExternalIdentityDeployment(),
    );
    const verification = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
      commercePortalVerificationWorkloadGrants(),
    );
    const values = new Map<string, string>([
      ['COMMERCE_CORE_IDENTITY_BASE_URL', `${shellUrl}/shell-super-app-api`],
      [CREDENTIALS_VARIABLE, credentials],
      ['ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT', deployment],
      ['COMMERCE_PORTAL_AUTH_VERIFICATION_WORKLOAD_GRANTS', verification],
      ['ONTOS_PRIVACY_GATEWAY_API_KEY', Redacted.value(privacyKey)],
      ['COMMERCE_MARKETING_ACTOR_PRINCIPAL_ID', commercePortalPrincipal.principalId],
    ]);
    yield* Console.log(
      `commerce-portal: portal + privacy identities ready; authority is the reviewed binding (${STOREFRONT_CLIENT_WORKLOAD}); run \`pnpm demo:reset-permissions\`.`,
    );
    for (const blocker of unmappedServicePrincipals) {
      yield* Console.log(
        `commerce-portal blocker: ${blocker.principalId} has no v2 authority — ${blocker.reason} Carrier: ${blocker.carrier}.`,
      );
    }
    return values;
  });

const persistConfiguration = (envFileOption: string | undefined) =>
  Effect.gen(function* writePortalConfiguration() {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const root = yield* path.fromFileUrl(workspaceRootOf(import.meta.url));
    const envFile = envFileOption ?? path.join(root, ENV_FILE);
    const existing = (yield* fs.exists(envFile))
      ? readEnv(yield* fs.readFileString(envFile))
      : new Map<string, string>();
    yield* writeEnv(envFile, yield* provisionCommercePortal(existing));
    return yield* Console.log(
      `commerce-portal: Core identity transport and Shell provider data -> ${envFile} (key never printed)`,
    );
  });

const command = Command.make(
  commercePortalPrincipal.apiKeyName,
  { envFile: Flag.String('env-file').pipe(Flag.optional) },
  ({ envFile }) => persistConfiguration(Option.getOrUndefined(envFile)),
);

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(AuthDatabaseFromDatabaseConfigLive.pipe(Layer.provide(adminDatabaseConfigLive))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(NodeServices.layer),
      Effect.tapError((problem) =>
        Console.error(
          Schema.is(MachineIdentityError)(problem)
            ? `commerce-portal failed: ${problem.reason}`
            : `commerce-portal failed (${problem._tag})`,
        ),
      ),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
