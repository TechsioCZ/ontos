import { expect, test } from 'effect-rstest';

import { makeOAuthConnectionHooks } from '../../../api/oauth-connections/better-auth-hooks.ts';

const hooks = makeOAuthConnectionHooks({} as never);
const session = { id: 's', userId: 'u' };
const user = { email: 'a@b.c', id: 'u' };

test('customAccessTokenClaims maps the grant id to the grant claim', async () => {
  await expect(hooks.customAccessTokenClaims({ referenceId: 'g-1', scopes: ['ontos'] })).resolves.toEqual({
    'https://ontos.cz/grant': 'g-1',
  });
});

test('customAccessTokenClaims refuses a token without a grant', async () => {
  await expect(hooks.customAccessTokenClaims({ scopes: [] })).rejects.toThrow();
});

test('shouldRedirect sends a fresh login to the connect page without touching the database', async () => {
  await expect(
    hooks.shouldRedirect({ headers: new Headers(), isContinuation: false, scopes: [], session, user }),
  ).resolves.toBe(true);
});
