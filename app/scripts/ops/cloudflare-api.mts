import { Context, Duration, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';

import { CloudflareApiError } from './cloudflare-api-error.mts';

/**
 * Minimal adapter over the Cloudflare v4 REST API for the stage account objects the cut-over owns:
 * the remotely managed Tunnel, the Workers VPC services behind it, the Hyperdrive config and the
 * Worker script inventory, plus the zone-level Origin CA certificates the tunnel's private origins
 * present. Paths and bodies follow what Wrangler 4 sends for the same objects
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
  name: Schema.String,
  service_id: Schema.NonEmptyString,
  tcp_port: optional(Schema.Number),
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
const WorkerSecretSchema = Schema.Struct({ name: Schema.String });

/** A Workers VPC service reached by hostname through the tunnel's resolver network. */
export interface VpcServiceSpec {
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
  readonly http_port?: number;
  readonly name: string;
  readonly tcp_port?: number;
  readonly type: 'http' | 'tcp';
}

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
type HyperdriveBody = ReturnType<typeof hyperdriveBody>;

export interface CloudflareApiService {
  readonly createHyperdrive: (spec: HyperdriveSpec) => Effect.Effect<CloudflareHyperdrive, CloudflareApiError>;
  /** Needs the zone permission "SSL and Certificates: Edit"; the Origin CA API is not account-scoped. */
  readonly createOriginCertificate: (
    spec: OriginCertificateSpec,
  ) => Effect.Effect<CloudflareOriginCertificate, CloudflareApiError>;
  readonly createTunnel: (name: string) => Effect.Effect<CloudflareTunnel, CloudflareApiError>;
  readonly createVpcService: (spec: VpcServiceSpec) => Effect.Effect<CloudflareVpcService, CloudflareApiError>;
  readonly findTunnel: (name: string) => Effect.Effect<Option.Option<CloudflareTunnel>, CloudflareApiError>;
  readonly hyperdrives: Effect.Effect<readonly CloudflareHyperdrive[], CloudflareApiError>;
  readonly tunnel: (tunnelId: string) => Effect.Effect<CloudflareTunnel, CloudflareApiError>;
  readonly tunnelToken: (tunnelId: string) => Effect.Effect<Redacted.Redacted, CloudflareApiError>;
  readonly vpcServices: Effect.Effect<readonly CloudflareVpcService[], CloudflareApiError>;
  readonly workerScriptNames: Effect.Effect<ReadonlySet<string>, CloudflareApiError>;
  /** The names, never the values, of a Worker's secrets. */
  readonly workerSecretNames: (scriptName: string) => Effect.Effect<ReadonlySet<string>, CloudflareApiError>;
}

export const CloudflareApi = Context.Service<CloudflareApiService>('@app/scripts/ops/cloudflare-api/CloudflareApi');

/** The request body Wrangler sends for `vpc service create --hostname … --tunnel-id …`. */
export const vpcServiceBody = (spec: VpcServiceSpec): VpcServiceBody => {
  const host = { hostname: spec.hostname, resolver_network: { tunnel_id: spec.tunnelId } };
  return spec.type === 'tcp'
    ? { app_protocol: 'postgresql', host, name: spec.name, tcp_port: spec.port, type: 'tcp' }
    : { host, http_port: spec.port, name: spec.name, type: 'http' };
};

const describeErrors = (errors: Option.Option<readonly { readonly code: number; readonly message: string }[]>) =>
  Option.getOrElse(errors, () => [])
    .map(({ code, message }) => `${String(code)} ${message}`)
    .join('; ');

const makeCloudflareApi = Effect.gen(function* makeCloudflareApi() {
  const client = yield* HttpClient.HttpClient;
  const { accountId, apiToken } = yield* CloudflareCredentials;
  const accountUrl = (path: string) => new URL(`${CLOUDFLARE_API_URL}/accounts/${accountId}${path}`);

  const call = <A, I>(request: HttpClientRequest.HttpClientRequest, schema: Schema.Codec<A, I>, label: string) =>
    client.execute(HttpClientRequest.acceptJson(HttpClientRequest.bearerToken(request, Redacted.value(apiToken)))).pipe(
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
              new CloudflareApiError({ message: `Cloudflare ${label} failed: ${describeErrors(envelope.errors)}` }),
            ),
      ),
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () => Effect.fail(new CloudflareApiError({ message: `Cloudflare ${label} timed out` })),
      }),
    );

  const postTo = <A, I>(
    url: URL,
    body: HyperdriveBody | OriginCertificateBody | TunnelCreateBody | VpcServiceBody,
    schema: Schema.Codec<A, I>,
    label: string,
  ) => call(HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), body), schema, label);

  const post = <A, I>(
    path: string,
    body: HyperdriveBody | TunnelCreateBody | VpcServiceBody,
    schema: Schema.Codec<A, I>,
    label: string,
  ) => postTo(accountUrl(path), body, schema, label);

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

  return {
    createHyperdrive: (spec) =>
      post('/hyperdrive/configs', hyperdriveBody(spec), HyperdriveSchema, 'Hyperdrive create'),
    createOriginCertificate: ({ csr, hostnames }) =>
      postTo(
        new URL(`${CLOUDFLARE_API_URL}/certificates`),
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
    findTunnel: (name) =>
      call(HttpClientRequest.get(tunnelsUrl(name)), Schema.Array(TunnelSchema), 'Tunnel lookup').pipe(
        Effect.map((tunnels) => Option.fromNullishOr(tunnels.find((tunnel) => tunnel.name === name))),
      ),
    hyperdrives: list('/hyperdrive/configs', HyperdriveSchema, 'Hyperdrive list'),
    tunnel: (tunnelId) =>
      call(HttpClientRequest.get(accountUrl(`/cfd_tunnel/${tunnelId}`)), TunnelSchema, 'Tunnel read'),
    tunnelToken: (tunnelId) =>
      call(
        HttpClientRequest.get(accountUrl(`/cfd_tunnel/${tunnelId}/token`)),
        Schema.NonEmptyString,
        'Tunnel token read',
      ).pipe(Effect.map((token) => Redacted.make(token))),
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
  } satisfies CloudflareApiService;
});

export const CloudflareApiLive = Layer.effect(CloudflareApi, makeCloudflareApi);
