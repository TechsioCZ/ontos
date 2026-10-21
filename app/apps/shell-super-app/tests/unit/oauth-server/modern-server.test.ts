// @rstest-environment node
import { expect, test } from 'effect-rstest';
import { isOAuthPagePath, oauthPageSecurityHeaders, serveRootMetadataAlias } from '../../../server/modern.server.ts';

const OAUTH_ALIAS = '/.well-known/oauth-authorization-server/shell-super-app-api/oauth';

test('isOAuthPagePath matches login, pripojit and connect pages only', () => {
  for (const path of ['/cs/login', '/en/login', '/cs/pripojit', '/cs/pripojit/souhlas']) {
    expect(isOAuthPagePath(path)).toBe(true);
  }
  for (const path of ['/cs/', '/cs/loginx', '/cs/crm']) {
    expect(isOAuthPagePath(path)).toBe(false);
  }
});

test('serveRootMetadataAlias handles GET in-process, rejects writes, answers OPTIONS and passes other paths on', async () => {
  const recorded: string[] = [];
  const handleCanonical = (request: Request): Promise<Response> => {
    recorded.push(request.url);
    return Promise.resolve(new Response('{"issuer":"x"}', { headers: { 'content-type': 'application/json' } }));
  };
  const handler = serveRootMetadataAlias(handleCanonical);
  let nextCalls = 0;
  const next = () => {
    nextCalls += 1;
    return Promise.resolve();
  };

  const get = await handler({ req: { method: 'GET', path: OAUTH_ALIAS }, res: new Response(null) }, next);
  expect(get?.status).toBe(200);
  expect(await get?.text()).toBe('{"issuer":"x"}');
  expect(get?.headers.get('access-control-allow-origin')).toBe('*');
  expect(recorded).toEqual(['https://shell.invalid/shell-super-app-api/oauth/.well-known/oauth-authorization-server']);
  expect(nextCalls).toBe(0);

  const head = await handler({ req: { method: 'HEAD', path: OAUTH_ALIAS }, res: new Response(null) }, next);
  expect(await head?.text()).toBe('');

  const post = await handler({ req: { method: 'POST', path: OAUTH_ALIAS }, res: new Response(null) }, next);
  expect(post?.status).toBe(405);

  const options = await handler({ req: { method: 'OPTIONS', path: OAUTH_ALIAS }, res: new Response(null) }, next);
  expect(options?.status).toBe(204);

  const passthrough = await handler({ req: { method: 'GET', path: '/cs/login' }, res: new Response(null) }, next);
  expect(passthrough).toBeUndefined();
  expect(nextCalls).toBe(1);
});

test('root metadata preserves canonical failure cache policy and removes credentialed CORS', async () => {
  const handler = serveRootMetadataAlias(() =>
    Promise.resolve(
      new Response('{"error":"unavailable"}', {
        headers: { 'cache-control': 'no-store', 'access-control-allow-credentials': 'true' },
        status: 503,
      }),
    ),
  );
  const response = await handler({ req: { method: 'GET', path: OAUTH_ALIAS }, res: new Response(null) }, () =>
    Promise.resolve(),
  );
  expect(response?.status).toBe(503);
  expect(response?.headers.get('cache-control')).toBe('no-store');
  expect(response?.headers.get('access-control-allow-origin')).toBe('*');
  expect(response?.headers.has('access-control-allow-credentials')).toBe(false);
});

test('oauthPageSecurityHeaders sets no-store and frame-ancestors on OAuth pages only', async () => {
  const page = { req: { method: 'GET', path: '/cs/login' }, res: new Response('<html>') };
  await oauthPageSecurityHeaders(page, () => Promise.resolve());
  expect(page.res.headers.get('cache-control')).toBe('no-store');
  expect(page.res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  expect(page.res.headers.get('x-frame-options')).toBe('DENY');
  expect(await page.res.text()).toBe('<html>');

  const original = new Response('ok');
  const other = { req: { method: 'GET', path: '/cs/' }, res: original };
  await oauthPageSecurityHeaders(other, () => Promise.resolve());
  expect(other.res).toBe(original);
  expect(other.res.headers.get('content-security-policy')).toBeNull();
});
