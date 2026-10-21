/** Local verification of OAuth access tokens (design §5.1 step 2). Never accepts Better Auth API keys or cookies. */
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { ConnectorUnavailableError, GRANT_CLAIM, InvalidTokenError, OAUTH_SCOPE } from './types.ts';
import type { VerifiedAccessToken } from './types.ts';

/** Better Auth signs EdDSA (Ed25519); newer JOSE libraries may label it Ed25519. */
export const ACCEPTED_ALGORITHMS = ['EdDSA', 'Ed25519'];
export const CLOCK_TOLERANCE_SECONDS = 60;

/** JWKS of the issuer, cached and refetched on an unknown kid. */
export const remoteJwks = (jwksUrl: string): JWTVerifyGetKey =>
  createRemoteJWKSet(new URL(jwksUrl), { cacheMaxAge: 600_000, cooldownDuration: 30_000, timeoutDuration: 5_000 });

export const scopesOf = (payload: JWTPayload): string[] => {
  const scope = payload['scope'];
  if (typeof scope === 'string') {
    return scope.split(' ').filter((entry) => entry !== '');
  }
  const scp = payload['scp'];
  return Array.isArray(scp) ? scp.filter((entry): entry is string => typeof entry === 'string') : [];
};

export interface VerifierOptions {
  /** Exact issuer string (no trailing slash). */
  readonly issuer: string;
  /** Exact MCP resource URL = required `aud`. */
  readonly audience: string;
  readonly keys: JWTVerifyGetKey;
}

const isUnavailable = (error: unknown): boolean =>
  error instanceof errors.JWKSTimeout || error instanceof TypeError;

export const createAccessTokenVerifier =
  (options: VerifierOptions) =>
  async (token: string): Promise<VerifiedAccessToken> => {
    if (token.split('.').length !== 3) {
      throw new InvalidTokenError('not a JWT');
    }
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, options.keys, {
        algorithms: ACCEPTED_ALGORITHMS,
        audience: options.audience,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        issuer: options.issuer,
        requiredClaims: ['exp', 'sub'],
      }));
    } catch (error) {
      if (isUnavailable(error)) {
        throw new ConnectorUnavailableError('JWKS unavailable');
      }
      throw new InvalidTokenError(error instanceof Error ? error.message : 'invalid token');
    }
    const scopes = scopesOf(payload);
    if (!scopes.includes(OAUTH_SCOPE)) {
      throw new InvalidTokenError('scope ontos missing');
    }
    const grantId = payload[GRANT_CLAIM];
    if (typeof grantId !== 'string' || grantId === '') {
      throw new InvalidTokenError('grant claim missing');
    }
    const azp = payload['azp'];
    const clientIdClaim = payload['client_id'];
    const clientId = typeof azp === 'string' ? azp : typeof clientIdClaim === 'string' ? clientIdClaim : '';
    return { clientId, expiresAt: payload.exp ?? 0, grantId, scopes, subject: payload.sub ?? '', token };
  };
