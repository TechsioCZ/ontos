import { expect, it } from 'effect-rstest';

import { gatewayReleaseRefusal } from '../../api/auth/gateway-release-refusal.ts';

const current = 'c'.repeat(64);
const stale = 'a'.repeat(64);

it('names the page, a coarse client kind and both revisions of a refused release, never a query or a cookie', () => {
  expect(
    gatewayReleaseRefusal({
      currentRevision: current,
      endpoint: 'auth/gateway-context',
      headers: {
        referer: 'https://stage.example/cs/crm/klienti?token=secret#x',
        'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/150.0 Safari/537.36',
      },
      sentRevision: stale,
    }),
  ).toEqual({
    clientKind: 'browser',
    currentRevision: 'cccccccccccc',
    endpoint: 'auth/gateway-context',
    refererPath: '/cs/crm/klienti',
    sentRevision: 'aaaaaaaaaaaa',
  });
  const headless = gatewayReleaseRefusal({
    currentRevision: current,
    endpoint: 'auth/gateway-contexts',
    headers: { 'user-agent': 'Mozilla/5.0 HeadlessChrome/150.0' },
    sentRevision: null,
  });
  expect(headless).toMatchObject({ clientKind: 'headless-browser', refererPath: null, sentRevision: null });
  expect(
    gatewayReleaseRefusal({
      currentRevision: current,
      endpoint: 'auth/gateway-context',
      headers: {},
      sentRevision: stale,
    }).clientKind,
  ).toBe('unknown');
  expect(JSON.stringify(headless)).not.toContain('secret');
});
