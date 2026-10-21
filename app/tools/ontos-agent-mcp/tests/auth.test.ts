import { describe, expect, it } from '@rstest/core';
import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { prmPaths, prmResponse, protectedResourceMetadata, unauthorizedResponse, wwwAuthenticate } from '../src/oauth/prm.ts';
import { createAccessTokenVerifier } from '../src/oauth/verify.ts';
import { ConnectorUnavailableError, GRANT_CLAIM, InvalidTokenError } from '../src/oauth/types.ts';

const ISSUER = 'http://localhost:3020/shell-super-app-api/oauth';
const AUDIENCE = 'http://localhost:3090/mcp';
const PRM = 'http://localhost:3090/.well-known/oauth-protected-resource/mcp';

interface SignOptions {
  readonly iss?: string;
  readonly aud?: string;
  readonly exp?: number;
  readonly scope?: string;
  readonly grant?: string | null;
}

const setup = async () => {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const jwk = { ...(await exportJWK(publicKey)), alg: 'EdDSA', kid: 'k1' };
  const verify = createAccessTokenVerifier({ audience: AUDIENCE, issuer: ISSUER, keys: createLocalJWKSet({ keys: [jwk] }) });
  const sign = async (overrides: SignOptions = {}): Promise<string> => {
    const { iss = ISSUER, aud = AUDIENCE, exp, scope = 'openid offline_access ontos', grant = 'grant-1' } = overrides;
    const claims: Record<string, unknown> = { azp: 'client-1', scope };
    if (grant !== null) {
      claims[GRANT_CLAIM] = grant;
    }
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
      .setIssuer(iss)
      .setAudience(aud)
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime(exp ?? Math.floor(Date.now() / 1000) + 600)
      .sign(privateKey);
  };
  return { sign, verify };
};

const errorOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('createAccessTokenVerifier', () => {
  it('accepts a valid token and extracts grant, client, subject and scopes', async () => {
    const { sign, verify } = await setup();
    const verified = await verify(await sign());
    expect(verified.grantId).toBe('grant-1');
    expect(verified.clientId).toBe('client-1');
    expect(verified.subject).toBe('user-1');
    expect(verified.scopes).toContain('ontos');
    expect(verified.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects a wrong audience', async () => {
    const { sign, verify } = await setup();
    const error = await errorOf(verify(await sign({ aud: 'http://localhost:3090/other' })));
    expect(error).toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a wrong issuer', async () => {
    const { sign, verify } = await setup();
    const error = await errorOf(verify(await sign({ iss: 'http://evil.example/oauth' })));
    expect(error).toBeInstanceOf(InvalidTokenError);
  });

  it('rejects an expired token beyond the clock tolerance', async () => {
    const { sign, verify } = await setup();
    const error = await errorOf(verify(await sign({ exp: Math.floor(Date.now() / 1000) - 120 })));
    expect(error).toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a token without the ontos scope', async () => {
    const { sign, verify } = await setup();
    const error = await errorOf(verify(await sign({ scope: 'openid profile' })));
    expect(error).toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a token without the grant claim', async () => {
    const { sign, verify } = await setup();
    const error = await errorOf(verify(await sign({ grant: null })));
    expect(error).toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a Better Auth API key', async () => {
    const { verify } = await setup();
    const error = await errorOf(verify('ontos_k7Hq2sXbY1zzAPIKEY'));
    expect(error).toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a token signed by another key pair', async () => {
    const { verify } = await setup();
    const other = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const forged = await new SignJWT({ azp: 'client-1', scope: 'ontos', [GRANT_CLAIM]: 'grant-1' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('user-1')
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(other.privateKey);
    const error = await errorOf(verify(forged));
    expect(error).toBeInstanceOf(InvalidTokenError);
  });

  it('maps an unreachable or failing JWKS to ConnectorUnavailableError, not 401', async () => {
    const { sign } = await setup();
    const failing = createAccessTokenVerifier({
      audience: AUDIENCE,
      issuer: ISSUER,
      keys: () => Promise.reject(new errors.JOSEError('Expected 200 OK from the JSON Web Key Set HTTP response')),
    });
    expect(await errorOf(failing(await sign()))).toBeInstanceOf(ConnectorUnavailableError);
  });
});

describe('WWW-Authenticate challenge', () => {
  it('formats the challenge with and without a sent token', () => {
    expect(wwwAuthenticate(PRM, false)).toBe(
      'Bearer resource_metadata="http://localhost:3090/.well-known/oauth-protected-resource/mcp", scope="ontos"',
    );
    expect(wwwAuthenticate(PRM, true)).toBe(
      'Bearer resource_metadata="http://localhost:3090/.well-known/oauth-protected-resource/mcp", scope="ontos", error="invalid_token"',
    );
  });

  it('builds the 401 response with the matching header and body', async () => {
    const withToken = unauthorizedResponse(PRM, true);
    expect(withToken.status).toBe(401);
    expect(withToken.headers.get('www-authenticate')).toBe(wwwAuthenticate(PRM, true));
    expect(withToken.headers.get('cache-control')).toBe('no-store');
    expect(((await withToken.json()) as { error: string }).error).toBe('invalid_token');

    const withoutToken = unauthorizedResponse(PRM, false);
    expect(((await withoutToken.json()) as { error: string }).error).toBe('unauthorized');
  });
});

describe('protected resource metadata', () => {
  const config = { connectGuideUrl: 'http://localhost:3020/cs/profil', issuer: ISSUER, resourceUrl: AUDIENCE };

  it('builds the PRM body with one authorization server and only the ontos scope', () => {
    expect(protectedResourceMetadata(config)).toEqual({
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      resource: AUDIENCE,
      resource_documentation: 'http://localhost:3020/cs/profil',
      resource_name: 'OntOS',
      scopes_supported: ['ontos'],
    });
    expect(prmResponse(config).headers.get('access-control-allow-origin')).toBe('*');
  });

  it('lists root and path-inserted PRM paths', () => {
    expect(prmPaths('http://localhost:3090/mcp')).toEqual([
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]);
  });
});
