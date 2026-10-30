import { Context, Duration, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';

import { CloudflareApiError } from './cloudflare-api-error.mts';

/**
 * Minimal adapter over the Cloudflare v4 REST API for the one object the stage still needs from Cloudflare: the
 * Origin CA certificate the SpiceDB HTTP gateway presents (scripts/ops/spicedb-tls.mts). Responses are decoded,
 * never logged; the API token stays redacted until the request is authorized.
 */
const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4';

const REQUEST_TIMEOUT = Duration.seconds(30);

interface CloudflareAccount {
  readonly apiToken: Redacted.Redacted;
}

export const CloudflareCredentials = Context.Service<CloudflareAccount>(
  '@app/scripts/ops/cloudflare-api/CloudflareCredentials',
);

const EnvelopeSchema = Schema.Struct({
  errors: Schema.OptionFromOptionalNullOr(Schema.Array(Schema.Struct({ code: Schema.Number, message: Schema.String }))),
  result: Schema.Unknown,
  success: Schema.Boolean,
});

const OriginCertificateSchema = Schema.Struct({
  certificate: Schema.NonEmptyString,
  expires_on: Schema.String,
  id: Schema.NonEmptyString,
});
type CloudflareOriginCertificate = typeof OriginCertificateSchema.Type;

/** An ECC certificate the Cloudflare Origin CA signs for the CSR's key, valid for 15 years. */
interface OriginCertificateSpec {
  readonly csr: string;
  readonly hostnames: readonly string[];
}

const ORIGIN_CERTIFICATE_VALIDITY_DAYS = 5475;

interface CloudflareApiService {
  /** Needs the zone permission "SSL and Certificates: Edit"; the Origin CA API is not account-scoped. */
  readonly createOriginCertificate: (
    spec: OriginCertificateSpec,
  ) => Effect.Effect<CloudflareOriginCertificate, CloudflareApiError>;
}

export const CloudflareApi = Context.Service<CloudflareApiService>('@app/scripts/ops/cloudflare-api/CloudflareApi');

const describeErrors = (errors: Option.Option<readonly { readonly code: number; readonly message: string }[]>) =>
  Option.getOrElse(errors, () => [])
    .map(({ code, message }) => `${String(code)} ${message}`)
    .join('; ');

const makeCloudflareApi = Effect.gen(function* makeCloudflareApi() {
  const { apiToken } = yield* CloudflareCredentials;
  const client = yield* HttpClient.HttpClient;
  const label = 'Origin CA certificate create';

  return {
    createOriginCertificate: ({ csr, hostnames }) =>
      client
        .execute(
          HttpClientRequest.post(`${CLOUDFLARE_API_URL}/certificates`).pipe(
            HttpClientRequest.bearerToken(Redacted.value(apiToken)),
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyJsonUnsafe({
              csr,
              hostnames,
              request_type: 'origin-ecc',
              requested_validity: ORIGIN_CERTIFICATE_VALIDITY_DAYS,
            }),
          ),
        )
        .pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(Schema.decodeUnknownEffect(EnvelopeSchema)),
          Effect.mapError((cause) => new CloudflareApiError({ cause, message: `Cloudflare ${label} failed` })),
          Effect.flatMap((envelope) =>
            envelope.success
              ? Schema.decodeUnknownEffect(OriginCertificateSchema)(envelope.result).pipe(
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
        ),
  } satisfies CloudflareApiService;
});

export const CloudflareApiLive = Layer.effect(CloudflareApi, makeCloudflareApi);
