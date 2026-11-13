/**
 * #1159 level-2 provider fixture: the production gateway adapters (`GatewayProviderAdaptersLive` over
 * `GatewayProviderServicesLive`, `GopayOAuthTokenLive`, `ProviderHttpLive` and `ProviderCredentialStoreLive`)
 * wired to a recorded `HttpClient`. Every request a provider would have received is recorded; each route answers
 * from its own script, and an unscripted route answers 599 so a missing script never passes as a provider answer.
 *
 * This is a fixture, not provider sandbox evidence: the answers are the documented provider bodies under
 * `tests/fixtures/{gopay,stripe,comgate}`, never a real provider exchange.
 */
import { ConfigProvider, Context, Effect, Layer, Match, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';
import type { HttpClientRequest } from 'effect/http';

import { GopayOAuthTokenLive } from '../../src/integrations/gopay/gopay-oauth-token.ts';
import { ProviderCredentialStoreLive } from '../../src/integrations/psp/credentials-live.ts';
import {
  GatewayProviderAdaptersLive,
  GatewayProviderServicesLive,
} from '../../src/integrations/psp/gateway-adapters-live.ts';
import { GatewayProviderAdapters } from '../../src/integrations/psp/psp-adapter.ts';
import { ProviderHttpLive } from '../../src/integrations/psp/provider-http-live.ts';

const RespondStepSchema = Schema.TaggedStruct('Respond', { body: Schema.String, status: Schema.Finite });
/** The connection dropped after the request was written (`ECONNRESET`): a lost response. */
const DropStepSchema = Schema.TaggedStruct('Drop', {});
const RecordedStepSchema = Schema.Union([RespondStepSchema, DropStepSchema]);
export type RecordedStep = typeof RecordedStepSchema.Type;

export const respond = (status: number, body: string): RecordedStep => RespondStepSchema.make({ body, status });
export const dropAfterWrite: RecordedStep = DropStepSchema.make({});

export interface RecordedRequest {
  readonly authorization: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  /** `METHOD url` without query parameters. */
  readonly route: string;
  readonly urlParams: readonly (readonly [string, string])[];
}

export type RouteScript = Readonly<Record<string, readonly RecordedStep[]>>;

const bodyTextOf = (request: HttpClientRequest.HttpClientRequest): string =>
  Match.value(request.body).pipe(
    Match.tag('Uint8Array', ({ body }) => new TextDecoder().decode(body)),
    Match.orElse(() => ''),
  );

const answer = (request: HttpClientRequest.HttpClientRequest, step: RecordedStep) =>
  Match.value(step).pipe(
    Match.tag('Drop', () =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            cause: new TypeError('fetch failed', {
              cause: Object.assign(new Error('socket ECONNRESET'), { code: 'ECONNRESET' }),
            }),
            request,
          }),
        }),
      ),
    ),
    Match.tag('Respond', ({ body, status }) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status }))),
    ),
    Match.exhaustive,
  );

/** Encoded `ONTOS_PAYMENT_PROVIDER_CREDENTIALS` document; entries are fixture strings, never credentials. */
export type CredentialDocument = Readonly<Record<string, Schema.Json>>;

/**
 * The credential deployment value for the run. The live store reads it per resolve, so the same provider is
 * given to the Layer build and to the test effect.
 */
export const credentialConfig = (document: CredentialDocument) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      ONTOS_PAYMENT_PROVIDER_CREDENTIALS: Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(document),
    }),
  );

/** Builds the production adapter set over a recorded HttpClient. Requires the credential ConfigProvider. */
export const recordedGatewayAdapters = (routes: RouteScript) =>
  Effect.gen(function* recordedGatewayAdaptersEffect() {
    const sent: RecordedRequest[] = [];
    const client = HttpClient.make((request) => {
      const route = `${request.method} ${request.url}`;
      const attempt = sent.filter((entry) => entry.route === route).length;
      sent.push({
        authorization: request.headers.authorization ?? '',
        body: bodyTextOf(request),
        headers: request.headers,
        route,
        urlParams: request.urlParams.params.map(
          ([name, value]) => [name, Redacted.isRedacted(value) ? '<redacted>' : value] as const,
        ),
      });
      return answer(request, routes[route]?.[attempt] ?? respond(599, 'unscripted'));
    });
    const transport = Layer.merge(
      ProviderHttpLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      ProviderCredentialStoreLive,
    );
    const adapters = GatewayProviderAdaptersLive.pipe(
      Layer.provide(GatewayProviderServicesLive),
      Layer.provide(GopayOAuthTokenLive),
      Layer.provide(transport),
    );
    const context = yield* Layer.build(adapters);
    const callsTo = (route: string) => sent.filter((entry) => entry.route === route);
    return { adapters: Context.get(context, GatewayProviderAdapters), callsTo, sent };
  });
