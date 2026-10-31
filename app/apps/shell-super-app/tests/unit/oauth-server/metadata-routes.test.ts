import { expect, test } from 'effect-rstest';

import { oauthMetadataTarget } from '../../../shared/oauth-metadata-routes.ts';

test('root and RFC 8414 path-inserted metadata use the canonical in-process BFF handlers', () => {
  for (const document of ['oauth-authorization-server', 'openid-configuration']) {
    const canonical = `/shell-super-app-api/oauth/.well-known/${document}`;
    expect(oauthMetadataTarget(`/.well-known/${document}`)).toBe(canonical);
    expect(oauthMetadataTarget(`/.well-known/${document}/shell-super-app-api/oauth`)).toBe(canonical);
    expect(oauthMetadataTarget(canonical)).toBeUndefined();
    expect(oauthMetadataTarget(`/.well-known/${document}/other`)).toBeUndefined();
  }
  expect(oauthMetadataTarget('/.well-known/oauth-protected-resource')).toBeUndefined();
  expect(oauthMetadataTarget('/cs/login')).toBeUndefined();
});
