import { Array as Arr, Context, DateTime, Duration, Effect, Layer, Option, Order, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';

import { CloudflareApiError } from './cloudflare-api-error.mts';

/**
 * Minimal adapter over the Cloudflare v4 REST API for the stage account objects the cut-over owns:
 * the remotely managed Tunnel, the Workers VPC services behind it, the Hyperdrive config, the
 * Worker script inventory, the zone-level Origin CA certificates the tunnel's private origins
 * present, and the cost guards (Access, the stage zone's WAF rules, the usage notification and
 * the Workers usage the GraphQL Analytics API reports). Paths and bodies follow what Wrangler 4 sends for the same objects
 * (`wrangler vpc service create`, `wrangler hyperdrive create`). Responses are decoded, never logged;
 * the tunnel connector token and the origin password stay redacted until the request body is built.
 */
export const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4';

const REQUEST_TIMEOUT = Duration.seconds(30);
const PAGE_SIZE = 50;

export interface CloudflareAccount {
  readonly accountId: string;
  readonly apiToken: Redacted.Redacted;
}

export const CloudflareCredentials = Context.Service<CloudflareAccount>(
  '@app/scripts/ops/cloudflare-api/CloudflareCredentials',
);

const optional = <S extends Schema.Top>(schema: S) => Schema.OptionFromOptionalNullOr(schema);

const EnvelopeSchema = Schema.Struct({
  errors: optional(Schema.Array(Schema.Struct({ code: Schema.Number, message: Schema.String }))),
  result: Schema.Unknown,
  success: Schema.Boolean,
});

const TunnelSchema = Schema.Struct({ id: Schema.NonEmptyString, name: Schema.String, status: Schema.String });
export type CloudflareTunnel = typeof TunnelSchema.Type;

const VpcServiceSchema = Schema.Struct({
  host: Schema.Struct({
    hostname: optional(Schema.String),
    resolver_network: optional(Schema.Struct({ tunnel_id: Schema.String })),
  }),
  http_port: optional(Schema.Number),
  https_port: optional(Schema.Number),
  name: Schema.String,
  service_id: Schema.NonEmptyString,
  tcp_port: optional(Schema.Number),
  tls_settings: optional(Schema.Struct({ cert_verification_mode: optional(Schema.String) })),
  type: Schema.String,
});
export type CloudflareVpcService = typeof VpcServiceSchema.Type;

const HyperdriveSchema = Schema.Struct({
  caching: optional(Schema.Struct({ disabled: optional(Schema.Boolean) })),
  id: Schema.NonEmptyString,
  name: Schema.String,
  origin: Schema.Struct({
    database: optional(Schema.String),
    scheme: optional(Schema.String),
    service_id: optional(Schema.String),
    user: optional(Schema.String),
  }),
  origin_connection_limit: optional(Schema.Number),
});
export type CloudflareHyperdrive = typeof HyperdriveSchema.Type;

const OriginCertificateSchema = Schema.Struct({
  certificate: Schema.NonEmptyString,
  expires_on: Schema.String,
  id: Schema.NonEmptyString,
});
export type CloudflareOriginCertificate = typeof OriginCertificateSchema.Type;

const WorkerScriptSchema = Schema.Struct({ id: Schema.String });

const ZoneSchema = Schema.Struct({ id: Schema.NonEmptyString, name: Schema.String });

const RulesetSummarySchema = Schema.Struct({ id: Schema.NonEmptyString, kind: Schema.String, phase: Schema.String });

const RulesetRuleSchema = Schema.Struct({
  action: Schema.String,
  description: optional(Schema.String),
  enabled: optional(Schema.Boolean),
  expression: Schema.String,
  id: Schema.NonEmptyString,
  ref: optional(Schema.String),
});
export type CloudflareRulesetRule = typeof RulesetRuleSchema.Type;

const RulesetSchema = Schema.Struct({ id: Schema.NonEmptyString, rules: optional(Schema.Array(RulesetRuleSchema)) });
export type CloudflareRuleset = typeof RulesetSchema.Type;

const AccessPolicySchema = Schema.Struct({
  decision: Schema.String,
  id: Schema.NonEmptyString,
  include: Schema.Array(Schema.Json),
  name: Schema.String,
});
export type CloudflareAccessPolicy = typeof AccessPolicySchema.Type;

const ServiceTokenSchema = Schema.Struct({ client_id: Schema.String, id: Schema.NonEmptyString, name: Schema.String });
export type CloudflareServiceToken = typeof ServiceTokenSchema.Type;

const ServiceTokenCredentialsSchema = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.RedactedFromValue(Schema.NonEmptyString),
  id: Schema.NonEmptyString,
});

const AccessAppSchema = Schema.Struct({
  domain: Schema.String,
  id: Schema.NonEmptyString,
  name: Schema.String,
  policies: optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
});
export type CloudflareAccessApp = typeof AccessAppSchema.Type;

const AlertPolicySchema = Schema.Struct({
  alert_type: Schema.String,
  enabled: Schema.Boolean,
  filters: optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  id: Schema.NonEmptyString,
  mechanisms: optional(Schema.Record(Schema.String, Schema.Array(Schema.Struct({ id: Schema.String })))),
  name: Schema.String,
});
export type CloudflareAlertPolicy = typeof AlertPolicySchema.Type;

const AlertPolicyIdSchema = Schema.Struct({ id: Schema.NonEmptyString });

const WorkersUsageSchema = Schema.Struct({
  data: Schema.OptionFromNullOr(
    Schema.Struct({
      viewer: Schema.Struct({
        accounts: Schema.Array(
          Schema.Struct({
            workersInvocationsAdaptive: Schema.Array(
              Schema.Struct({
                dimensions: Schema.Struct({ scriptName: Schema.String }),
                sum: Schema.Struct({ cpuTimeUs: Schema.Number, requests: Schema.Number }),
              }),
            ),
          }),
        ),
      }),
    }),
  ),
  errors: optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
});

/** One Worker script's invocations and CPU time in a window. */
export interface ScriptUsage {
  readonly cpuTimeMs: number;
  readonly requests: number;
  readonly scriptName: string;
}

/** The whole account's Workers usage in a window, with each script's share, busiest first. */
export interface WorkersUsage {
  readonly cpuTimeMs: number;
  readonly requests: number;
  readonly scripts: readonly ScriptUsage[];
}

/** One rule of a zone phase entrypoint, owned by the cut-over and found again by its `ref`. */
export interface RulesetRuleSpec {
  readonly action: 'block';
  readonly description: string;
  readonly enabled: boolean;
  readonly expression: string;
  readonly ref: string;
}

export type AccessRule =
  | { readonly email: { readonly email: string } }
  | { readonly everyone: Readonly<Record<string, never>> }
  | { readonly service_token: { readonly token_id: string } };

/** A reusable Access policy; `non_identity` admits a service token without a user login. */
export interface AccessPolicySpec {
  readonly decision: 'allow' | 'bypass' | 'non_identity';
  readonly include: readonly AccessRule[];
  readonly name: string;
}

/** A self-hosted Access application in front of a hostname, or one path of it. */
export interface AccessAppSpec {
  readonly domain: string;
  readonly name: string;
  readonly policies: readonly { readonly id: string; readonly precedence: number }[];
}

export interface AlertPolicySpec {
  readonly alert_type: string;
  readonly enabled: boolean;
  readonly filters: Readonly<Record<string, readonly string[]>>;
  readonly mechanisms: { readonly email: readonly { readonly id: string }[] };
  readonly name: string;
}

export interface ServiceTokenCredentials {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted;
  readonly id: string;
}

const WORKERS_USAGE_QUERY = `query WorkersUsage($accountTag: string!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $since, datetime_leq: $until }) {
        dimensions { scriptName }
        sum { requests cpuTimeUs }
      }
    }
  }
}`;
const WorkerSecretSchema = Schema.Struct({ name: Schema.String });

/**
 * How Workers VPC checks an origin certificate: `verify_full` checks its chain and that it names the fetch URL's
 * hostname; `disabled` encrypts without checking, for an origin that only has a self-signed certificate.
 */
export const VpcCertificateVerificationSchema = Schema.Literals(['disabled', 'verify_full']);
export type VpcCertificateVerification = typeof VpcCertificateVerificationSchema.Type;

/**
 * A Workers VPC service reached by hostname through the tunnel's resolver network. An `http`
 * service is only ever reached over HTTPS on `port`.
 */
export interface VpcServiceSpec {
  readonly certificateVerification: VpcCertificateVerification;
  readonly hostname: string;
  readonly name: string;
  readonly port: number;
  readonly tunnelId: string;
  readonly type: 'http' | 'tcp';
}

export interface HyperdriveSpec {
  readonly database: Redacted.Redacted;
  readonly name: string;
  readonly originConnectionLimit: number;
  readonly password: Redacted.Redacted;
  readonly serviceId: string;
  readonly user: string;
}

/** An ECC certificate the Cloudflare Origin CA signs for the CSR's key, valid for 15 years. */
export interface OriginCertificateSpec {
  readonly csr: string;
  readonly hostnames: readonly string[];
}

export const ORIGIN_CERTIFICATE_VALIDITY_DAYS = 5475;

interface OriginCertificateBody {
  readonly csr: string;
  readonly hostnames: readonly string[];
  readonly request_type: 'origin-ecc';
  readonly requested_validity: number;
}

interface TunnelCreateBody {
  readonly config_src: 'cloudflare';
  readonly name: string;
}

interface VpcServiceBody {
  readonly app_protocol?: 'postgresql';
  readonly host: { readonly hostname: string; readonly resolver_network: { readonly tunnel_id: string } };
  readonly https_port?: number;
  readonly name: string;
  readonly tcp_port?: number;
  readonly tls_settings: { readonly cert_verification_mode: VpcCertificateVerification };
  readonly type: 'http' | 'tcp';
}

/** The check Workers VPC applies when a service names none. */
export const VPC_CERT_VERIFICATION_MODE: VpcCertificateVerification = 'verify_full';

/** The body Wrangler sends for `hyperdrive create --service-id … --caching-disabled`; secrets are revealed only here. */
const hyperdriveBody = (spec: HyperdriveSpec) => ({
  caching: { disabled: true },
  name: spec.name,
  origin: {
    database: Redacted.value(spec.database),
    password: Redacted.value(spec.password),
    scheme: 'postgresql',
    service_id: spec.serviceId,
    user: spec.user,
  },
  origin_connection_limit: spec.originConnectionLimit,
});

const accessAppBody = (spec: AccessAppSpec) => ({
  domain: spec.domain,
  name: spec.name,
  policies: spec.policies,
  session_duration: '24h',
  type: 'self_hosted',
});

/** Every JSON body the adapter sends; each is built from a typed spec. */
type RequestBody =
  | AccessPolicySpec
  | AlertPolicySpec
  | ReturnType<typeof accessAppBody>
  | ReturnType<typeof hyperdriveBody>
  | RulesetRuleSpec
  | OriginCertificateBody
  | TunnelCreateBody
  | VpcServiceBody
  | { readonly duration: string; readonly name: string }
  | { readonly rules: readonly RulesetRuleSpec[] }
  | Record<string, never>;

const serviceTokenCredentials = ({
  client_id,
  client_secret,
  id,
}: typeof ServiceTokenCredentialsSchema.Type): ServiceTokenCredentials => ({
  clientId: client_id,
  clientSecret: client_secret,
  id,
});

/** Sums the GraphQL rows (one per script and sample interval) per script and for the account. */
const summarizeUsage = (
  rows: readonly {
    readonly dimensions: { readonly scriptName: string };
    readonly sum: { readonly cpuTimeUs: number; readonly requests: number };
  }[],
): WorkersUsage => {
  const perScript = new Map<string, { cpuTimeUs: number; requests: number }>();
  for (const { dimensions, sum } of rows) {
    const current = perScript.get(dimensions.scriptName) ?? { cpuTimeUs: 0, requests: 0 };
    perScript.set(dimensions.scriptName, {
      cpuTimeUs: current.cpuTimeUs + sum.cpuTimeUs,
      requests: current.requests + sum.requests,
    });
  }
  const scripts = Arr.sortWith(
    [...perScript].map(([scriptName, { cpuTimeUs, requests }]) => ({
      cpuTimeMs: Duration.toMillis(Duration.micros(BigInt(Math.round(cpuTimeUs)))),
      requests,
      scriptName,
    })),
    ({ requests }) => -requests,
    Order.Number,
  );
  return {
    cpuTimeMs: scripts.reduce((total, { cpuTimeMs }) => total + cpuTimeMs, 0),
    requests: scripts.reduce((total, { requests }) => total + requests, 0),
    scripts,
  };
};

export interface CloudflareApiService {
  readonly accessApps: Effect.Effect<readonly CloudflareAccessApp[], CloudflareApiError>;
  readonly accessPolicies: Effect.Effect<readonly CloudflareAccessPolicy[], CloudflareApiError>;
  readonly accessServiceTokens: Effect.Effect<readonly CloudflareServiceToken[], CloudflareApiError>;
  /** Adds a rule to an existing zone ruleset and returns the ruleset. */
  readonly addRulesetRule: (
    zoneId: string,
    rulesetId: string,
    rule: RulesetRuleSpec,
  ) => Effect.Effect<CloudflareRuleset, CloudflareApiError>;
  readonly alertPolicies: Effect.Effect<readonly CloudflareAlertPolicy[], CloudflareApiError>;
  readonly createAccessApp: (spec: AccessAppSpec) => Effect.Effect<CloudflareAccessApp, CloudflareApiError>;
  readonly createAccessPolicy: (spec: AccessPolicySpec) => Effect.Effect<CloudflareAccessPolicy, CloudflareApiError>;
  readonly createAccessServiceToken: (name: string) => Effect.Effect<ServiceTokenCredentials, CloudflareApiError>;
  readonly createAlertPolicy: (spec: AlertPolicySpec) => Effect.Effect<string, CloudflareApiError>;
  readonly createHyperdrive: (spec: HyperdriveSpec) => Effect.Effect<CloudflareHyperdrive, CloudflareApiError>;
  /** Needs the zone permission "SSL and Certificates: Edit"; the Origin CA API is not account-scoped. */
  readonly createOriginCertificate: (
    spec: OriginCertificateSpec,
  ) => Effect.Effect<CloudflareOriginCertificate, CloudflareApiError>;
  readonly createTunnel: (name: string) => Effect.Effect<CloudflareTunnel, CloudflareApiError>;
  readonly createVpcService: (spec: VpcServiceSpec) => Effect.Effect<CloudflareVpcService, CloudflareApiError>;
  /**
   * Creates a zone phase entrypoint holding `rules`. Only for a phase without one: a PUT on an existing
   * entrypoint replaces every rule in it.
   */
  readonly createZoneEntrypoint: (
    zoneId: string,
    phase: string,
    rules: readonly RulesetRuleSpec[],
  ) => Effect.Effect<CloudflareRuleset, CloudflareApiError>;
  readonly findTunnel: (name: string) => Effect.Effect<Option.Option<CloudflareTunnel>, CloudflareApiError>;
  readonly findZoneId: (name: string) => Effect.Effect<Option.Option<string>, CloudflareApiError>;
  readonly hyperdrives: Effect.Effect<readonly CloudflareHyperdrive[], CloudflareApiError>;
  /** A new client secret for an existing service token; the client ID stays. */
  readonly rotateAccessServiceToken: (tokenId: string) => Effect.Effect<ServiceTokenCredentials, CloudflareApiError>;
  readonly ruleset: (zoneId: string, rulesetId: string) => Effect.Effect<CloudflareRuleset, CloudflareApiError>;
  readonly tunnel: (tunnelId: string) => Effect.Effect<CloudflareTunnel, CloudflareApiError>;
  readonly tunnelToken: (tunnelId: string) => Effect.Effect<Redacted.Redacted, CloudflareApiError>;
  readonly updateAccessApp: (
    appId: string,
    spec: AccessAppSpec,
  ) => Effect.Effect<CloudflareAccessApp, CloudflareApiError>;
  readonly updateAccessPolicy: (
    policyId: string,
    spec: AccessPolicySpec,
  ) => Effect.Effect<CloudflareAccessPolicy, CloudflareApiError>;
  readonly updateAlertPolicy: (policyId: string, spec: AlertPolicySpec) => Effect.Effect<string, CloudflareApiError>;
  /** Updates one rule in place, leaving the ruleset's other rules untouched. */
  readonly updateRulesetRule: (
    zoneId: string,
    rulesetId: string,
    ruleId: string,
    rule: RulesetRuleSpec,
  ) => Effect.Effect<CloudflareRuleset, CloudflareApiError>;
  readonly vpcServices: Effect.Effect<readonly CloudflareVpcService[], CloudflareApiError>;
  readonly workerScriptNames: Effect.Effect<ReadonlySet<string>, CloudflareApiError>;
  /** The names, never the values, of a Worker's secrets. */
  readonly workerSecretNames: (scriptName: string) => Effect.Effect<ReadonlySet<string>, CloudflareApiError>;
  /** The whole account's Workers invocations and CPU time from `since` to `until` (at most a month), per script. */
  readonly workersUsage: (since: DateTime.Utc, until: DateTime.Utc) => Effect.Effect<WorkersUsage, CloudflareApiError>;
  /** The zone rulesets; a phase entrypoint has kind `zone`. */
  readonly zoneRulesets: (
    zoneId: string,
  ) => Effect.Effect<readonly (typeof RulesetSummarySchema.Type)[], CloudflareApiError>;
}

export const CloudflareApi = Context.Service<CloudflareApiService>('@app/scripts/ops/cloudflare-api/CloudflareApi');

/** The request body Wrangler sends for `vpc service create --hostname … --tunnel-id …` (with `--https-port` for HTTP). */
export const vpcServiceBody = (spec: VpcServiceSpec): VpcServiceBody => {
  const host = { hostname: spec.hostname, resolver_network: { tunnel_id: spec.tunnelId } };
  const tlsSettings = { cert_verification_mode: spec.certificateVerification };
  return spec.type === 'tcp'
    ? { app_protocol: 'postgresql', host, name: spec.name, tcp_port: spec.port, tls_settings: tlsSettings, type: 'tcp' }
    : { host, https_port: spec.port, name: spec.name, tls_settings: tlsSettings, type: 'http' };
};

const describeErrors = (errors: Option.Option<readonly { readonly code: number; readonly message: string }[]>) =>
  Option.getOrElse(errors, () => [])
    .map(({ code, message }) => `${String(code)} ${message}`)
    .join('; ');

const makeCloudflareApi = Effect.gen(function* makeCloudflareApi() {
  const client = yield* HttpClient.HttpClient;
  const { accountId, apiToken } = yield* CloudflareCredentials;
  const accountUrl = (path: string) => new URL(`${CLOUDFLARE_API_URL}/accounts/${accountId}${path}`);
  const zoneUrl = (zoneId: string, path: string) => new URL(`${CLOUDFLARE_API_URL}/zones/${zoneId}${path}`);
  const authorize = (request: HttpClientRequest.HttpClientRequest) =>
    HttpClientRequest.acceptJson(HttpClientRequest.bearerToken(request, Redacted.value(apiToken)));
  const timeout = (label: string) =>
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () => Effect.fail(new CloudflareApiError({ message: `Cloudflare ${label} timed out` })),
    });

  const call = <A, I>(request: HttpClientRequest.HttpClientRequest, schema: Schema.Codec<A, I>, label: string) =>
    client.execute(authorize(request)).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(EnvelopeSchema)),
      Effect.mapError((cause) => new CloudflareApiError({ cause, message: `Cloudflare ${label} failed` })),
      Effect.flatMap((envelope) =>
        envelope.success
          ? Schema.decodeUnknownEffect(schema)(envelope.result).pipe(
              Effect.mapError(
                (cause) =>
                  new CloudflareApiError({ cause, message: `Cloudflare ${label} returned an unexpected result` }),
              ),
            )
          : Effect.fail(
              new CloudflareApiError({
                apiMessages: Option.getOrElse(envelope.errors, () => []).map(({ message }) => message),
                message: `Cloudflare ${label} failed: ${describeErrors(envelope.errors)}`,
              }),
            ),
      ),
      timeout(label),
    );

  /** Sends `body` as JSON; bodies are built from typed specs only. */
  const send = <A, I>(
    request: HttpClientRequest.HttpClientRequest,
    body: RequestBody,
    schema: Schema.Codec<A, I>,
    label: string,
  ) => call(HttpClientRequest.bodyJsonUnsafe(request, body), schema, label);

  const post = <A, I>(path: string, body: RequestBody, schema: Schema.Codec<A, I>, label: string) =>
    send(HttpClientRequest.post(accountUrl(path)), body, schema, label);

  /** The GraphQL Analytics API answers `{ data, errors }`, not the REST envelope. */
  const workersUsage = (since: DateTime.Utc, until: DateTime.Utc) =>
    client
      .execute(
        authorize(
          HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(`${CLOUDFLARE_API_URL}/graphql`), {
            query: WORKERS_USAGE_QUERY,
            variables: { accountTag: accountId, since: DateTime.formatIso(since), until: DateTime.formatIso(until) },
          }),
        ),
      )
      .pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(Schema.decodeUnknownEffect(WorkersUsageSchema)),
        Effect.mapError((cause) => new CloudflareApiError({ cause, message: 'Cloudflare Workers usage query failed' })),
        Effect.flatMap(({ data, errors }) => {
          const messages = Option.getOrElse(errors, () => []).map(({ message }) => message);
          if (Option.isNone(data) || messages.length > 0) {
            return Effect.fail(
              new CloudflareApiError({ message: `Cloudflare Workers usage query failed: ${messages.join('; ')}` }),
            );
          }
          return Effect.succeed(
            summarizeUsage(
              data.value.viewer.accounts.flatMap(({ workersInvocationsAdaptive }) => workersInvocationsAdaptive),
            ),
          );
        }),
        timeout('Workers usage query'),
      );

  /** Reads every page of a list endpoint; a short page ends the listing. */
  const list = <A, I>(path: string, schema: Schema.Codec<A, I>, label: string) =>
    Effect.gen(function* listPages() {
      const items: A[] = [];
      for (let page = 1; ; page += 1) {
        const url = accountUrl(path);
        url.searchParams.set('page', String(page));
        url.searchParams.set('per_page', String(PAGE_SIZE));
        const pageItems = yield* call(HttpClientRequest.get(url), Schema.Array(schema), label);
        items.push(...pageItems);
        if (pageItems.length < PAGE_SIZE) {
          return items;
        }
      }
    });

  const tunnelsUrl = (name: string) => {
    const url = accountUrl('/cfd_tunnel');
    url.searchParams.set('name', name);
    url.searchParams.set('is_deleted', 'false');
    return url;
  };

  const rule = (zoneId: string, rulesetId: string, ruleId?: string) =>
    zoneUrl(zoneId, ['', 'rulesets', rulesetId, 'rules', ...(ruleId === undefined ? [] : [ruleId])].join('/'));

  return {
    accessApps: list('/access/apps', AccessAppSchema, 'Access application list'),
    accessPolicies: list('/access/policies', AccessPolicySchema, 'Access policy list'),
    accessServiceTokens: list('/access/service_tokens', ServiceTokenSchema, 'Access service token list'),
    addRulesetRule: (zoneId, rulesetId, spec) =>
      send(HttpClientRequest.post(rule(zoneId, rulesetId)), spec, RulesetSchema, `ruleset rule ${spec.ref} create`),
    alertPolicies: call(
      HttpClientRequest.get(accountUrl('/alerting/v3/policies')),
      Schema.Array(AlertPolicySchema),
      'notification policy list',
    ),
    createAccessApp: (spec) =>
      post('/access/apps', accessAppBody(spec), AccessAppSchema, `Access application ${spec.name} create`),
    createAccessPolicy: (spec) =>
      post('/access/policies', spec, AccessPolicySchema, `Access policy ${spec.name} create`),
    createAccessServiceToken: (name) =>
      post(
        '/access/service_tokens',
        { duration: '8760h', name },
        ServiceTokenCredentialsSchema,
        `Access service token ${name} create`,
      ).pipe(Effect.map(serviceTokenCredentials)),
    createAlertPolicy: (spec) =>
      post('/alerting/v3/policies', spec, AlertPolicyIdSchema, `notification policy ${spec.name} create`).pipe(
        Effect.map(({ id }) => id),
      ),
    createHyperdrive: (spec) =>
      post('/hyperdrive/configs', hyperdriveBody(spec), HyperdriveSchema, 'Hyperdrive create'),
    createOriginCertificate: ({ csr, hostnames }) =>
      send(
        HttpClientRequest.post(`${CLOUDFLARE_API_URL}/certificates`),
        {
          csr,
          hostnames,
          request_type: 'origin-ecc',
          requested_validity: ORIGIN_CERTIFICATE_VALIDITY_DAYS,
        },
        OriginCertificateSchema,
        'Origin CA certificate create',
      ),
    createTunnel: (name) => post('/cfd_tunnel', { config_src: 'cloudflare', name }, TunnelSchema, 'Tunnel create'),
    createVpcService: (spec) =>
      post('/connectivity/directory/services', vpcServiceBody(spec), VpcServiceSchema, 'Workers VPC service create'),
    createZoneEntrypoint: (zoneId, phase, rules) =>
      send(
        HttpClientRequest.put(zoneUrl(zoneId, `/rulesets/phases/${phase}/entrypoint`)),
        { rules },
        RulesetSchema,
        `${phase} entrypoint create`,
      ),
    findTunnel: (name) =>
      call(HttpClientRequest.get(tunnelsUrl(name)), Schema.Array(TunnelSchema), 'Tunnel lookup').pipe(
        Effect.map((tunnels) => Option.fromNullishOr(tunnels.find((tunnel) => tunnel.name === name))),
      ),
    findZoneId: (name) => {
      const url = new URL(`${CLOUDFLARE_API_URL}/zones`);
      url.searchParams.set('name', name);
      return call(HttpClientRequest.get(url), Schema.Array(ZoneSchema), 'zone lookup').pipe(
        Effect.map((zones) => Option.fromNullishOr(zones.find((zone) => zone.name === name)?.id)),
      );
    },
    hyperdrives: list('/hyperdrive/configs', HyperdriveSchema, 'Hyperdrive list'),
    rotateAccessServiceToken: (tokenId) =>
      post(
        `/access/service_tokens/${tokenId}/rotate`,
        {},
        ServiceTokenCredentialsSchema,
        'Access service token rotate',
      ).pipe(Effect.map(serviceTokenCredentials)),
    ruleset: (zoneId, rulesetId) =>
      call(HttpClientRequest.get(zoneUrl(zoneId, `/rulesets/${rulesetId}`)), RulesetSchema, 'ruleset read'),
    tunnel: (tunnelId) =>
      call(HttpClientRequest.get(accountUrl(`/cfd_tunnel/${tunnelId}`)), TunnelSchema, 'Tunnel read'),
    tunnelToken: (tunnelId) =>
      call(
        HttpClientRequest.get(accountUrl(`/cfd_tunnel/${tunnelId}/token`)),
        Schema.NonEmptyString,
        'Tunnel token read',
      ).pipe(Effect.map((token) => Redacted.make(token))),
    updateAccessApp: (appId, spec) =>
      send(
        HttpClientRequest.put(accountUrl(`/access/apps/${appId}`)),
        accessAppBody(spec),
        AccessAppSchema,
        `Access application ${spec.name} update`,
      ),
    updateAccessPolicy: (policyId, spec) =>
      send(
        HttpClientRequest.put(accountUrl(`/access/policies/${policyId}`)),
        spec,
        AccessPolicySchema,
        `Access policy ${spec.name} update`,
      ),
    updateAlertPolicy: (policyId, spec) =>
      send(
        HttpClientRequest.put(accountUrl(`/alerting/v3/policies/${policyId}`)),
        spec,
        AlertPolicyIdSchema,
        `notification policy ${spec.name} update`,
      ).pipe(Effect.map(({ id }) => id)),
    updateRulesetRule: (zoneId, rulesetId, ruleId, spec) =>
      send(
        HttpClientRequest.patch(rule(zoneId, rulesetId, ruleId)),
        spec,
        RulesetSchema,
        `ruleset rule ${spec.ref} update`,
      ),
    vpcServices: list('/connectivity/directory/services', VpcServiceSchema, 'Workers VPC service list'),
    workerScriptNames: call(
      HttpClientRequest.get(accountUrl('/workers/scripts')),
      Schema.Array(WorkerScriptSchema),
      'Worker script list',
    ).pipe(Effect.map((scripts) => new Set(scripts.map(({ id }) => id)))),
    workerSecretNames: (scriptName) =>
      call(
        HttpClientRequest.get(accountUrl(`/workers/scripts/${encodeURIComponent(scriptName)}/secrets`)),
        Schema.Array(WorkerSecretSchema),
        `Worker ${scriptName} secret list`,
      ).pipe(Effect.map((secrets) => new Set(secrets.map(({ name }) => name)))),
    workersUsage,
    zoneRulesets: (zoneId) =>
      call(HttpClientRequest.get(zoneUrl(zoneId, '/rulesets')), Schema.Array(RulesetSummarySchema), 'ruleset list'),
  } satisfies CloudflareApiService;
});

export const CloudflareApiLive = Layer.effect(CloudflareApi, makeCloudflareApi);
