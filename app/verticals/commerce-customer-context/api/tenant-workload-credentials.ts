import { TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { Config, ConfigProvider, Effect, Option, Redacted, Schema } from 'effect';

/**
 * Commerce acts for each Tenant through that Tenant's own service Principal. A Shell API key resolves to exactly one
 * Principal and a Principal belongs to exactly one Tenant, so one key can never serve two Tenants: the Shell verifies
 * every workload call under the key's Tenant.
 *
 * `COMMERCE_TENANT_CREDENTIALS` is a JSON object keyed by Tenant ID:
 *
 *   { "<tenant id>": { "coreIdentityApiKey": "…", "gatewayApiKey": "…" } }
 *
 * - `coreIdentityApiKey` is presented to the Core identity endpoint (binding reserve, activate, read, resolve);
 * - `gatewayApiKey` mints the owner gateway assertions Commerce presents to Party Registry, Privacy, Payment Term
 *   Catalog, Price Group Catalog, Pricing, Catalog and to Commerce itself.
 *
 * Every call selects the pair by the Tenant of the Attempt or request it serves. A Tenant without an entry fails closed
 * with {@link CommerceTenantWorkloadCredentialUnavailable}; there is no default key and no other Tenant's key is used.
 */
export const COMMERCE_TENANT_CREDENTIALS_KEY = 'COMMERCE_TENANT_CREDENTIALS';

const MINIMUM_KEY_LENGTH = 16;
const TenantCredentialsSchema = Schema.fromJsonString(
  Schema.Record(
    TenantIdSchema,
    Schema.Struct({
      coreIdentityApiKey: Schema.RedactedFromValue(Schema.Trim.check(Schema.isMinLength(MINIMUM_KEY_LENGTH))),
      gatewayApiKey: Schema.RedactedFromValue(Schema.Trim.check(Schema.isMinLength(MINIMUM_KEY_LENGTH))),
    }),
  ),
);

export interface CommerceTenantWorkloadCredential {
  readonly coreIdentityApiKey: Redacted.Redacted;
  readonly gatewayApiKey: Redacted.Redacted;
}

/** Commerce has no workload credential for the Tenant it was asked to act for. */
export class CommerceTenantWorkloadCredentialUnavailable extends Schema.TaggedError<CommerceTenantWorkloadCredentialUnavailable>()(
  'CommerceTenantWorkloadCredentialUnavailable',
  { reason: Schema.Literal('No Commerce workload credential is configured for this tenant') },
) {}

export interface CommerceTenantWorkloadCredentials {
  readonly forTenant: (
    tenantId: string,
  ) => Effect.Effect<CommerceTenantWorkloadCredential, CommerceTenantWorkloadCredentialUnavailable>;
  /** The configured Tenants, for readiness and diagnostics only; never a selection fallback. */
  readonly tenantIds: readonly string[];
}

// The decoder's own message would quote the secret value, so only a fixed reason is reported.
const malformed = new Config.ConfigError(
  new ConfigProvider.SourceError({
    message: `${COMMERCE_TENANT_CREDENTIALS_KEY} must be a JSON object of tenant IDs to { coreIdentityApiKey, gatewayApiKey }`,
  }),
);

export const makeCommerceTenantWorkloadCredentials = (
  entries: Readonly<Record<string, CommerceTenantWorkloadCredential>>,
): CommerceTenantWorkloadCredentials => {
  const byTenant = new Map(Object.entries(entries));
  return Object.freeze({
    forTenant: (tenantId: string) => {
      const credential = byTenant.get(tenantId);
      return credential === undefined
        ? Effect.fail(
            new CommerceTenantWorkloadCredentialUnavailable({
              reason: 'No Commerce workload credential is configured for this tenant',
            }),
          )
        : Effect.succeed(credential);
    },
    tenantIds: Object.freeze([...byTenant.keys()]),
  });
};

/**
 * The deployment's Tenant credential map. Missing configuration is a `ConfigError` (callers install their fail-closed
 * leaf); a present but malformed or empty map is a `ConfigError` too, never a partial map.
 */
export const commerceTenantWorkloadCredentials: Config.Config<CommerceTenantWorkloadCredentials> = Config.Redacted(
  COMMERCE_TENANT_CREDENTIALS_KEY,
).pipe(
  Config.mapEffect((json) =>
    Option.match(Schema.decodeUnknownOption(TenantCredentialsSchema)(Redacted.value(json)), {
      onNone: () => Effect.fail(malformed),
      onSome: (decoded) =>
        Object.keys(decoded).length === 0
          ? Effect.fail(malformed)
          : Effect.succeed(makeCommerceTenantWorkloadCredentials(decoded)),
    }),
  ),
);

/** The gateway key of one Tenant, read from the deployment map; an unconfigured Tenant fails closed. */
export const commerceTenantGatewayApiKey = (
  tenantId: string,
): Effect.Effect<Redacted.Redacted, Config.ConfigError | CommerceTenantWorkloadCredentialUnavailable> =>
  commerceTenantWorkloadCredentials.pipe(
    Effect.flatMap((credentials) => credentials.forTenant(tenantId)),
    Effect.map(({ gatewayApiKey }) => gatewayApiKey),
  );
