// @rstest-environment node
import { expect, test } from 'effect-rstest';

import {
  oauthErrorPageCode,
  oauthErrorPageLocation,
  publicMetadataDocument,
  withOfflineAccess,
} from '../../../api/auth/oauth-server/policy.ts';

test('withOfflineAccess adds offline_access when ontos is requested', () => {
  const result = new URLSearchParams(withOfflineAccess('?client_id=a&scope=ontos&state=s'));
  expect(result.get('scope')).toBe('ontos offline_access');
  expect(result.get('client_id')).toBe('a');
  expect(result.get('state')).toBe('s');
});

test('withOfflineAccess keeps queries that already ask for offline_access, lack ontos, or are signed', () => {
  expect(withOfflineAccess('?scope=openid+offline_access+ontos')).toBe('?scope=openid+offline_access+ontos');
  expect(withOfflineAccess('?scope=openid+profile')).toBe('?scope=openid+profile');
  expect(withOfflineAccess('?client_id=a')).toBe('?client_id=a');
  expect(withOfflineAccess('?scope=ontos&sig=x')).toBe('?scope=ontos&sig=x');
});

test('publicMetadataDocument drops introspection and client secret methods', () => {
  const document = publicMetadataDocument({
    introspection_endpoint: 'x/oauth2/introspect',
    introspection_endpoint_auth_methods_supported: ['client_secret_basic'],
    introspection_endpoint_auth_signing_alg_values_supported: ['EdDSA'],
    issuer: 'http://localhost:3020/shell-super-app-api/oauth',
    revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'private_key_jwt'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt'],
  });
  expect(document).toEqual({
    issuer: 'http://localhost:3020/shell-super-app-api/oauth',
    revocation_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
  });
});

test('error codes map to the three Czech error cards', () => {
  expect(oauthErrorPageCode('invalid_redirect')).toBe('invalid_redirect');
  expect(oauthErrorPageCode('invalid_redirect_uri')).toBe('invalid_redirect');
  expect(oauthErrorPageCode('invalid_client')).toBe('invalid_client');
  expect(oauthErrorPageCode('UNKNOWN')).toBe('request_failed');
  expect(oauthErrorPageCode(null)).toBe('request_failed');
  expect(oauthErrorPageLocation('invalid_client')).toBe('/cs/login?oauth_error=invalid_client');
});
