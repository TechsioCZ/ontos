// @rstest-environment node
import { cimd } from '@better-auth/cimd';
import { mcp } from '@better-auth/mcp';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { jwt } from 'better-auth/plugins/jwt';
import { Effect } from 'effect';
import { expect, test } from 'effect-rstest';

import { fetchClientMetadataResource } from '../../../api/auth/cimd-transport.workerd.ts';
import { forwardOAuthRequest } from '../../../api/auth/oauth-server/forward.ts';
import { OAUTH_BASE_PATH } from '../../../api/auth/oauth-server/policy.ts';
import { oauthMetadataTarget } from '../../../shared/oauth-metadata-routes.ts';

test('installed Better Auth mcp/jwt/cimd metadata advertises CIMD, S256 and RFC 9207 through every discovery form', async () => {
  const origin = 'https://shell.example.test';
  const issuer = `${origin}${OAUTH_BASE_PATH}`;
  const auth = betterAuth({
    basePath: OAUTH_BASE_PATH,
    baseURL: origin,
    database: memoryAdapter({}),
    logger: { disabled: true },
    plugins: [
      jwt({
        disableSettingJwtHeader: true,
        jwks: { keyPairConfig: { alg: 'EdDSA', crv: 'Ed25519' } },
        jwt: { issuer },
      }),
      mcp({
        consentPage: '/cs/pripojit/souhlas',
        loginPage: '/cs/login',
        resource: 'https://mcp.example.test/mcp',
        scopes: ['openid', 'profile', 'email', 'offline_access', 'ontos'],
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    ],
    secret: 'metadata-runtime-fixture-secret-32-characters',
  });
  const forward = forwardOAuthRequest({ handler: (request) => auth.handler(request), issuer });
  for (const document of ['oauth-authorization-server', 'openid-configuration']) {
    let canonical: unknown;
    for (const path of [
      `${OAUTH_BASE_PATH}/.well-known/${document}`,
      `/.well-known/${document}`,
      `/.well-known/${document}${OAUTH_BASE_PATH}`,
    ]) {
      const target = oauthMetadataTarget(path) ?? path;
      const response = await Effect.runPromise(forward(new Request(`${origin}${target}`)));
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      const metadata = await response.json();
      expect(metadata).toMatchObject({
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
        code_challenge_methods_supported: ['S256'],
        issuer,
      });
      expect(metadata).not.toHaveProperty('registration_endpoint');
      expect(metadata).not.toHaveProperty('introspection_endpoint');
      if (canonical === undefined) {
        canonical = metadata;
      }
      expect(metadata).toEqual(canonical);
    }
  }
});
