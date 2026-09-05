// expect-count: 4
// A3: one generic `configurationError()` thrown for six different causes — no typed failure channel.
import { Schema } from 'effect';

export class ActionPrincipalConfigurationError extends Schema.TaggedError<ActionPrincipalConfigurationError>()(
  'ActionPrincipalConfigurationError',
  { reason: Schema.String },
) {}

const configurationError = () =>
  new ActionPrincipalConfigurationError({ reason: 'Action identity verification is misconfigured' });

export interface VerificationConfiguration {
  readonly issuer: string;
  readonly jwks: string;
}

export const parseConfiguration = (
  environment: Readonly<Record<string, string | undefined>>,
): VerificationConfiguration => {
  const issuer = environment['ONTOS_GATEWAY_ISSUER'];
  const rawJwks = environment['ONTOS_GATEWAY_PUBLIC_JWKS'];
  if (issuer === undefined || rawJwks === undefined) {
    throw configurationError();
  }
  try {
    const parsedIssuer = new URL(issuer);
    if (parsedIssuer.protocol !== 'https:' && parsedIssuer.protocol !== 'http:') {
      throw configurationError();
    }
  } catch {
    throw configurationError();
  }
  if (rawJwks.length === 0) {
    throw configurationError();
  }
  return { issuer, jwks: rawJwks };
};
