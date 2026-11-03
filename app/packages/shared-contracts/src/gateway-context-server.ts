import type { Crypto } from 'effect';
import { Config, Effect, Redacted, Schema } from 'effect';

import { issueRelayedGatewayContext } from './gateway-context-api-key.ts';

export class GatewayRelaySourceError extends Schema.TaggedError<GatewayRelaySourceError>()('GatewayRelaySourceError', {
  cause: Schema.optionalKey(Schema.Defect()),
  reason: Schema.String,
}) {}

export interface GatewayRelaySource {
  readonly assertion: Redacted.Redacted;
  readonly audience: string;
  readonly compositionRevision: string;
  readonly requestCorrelation: string;
}

/** Source evidence is extracted by the Core-owned receiving boundary; Shell revalidates it independently. */
export const acquireRelayedGatewayContext = Effect.fn('GatewayRelay.acquire')(function* acquire(
  source: GatewayRelaySource,
  target: { readonly audience: string; readonly operationKey: string },
  crypto: Crypto.Crypto,
) {
  const configuration = yield* Config.all({
    apiKey: Config.Redacted('ONTOS_GATEWAY_RELAY_API_KEY'),
    baseUrl: Config.schema(
      Schema.URLFromString.check(
        Schema.makeFilter((url) =>
          (url.protocol === 'http:' || url.protocol === 'https:') &&
          url.username === '' &&
          url.password === '' &&
          url.hash === ''
            ? undefined
            : 'Gateway transport requires an HTTP URL without credentials or fragment',
        ),
      ),
      'ONTOS_SHELL_GATEWAY_BASE_URL',
    ),
  }).pipe(Effect.mapError((cause) => new GatewayRelaySourceError({ cause, reason: 'Relay transport is unavailable' })));
  const exchangeId = yield* crypto
    .randomUUIDv4()
    .pipe(
      Effect.mapError(
        (cause) => new GatewayRelaySourceError({ cause, reason: 'Relay attempt identity is unavailable' }),
      ),
    );
  const response = yield* issueRelayedGatewayContext(
    {
      audience: target.audience,
      compositionRevision: source.compositionRevision,
      exchangeId,
      operationKey: target.operationKey,
      sourceAssertion: Redacted.value(source.assertion),
    },
    { ...configuration, requestCorrelation: source.requestCorrelation },
  );
  if (response.compositionRevision !== source.compositionRevision) {
    return yield* new GatewayRelaySourceError({ reason: 'Relay changed the admitted release' });
  }
  return {
    ...response,
    apiUrl: new URL(response.apiBaseUrl, configuration.baseUrl),
    authorization: Redacted.make(`Bearer ${response.token}`),
  };
});
