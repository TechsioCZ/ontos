// Throws inside Effect callbacks already have a typed boundary; they belong to
// effect-native/no-throw-in-effect-callback, not to this rule.
import { Effect, Schema } from 'effect';

type Environment = Readonly<Record<string, string | undefined>>;

export class GatewayIssuerConfigError extends Schema.TaggedError<GatewayIssuerConfigError>()(
  'GatewayIssuerConfigError',
  { reason: Schema.String },
) {}

export const parseGatewayIssuerConfig = (environment: Environment) =>
  Effect.try({
    catch: () => new GatewayIssuerConfigError({ reason: 'Gateway configuration is missing or malformed' }),
    try: () => {
      const issuer = environment['ONTOS_GATEWAY_ISSUER']?.trim();
      if (issuer === undefined || issuer.length === 0) {
        throw new Error('Gateway issuer is required');
      }
      const issuerUrl = new URL(issuer);
      if (issuerUrl.protocol !== 'https:') {
        throw new Error('Gateway issuer must use HTTPS');
      }
      return { issuer };
    },
  });

export const loadGatewayIssuerConfig = (environment: Environment) =>
  Effect.gen(function* () {
    const parsed = yield* parseGatewayIssuerConfig(environment);
    if (parsed.issuer.length === 0) {
      throw new Error('unreachable: decoded issuer is never empty');
    }
    return parsed;
  });
